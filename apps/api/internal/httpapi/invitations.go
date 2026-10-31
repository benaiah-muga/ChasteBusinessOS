package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	invitationAttemptLimit      = 30
	invitationAttemptWindow     = time.Minute
	invitationAttemptMaxBuckets = 50_000
)

var invitationTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)

type invitationSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type invitationPreview struct {
	Email     string    `json:"email"`
	OrgName   string    `json:"orgName"`
	RoleName  string    `json:"roleName"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type invitationClaimResult struct {
	status  int
	message string
}

type invitationStore interface {
	resolveOrg(context.Context, string) (string, bool, error)
	preview(context.Context, string, string, time.Time) (invitationPreview, bool, error)
	claim(context.Context, string, string, string, string, bool, time.Time) (invitationClaimResult, error)
}

type GoInvitationHandler struct {
	store             invitationStore
	resolver          invitationSessionResolver
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	limiter           *invitationAttemptLimiter
	now               func() time.Time
}

type invitationAttemptLimiter struct {
	mu      sync.Mutex
	buckets map[string]invitationAttemptBucket
	clock   func() time.Time
}

type invitationAttemptBucket struct {
	started time.Time
	count   int
}

func newInvitationAttemptLimiter(clock func() time.Time) *invitationAttemptLimiter {
	if clock == nil {
		clock = time.Now
	}
	return &invitationAttemptLimiter{buckets: make(map[string]invitationAttemptBucket), clock: clock}
}

func (l *invitationAttemptLimiter) allow(ip string) (bool, time.Duration) {
	if l == nil || ip == "" {
		return false, invitationAttemptWindow
	}
	now := l.clock()
	l.mu.Lock()
	defer l.mu.Unlock()
	bucket, ok := l.buckets[ip]
	if !ok || now.Sub(bucket.started) >= invitationAttemptWindow || now.Before(bucket.started) {
		if len(l.buckets) >= invitationAttemptMaxBuckets {
			for key, candidate := range l.buckets {
				if now.Sub(candidate.started) >= invitationAttemptWindow || now.Before(candidate.started) {
					delete(l.buckets, key)
				}
			}
			if len(l.buckets) >= invitationAttemptMaxBuckets {
				return false, invitationAttemptWindow
			}
		}
		l.buckets[ip] = invitationAttemptBucket{started: now, count: 1}
		return true, 0
	}
	if bucket.count >= invitationAttemptLimit {
		return false, invitationAttemptWindow - now.Sub(bucket.started)
	}
	bucket.count++
	l.buckets[ip] = bucket
	return true, 0
}

func NewGoInvitationHandler(pool *pgxpool.Pool, resolver invitationSessionResolver, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	if pool == nil {
		return nil, errors.New("invitation handler requires a database pool")
	}
	for _, cidr := range trustedProxyCIDRs {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	now := time.Now
	return &GoInvitationHandler{
		store: postgresInvitationStore{pool: pool}, resolver: resolver, logger: logger,
		trustedProxyCIDRs: trustedProxyCIDRs, limiter: newInvitationAttemptLimiter(now), now: now,
	}, nil
}

func (h *GoInvitationHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if h == nil || h.store == nil || h.limiter == nil || h.now == nil || h.logger == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "invitation service unavailable"})
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	clientIP := requestClientIP(r, h.trustedProxyCIDRs)
	allowed, retry := h.limiter.allow(clientIP)
	if !allowed {
		seconds := int(retry.Seconds())
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	token := r.PathValue("token")
	if r.Method == http.MethodPost {
		h.accept(w, r, token)
		return
	}
	if !invitationTokenPattern.MatchString(token) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invitation is not valid"})
		return
	}
	orgID, found, err := h.store.resolveOrg(r.Context(), token)
	if err != nil {
		h.logger.Error("Go invitation token lookup failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !found || !isUUID(orgID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invitation is not valid"})
		return
	}
	preview, active, err := h.store.preview(r.Context(), orgID, token, h.now())
	if err != nil {
		h.logger.Error("Go invitation preview failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !active {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invitation is not valid"})
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (h *GoInvitationHandler) accept(w http.ResponseWriter, r *http.Request, token string) {
	if h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "invitation service unavailable"})
		return
	}
	activeOrg, validSelector := activeOrganizationSelector(r)
	if !validSelector {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	var resolved *session.ResolvedUser
	bearer := false
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		bearer = true
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			writeInvitationUnauthorized(w)
			return
		}
		resolved, _ = h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
	} else {
		resolved, _ = h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	}
	if resolved == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) {
		writeInvitationUnauthorized(w)
		return
	}
	if !resolved.EmailVerified {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "verify your email address before accepting invitations"})
		return
	}
	if strings.TrimSpace(resolved.Email) == "" {
		writeInvitationUnauthorized(w)
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if !invitationTokenPattern.MatchString(token) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invitation is not valid"})
		return
	}
	orgID, found, err := h.store.resolveOrg(r.Context(), token)
	if err != nil {
		h.logger.Error("Go invitation token lookup failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !found || !isUUID(orgID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invitation is not valid"})
		return
	}
	result, err := h.store.claim(r.Context(), orgID, token, resolved.UserID, resolved.Email, resolved.EmailVerified, h.now())
	if err != nil {
		h.logger.Error("Go invitation acceptance failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if result.status != 0 {
		writeJSON(w, result.status, map[string]string{"error": result.message})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeInvitationUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
}

type postgresInvitationStore struct {
	pool *pgxpool.Pool
}

func (s postgresInvitationStore) resolveOrg(ctx context.Context, token string) (string, bool, error) {
	var orgID *string
	err := s.pool.QueryRow(ctx, `SELECT public.chaste_resolve_invitation_org($1)::text`, token).Scan(&orgID)
	if err != nil {
		return "", false, err
	}
	if orgID == nil {
		return "", false, nil
	}
	return *orgID, true, nil
}

func (s postgresInvitationStore) preview(ctx context.Context, orgID, token string, now time.Time) (invitationPreview, bool, error) {
	preview, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (invitationPreview, error) {
		var preview invitationPreview
		err := tx.QueryRow(ctx, `
			SELECT invitation.email, organization.name, role.name, invitation.expires_at
			FROM invitations AS invitation
			JOIN organizations AS organization ON organization.id = invitation.org_id
			JOIN roles AS role ON role.id = invitation.role_id AND role.org_id = invitation.org_id
			WHERE invitation.org_id = $1::uuid AND invitation.token = $2
			  AND invitation.status = 'pending' AND invitation.expires_at > $3`, orgID, token, now.UTC()).Scan(
			&preview.Email, &preview.OrgName, &preview.RoleName, &preview.ExpiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return invitationPreview{}, nil
		}
		if err != nil {
			return invitationPreview{}, err
		}
		return preview, nil
	})
	if err != nil {
		return invitationPreview{}, false, err
	}
	return preview, preview.Email != "", nil
}

func (s postgresInvitationStore) claim(ctx context.Context, orgID, token, userID, email string, emailVerified bool, now time.Time) (invitationClaimResult, error) {
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (invitationClaimResult, error) {
		var invitationID, inviteEmail, roleID string
		var invitedBy *string
		var status string
		var expiresAt time.Time
		err := tx.QueryRow(ctx, `
			SELECT id::text, email, role_id::text, invited_by_user_id::text, status, expires_at
			FROM invitations
			WHERE org_id = $1::uuid AND token = $2
			FOR UPDATE`, orgID, token).Scan(&invitationID, &inviteEmail, &roleID, &invitedBy, &status, &expiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return invitationClaimResult{status: http.StatusNotFound, message: "invitation is not valid"}, nil
		}
		if err != nil {
			return invitationClaimResult{}, err
		}
		switch status {
		case "accepted":
			return invitationClaimResult{status: http.StatusNotFound, message: "invitation was already used"}, nil
		case "revoked":
			return invitationClaimResult{status: http.StatusNotFound, message: "invitation was revoked"}, nil
		case "pending":
		default:
			return invitationClaimResult{status: http.StatusNotFound, message: "invitation is not valid"}, nil
		}
		if !expiresAt.After(now) {
			if _, err := tx.Exec(ctx, `UPDATE invitations SET status = 'expired' WHERE id = $1::uuid AND status = 'pending'`, invitationID); err != nil {
				return invitationClaimResult{}, err
			}
			return invitationClaimResult{status: http.StatusGone, message: "invitation expired"}, nil
		}
		if !strings.EqualFold(strings.TrimSpace(email), strings.TrimSpace(inviteEmail)) {
			return invitationClaimResult{status: http.StatusForbidden, message: "this invitation was sent to " + inviteEmail}, nil
		}
		if !emailVerified {
			return invitationClaimResult{status: http.StatusForbidden, message: "verify your email address before accepting invitations"}, nil
		}
		var roleKey string
		if err := tx.QueryRow(ctx, `SELECT key FROM roles WHERE id = $1::uuid AND org_id = $2::uuid`, roleID, orgID).Scan(&roleKey); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return invitationClaimResult{status: http.StatusNotFound, message: "invitation is not valid"}, nil
			}
			return invitationClaimResult{}, err
		}
		if roleKey != "owner" {
			if err := invitationAssertNotLastOwner(ctx, tx, orgID, userID); err != nil {
				if errors.Is(err, errInvitationLastOwner) {
					return invitationClaimResult{status: http.StatusForbidden, message: "cannot remove the organization's last owner"}, nil
				}
				return invitationClaimResult{}, err
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)
			ON CONFLICT DO NOTHING`, orgID, userID); err != nil {
			return invitationClaimResult{}, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM user_roles WHERE user_id = $1::uuid AND org_id = $2::uuid`, userID, orgID); err != nil {
			return invitationClaimResult{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_roles (user_id, role_id, org_id, assigned_by)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`, userID, roleID, orgID, invitedBy); err != nil {
			return invitationClaimResult{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE invitations SET status = 'accepted', accepted_at = $2
			WHERE id = $1::uuid AND status = 'pending'`, invitationID, now.UTC()); err != nil {
			return invitationClaimResult{}, err
		}
		return invitationClaimResult{}, nil
	})
}

var errInvitationLastOwner = errors.New("invitation claim would remove the last owner")

func invitationAssertNotLastOwner(ctx context.Context, tx pgx.Tx, orgID, userID string) error {
	var held bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM user_roles AS user_role
			JOIN roles AS role ON role.id = user_role.role_id AND role.org_id = user_role.org_id
			WHERE user_role.user_id = $1::uuid AND user_role.org_id = $2::uuid AND role.key = 'owner'
		)`, userID, orgID).Scan(&held); err != nil || !held {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT user_role.user_id::text FROM user_roles AS user_role
		JOIN roles AS role ON role.id = user_role.role_id AND role.org_id = user_role.org_id
		WHERE user_role.org_id = $1::uuid AND role.key = 'owner'
		FOR UPDATE OF user_role`, orgID)
	if err != nil {
		return err
	}
	owners := 0
	for rows.Next() {
		var ownerID string
		if err := rows.Scan(&ownerID); err != nil {
			rows.Close()
			return err
		}
		if ownerID != userID {
			owners++
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if owners == 0 {
		return errInvitationLastOwner
	}
	return nil
}

// MountGoInvitationRoutes adds Go-owned invitation preview and acceptance to
// the auth namespace without widening the remaining auth route surface.
func MountGoInvitationRoutes(base, invitationRoute http.Handler) http.Handler {
	if invitationRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /invitations/{token}", invitationRoute)
	mux.Handle("POST /invitations/{token}", invitationRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
