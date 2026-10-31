package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const manufacturingCollectionMaxBodyBytes = 256 << 10

// manufacturingActionCapabilities mirrors the legacy POST switch exactly:
// reverseProductionRun renames runId to runRef, everything else forwards the
// remaining body. The legacy route has no restoreBom case.
var manufacturingActionCapabilities = map[string]string{
	"defineBom":                  "manufacturing.defineBom",
	"deleteBom":                  "manufacturing.deleteBom",
	"bomReport":                  "manufacturing.bomReport",
	"bomTree":                    "manufacturing.bomTree",
	"checkProductionFeasibility": "manufacturing.checkProductionFeasibility",
	"costPreview":                "manufacturing.costPreview",
	"produceFromBom":             "manufacturing.produceFromBom",
	"reverseProductionRun":       "manufacturing.reverseProductionRun",
	"createWorkOrder":            "manufacturing.createWorkOrder",
	"releaseWorkOrder":           "manufacturing.releaseWorkOrder",
	"completeWorkOrder":          "manufacturing.completeWorkOrder",
	"cancelWorkOrder":            "manufacturing.cancelWorkOrder",
}

// ManufacturingCollectionHandler serves GET and POST /api/manufacturing:
// the overview and lot-trace reads, plus the legacy manufacturing action
// union, all through the governed capability executor.
type ManufacturingCollectionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

// NewManufacturingCollectionHandler builds the Go manufacturing surface for
// /api/manufacturing.
func NewManufacturingCollectionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &ManufacturingCollectionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *ManufacturingCollectionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	switch r.Method {
	case http.MethodGet, http.MethodPost:
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "manufacturing unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		strings.TrimSpace(resolved.AuthSessionID) == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "manufacturing") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if r.Method == http.MethodGet {
		h.handleRead(w, r, resolved)
		return
	}
	h.handleAction(w, r, resolved)
}

func (h *ManufacturingCollectionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func (h *ManufacturingCollectionHandler) handleRead(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "manufacturing unavailable"})
		return
	}
	query := r.URL.Query()
	sku := query.Get("sku")
	lotCode := query.Get("lotCode")
	if sku != "" && lotCode != "" {
		input, err := json.Marshal(map[string]string{"sku": sku, "lotCode": lotCode})
		if err != nil {
			h.logFailure("encode manufacturing lot trace", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		h.execute(w, r, resolved, "manufacturing.lotTrace", "", input, true)
		return
	}
	h.execute(w, r, resolved, "manufacturing.overviewReport", "", json.RawMessage(`{}`), false)
}

func (h *ManufacturingCollectionHandler) handleAction(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return
	}
	fields, ok := readManufacturingCollectionFields(w, r)
	if !ok {
		return
	}
	var action string
	if raw, exists := fields["action"]; exists {
		if json.Unmarshal(raw, &action) != nil {
			action = ""
		}
	}
	capabilityID, supported := manufacturingActionCapabilities[action]
	if !supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
		return
	}
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "manufacturing unavailable"})
		return
	}
	delete(fields, "action")
	intentID := manufacturingIntentField(fields)
	input := manufacturingActionInput(action, fields)
	h.execute(w, r, resolved, capabilityID, intentID, input, true)
}

func (h *ManufacturingCollectionHandler) execute(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage, envelope bool) {
	claims := manufacturingCollectionClaims(resolved, capabilityID, intentID, input)
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		h.writeExecutionError(w, capabilityID, err, envelope)
		return
	}
	if result.PendingApproval {
		payload := map[string]any{"ok": false, "pendingApproval": true}
		if result.Error != "" {
			payload["reason"] = result.Error
		}
		writeJSON(w, http.StatusAccepted, payload)
		return
	}
	if !result.OK {
		switch {
		case strings.HasPrefix(result.Error, "forbidden:"):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": result.Error})
		case strings.Contains(result.Error, "is disabled for this organization"):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		default:
			manufacturingWriteRefusal(w, result.Error, envelope)
		}
		return
	}
	if !json.Valid(result.Data) {
		h.logFailure("execute "+capabilityID, errors.New("capability returned invalid JSON"))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if envelope {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func (h *ManufacturingCollectionHandler) writeExecutionError(w http.ResponseWriter, capabilityID string, err error, envelope bool) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	default:
		if message, refusal := manufacturingRefusalMessage(err); refusal {
			manufacturingWriteRefusal(w, message, envelope)
			return
		}
		h.logFailure("execute "+capabilityID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

// manufacturingRefusalMessage recognises expected workflow refusals:
// typed ones as ManufacturingDomainError, plus the legacy read helpers that
// returned plain errors but were surfaced to the client as 422 refusals.
func manufacturingRefusalMessage(err error) (string, bool) {
	var domainError capability.ManufacturingDomainError
	if errors.As(err, &domainError) {
		return domainError.Error(), true
	}
	message := err.Error()
	switch {
	case strings.HasPrefix(message, "no item with SKU "), strings.HasPrefix(message, "no item with sku "):
		return message, true
	case strings.HasPrefix(message, "no lot "):
		return message, true
	case strings.HasSuffix(message, "has no bill of materials"), strings.HasSuffix(message, "has no bill of materials; nothing to explode"):
		return message, true
	}
	return "", false
}

func manufacturingWriteRefusal(w http.ResponseWriter, message string, envelope bool) {
	if envelope {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": message})
		return
	}
	writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": message})
}

func (h *ManufacturingCollectionHandler) logFailure(operation string, err error) {
	if h.logger != nil {
		h.logger.Error("Go manufacturing request failed", "operation", operation, "error", err)
	}
}

func readManufacturingCollectionFields(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	if r.Body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, manufacturingCollectionMaxBodyBytes)
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	return fields, true
}

// manufacturingIntentField mirrors the legacy guard: only a string intentId
// reaches the claims; anything else is ignored. The field is always removed
// so it never lands in the capability input.
func manufacturingIntentField(fields map[string]json.RawMessage) string {
	raw, exists := fields["intentId"]
	if !exists {
		return ""
	}
	delete(fields, "intentId")
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return ""
	}
	var intentID string
	if json.Unmarshal(raw, &intentID) != nil {
		return ""
	}
	intentID = strings.TrimSpace(intentID)
	if len(intentID) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		return ""
	}
	return intentID
}

func manufacturingActionInput(action string, fields map[string]json.RawMessage) json.RawMessage {
	if action == "reverseProductionRun" {
		value, ok := fields["runId"]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			value, ok = fields["runRef"]
		}
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return json.RawMessage(`{}`)
		}
		encoded, _ := json.Marshal(map[string]json.RawMessage{"runRef": value})
		return encoded
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func manufacturingCollectionClaims(resolved *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
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

// MountGoManufacturingCollectionRoute owns GET and POST /api/manufacturing.
func MountGoManufacturingCollectionRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/manufacturing", route)
	mux.Handle("POST /api/manufacturing", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
