package httpapi

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

var purchasingPaymentRunActions = map[string]purchasingRouteAction{
	"create":   {capabilityID: "purchasing.createPaymentRun", fields: []string{"memo", "lines"}, optional: []string{"memo"}, write: true},
	"instruct": {capabilityID: "purchasing.instructPaymentRun", fields: []string{"paymentRunId"}, write: true},
	"cancel":   {capabilityID: "purchasing.cancelPaymentRunDraft", fields: []string{"paymentRunId"}, write: true},
	"restore":  {capabilityID: "purchasing.restorePaymentRunDraft", fields: []string{"paymentRunId"}, write: true},
	"reverse":  {capabilityID: "purchasing.reversePaymentRun", fields: []string{"paymentRunId", "reason"}, write: true},
}

type PurchasingPaymentRunsSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

// NewPurchasingPaymentRunsSessionHandler exposes the supplier payment run
// workspace read and its draft/instruct/reverse actions through the governed
// capability executor.
func NewPurchasingPaymentRunsSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &PurchasingPaymentRunsSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *PurchasingPaymentRunsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "purchasing service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, h.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Method == http.MethodPost && strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.read(w, r, resolved)
		return
	}
	h.write(w, r, resolved)
}

func (h *PurchasingPaymentRunsSessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	result, err := purchasingRouteExecute(r.Context(), h.executor, resolved, "purchasing.listPaymentRuns", json.RawMessage(`{}`), "")
	if purchasingRouteWriteError(w, h.logger, "purchasing.listPaymentRuns", result, err) {
		return
	}
	var output capability.ListPaymentRunsOutput
	if !json.Valid(result.Data) || json.Unmarshal(result.Data, &output) != nil || output.Runs == nil {
		purchasingRouteLogInvalidOutput(h.logger, "purchasing.listPaymentRuns")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": output})
}

func (h *PurchasingPaymentRunsSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	fields, ok := purchasingRouteDecodeBody(w, r)
	if !ok {
		return
	}
	action, actionOK := purchasingJSONString(fields["action"])
	if !actionOK {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	definition, found := purchasingPaymentRunActions[action]
	if !found {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, intentOK := purchasingRouteIntentID(fields, definition.write)
	if !intentOK {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if !purchasingRouteFieldsAllowed(fields, definition) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	input, err := purchasingRouteBuildInput(fields, definition)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if _, err := purchasingRouteParse(definition.capabilityID, input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := purchasingRouteExecute(r.Context(), h.executor, resolved, definition.capabilityID, input, intentID)
	if purchasingRouteWriteError(w, h.logger, definition.capabilityID, result, err) {
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
}

// MountGoPurchasingPaymentRunsRoute owns GET/POST /api/purchasing/payment-runs.
func MountGoPurchasingPaymentRunsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/purchasing/payment-runs", route)
	mux.Handle("POST /api/purchasing/payment-runs", route)
	if base != nil {
		mux.Handle("HEAD /api/purchasing/payment-runs", base)
		mux.Handle("/", base)
	}
	return mux
}
