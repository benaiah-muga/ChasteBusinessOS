package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const sessionRevertBodyLimit = 4 << 10

type sessionRevertResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type SessionRevertHandler struct {
	resolver          sessionRevertResolver
	executor          CapabilityExecutor
	pool              *pgxpool.Pool
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewSessionRevertHandler(pool *pgxpool.Pool, resolver sessionRevertResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...*net.IPNet) http.Handler {
	return &SessionRevertHandler{resolver: resolver, executor: executor, pool: pool, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs}
}

type sessionRevertRequest struct {
	CallID string `json:"callId,omitempty"`
	TurnID string `json:"turnId,omitempty"`
}

type sessionRevertPlan struct {
	CallID       string
	CapabilityID string
	InverseID    string
	Input        json.RawMessage
}

func (h *SessionRevertHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil || h.pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "revert service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, bearer, ok := resolveSessionRevertUser(r, selector, h.resolver)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return
	}
	sessionID, valid := parseSessionRevertPath(r.URL.Path)
	if !valid {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, sessionRevertBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body sessionRevertRequest
	if decoder.Decode(&body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if (body.CallID == "" && body.TurnID == "") || (body.CallID != "" && body.TurnID != "") ||
		len(body.CallID) > 200 || len(body.TurnID) > 200 ||
		strings.ContainsAny(body.CallID+body.TurnID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "exactly one of callId or turnId is required"})
		return
	}

	plans, err := h.loadRevertPlans(r.Context(), *resolved.OrgID, resolved.UserID, sessionID, body)
	if err != nil {
		h.writeRevertError(w, sessionID, err)
		return
	}
	if body.TurnID == "" {
		result := h.executeRevertPlan(r.Context(), resolved, sessionID, plans[0])
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": result.OK, "inverseCapabilityId": plans[0].InverseID, "data": result.Data,
			"error": result.Error, "pendingApproval": result.PendingApproval,
			"approvalId": result.ApprovalID, "approvalRationale": result.ApprovalRationale,
		})
		return
	}

	outcomes := make([]map[string]any, 0, len(plans))
	for index := len(plans) - 1; index >= 0; index-- {
		plan := plans[index]
		result := h.executeRevertPlan(r.Context(), resolved, sessionID, plan)
		outcomes = append(outcomes, map[string]any{
			"callId": plan.CallID, "inverseCapabilityId": plan.InverseID,
			"ok": result.OK, "error": result.Error,
			"pendingApproval": result.PendingApproval, "approvalId": result.ApprovalID,
		})
		if result.PendingApproval || !result.OK {
			break
		}
	}
	allOK := true
	for _, outcome := range outcomes {
		if outcome["ok"] != true || outcome["pendingApproval"] == true {
			allOK = false
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"turnId": body.TurnID, "ok": allOK, "planCount": len(plans),
		"reverted": outcomes,
	})
}

func (h *SessionRevertHandler) loadRevertPlans(ctx context.Context, orgID, userID, sessionID string, body sessionRevertRequest) ([]sessionRevertPlan, error) {
	var plans []sessionRevertPlan
	_, err := dbx.WithOrgTx(ctx, h.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		var owned bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid)`, sessionID, orgID, userID).Scan(&owned); err != nil {
			return struct{}{}, err
		}
		if !owned {
			return struct{}{}, errSessionRevertNotFound
		}
		query := `SELECT content FROM session_events WHERE session_id=$1::uuid AND role='tool_result' AND content->>'ok'='true' AND content->>'callId'=$2 ORDER BY seq DESC LIMIT 1`
		arg := body.CallID
		if body.TurnID != "" {
			query = `SELECT content FROM session_events WHERE session_id=$1::uuid AND role='tool_result' AND content->>'ok'='true' AND content->>'turnId'=$2 ORDER BY seq ASC`
			arg = body.TurnID
		}
		rows, err := tx.Query(ctx, query, sessionID, arg)
		if err != nil {
			return struct{}{}, err
		}
		defer rows.Close()
		var unsupported []string
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				return struct{}{}, err
			}
			var content map[string]any
			if json.Unmarshal(raw, &content) != nil {
				continue
			}
			capabilityID, _ := content["capabilityId"].(string)
			callID, _ := content["callId"].(string)
			if capabilityID == "" || callID == "" {
				continue
			}
			risk, known := capability.CapabilityRisk(capabilityID)
			if !known {
				continue
			}
			if risk == "read" {
				continue
			}
			resultText, _ := content["result"].(string)
			plan, ok := capability.PlanInverse(capabilityID, json.RawMessage(resultText))
			if !ok {
				unsupported = append(unsupported, capabilityID)
				continue
			}
			plans = append(plans, sessionRevertPlan{CallID: callID, CapabilityID: capabilityID, InverseID: plan.CapabilityID, Input: plan.Input})
		}
		if err := rows.Err(); err != nil {
			return struct{}{}, err
		}
		if len(unsupported) > 0 {
			return struct{}{}, &unsupportedRevertError{capabilities: unsupported}
		}
		if len(plans) == 0 {
			if body.TurnID != "" {
				return struct{}{}, errSessionRevertNoWrites
			}
			return struct{}{}, errSessionRevertActionNotFound
		}
		return struct{}{}, nil
	})
	return plans, err
}

func (h *SessionRevertHandler) executeRevertPlan(ctx context.Context, resolved *session.ResolvedUser, sessionID string, plan sessionRevertPlan) capability.Result {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	inputHash, err := capability.InputHash(plan.Input)
	if err != nil {
		return capability.Result{Error: "the saved action could not be prepared for reversal"}
	}
	now := time.Now().UTC()
	actorID := resolved.UserID
	claims := authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: plan.InverseID, InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID,
		IntentID:      deterministicMessagingUUID("session-revert:" + sessionID + ":" + plan.CallID),
		IssuedAt:      now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	result, err := h.executor.Execute(ctx, claims, plan.InverseID, plan.Input)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go session revert execution failed", "sessionId", sessionID, "callId", plan.CallID, "error", err)
		}
		return capability.Result{Error: "revert failed"}
	}
	return result
}

func (h *SessionRevertHandler) writeRevertError(w http.ResponseWriter, sessionID string, err error) {
	var unsupported *unsupportedRevertError
	switch {
	case errors.Is(err, errSessionRevertNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
	case errors.Is(err, errSessionRevertActionNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "action not found"})
	case errors.Is(err, errSessionRevertNoWrites):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "this turn has no reversible state changes"})
	case errors.As(err, &unsupported):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "this turn contains actions with no safe automatic reversal", "capabilities": unsupported.capabilities})
	default:
		if h.logger != nil {
			h.logger.Error("Go session revert failed", "sessionId", sessionID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "revert failed"})
	}
}

var (
	errSessionRevertNotFound       = errors.New("session not found")
	errSessionRevertActionNotFound = errors.New("action not found")
	errSessionRevertNoWrites       = errors.New("no reversible actions")
)

type unsupportedRevertError struct{ capabilities []string }

func (e *unsupportedRevertError) Error() string {
	return "unsupported reversal for " + strings.Join(e.capabilities, ", ")
}

func parseSessionRevertPath(path string) (string, bool) {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, "/revert") {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(path, prefix), "/revert")
	return id, isUUID(id)
}

func resolveSessionRevertUser(r *http.Request, selector string, resolver sessionRevertResolver) (*session.ResolvedUser, bool, bool) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, false
		}
		resolved, err := resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return resolved, true, err == nil
	}
	resolved, err := resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	return resolved, false, err == nil
}
