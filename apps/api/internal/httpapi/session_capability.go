package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const sessionCapabilityBodyLimit = 64 << 10

const (
	inventoryImportRateLimit      = 40
	inventoryImportRateWindow     = time.Hour
	inventoryImportRateMaxBuckets = 50_000
)

type DirectCapabilitySessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type SessionCapabilityHandler struct {
	resolver             DirectCapabilitySessionResolver
	executor             CapabilityExecutor
	logger               *slog.Logger
	trustedProxyCIDRs    []*net.IPNet
	disabledCapabilities map[string]struct{}
	inventoryImportLimit *inventoryImportRateLimiter
}

// The legacy import route also keeps its quota in process memory. This limiter
// intentionally resets when this API process restarts and counts independently
// on each replica.
type inventoryImportRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]inventoryImportRateWindowState
	now     func() time.Time
}

type inventoryImportRateWindowState struct {
	start time.Time
	count int
}

func newInventoryImportRateLimiter(now func() time.Time) *inventoryImportRateLimiter {
	if now == nil {
		now = time.Now
	}
	return &inventoryImportRateLimiter{buckets: make(map[string]inventoryImportRateWindowState), now: now}
}

func (limiter *inventoryImportRateLimiter) allow(orgID string) (bool, time.Duration) {
	if limiter == nil || orgID == "" {
		return false, inventoryImportRateWindow
	}
	now := limiter.now()
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	if len(limiter.buckets) > inventoryImportRateMaxBuckets {
		for key, bucket := range limiter.buckets {
			if !now.Before(bucket.start.Add(inventoryImportRateWindow)) {
				delete(limiter.buckets, key)
			}
			if len(limiter.buckets) <= inventoryImportRateMaxBuckets/2 {
				break
			}
		}
	}

	bucket, exists := limiter.buckets[orgID]
	if !exists || !now.Before(bucket.start.Add(inventoryImportRateWindow)) {
		limiter.buckets[orgID] = inventoryImportRateWindowState{start: now, count: 1}
		return true, 0
	}
	if bucket.count >= inventoryImportRateLimit {
		return false, bucket.start.Add(inventoryImportRateWindow).Sub(now)
	}
	bucket.count++
	limiter.buckets[orgID] = bucket
	return true, 0
}

func isInventoryImportCapability(capabilityID string) bool {
	return capabilityID == "inventory.importItems" || capabilityID == "inventory.undoItemImport"
}

type sessionCapabilityInput struct {
	CapabilityID string          `json:"capabilityId"`
	Input        json.RawMessage `json:"input"`
	IntentID     string          `json:"intentId"`
}

// NewSessionCapabilityHandler exposes the governed executor directly to
// authenticated clients. Identity and permissions are resolved from the
// Better Auth session on every request, never from caller-supplied claims.
func NewSessionCapabilityHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	return NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, logger, nil, trustedProxyCIDRs...)
}

func NewSessionCapabilityHandlerWithDisabledCapabilities(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, disabledCapabilities map[string]struct{}, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &SessionCapabilityHandler{
		resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted,
		disabledCapabilities: disabledCapabilities, inventoryImportLimit: newInventoryImportRateLimiter(nil),
	}
}

func (h *SessionCapabilityHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "capability execution unavailable"})
		return
	}

	resolved, bearer, ok := h.resolve(r)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, sessionCapabilityBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body sessionCapabilityInput
	if decoder.Decode(&body) != nil || body.CapabilityID == "" || len(body.CapabilityID) > 200 || len(body.Input) == 0 || !json.Valid(body.Input) || len(body.IntentID) > 200 || strings.ContainsAny(body.IntentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if _, disabled := h.disabledCapabilities[body.CapabilityID]; disabled {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "capability is disabled on this Go route"})
		return
	}
	if isInventoryImportCapability(body.CapabilityID) {
		if !resolved.HasPermission("inventory.write") && !resolved.HasPermission("*") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var parseErr error
		switch body.CapabilityID {
		case "inventory.importItems":
			_, parseErr = capability.ParseInventoryImportItemsInput(body.Input)
		case "inventory.undoItemImport":
			_, parseErr = capability.ParseInventoryUndoItemImportInput(body.Input)
		}
		if parseErr != nil {
			writeJSON(w, http.StatusUnprocessableEntity, capability.Result{OK: false, Error: parseErr.Error()})
			return
		}
		allowed, retryAfter := h.inventoryImportLimit.allow(*resolved.OrgID)
		if !allowed {
			retryAfterSeconds := int64((retryAfter + time.Second - 1) / time.Second)
			if retryAfterSeconds < 1 {
				retryAfterSeconds = 1
			}
			w.Header().Set("Retry-After", strconv.FormatInt(retryAfterSeconds, 10))
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "import limit reached; try again later"})
			return
		}
	}
	inputHash, err := capability.InputHash(body.Input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := resolved.UserID
	now := time.Now().UTC()
	claims := authbridge.CapabilityClaims{
		Audience:       "go.capability.execute",
		Subject:        resolved.UserID,
		OrganizationID: *resolved.OrgID,
		CapabilityID:   body.CapabilityID,
		InputSHA256:    inputHash,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    permissions,
		AuthSessionID:  resolved.AuthSessionID,
		IntentID:       body.IntentID,
		IssuedAt:       now.Unix(),
		ExpiresAt:      now.Add(30 * time.Second).Unix(),
	}
	result, err := h.executor.Execute(r.Context(), claims, body.CapabilityID, body.Input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go direct capability execution failed", "capabilityId", body.CapabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, struct {
			OK              bool   `json:"ok"`
			PendingApproval bool   `json:"pendingApproval"`
			Reason          string `json:"reason"`
			ApprovalID      string `json:"approvalId,omitempty"`
		}{OK: false, PendingApproval: true, Reason: reason, ApprovalID: result.ApprovalID})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, result)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

func (h *SessionCapabilityHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, false
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(
		r.Context(),
		session.CookieFromRequest(r, session.SessionCookieName),
		activeOrg,
	)
	return resolved, false, err == nil
}

// activeOrganizationSelector supports native clients without cookies. The
// session resolver still checks the requested organization against membership.
func activeOrganizationSelector(r *http.Request) (string, bool) {
	values := r.Header.Values("X-Organization-ID")
	if len(values) > 1 {
		return "", false
	}
	if len(values) == 0 {
		return session.CookieFromRequest(r, session.ActiveOrgCookieName), true
	}
	orgID := strings.ToLower(strings.TrimSpace(values[0]))
	if !isUUID(orgID) {
		return "", false
	}
	return orgID, true
}

func matchesRequestedOrganization(r *http.Request, resolved *session.ResolvedUser) bool {
	values := r.Header.Values("X-Organization-ID")
	if len(values) == 0 {
		return true
	}
	return len(values) == 1 && resolved != nil && resolved.OrgID != nil &&
		strings.EqualFold(strings.TrimSpace(values[0]), *resolved.OrgID)
}

func sameOriginCapabilityRequest(r *http.Request, trustedProxyCIDRs []*net.IPNet) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || strings.Contains(origin, ",") {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed == nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if peerText, _, splitErr := net.SplitHostPort(r.RemoteAddr); splitErr == nil && isTrustedProxy(net.ParseIP(peerText), trustedProxyCIDRs) {
		forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
		if strings.Contains(forwarded, ",") {
			return false
		}
		if forwarded == "http" || forwarded == "https" {
			scheme = forwarded
		}
	}
	return strings.EqualFold(parsed.Scheme, scheme) && strings.EqualFold(parsed.Host, r.Host)
}
