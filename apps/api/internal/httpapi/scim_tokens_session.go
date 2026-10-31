package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const scimTokenManagementBodyLimit = 8 << 10
const scimTokenLabelLimit = 120

type SCIMTokenSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type SCIMTokenSessionHandler struct {
	pool              *pgxpool.Pool
	resolver          SCIMTokenSessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	now               func() time.Time
}

type scimManagedToken struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	Active     bool       `json:"active"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	CreatedAt  time.Time  `json:"createdAt"`
}

func truncateSCIMTokenTimestamps(row *scimManagedToken) {
	row.CreatedAt = row.CreatedAt.Truncate(time.Millisecond)
	if row.ExpiresAt != nil {
		value := row.ExpiresAt.Truncate(time.Millisecond)
		row.ExpiresAt = &value
	}
	if row.LastUsedAt != nil {
		value := row.LastUsedAt.Truncate(time.Millisecond)
		row.LastUsedAt = &value
	}
}

func NewSCIMTokenSessionHandler(pool *pgxpool.Pool, resolver SCIMTokenSessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &SCIMTokenSessionHandler{pool: pool, resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs, now: time.Now}
}

func hashSCIMManagementToken(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

func (h *SCIMTokenSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || (r.Method != http.MethodGet && h.executor == nil) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SCIM token service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, bearer, ok := h.resolve(r, selector)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.AuthSessionID == "" || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Method != http.MethodGet && !resolved.HasPermission("iam.admin") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "requires iam.admin permission"})
		return
	}
	if r.Method != http.MethodGet && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.list(w, r, *resolved.OrgID)
	case http.MethodPost:
		h.create(w, r, resolved)
	case http.MethodDelete:
		h.revoke(w, r, resolved)
	}
}

func (h *SCIMTokenSessionHandler) resolve(r *http.Request, activeOrg string) (*session.ResolvedUser, bool, bool) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err == nil
}

func (h *SCIMTokenSessionHandler) list(w http.ResponseWriter, r *http.Request, orgID string) {
	if h.pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SCIM token service unavailable"})
		return
	}
	rows, err := dbx.WithOrgTx(r.Context(), h.pool, orgID, func(tx pgx.Tx) ([]scimManagedToken, error) {
		rows := make([]scimManagedToken, 0)
		result, err := tx.Query(r.Context(), `
			SELECT id::text, label, active, expires_at, last_used_at, created_at
			FROM scim_tokens
			WHERE org_id = $1::uuid
			ORDER BY created_at DESC, id`, orgID)
		if err != nil {
			return nil, err
		}
		defer result.Close()
		for result.Next() {
			var row scimManagedToken
			if err := result.Scan(&row.ID, &row.Label, &row.Active, &row.ExpiresAt, &row.LastUsedAt, &row.CreatedAt); err != nil {
				return nil, err
			}
			truncateSCIMTokenTimestamps(&row)
			rows = append(rows, row)
		}
		return rows, result.Err()
	})
	if err != nil {
		h.logError("SCIM token list failed", orgID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Tokens []scimManagedToken `json:"tokens"`
	}{Tokens: rows})
}

func (h *SCIMTokenSessionHandler) create(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, scimTokenManagementBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body struct {
		Label         *string `json:"label"`
		ExpiresInDays *int    `json:"expiresInDays"`
	}
	if err := decoder.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	label := "IdP provisioning"
	if body.Label != nil {
		label = *body.Label
	}
	if utf8.RuneCountInString(label) > scimTokenLabelLimit || strings.ContainsAny(label, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "label must be at most 120 characters"})
		return
	}
	expiresInDays := 90
	if body.ExpiresInDays != nil {
		expiresInDays = *body.ExpiresInDays
	}
	if expiresInDays < 1 || expiresInDays > 365 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expiresInDays must be an integer between 1 and 365"})
		return
	}
	intentID, ok := scimTokenManagementIntentID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a single UUID Idempotency-Key is required"})
		return
	}
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SCIM token service unavailable"})
		return
	}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		h.logError("SCIM token generation failed", *resolved.OrgID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	raw := "scim_" + base64.RawURLEncoding.EncodeToString(random)
	tokenHash := hashSCIMManagementToken(raw)
	input, err := json.Marshal(capability.SCIMTokenCreateInput{TokenHash: tokenHash, Label: label, ExpiresInDays: expiresInDays})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	claims := scimTokenManagementClaims(resolved, intentID, capability.SCIMTokenCreateCapabilityID, input, h.now())
	result, err := h.executor.Execute(r.Context(), claims, capability.SCIMTokenCreateCapabilityID, input)
	if err != nil {
		h.logError("SCIM token creation failed", *resolved.OrgID, err)
		writeSCIMTokenCapabilityError(w, err)
		return
	}
	if !result.OK || result.PendingApproval || result.Replayed {
		if result.Replayed {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "token result is unavailable; create a new token"})
			return
		}
		if result.PendingApproval {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "token creation cannot be deferred for approval; no token was created"})
			return
		}
		if strings.Contains(result.Error, "action intent conflict") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "idempotency key was already used; use a new key"})
			return
		}
		if strings.Contains(result.Error, "one-time secret output cannot be deferred") {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "token creation cannot be deferred for approval; no token was created"})
			return
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "token creation failed"})
		return
	}
	var row capability.SCIMTokenCreateOutput
	if err := json.Unmarshal(result.Data, &row); err != nil || !isUUID(row.TokenID) {
		h.logError("SCIM token creation returned invalid result", *resolved.OrgID, errors.New("invalid capability result"))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		Token     string    `json:"token"`
		ID        string    `json:"id"`
		Label     string    `json:"label"`
		ExpiresAt time.Time `json:"expiresAt"`
	}{Token: raw, ID: row.TokenID, Label: row.Label, ExpiresAt: row.ExpiresAt})
}

func (h *SCIMTokenSessionHandler) revoke(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	orgID := *resolved.OrgID
	query := r.URL.Query()
	ids, exists := query["id"]
	if !exists || len(ids) != 1 || ids[0] == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id required"})
		return
	}
	if !isUUID(ids[0]) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	intentID, ok := scimTokenManagementIntentID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a single UUID Idempotency-Key is required"})
		return
	}
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SCIM token service unavailable"})
		return
	}
	input, err := json.Marshal(capability.SCIMTokenRevokeInput{TokenID: ids[0]})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	claims := scimTokenManagementClaims(resolved, intentID, capability.SCIMTokenRevokeCapabilityID, input, h.now())
	result, err := h.executor.Execute(r.Context(), claims, capability.SCIMTokenRevokeCapabilityID, input)
	if err != nil {
		h.logError("SCIM token revocation failed", orgID, err)
		writeSCIMTokenCapabilityError(w, err)
		return
	}
	if result.PendingApproval {
		writeSCIMTokenPendingApproval(w, result)
		return
	}
	if !result.OK {
		if strings.Contains(result.Error, "action intent conflict") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "idempotency key was already used; use a new key"})
			return
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "token revocation failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func scimTokenManagementClaims(resolved *session.ResolvedUser, intentID, capabilityID string, input json.RawMessage, now time.Time) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now = now.UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID, IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func scimTokenManagementIntentID(r *http.Request) (string, bool) {
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 || strings.TrimSpace(keys[0]) != keys[0] || !scimUUIDPattern.MatchString(keys[0]) {
		return "", false
	}
	return "scim:tokens:" + strings.ToLower(keys[0]), true
}

func writeSCIMTokenPendingApproval(w http.ResponseWriter, result capability.Result) {
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
}

func writeSCIMTokenCapabilityError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func (h *SCIMTokenSessionHandler) logError(message, orgID string, err error) {
	if h.logger != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		h.logger.Error(message, "organizationId", orgID, "error", err)
	}
}
