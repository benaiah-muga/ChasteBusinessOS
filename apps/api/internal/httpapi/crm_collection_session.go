package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const crmCollectionMaxBodyBytes = 256 << 10

type crmCollectionAction struct {
	capabilityID  string
	durableIntent bool
}

var crmLeadAndTaskActions = map[string]crmCollectionAction{
	"convertLead":       {capabilityID: "crm.convertLead", durableIntent: true},
	"createTask":        {capabilityID: "crm.createTask"},
	"completeTask":      {capabilityID: "crm.completeTask"},
	"updateTaskDetails": {capabilityID: "crm.updateTaskDetails"},
}

var crmCustomerActions = map[string]crmCollectionAction{
	"create":        {capabilityID: "crm.createCustomer"},
	"deactivate":    {capabilityID: "crm.deactivateCustomer"},
	"merge":         {capabilityID: "crm.mergeCustomers", durableIntent: true},
	"undoMerge":     {capabilityID: "crm.restoreCustomerMerge"},
	"updateProfile": {capabilityID: "crm.updateCustomerProfiles"},
}

var crmDealActions = map[string]crmCollectionAction{
	"create": {capabilityID: "crm.createDeal"},
	"move":   {capabilityID: "crm.moveDealStage"},
}

// CRMCollectionSessionHandler serves the legacy CRM collection writes
// (POST /api/crm, POST /api/customers, POST /api/deals, GET+POST
// /api/crm/views) through the governed capability executor.
type CRMCollectionSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	followUpDraft     http.Handler
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewCRMCollectionSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	return NewCRMCollectionSessionHandlerWithFollowUpDraft(resolver, executor, nil, logger, trustedProxyCIDRs...)
}

func NewCRMCollectionSessionHandlerWithFollowUpDraft(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, followUpDraft http.Handler, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &CRMCollectionSessionHandler{
		resolver: resolver, executor: executor, followUpDraft: followUpDraft, logger: logger, trustedProxyCIDRs: trusted,
	}
}

func (h *CRMCollectionSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/api/crm":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		h.handleLeadAndTaskAction(w, r)
	case "/api/crm/views":
		switch r.Method {
		case http.MethodGet:
			h.handleCustomerViews(w, r)
		case http.MethodPost:
			h.handleSaveCustomerView(w, r)
		default:
			writeMethodNotAllowed(w, http.MethodGet, http.MethodPost)
		}
	case "/api/customers":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		h.handleCustomerAction(w, r)
	case "/api/deals":
		switch r.Method {
		case http.MethodGet:
			h.handleDeals(w, r)
		case http.MethodPost:
			h.handleDealAction(w, r)
		default:
			writeMethodNotAllowed(w, http.MethodGet, http.MethodPost)
		}
	default:
		http.NotFound(w, r)
	}
}

func writeMethodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

func (h *CRMCollectionSessionHandler) handleLeadAndTaskAction(w http.ResponseWriter, r *http.Request) {
	resolved, ok := h.authorizeWrite(w, r)
	if !ok {
		return
	}
	action, input, intentID, ok := crmCollectionActionInput(w, r)
	if !ok {
		return
	}
	if action == "draftFollowUp" {
		h.delegateFollowUpDraft(w, r, input)
		return
	}
	mapped, supported := crmLeadAndTaskActions[action]
	if !supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, ok = crmCollectionIntentID(w, intentID, mapped.durableIntent)
	if !ok {
		return
	}
	h.executeWrite(w, r, resolved, mapped.capabilityID, intentID, input, writeCRMActionResult)
}

func (h *CRMCollectionSessionHandler) handleCustomerViews(w http.ResponseWriter, r *http.Request) {
	resolved, ok := h.authorizeRead(w, r)
	if !ok {
		return
	}
	h.executeRead(w, r, resolved, "crm.listCustomerViews", json.RawMessage(`{}`))
}

func (h *CRMCollectionSessionHandler) handleSaveCustomerView(w http.ResponseWriter, r *http.Request) {
	resolved, ok := h.authorizeWrite(w, r)
	if !ok {
		return
	}
	input, intentID, ok := crmCollectionViewInput(w, r)
	if !ok {
		return
	}
	h.executeWrite(w, r, resolved, "crm.saveCustomerView", intentID, input, writeViewSaveResult)
}

func (h *CRMCollectionSessionHandler) handleCustomerAction(w http.ResponseWriter, r *http.Request) {
	resolved, ok := h.authorizeWrite(w, r)
	if !ok {
		return
	}
	action, input, intentID, ok := crmCollectionActionInput(w, r)
	if !ok {
		return
	}
	mapped, supported := crmCustomerActions[action]
	if !supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, ok = crmCollectionIntentID(w, intentID, mapped.durableIntent)
	if !ok {
		return
	}
	h.executeWrite(w, r, resolved, mapped.capabilityID, intentID, input, writeCRMActionResult)
}

func (h *CRMCollectionSessionHandler) handleDeals(w http.ResponseWriter, r *http.Request) {
	resolved, ok := h.authorizeRead(w, r)
	if !ok {
		return
	}
	h.executeRead(w, r, resolved, "crm.listDeals", json.RawMessage(`{}`))
}

func (h *CRMCollectionSessionHandler) handleDealAction(w http.ResponseWriter, r *http.Request) {
	resolved, ok := h.authorizeWrite(w, r)
	if !ok {
		return
	}
	action, input, intentID, ok := crmCollectionActionInput(w, r)
	if !ok {
		return
	}
	mapped, supported := crmDealActions[action]
	if !supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, ok = crmCollectionIntentID(w, intentID, mapped.durableIntent)
	if !ok {
		return
	}
	h.executeWrite(w, r, resolved, mapped.capabilityID, intentID, input, writeCRMActionResult)
}

func (h *CRMCollectionSessionHandler) delegateFollowUpDraft(w http.ResponseWriter, r *http.Request, input json.RawMessage) {
	if h.followUpDraft == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CRM drafting unavailable"})
		return
	}
	clone := r.Clone(r.Context())
	clone.Body = io.NopCloser(bytes.NewReader(input))
	clone.ContentLength = int64(len(input))
	clone.Header = r.Header.Clone()
	h.followUpDraft.ServeHTTP(w, clone)
}

func (h *CRMCollectionSessionHandler) executeWrite(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage, write func(http.ResponseWriter, capability.Result)) {
	result, err := h.executor.Execute(r.Context(), crmCollectionClaims(resolved, capabilityID, intentID, input), capabilityID, input)
	if err != nil {
		h.writeExecuteError(w, capabilityID, err)
		return
	}
	write(w, result)
}

func (h *CRMCollectionSessionHandler) handleReadExecuteError(w http.ResponseWriter, capabilityID string, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	default:
		if status, ok := capabilityErrorStatus(err); ok {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		if h.logger != nil {
			h.logger.Error("Go CRM collection read failed", "capabilityId", capabilityID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func (h *CRMCollectionSessionHandler) writeExecuteError(w http.ResponseWriter, capabilityID string, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	default:
		if status, ok := capabilityErrorStatus(err); ok {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		if h.logger != nil {
			h.logger.Error("Go CRM collection write failed", "capabilityId", capabilityID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func (h *CRMCollectionSessionHandler) executeRead(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) {
	result, err := h.executor.Execute(r.Context(), crmCollectionClaims(resolved, capabilityID, "", input), capabilityID, input)
	if err != nil {
		h.handleReadExecuteError(w, capabilityID, err)
		return
	}
	if !result.OK {
		status := http.StatusUnprocessableEntity
		if strings.HasPrefix(strings.ToLower(result.Error), "forbidden") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		if h.logger != nil {
			h.logger.Error("Go CRM collection read returned invalid JSON", "capabilityId", capabilityID)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func writeCRMActionResult(w http.ResponseWriter, result capability.Result) {
	switch {
	case result.PendingApproval:
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
	case !result.OK:
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
	case !json.Valid(result.Data):
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
	}
}

func writeViewSaveResult(w http.ResponseWriter, result capability.Result) {
	switch {
	case result.PendingApproval:
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"pendingApproval": true, "error": reason})
	case !result.OK:
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
	case !json.Valid(result.Data):
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
	}
}

func crmCollectionActionInput(w http.ResponseWriter, r *http.Request) (string, json.RawMessage, string, bool) {
	fields, ok := readCRMCollectionFields(w, r)
	if !ok {
		return "", nil, "", false
	}
	rawAction, exists := fields["action"]
	if !exists {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", nil, "", false
	}
	var action string
	if json.Unmarshal(rawAction, &action) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", nil, "", false
	}
	action = strings.TrimSpace(action)
	if action == "" || utf8.RuneCountInString(action) > 40 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", nil, "", false
	}
	delete(fields, "action")
	intentID, ok := crmCollectionIntentField(w, fields)
	if !ok {
		return "", nil, "", false
	}
	input, err := json.Marshal(fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", nil, "", false
	}
	return action, input, intentID, true
}

func crmCollectionViewInput(w http.ResponseWriter, r *http.Request) (json.RawMessage, string, bool) {
	fields, ok := readCRMCollectionFields(w, r)
	if !ok {
		return nil, "", false
	}
	intentID, ok := crmCollectionIntentField(w, fields)
	if !ok {
		return nil, "", false
	}
	input, err := json.Marshal(fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, "", false
	}
	return input, intentID, true
}

func readCRMCollectionFields(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, crmCollectionMaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil || !utf8.Valid(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	return fields, true
}

func crmCollectionIntentField(w http.ResponseWriter, fields map[string]json.RawMessage) (string, bool) {
	rawIntent, exists := fields["intentId"]
	if !exists {
		return "", true
	}
	var intentID string
	if json.Unmarshal(rawIntent, &intentID) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	intentID = strings.TrimSpace(intentID)
	if utf8.RuneCountInString(intentID) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	delete(fields, "intentId")
	return intentID, true
}

// crmCollectionIntentID supplies a fresh v4 intent for actions that the
// kernel records against a durable receipt when the caller did not send one.
func crmCollectionIntentID(w http.ResponseWriter, intentID string, required bool) (string, bool) {
	if intentID != "" || !required {
		return intentID, true
	}
	generated, err := newCRMCollectionIntentID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return "", false
	}
	return generated, true
}

func newCRMCollectionIntentID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

func crmCollectionClaims(resolved *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID, ActorType: "human",
		Permissions: permissions, AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func (h *CRMCollectionSessionHandler) authorizeWrite(w http.ResponseWriter, r *http.Request) (*session.ResolvedUser, bool) {
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CRM service unavailable"})
		return nil, false
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return nil, false
	}
	resolved, bearer, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		strings.TrimSpace(resolved.AuthSessionID) == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, false
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return nil, false
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return nil, false
	}
	return resolved, true
}

func (h *CRMCollectionSessionHandler) authorizeRead(w http.ResponseWriter, r *http.Request) (*session.ResolvedUser, bool) {
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CRM service unavailable"})
		return nil, false
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return nil, false
	}
	resolved, _, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		strings.TrimSpace(resolved.AuthSessionID) == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, false
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return nil, false
	}
	if !resolved.HasPermission("crm.read") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing crm.read"})
		return nil, false
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "crm") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "CRM module is disabled"})
		return nil, false
	}
	return resolved, true
}

func (h *CRMCollectionSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, bool, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return resolved, true, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	return resolved, false, err
}

// MountGoCRMCollectionRoute owns the CRM collection writes plus the deals and
// saved views collections. Reads of GET /api/crm and GET /api/customers stay
// with their existing mount.
func MountGoCRMCollectionRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/crm", route)
	mux.Handle("GET /api/crm/views", route)
	mux.Handle("POST /api/crm/views", route)
	mux.Handle("POST /api/customers", route)
	mux.Handle("GET /api/deals", route)
	mux.Handle("POST /api/deals", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
