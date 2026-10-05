package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const notificationReadBodyLimit = 8 << 10

type NotificationReadHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type notificationReadRequest struct {
	ID       string `json:"id"`
	IntentID string `json:"intentId,omitempty"`
}

// NewNotificationReadHandler handles the legacy POST /api/notifications mark-read contract.
func NewNotificationReadHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &NotificationReadHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *NotificationReadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notifications service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, bearer, ok := h.resolve(r, selector)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, notificationReadBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body notificationReadRequest
	if decoder.Decode(&body) != nil || !isUUID(body.ID) || len(body.IntentID) > 200 || strings.ContainsAny(body.IntentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	input, err := json.Marshal(struct {
		ID string `json:"id"`
	}{ID: body.ID})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	inputHash, err := capability.InputHash(input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	actorID := resolved.UserID
	claims := authbridge.CapabilityClaims{
		Audience: "go.capability.execute", Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: "notifications.markRead", InputSHA256: inputHash, ActorID: &actorID,
		ActorType: "human", AuthSessionID: resolved.AuthSessionID, IntentID: body.IntentID,
	}
	result, err := h.executor.Execute(r.Context(), claims, claims.CapabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		default:
			if h.logger != nil {
				h.logger.Error("Go notification read mutation failed", "organizationId", *resolved.OrgID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	var outcome struct {
		Found bool `json:"found"`
	}
	if !json.Valid(result.Data) || json.Unmarshal(result.Data, &outcome) != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !outcome.Found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *NotificationReadHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, bool, bool) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	return resolved, false, err == nil
}
