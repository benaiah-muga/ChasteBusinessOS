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

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var notificationPreferenceKinds = []string{"approval.requested", "ticket.filed", "routine.run", "system"}

type notificationPreferencesResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type NotificationPreferencesHandler struct {
	pool              *pgxpool.Pool
	resolver          notificationPreferencesResolver
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewNotificationPreferencesHandler(pool *pgxpool.Pool, resolver notificationPreferencesResolver, logger *slog.Logger, trustedProxyCIDRs ...*net.IPNet) http.Handler {
	return &NotificationPreferencesHandler{pool: pool, resolver: resolver, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs}
}

func (h *NotificationPreferencesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h == nil || h.pool == nil || h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notification preferences unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, bearer, ok := resolveNotificationPreferencesUser(r, selector, h.resolver)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		muted, err := readNotificationPreferences(r.Context(), h.pool, *resolved.OrgID, resolved.UserID)
		if err != nil {
			h.fail(w, *resolved.OrgID, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"kinds": notificationPreferenceKinds, "mutedKinds": muted})
	case http.MethodPut:
		if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var body struct {
			MutedKinds []string `json:"mutedKinds"`
		}
		if decoder.Decode(&body) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		var trailing any
		if decoder.Decode(&trailing) != io.EOF {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		muted, err := normalizeMutedKinds(body.MutedKinds)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := writeNotificationPreferences(r.Context(), h.pool, *resolved.OrgID, resolved.UserID, muted); err != nil {
			h.fail(w, *resolved.OrgID, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"kinds": notificationPreferenceKinds, "mutedKinds": muted})
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *NotificationPreferencesHandler) fail(w http.ResponseWriter, orgID string, err error) {
	if h.logger != nil {
		h.logger.Error("Go notification preferences failed", "organizationId", orgID, "error", err)
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "notification preferences failed"})
}

func readNotificationPreferences(ctx context.Context, pool *pgxpool.Pool, orgID, userID string) ([]string, error) {
	var muted []string
	_, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		err := tx.QueryRow(ctx, `SELECT muted_kinds FROM notification_preferences WHERE org_id=$1::uuid AND user_id=$2::uuid`, orgID, userID).Scan(&muted)
		if errors.Is(err, pgx.ErrNoRows) {
			muted = []string{}
			return struct{}{}, nil
		}
		return struct{}{}, err
	})
	if muted == nil {
		muted = []string{}
	}
	return muted, err
}

func writeNotificationPreferences(ctx context.Context, pool *pgxpool.Pool, orgID, userID string, muted []string) error {
	_, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			INSERT INTO notification_preferences (org_id, user_id, muted_kinds, updated_at)
			VALUES ($1::uuid, $2::uuid, $3::text[], now())
			ON CONFLICT (org_id, user_id) DO UPDATE SET muted_kinds=EXCLUDED.muted_kinds, updated_at=now()`, orgID, userID, muted)
		return struct{}{}, err
	})
	return err
}

func normalizeMutedKinds(values []string) ([]string, error) {
	allowed := map[string]bool{}
	for _, kind := range notificationPreferenceKinds {
		allowed[kind] = true
	}
	seen := map[string]bool{}
	muted := make([]string, 0, len(values))
	for _, raw := range values {
		kind := strings.TrimSpace(raw)
		if kind == "" || !allowed[kind] {
			return nil, errors.New("unknown notification kind")
		}
		if !seen[kind] {
			seen[kind] = true
			muted = append(muted, kind)
		}
	}
	sort.Strings(muted)
	return muted, nil
}

func resolveNotificationPreferencesUser(r *http.Request, selector string, resolver notificationPreferencesResolver) (*session.ResolvedUser, bool, bool) {
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
