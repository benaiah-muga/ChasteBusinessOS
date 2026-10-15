package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const (
	DurableRunMaxSteps       = 100
	DurableRunMaxGoalUTF16   = 2000
	DurableRunMaxModelRef    = 200
	DurableRunMaxStepInput   = 32 << 10
	DurableRunDefaultVersion = "1"
)

var (
	ErrDurableRunConflict    = errors.New("durable run idempotency key conflicts with an existing run")
	ErrDurableRunInput       = errors.New("durable run input is invalid")
	ErrDurableRunComposition = errors.New("durable run composition is not approved")
	ErrDurableRunApproval    = errors.New("durable run step approval is not ready")
	ErrDurableRunSession     = errors.New("durable run session is not owned by this user")
)

type DurableRunStepInput struct {
	CapabilityID       string          `json:"capabilityId"`
	Input              json.RawMessage `json:"input"`
	ApprovedApprovalID *string         `json:"approvedApprovalId,omitempty"`
}

type StartDurableRunInput struct {
	RunID                  string
	OrgID                  string
	ActorID                string
	SessionID              *string
	Goal                   string
	RegistryVersion        string
	ModelRef               *string
	HarnessCompositionID   string
	HarnessCompositionHash string
	CompositionApprovalID  string
	Steps                  []DurableRunStepInput
}

type StartDurableRunResult struct {
	RunID    string `json:"runId"`
	Status   string `json:"status"`
	Replayed bool   `json:"replayed"`
}

type DurableRunDispatcher struct{ db dbx.Beginner }

func NewDurableRunDispatcher(db dbx.Beginner) *DurableRunDispatcher {
	return &DurableRunDispatcher{db: db}
}

func (d *DurableRunDispatcher) CreateAndDispatch(ctx context.Context, input StartDurableRunInput) (StartDurableRunResult, error) {
	if d == nil || d.db == nil {
		return StartDurableRunResult{}, errors.New("durable run database unavailable")
	}
	if err := validateDurableRunInput(input); err != nil {
		return StartDurableRunResult{}, fmt.Errorf("%w: %v", ErrDurableRunInput, err)
	}
	result, err := dbx.WithOrgTx(ctx, d.db, input.OrgID, func(tx pgx.Tx) (StartDurableRunResult, error) {
		composition, err := capability.VerifyDurableRunCompositionTx(
			ctx, tx, input.OrgID, input.HarnessCompositionID, input.HarnessCompositionHash, input.CompositionApprovalID,
		)
		if err != nil {
			return StartDurableRunResult{}, fmt.Errorf("%w: %v", ErrDurableRunComposition, err)
		}
		if input.SessionID != nil {
			var belongs bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (
				SELECT 1 FROM agent_sessions WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid
			)`, *input.SessionID, input.OrgID, input.ActorID).Scan(&belongs); err != nil {
				return StartDurableRunResult{}, err
			}
			if !belongs {
				return StartDurableRunResult{}, ErrDurableRunSession
			}
		}

		inserted := false
		err = tx.QueryRow(ctx, `
			INSERT INTO agent_runs (
				id, org_id, session_id, goal, status, registry_version, model_ref,
				harness_composition_id, harness_profile_id, harness_profile_version,
				harness_composition_digest, initiated_by_actor_type, initiated_by_actor_id
			) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'pending',$5,$6,$7::uuid,$8,$9,$10,'human',$11::uuid)
			ON CONFLICT (id) DO NOTHING
			RETURNING id::text`, input.RunID, input.OrgID, nullableUUID(input.SessionID), input.Goal,
			input.RegistryVersion, nullableString(input.ModelRef), composition.ID, composition.ProfileID,
			composition.ProfileVersion, composition.CompositionDigest, input.ActorID).Scan(new(string))
		if err == nil {
			inserted = true
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return StartDurableRunResult{}, err
		}
		if !inserted {
			matches, err := durableRunMatchesRequest(ctx, tx, input, composition)
			if err != nil {
				return StartDurableRunResult{}, err
			}
			if !matches {
				return StartDurableRunResult{}, ErrDurableRunConflict
			}
		}

		for index, step := range input.Steps {
			hash, err := capability.InputHash(step.Input)
			if err != nil {
				return StartDurableRunResult{}, fmt.Errorf("step %d input is invalid: %w", index, err)
			}
			insertedStep := false
			err = tx.QueryRow(ctx, `
				INSERT INTO agent_run_steps (
					org_id, run_id, step_index, kind, status, capability_id,
					capability_version, input_hash, input, approval_id
				) VALUES ($1::uuid,$2::uuid,$3,'capability','pending',$4,$5,$6,$7::jsonb,$8::uuid)
				ON CONFLICT (run_id, step_index) DO NOTHING
				RETURNING id::text`, input.OrgID, input.RunID, index, step.CapabilityID,
				input.RegistryVersion, hash, []byte(step.Input), nullableUUID(step.ApprovedApprovalID)).Scan(new(string))
			if err == nil {
				insertedStep = true
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return StartDurableRunResult{}, err
			}
			existingStatus := "pending"
			if !insertedStep {
				var existingHash, existingCapability, existingVersion string
				var existingApproval *string
				if err := tx.QueryRow(ctx, `
					SELECT input_hash, capability_id, capability_version, approval_id::text, status
					FROM agent_run_steps WHERE org_id=$1::uuid AND run_id=$2::uuid AND step_index=$3
					FOR UPDATE`, input.OrgID, input.RunID, index).Scan(&existingHash, &existingCapability, &existingVersion, &existingApproval, &existingStatus); err != nil {
					return StartDurableRunResult{}, err
				}
				if existingHash != hash || existingCapability != step.CapabilityID || existingVersion != input.RegistryVersion || !sameOptionalString(existingApproval, step.ApprovedApprovalID) {
					return StartDurableRunResult{}, ErrDurableRunConflict
				}
			}
			if existingStatus != "pending" {
				continue
			}
			if err := validateDurableRunApproval(ctx, tx, input.OrgID, step, input.RunID, index); err != nil {
				return StartDurableRunResult{}, err
			}
			if index > 0 {
				var previousCommitted bool
				if err := tx.QueryRow(ctx, `SELECT status='committed' FROM agent_run_steps WHERE org_id=$1::uuid AND run_id=$2::uuid AND step_index=$3`, input.OrgID, input.RunID, index-1).Scan(&previousCommitted); err != nil {
					return StartDurableRunResult{}, err
				}
				if !previousCommitted {
					continue
				}
			}
			var jobCount int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid AND run_step_index=$3`, input.OrgID, input.RunID, index).Scan(&jobCount); err != nil {
				return StartDurableRunResult{}, err
			}
			if jobCount > 1 {
				return StartDurableRunResult{}, ErrDurableRunConflict
			}
			if jobCount == 1 {
				var matches bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS (
					SELECT 1 FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid AND run_step_index=$3
					  AND type=$4 AND payload=$5::jsonb
					  AND approved_approval_id IS NOT DISTINCT FROM $6::uuid
				)`, input.OrgID, input.RunID, index, step.CapabilityID, []byte(step.Input), nullableUUID(step.ApprovedApprovalID)).Scan(&matches); err != nil {
					return StartDurableRunResult{}, err
				}
				if !matches {
					return StartDurableRunResult{}, ErrDurableRunConflict
				}
				continue
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO jobs (
					org_id, type, payload, status, max_attempts, available_at,
					created_by_actor_type, created_by_actor_id, run_id, run_step_index, approved_approval_id
				) VALUES ($1::uuid,$2,$3::jsonb,'pending',3,clock_timestamp(),'human',$4::uuid,$5::uuid,$6,$7::uuid)`,
				input.OrgID, step.CapabilityID, []byte(step.Input), input.ActorID, input.RunID, index, nullableUUID(step.ApprovedApprovalID)); err != nil {
				return StartDurableRunResult{}, err
			}
		}
		status := "pending"
		if !inserted {
			if err := tx.QueryRow(ctx, `SELECT status FROM agent_runs WHERE org_id=$1::uuid AND id=$2::uuid`, input.OrgID, input.RunID).Scan(&status); err != nil {
				return StartDurableRunResult{}, err
			}
		}
		return StartDurableRunResult{RunID: input.RunID, Status: status, Replayed: !inserted}, nil
	})
	return result, err
}

func validateDurableRunInput(input StartDurableRunInput) error {
	if !validDurableRunUUID(input.RunID) || !validDurableRunUUID(input.OrgID) || !validDurableRunUUID(input.ActorID) ||
		!validDurableRunUUID(input.HarnessCompositionID) || !validDurableRunUUID(input.CompositionApprovalID) {
		return errors.New("durable run identity is invalid")
	}
	if input.SessionID != nil && !validDurableRunUUID(*input.SessionID) {
		return errors.New("durable run session is invalid")
	}
	if utf16Length(input.Goal) < 1 || utf16Length(input.Goal) > DurableRunMaxGoalUTF16 {
		return errors.New("durable run goal is outside the allowed length")
	}
	if input.RegistryVersion == "" || len(input.RegistryVersion) > 64 || len(input.Steps) == 0 || len(input.Steps) > DurableRunMaxSteps {
		return errors.New("durable run version or step count is invalid")
	}
	if input.ModelRef != nil && (strings.TrimSpace(*input.ModelRef) == "" || utf16Length(*input.ModelRef) > DurableRunMaxModelRef) {
		return errors.New("durable run model reference is invalid")
	}
	for index, step := range input.Steps {
		if _, ok := GoCapabilityPermissions[step.CapabilityID]; !ok {
			return fmt.Errorf("step %d capability is not enabled for Go jobs", index)
		}
		if len(step.Input) == 0 || len(step.Input) > DurableRunMaxStepInput || !json.Valid(step.Input) {
			return fmt.Errorf("step %d input is invalid or exceeds size limit", index)
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(step.Input, &object); err != nil || object == nil {
			return fmt.Errorf("step %d input must be a JSON object", index)
		}
		if step.ApprovedApprovalID != nil && !validDurableRunUUID(*step.ApprovedApprovalID) {
			return fmt.Errorf("step %d approval identity is invalid", index)
		}
	}
	return nil
}

func durableRunMatchesRequest(ctx context.Context, tx pgx.Tx, input StartDurableRunInput, composition capability.DurableRunCompositionIdentity) (bool, error) {
	var orgID, goal, registryVersion, actorType string
	var compositionID, profileID, profileVersion, digest *string
	var sessionID, actorID, modelRef *string
	err := tx.QueryRow(ctx, `
		SELECT org_id::text, goal, registry_version, model_ref, harness_composition_id::text,
		       harness_profile_id, harness_profile_version, harness_composition_digest,
		       initiated_by_actor_type, initiated_by_actor_id::text, session_id::text
		FROM agent_runs WHERE id=$1::uuid FOR UPDATE`, input.RunID).Scan(
		&orgID, &goal, &registryVersion, &modelRef, &compositionID, &profileID,
		&profileVersion, &digest, &actorType, &actorID, &sessionID)
	if err != nil {
		return false, err
	}
	if orgID != input.OrgID || goal != input.Goal || registryVersion != input.RegistryVersion ||
		!sameOptionalString(modelRef, input.ModelRef) || compositionID == nil || *compositionID != composition.ID ||
		profileID == nil || *profileID != composition.ProfileID || profileVersion == nil || *profileVersion != composition.ProfileVersion ||
		digest == nil || *digest != composition.CompositionDigest || actorType != "human" || !sameOptionalString(actorID, &input.ActorID) ||
		!sameOptionalString(sessionID, input.SessionID) {
		return false, nil
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_run_steps WHERE org_id=$1::uuid AND run_id=$2::uuid`, input.OrgID, input.RunID).Scan(&count); err != nil {
		return false, err
	}
	return count == 0 || count == len(input.Steps), nil
}

func validateDurableRunApproval(ctx context.Context, tx pgx.Tx, orgID string, step DurableRunStepInput, runID string, index int) error {
	risk, ok := capability.DurableRunCapabilityRisk(step.CapabilityID)
	if !ok {
		return fmt.Errorf("%w: step %d capability is unsupported", ErrDurableRunInput, index)
	}
	if risk == "read" && step.ApprovedApprovalID == nil {
		return nil
	}
	if step.ApprovedApprovalID == nil {
		return fmt.Errorf("%w: step %d requires an executed approval before durable dispatch", ErrDurableRunApproval, index)
	}
	var payloadMatches bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM approvals
			WHERE id=$1::uuid AND org_id=$2::uuid AND capability_id=$3 AND status='executing'
			  AND expires_at > clock_timestamp() AND payload=$4::jsonb
		)`, *step.ApprovedApprovalID, orgID, step.CapabilityID, []byte(step.Input)).Scan(&payloadMatches)
	if err != nil {
		return err
	}
	if !payloadMatches {
		return fmt.Errorf("%w: step %d approval is not executing for this capability input", ErrDurableRunApproval, index)
	}
	return nil
}

func nullableUUID(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func validDurableRunUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}
