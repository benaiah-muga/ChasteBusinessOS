package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	businesscontract "github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract/business"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type dashboardSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type dashboardReader interface {
	ForOrg(context.Context, string, time.Time, dashboard.ReportReadAccess) (dashboard.Payload, error)
}

type DashboardSessionHandler struct {
	resolver dashboardSessionResolver
	reader   dashboardReader
	executor CapabilityExecutor
	logger   *slog.Logger
	now      func() time.Time
}

// NewDashboardSessionHandler serves the authenticated dashboard snapshot from
// the tenant-scoped Go read model and preserves the legacy report fallbacks.
func NewDashboardSessionHandler(resolver dashboardSessionResolver, reader dashboardReader, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &DashboardSessionHandler{resolver: resolver, reader: reader, executor: executor, logger: logger, now: time.Now}
}

func (h *DashboardSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "dashboard service unavailable"})
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

	claimsInput := json.RawMessage(`{}`)
	access := dashboard.ReportReadAccess{
		IncomeStatement: h.reportAllowed(r, resolved, "accounting.incomeStatement", claimsInput),
		BalanceSheet:    h.reportAllowed(r, resolved, "accounting.balanceSheet", claimsInput),
		TrialBalance:    h.reportAllowed(r, resolved, "accounting.trialBalance", claimsInput),
	}

	now := time.Now
	if h.now != nil {
		now = h.now
	}
	payload, err := h.reader.ForOrg(r.Context(), *resolved.OrgID, now().UTC(), access)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go dashboard read failed", "organizationId", *resolved.OrgID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	response := struct {
		dashboard.Payload
		Signals []json.RawMessage `json:"signals"`
	}{Payload: payload, Signals: h.dashboardSignals(r, resolved, claimsInput)}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	var contract businesscontract.DashboardResponse
	if err := json.Unmarshal(encoded, &contract); err != nil {
		if h.logger != nil {
			h.logger.Error("Go dashboard response did not match the generated API contract", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, contract)
}

func (h *DashboardSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func (h *DashboardSessionHandler) reportAllowed(r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) bool {
	result, err := h.execute(r, resolved, capabilityID, input)
	return err == nil && result.OK && len(result.Data) > 0 && string(result.Data) != "null"
}

func (h *DashboardSessionHandler) dashboardSignals(r *http.Request, resolved *session.ResolvedUser, input json.RawMessage) []json.RawMessage {
	result, err := h.execute(r, resolved, "signals.list", input)
	if err != nil || !result.OK || len(result.Data) == 0 || string(result.Data) == "null" {
		return []json.RawMessage{}
	}
	var output struct {
		Signals []json.RawMessage `json:"signals"`
	}
	if json.Unmarshal(result.Data, &output) != nil || output.Signals == nil {
		return []json.RawMessage{}
	}
	if len(output.Signals) > 8 {
		output.Signals = output.Signals[:8]
	}
	for _, signal := range output.Signals {
		if !dashboardSignalDraftIsObject(signal) {
			return []json.RawMessage{}
		}
	}
	return output.Signals
}

func dashboardSignalDraftIsObject(raw json.RawMessage) bool {
	var signal map[string]json.RawMessage
	if err := json.Unmarshal(raw, &signal); err != nil || signal == nil {
		return false
	}
	actionRaw, ok := signal["suggestedAction"]
	if !ok || strings.TrimSpace(string(actionRaw)) == "null" {
		return true
	}
	var action map[string]json.RawMessage
	if err := json.Unmarshal(actionRaw, &action); err != nil || action == nil {
		return false
	}
	draft, ok := action["inputDraft"]
	if !ok {
		return true
	}
	draft = json.RawMessage(strings.TrimSpace(string(draft)))
	return len(draft) > 0 && draft[0] == '{'
}

func (h *DashboardSessionHandler) execute(r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) (capability.Result, error) {
	claims := analyticsSessionClaims(resolved, capabilityID, input)
	claims.Audience = authbridge.CapabilityExecuteAudience
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) && h.logger != nil {
		h.logger.Warn("dashboard capability read failed", "capabilityId", capabilityID, "error", err)
	}
	return result, err
}
