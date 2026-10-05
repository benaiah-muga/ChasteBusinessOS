package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const supportChannelsBodyLimit = 4096

type supportChannelsPatch struct {
	AutoReplyEnabled *bool   `json:"autoReplyEnabled"`
	Greeting         *string `json:"greeting"`
	RegenerateToken  *bool   `json:"regenerateToken"`
}

type supportChannelsData struct {
	AutoReplyEnabled bool
	Greeting         string
	EmbedToken       *string
	Member           bool
	ModuleEnabled    bool
	CanManage        bool
}

// supportChannelsStore isolates the channel route from PostgreSQL in handler tests.
// Production reads and mutations use pgSupportChannelsStore, which repeats the
// membership, module, and permission checks inside the tenant transaction.
type supportChannelsStore interface {
	Read(context.Context, string, string) (supportChannelsData, error)
	Upsert(context.Context, string, string, supportChannelsPatch, string) (supportChannelsData, error)
}

type supportChannelsHandler struct {
	store        supportChannelsStore
	session      SessionResolver
	logger       *slog.Logger
	trustedProxy []*net.IPNet
}

// NewSupportChannelsHandler builds the authenticated support channel settings
// endpoint. Mount it at /api/support/channels behind the Go API router.
func NewSupportChannelsHandler(pool *pgxpool.Pool, resolver SessionResolver, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if pool == nil {
		return nil, errors.New("support channels handler requires a database pool")
	}
	if resolver == nil {
		return nil, errors.New("support channels handler requires a session resolver")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &supportChannelsHandler{store: newPgSupportChannelsStore(pool), session: resolver, logger: logger, trustedProxy: trustedProxyCIDRs}, nil
}

// newSupportChannelsHandler is the test seam for exercising HTTP behavior
// without opening a PostgreSQL connection.
func newSupportChannelsHandler(store supportChannelsStore, resolver SessionResolver, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &supportChannelsHandler{store: store, session: resolver, logger: logger, trustedProxy: trustedProxyCIDRs}
}

func (h *supportChannelsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	switch r.Method {
	case http.MethodGet, http.MethodPost:
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	resolved, bearer, err := h.resolve(r)
	if err != nil || resolved == nil {
		if errors.Is(err, session.ErrSecretTooShort) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "support channels unavailable"})
		} else {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		}
		return
	}
	if resolved.OrgID == nil || !resolved.EmailVerified || !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if r.Method == http.MethodPost && !bearer && !sameOriginRequest(r, h.trustedProxy) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin check failed"})
		return
	}
	if r.Method == http.MethodGet {
		h.get(w, r, resolved)
		return
	}
	patch, ok := decodeSupportChannelsPatch(w, r)
	if !ok {
		return
	}
	token, err := newSupportEmbedToken()
	if err != nil {
		h.fail(w, "generate embed token", err)
		return
	}
	data, err := h.store.Upsert(r.Context(), resolved.UserID, *resolved.OrgID, patch, token)
	if err != nil {
		h.fail(w, "update channel settings", err)
		return
	}
	if !h.authorized(w, data) {
		return
	}
	if !data.CanManage {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	writeJSON(w, http.StatusOK, channelsResponse(data, true))
}

func (h *supportChannelsHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, error) {
	if h.session == nil {
		return nil, false, session.ErrNoSession
	}
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, session.ErrNoSession
	}
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, session.ErrNoSession
		}
		resolver, ok := h.session.(interface {
			ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
		})
		if !ok {
			return nil, true, session.ErrNoSession
		}
		resolved, err := resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err
	}
	resolved, err := h.session.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err
}

func (h *supportChannelsHandler) get(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	data, err := h.store.Read(r.Context(), user.UserID, *user.OrgID)
	if err != nil {
		h.fail(w, "read channel settings", err)
		return
	}
	if !h.authorized(w, data) {
		return
	}
	writeJSON(w, http.StatusOK, channelsResponse(data, data.CanManage))
}

func (h *supportChannelsHandler) authorized(w http.ResponseWriter, data supportChannelsData) bool {
	if !data.Member {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	if !data.ModuleEnabled {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return false
	}
	return true
}

func channelsResponse(data supportChannelsData, canManage bool) map[string]any {
	var token any
	if canManage {
		token = data.EmbedToken
	}
	return map[string]any{
		"autoReplyEnabled": data.AutoReplyEnabled,
		"greeting":         data.Greeting,
		"embedToken":       token,
		"canManage":        canManage,
	}
}

func decodeSupportChannelsPatch(w http.ResponseWriter, r *http.Request) (supportChannelsPatch, bool) {
	var patch supportChannelsPatch
	if r.Body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return patch, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, supportChannelsBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return patch, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return patch, false
	}
	for key := range fields {
		if key != "autoReplyEnabled" && key != "greeting" && key != "regenerateToken" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return patch, false
		}
	}
	if raw, ok := fields["autoReplyEnabled"]; ok {
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil || string(raw) == "null" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return patch, false
		}
		patch.AutoReplyEnabled = &value
	}
	if raw, ok := fields["regenerateToken"]; ok {
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil || string(raw) == "null" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return patch, false
		}
		patch.RegenerateToken = &value
	}
	if raw, ok := fields["greeting"]; ok {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || string(raw) == "null" || len(utf16.Encode([]rune(value))) < 1 || len(utf16.Encode([]rune(value))) > 300 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return patch, false
		}
		value = strings.TrimSpace(value)
		patch.Greeting = &value
	}
	return patch, true
}

func newSupportEmbedToken() (string, error) {
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", fmt.Errorf("read embed token entropy: %w", err)
	}
	return hex.EncodeToString(entropy[:]), nil
}

func (h *supportChannelsHandler) fail(w http.ResponseWriter, operation string, err error) {
	h.logger.Error("support channels request failed", "operation", operation, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

// pgSupportChannelsStore performs the settings access and live authorization
// checks under the same organization-scoped transaction.
type pgSupportChannelsStore struct{ pool *pgxpool.Pool }

func newPgSupportChannelsStore(pool *pgxpool.Pool) *pgSupportChannelsStore {
	return &pgSupportChannelsStore{pool: pool}
}

func (s *pgSupportChannelsStore) Read(ctx context.Context, userID, orgID string) (supportChannelsData, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (supportChannelsData, error) {
		data, err := loadSupportChannelsAccess(ctx, tx, userID, orgID)
		if err != nil || !data.Member || !data.ModuleEnabled {
			return data, err
		}
		err = tx.QueryRow(ctx, `SELECT auto_reply_enabled, greeting, embed_token FROM support_settings WHERE org_id = $1::uuid`, orgID).
			Scan(&data.AutoReplyEnabled, &data.Greeting, &data.EmbedToken)
		if errors.Is(err, pgx.ErrNoRows) {
			return supportChannelsData{AutoReplyEnabled: false, Greeting: "", Member: data.Member, ModuleEnabled: data.ModuleEnabled, CanManage: data.CanManage}, nil
		}
		return data, err
	})
}

func (s *pgSupportChannelsStore) Upsert(ctx context.Context, userID, orgID string, patch supportChannelsPatch, newToken string) (supportChannelsData, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (supportChannelsData, error) {
		data, err := loadSupportChannelsAccess(ctx, tx, userID, orgID)
		if err != nil || !data.Member || !data.ModuleEnabled || !data.CanManage {
			return data, err
		}
		var enabled any
		if patch.AutoReplyEnabled != nil {
			enabled = *patch.AutoReplyEnabled
		}
		var greeting any
		if patch.Greeting != nil {
			greeting = *patch.Greeting
		}
		regenerate := patch.RegenerateToken != nil && *patch.RegenerateToken
		err = tx.QueryRow(ctx, `
			INSERT INTO support_settings (org_id, embed_token, auto_reply_enabled, greeting)
			VALUES ($1::uuid, $2, COALESCE($3::boolean, true), COALESCE($4::text, 'Hi - ask us anything and we''ll get right back to you.'))
			ON CONFLICT (org_id) DO UPDATE SET
				auto_reply_enabled = COALESCE($3::boolean, support_settings.auto_reply_enabled),
				greeting = COALESCE($4::text, support_settings.greeting),
				embed_token = CASE WHEN $5::boolean THEN EXCLUDED.embed_token ELSE support_settings.embed_token END,
				updated_at = now()
			RETURNING auto_reply_enabled, greeting, embed_token`, orgID, newToken, enabled, greeting, regenerate).
			Scan(&data.AutoReplyEnabled, &data.Greeting, &data.EmbedToken)
		return data, err
	})
}

func loadSupportChannelsAccess(ctx context.Context, tx pgx.Tx, userID, orgID string) (supportChannelsData, error) {
	data := supportChannelsData{}
	var modules []byte
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid),
		       EXISTS (
		         SELECT 1 FROM user_roles ur
		         JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.org_id=ur.org_id
		         WHERE ur.org_id=$1::uuid AND ur.user_id=$2::uuid AND rp.permission_key IN ('iam.admin', '*')
		       ),
		       o.enabled_modules
		FROM organizations o WHERE o.id=$1::uuid`, orgID, userID).
		Scan(&data.Member, &data.CanManage, &modules); err != nil {
		return data, err
	}
	data.ModuleEnabled = modules == nil
	if modules != nil {
		var enabled []string
		if err := json.Unmarshal(modules, &enabled); err != nil {
			return data, fmt.Errorf("decode enabled modules: %w", err)
		}
		for _, module := range enabled {
			if module == "support" {
				data.ModuleEnabled = true
				break
			}
		}
	}
	return data, nil
}

func sameOriginRequest(r *http.Request, trustedProxyCIDRs []*net.IPNet) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || strings.Contains(origin, ",") {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed == nil || parsed.User != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if isTrustedProxy(net.ParseIP(clientIP(r.RemoteAddr)), trustedProxyCIDRs) {
		forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
		if strings.Contains(forwarded, ",") {
			return false
		}
		if forwarded == "http" || forwarded == "https" {
			scheme = forwarded
		}
	}
	if !strings.EqualFold(parsed.Scheme, scheme) {
		return false
	}
	expected, err := url.Parse(scheme + "://" + r.Host)
	if err != nil || expected.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Hostname(), expected.Hostname()) && effectiveOriginPort(parsed) == effectiveOriginPort(expected)
}

func effectiveOriginPort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if strings.EqualFold(u.Scheme, "https") {
		return "443"
	}
	return "80"
}
