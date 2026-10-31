package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/jackc/pgx/v5"
)

type OrganizationBootstrapIdentity struct {
	UserID        string
	AuthSessionID string
}

type OrganizationBootstrapInput struct {
	OrgName             string   `json:"orgName"`
	BusinessDescription string   `json:"businessDescription"`
	BaseCurrency        string   `json:"baseCurrency"`
	Path                string   `json:"path"`
	DeferredSteps       []string `json:"deferredSteps"`
	IntentID            string   `json:"intentId"`
}

type OrganizationBootstrapOutput struct {
	OrgID    string `json:"orgId"`
	Replayed bool   `json:"replayed,omitempty"`
}

type preOrgSavepointBeginner struct{ tx pgx.Tx }

func (b preOrgSavepointBeginner) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return b.tx.Begin(ctx)
}

var ErrBootstrapIdentityMismatch = errors.New("bootstrap session identity does not match the verified request")

// ExecuteOrganizationBootstrap is the only executor path allowed to create
// an organization before an org-scoped identity exists. It is deliberately
// separate from Execute, which remains strictly org scoped.
func (e *Executor) ExecuteOrganizationBootstrap(
	ctx context.Context,
	identity OrganizationBootstrapIdentity,
	sessionToken string,
	rawInput json.RawMessage,
) (Result, error) {
	if e == nil || e.pool == nil {
		return Result{}, errors.New("capability executor is unavailable")
	}
	spec, ok := capabilitySpecs[iamBootstrapOrganizationCapabilityID]
	if !ok || spec.module != "iam" || spec.permission != "iam.bootstrapOrganization" || spec.risk != "write" || spec.executionScope != "pre-organization" || spec.inverseCapabilityID != "" {
		return Result{}, errors.New("organization bootstrap capability spec is invalid")
	}
	if !isUUID(identity.UserID) || strings.TrimSpace(identity.AuthSessionID) == "" || len(identity.AuthSessionID) > 200 ||
		len(sessionToken) < 16 || len(sessionToken) > 512 {
		return Result{}, ErrSessionInvalid
	}

	var input OrganizationBootstrapInput
	if err := json.Unmarshal(rawInput, &input); err != nil {
		return Result{}, fmt.Errorf("invalid organization bootstrap input: %w", err)
	}
	input.BaseCurrency = strings.ToUpper(input.BaseCurrency)
	if utf16Length(input.OrgName) < 2 || utf16Length(input.OrgName) > 80 ||
		utf16Length(input.BusinessDescription) < 20 || utf16Length(input.BusinessDescription) > 8000 ||
		len(input.BaseCurrency) != 3 || !asciiUpper(input.BaseCurrency) ||
		(input.Path != "fresh" && input.Path != "import" && input.Path != "connect") ||
		utf16Length(input.IntentID) < 8 || utf16Length(input.IntentID) > 100 || len(input.DeferredSteps) > 100 {
		return Result{}, errors.New("invalid organization bootstrap input")
	}
	for _, step := range input.DeferredSteps {
		if utf16Length(step) > 128 {
			return Result{}, errors.New("invalid organization bootstrap input")
		}
	}
	tx, err := e.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var derivedSessionID, derivedUserID string
	var emailVerified bool
	err = tx.QueryRow(ctx, `
		SELECT auth_session_id, user_id::text, email_verified
		FROM public.chaste_resolve_better_auth_session($1, clock_timestamp())`, sessionToken,
	).Scan(&derivedSessionID, &derivedUserID, &emailVerified)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, ErrBootstrapIdentityMismatch
		}
		return Result{}, err
	}
	if !emailVerified || derivedUserID != identity.UserID || derivedSessionID != identity.AuthSessionID {
		return Result{}, ErrBootstrapIdentityMismatch
	}

	var output OrganizationBootstrapOutput
	err = tx.QueryRow(ctx, `
		SELECT org_id::text, replayed
		FROM public.chaste_bootstrap_organization($1, $2, $3, $4, $5, $6::text[], $7)`,
		sessionToken, input.OrgName, input.BusinessDescription, input.BaseCurrency,
		input.Path, input.DeferredSteps, input.IntentID,
	).Scan(&output.OrgID, &output.Replayed)
	if err != nil {
		return Result{}, err
	}
	if !isUUID(output.OrgID) {
		return Result{}, errors.New("organization bootstrap returned an invalid organization id")
	}

	_, err = dbx.WithOrgTx(ctx, preOrgSavepointBeginner{tx: tx}, output.OrgID, func(scopedTx pgx.Tx) (struct{}, error) {
		var ownsOrg, ownsReceipt bool
		if err := scopedTx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM public.memberships WHERE org_id=$1::uuid AND user_id=$2::uuid),
			       EXISTS (SELECT 1 FROM public.bootstrap_intents WHERE org_id=$1::uuid AND user_id=$2::uuid AND intent_id=$3)`,
			output.OrgID, derivedUserID, input.IntentID,
		).Scan(&ownsOrg, &ownsReceipt); err != nil {
			return struct{}{}, err
		}
		if !ownsOrg || !ownsReceipt {
			return struct{}{}, ErrBootstrapIdentityMismatch
		}
		if output.Replayed {
			return struct{}{}, nil
		}
		var appendSessionID, appendUserID string
		var appendEmailVerified bool
		if err := scopedTx.QueryRow(ctx, `
			SELECT auth_session_id, user_id::text, email_verified
			FROM public.chaste_resolve_better_auth_session($1, clock_timestamp())`, sessionToken,
		).Scan(&appendSessionID, &appendUserID, &appendEmailVerified); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return struct{}{}, ErrBootstrapIdentityMismatch
			}
			return struct{}{}, err
		}
		if !appendEmailVerified || appendSessionID != identity.AuthSessionID || appendUserID != identity.UserID {
			return struct{}{}, ErrBootstrapIdentityMismatch
		}
		payload, err := json.Marshal(struct {
			OrgID string `json:"orgId"`
			Name  string `json:"name"`
		}{OrgID: output.OrgID, Name: input.OrgName})
		if err != nil {
			return struct{}{}, err
		}
		capabilityID := iamBootstrapOrganizationCapabilityID
		actorID := derivedUserID
		authSessionID := derivedSessionID
		_, _, err = ledger.AppendTx(ctx, scopedTx, ledger.AppendEvent{
			OrgID: output.OrgID, ActorType: "human", ActorID: &actorID,
			CapabilityID: &capabilityID, AuthSessionID: &authSessionID,
			Kind: "organization.created", Payload: payload, OccurredAt: time.Now().UTC(),
		})
		return struct{}{}, err
	})
	if err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	data, err := json.Marshal(output)
	if err != nil {
		return Result{}, err
	}
	return Result{OK: true, Data: data, Replayed: output.Replayed}, nil
}

func asciiUpper(value string) bool {
	for _, char := range value {
		if char < 'A' || char > 'Z' {
			return false
		}
	}
	return true
}
