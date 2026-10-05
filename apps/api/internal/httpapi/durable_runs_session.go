package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type durableRunsSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type durableRunListRow struct {
	ID                       string  `json:"id"`
	SessionID                *string `json:"sessionId"`
	Goal                     string  `json:"goal"`
	Status                   string  `json:"status"`
	CurrentStep              int     `json:"currentStep"`
	ModelRef                 *string `json:"modelRef"`
	HarnessProfileID         *string `json:"harnessProfileId"`
	HarnessProfileVersion    *string `json:"harnessProfileVersion"`
	HarnessCompositionDigest *string `json:"harnessCompositionDigest"`
	LastError                *string `json:"lastError"`
	CreatedAt                string  `json:"createdAt"`
	UpdatedAt                string  `json:"updatedAt"`
	StartedAt                *string `json:"startedAt"`
	FinishedAt               *string `json:"finishedAt"`
}

type durableRunDetailRecord struct {
	durableRunListRow
	OrgID                string  `json:"orgId"`
	ContractRevision     int     `json:"contractRevision"`
	RegistryVersion      string  `json:"registryVersion"`
	HarnessCompositionID *string `json:"harnessCompositionId"`
	InitiatedByActorType string  `json:"initiatedByActorType"`
	InitiatedByActorID   *string `json:"initiatedByActorId"`
}

type durableRunStepRecord struct {
	ID                string          `json:"id"`
	OrgID             string          `json:"orgId"`
	RunID             string          `json:"runId"`
	StepIndex         int             `json:"stepIndex"`
	Kind              string          `json:"kind"`
	Status            string          `json:"status"`
	CapabilityID      *string         `json:"capabilityId"`
	CapabilityVersion *string         `json:"capabilityVersion"`
	InputHash         *string         `json:"inputHash"`
	Input             json.RawMessage `json:"input"`
	Output            json.RawMessage `json:"output"`
	ReceiptID         *string         `json:"receiptId"`
	ApprovalID        *string         `json:"approvalId"`
	Error             *string         `json:"error"`
	StartedAt         *string         `json:"startedAt"`
	FinishedAt        *string         `json:"finishedAt"`
	CreatedAt         string          `json:"createdAt"`
}

type durableRunDetail struct {
	Run   durableRunDetailRecord `json:"run"`
	Steps []durableRunStepRecord `json:"steps"`
}

const (
	durableRunDetailMaxSteps = 200
	durableRunDetailMaxBytes = 2 << 20
)

var errDurableRunDetailTooLarge = errors.New("durable run detail exceeds response limits")

type durableRunsSessionReader interface {
	ListForUser(context.Context, string, string, bool) ([]durableRunListRow, error)
	DetailForUser(context.Context, string, string, string, bool) (*durableRunDetail, error)
}

type pgDurableRunsSessionReader struct{ pool *pgxpool.Pool }

func (r pgDurableRunsSessionReader) ListForUser(ctx context.Context, orgID, userID string, admin bool) ([]durableRunListRow, error) {
	if r.pool == nil {
		return nil, errors.New("durable runs database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) ([]durableRunListRow, error) {
		query := `
			SELECT ar.id::text, ar.session_id::text, ar.goal, ar.status, ar.current_step, ar.model_ref,
			       ar.harness_profile_id, ar.harness_profile_version, ar.harness_composition_digest,
			       ar.last_error, ar.created_at, ar.updated_at, ar.started_at, ar.finished_at
			FROM agent_runs ar
			LEFT JOIN agent_sessions s ON s.id = ar.session_id AND s.org_id = ar.org_id
			WHERE ar.org_id = $1::uuid`
		args := []any{orgID}
		if !admin {
			query += ` AND (ar.initiated_by_actor_id = $2::uuid OR s.user_id = $2::uuid)`
			args = append(args, userID)
		}
		query += ` ORDER BY ar.created_at DESC LIMIT 50`
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		result := make([]durableRunListRow, 0)
		for rows.Next() {
			var row durableRunListRow
			var createdAt, updatedAt time.Time
			var startedAt, finishedAt *time.Time
			if err := rows.Scan(&row.ID, &row.SessionID, &row.Goal, &row.Status, &row.CurrentStep,
				&row.ModelRef, &row.HarnessProfileID, &row.HarnessProfileVersion,
				&row.HarnessCompositionDigest, &row.LastError, &createdAt, &updatedAt,
				&startedAt, &finishedAt); err != nil {
				return nil, err
			}
			row.CreatedAt = legacySessionTime(createdAt)
			row.UpdatedAt = legacySessionTime(updatedAt)
			row.StartedAt = durableRunOptionalTime(startedAt)
			row.FinishedAt = durableRunOptionalTime(finishedAt)
			result = append(result, row)
		}
		return result, rows.Err()
	})
}

func (r pgDurableRunsSessionReader) DetailForUser(ctx context.Context, orgID, runID, userID string, admin bool) (*durableRunDetail, error) {
	if r.pool == nil {
		return nil, errors.New("durable runs database unavailable")
	}
	return dbx.WithOrgTxOptions(ctx, r.pool, orgID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) (*durableRunDetail, error) {
		var visible bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM agent_runs ar
				LEFT JOIN agent_sessions s ON s.id = ar.session_id AND s.org_id = ar.org_id
				WHERE ar.org_id = $1::uuid AND ar.id = $2::uuid
				  AND ($4::boolean OR ar.initiated_by_actor_id = $3::uuid OR s.user_id = $3::uuid)
			)`, orgID, runID, userID, admin).Scan(&visible); err != nil {
			return nil, err
		}
		if !visible {
			return nil, nil
		}

		var stepCount int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*)
			FROM agent_run_steps
			WHERE org_id = $1::uuid AND run_id = $2::uuid`, orgID, runID).Scan(&stepCount); err != nil {
			return nil, err
		}
		if stepCount > durableRunDetailMaxSteps {
			return nil, errDurableRunDetailTooLarge
		}
		var storedJSONBytes int64
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(sum(
				COALESCE(octet_length(input::text), 0)::bigint
				+ COALESCE(octet_length(output::text), 0)::bigint
			), 0)
			FROM agent_run_steps
			WHERE org_id = $1::uuid AND run_id = $2::uuid`, orgID, runID).Scan(&storedJSONBytes); err != nil {
			return nil, err
		}
		if storedJSONBytes > durableRunDetailMaxBytes {
			return nil, errDurableRunDetailTooLarge
		}
		var detail durableRunDetail
		var createdAt, updatedAt time.Time
		var startedAt, finishedAt *time.Time
		err := tx.QueryRow(ctx, `
			SELECT id::text, org_id::text, session_id::text, goal, status, contract_revision,
			       registry_version, model_ref, harness_composition_id::text, harness_profile_id,
			       harness_profile_version, harness_composition_digest, current_step, last_error,
			       initiated_by_actor_type, initiated_by_actor_id::text, created_at, updated_at,
			       started_at, finished_at
			FROM agent_runs
			WHERE org_id = $1::uuid AND id = $2::uuid`, orgID, runID).Scan(
			&detail.Run.ID, &detail.Run.OrgID, &detail.Run.SessionID, &detail.Run.Goal, &detail.Run.Status,
			&detail.Run.ContractRevision, &detail.Run.RegistryVersion, &detail.Run.ModelRef,
			&detail.Run.HarnessCompositionID, &detail.Run.HarnessProfileID,
			&detail.Run.HarnessProfileVersion, &detail.Run.HarnessCompositionDigest,
			&detail.Run.CurrentStep, &detail.Run.LastError, &detail.Run.InitiatedByActorType,
			&detail.Run.InitiatedByActorID, &createdAt, &updatedAt, &startedAt, &finishedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		detail.Run.CreatedAt = legacySessionTime(createdAt)
		detail.Run.UpdatedAt = legacySessionTime(updatedAt)
		detail.Run.StartedAt = durableRunOptionalTime(startedAt)
		detail.Run.FinishedAt = durableRunOptionalTime(finishedAt)
		rows, err := tx.Query(ctx, `
			SELECT id::text, org_id::text, run_id::text, step_index, kind, status, capability_id,
			       capability_version, input_hash, input, output, receipt_id::text, approval_id::text,
			       error, started_at, finished_at, created_at
			FROM agent_run_steps
			WHERE org_id = $1::uuid AND run_id = $2::uuid
			ORDER BY step_index`, orgID, runID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		detail.Steps = make([]durableRunStepRecord, 0)
		for rows.Next() {
			var step durableRunStepRecord
			var stepCreatedAt time.Time
			var stepStartedAt, stepFinishedAt *time.Time
			if err := rows.Scan(&step.ID, &step.OrgID, &step.RunID, &step.StepIndex, &step.Kind,
				&step.Status, &step.CapabilityID, &step.CapabilityVersion, &step.InputHash,
				&step.Input, &step.Output, &step.ReceiptID, &step.ApprovalID, &step.Error,
				&stepStartedAt, &stepFinishedAt, &stepCreatedAt); err != nil {
				return nil, err
			}
			step.CreatedAt = legacySessionTime(stepCreatedAt)
			step.StartedAt = durableRunOptionalTime(stepStartedAt)
			step.FinishedAt = durableRunOptionalTime(stepFinishedAt)
			detail.Steps = append(detail.Steps, step)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return &detail, nil
	})
}

func durableRunOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := legacySessionTime(*value)
	return &formatted
}

type DurableRunsSessionHandler struct {
	resolver durableRunsSessionResolver
	reader   durableRunsSessionReader
	logger   *slog.Logger
}

func NewDurableRunsSessionHandler(pool *pgxpool.Pool, resolver durableRunsSessionResolver, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &DurableRunsSessionHandler{resolver: resolver, reader: pgDurableRunsSessionReader{pool: pool}, logger: logger}
}

func newDurableRunsSessionHandler(resolver durableRunsSessionResolver, reader durableRunsSessionReader, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &DurableRunsSessionHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *DurableRunsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "durable runs service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	admin := resolved.HasPermission("iam.admin") || resolved.HasPermission("*")

	if r.URL.Path == "/api/durable-runs" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		runs, err := h.reader.ListForUser(r.Context(), *resolved.OrgID, resolved.UserID, admin)
		if err != nil {
			h.logReadFailure("Go durable runs list failed", *resolved.OrgID, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		if runs == nil {
			runs = []durableRunListRow{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	const prefix = "/api/durable-runs/"
	if !strings.HasPrefix(r.URL.Path, prefix) || strings.Contains(strings.TrimPrefix(r.URL.Path, prefix), "/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	runID := strings.TrimPrefix(r.URL.Path, prefix)
	if !isUUID(runID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	detail, err := h.reader.DetailForUser(r.Context(), *resolved.OrgID, runID, resolved.UserID, admin)
	if errors.Is(err, errDurableRunDetailTooLarge) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": errDurableRunDetailTooLarge.Error()})
		return
	}
	if err != nil {
		h.logReadFailure("Go durable run detail failed", *resolved.OrgID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if detail == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if durableRunDetailExceedsResponseBounds(detail) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": errDurableRunDetailTooLarge.Error()})
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func durableRunDetailExceedsResponseBounds(detail *durableRunDetail) bool {
	if detail == nil || len(detail.Steps) > durableRunDetailMaxSteps {
		return detail != nil
	}
	encoded, err := json.Marshal(detail)
	return err != nil || len(encoded)+1 > durableRunDetailMaxBytes
}

func (h *DurableRunsSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func (h *DurableRunsSessionHandler) logReadFailure(message, orgID string, err error) {
	if h.logger != nil {
		h.logger.Error(message, "organizationId", orgID, "error", err)
	}
}
