// Package session resolves a browser session into the actor identity and
// permission set the capability kernel authorizes against.
//
// It reproduces the TypeScript session authority in
// apps/web/src/server/session.ts and apps/web/src/server/kernel.ts exactly,
// so Go can become the session owner instead of trusting an assertion minted
// by the legacy app. Three properties are load-bearing and are asserted by
// tests rather than left to inspection:
//
//   - An unverified mailbox resolves to a bare identity: no organization, no
//     permissions, no memberships. A password proves nothing about mailbox
//     ownership, and pre-provisioned domain identities bind by email (N03).
//   - The active-organization cookie is only honored when the user is a
//     member of it. A tampered cookie must fall back, never widen access.
//   - Permissions are always scoped to the resolved organization, so a user in
//     three organizations cannot spend one tenant's grants on another.
package session

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// SessionCookieName matches Better Auth's default
	// `${cookiePrefix}.session_token`; the app does not override the prefix.
	SessionCookieName = "better-auth.session_token"
	// ActiveOrgCookieName selects the active organization for multi-tenant
	// users. It is a per-session cookie, never a silent default.
	ActiveOrgCookieName = "chaste_active_org"
	// minSecretBytes mirrors the TypeScript session secret floor. A short
	// secret is refused outright rather than silently weakening the MAC.
	minSecretBytes = 32
)

var (
	// ErrNoSession means no resolvable session: absent, malformed, unsigned,
	// expired, revoked, or belonging to a user that no longer exists.
	ErrNoSession = errors.New("no resolvable session")
	// ErrSecretTooShort means the configured secret cannot safely sign or
	// verify session cookies, so no session is ever resolved.
	ErrSecretTooShort = errors.New("session secret is too short")
)

// ResolvedUser is the Go mirror of the TypeScript ResolvedUser plus the
// SessionUser fields the legacy session module adds.
type ResolvedUser struct {
	// UserID is the stable domain identity, mirrored from the auth account.
	UserID string
	// Email is the auth account address, unnormalized, as the legacy module
	// returns it. Identity lookups normalize before querying.
	Email string
	// Name is the auth display name, which may be absent.
	Name *string
	// OrgID is the active organization, or nil when the user has no verified
	// membership or has not been resolved to one.
	OrgID *string
	// Permissions is the effective permission set for OrgID only.
	Permissions map[string]bool
	// AllOrgIDs lists every organization the user belongs to. An empty slice
	// with a nil OrgID means the identity carries no tenant access.
	AllOrgIDs []string
	// EnabledModules is the organization's saved module list. Nil means every
	// standard module is enabled.
	EnabledModules []string
	// ModulesRestricted distinguishes "no saved list" from a saved empty list,
	// because the two mean different things to the module gate.
	ModulesRestricted bool
	// BaseCurrency is the organization's recording currency.
	BaseCurrency *string
	// EmailVerified gates every permission and membership lookup.
	EmailVerified bool
	// AuthSessionID is the Better Auth session row id. It is deliberately
	// distinct from the kernel's agent session id.
	AuthSessionID string
}

// HasPermission reports whether the resolved identity holds a permission in
// the active organization.
func (r *ResolvedUser) HasPermission(key string) bool {
	if r == nil || r.OrgID == nil {
		return false
	}
	return r.Permissions[key]
}

// IsMemberOf reports whether the identity belongs to the given organization.
// Callers use it to authorize a requested org before acting on it.
func (r *ResolvedUser) IsMemberOf(orgID string) bool {
	if r == nil || orgID == "" {
		return false
	}
	for _, candidate := range r.AllOrgIDs {
		if candidate == orgID {
			return true
		}
	}
	return false
}

// normalizeEmail keeps case variants bound to the same pre-provisioned identity.
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// signCookieValue reproduces Better Auth's cookie signature: HMAC-SHA256 over
// the raw value using the secret's UTF-8 bytes, encoded with STANDARD base64.
func signCookieValue(value, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// SplitSignedCookie separates a `<token>.<signature>` cookie. It returns the
// token and the presented signature. A cookie with no dot is unsigned and is
// rejected rather than treated as a bare token.
func SplitSignedCookie(cookieValue string) (token string, signature string, err error) {
	// The token itself is base64-ish and never contains a dot, so the first
	// dot is the separator. SplitN keeps a malformed multi-dot value visible
	// to the constant-time comparison instead of silently truncating.
	parts := strings.SplitN(cookieValue, ".", 2)
	if len(parts) != 2 {
		return "", "", ErrNoSession
	}
	token, signature = parts[0], parts[1]
	if token == "" || signature == "" {
		return "", "", ErrNoSession
	}
	return token, signature, nil
}

// VerifySignedCookie checks a Better Auth signed cookie against the secret and
// returns the underlying session token. The comparison is constant time.
func VerifySignedCookie(cookieValue, secret string) (string, error) {
	if len([]byte(secret)) < minSecretBytes {
		return "", ErrSecretTooShort
	}
	token, presented, err := SplitSignedCookie(cookieValue)
	if err != nil {
		return "", err
	}
	expected := signCookieValue(token, secret)
	if subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) != 1 {
		return "", ErrNoSession
	}
	return token, nil
}

// CookieFromRequest reads the session cookie from a request, tolerating the
// percent-encoding that transport applies to base64 characters.
func CookieFromRequest(r *http.Request, name string) string {
	cookie, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return urlUnescapeCookie(cookie.Value)
}

// urlUnescapeCookie reverses percent-encoding on a cookie value. Standard
// base64 uses '+', '/', and '=', and some proxies re-encode them. A value that
// is not valid percent-encoding is returned unchanged rather than dropped,
// because the signature check is the real gate.
func urlUnescapeCookie(value string) string {
	if !strings.Contains(value, "%") {
		return value
	}
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '%' && i+2 < len(value) {
			hi, ok1 := unhex(value[i+1])
			lo, ok2 := unhex(value[i+2])
			if ok1 && ok2 {
				out.WriteByte(hi<<4 | lo)
				i += 2
				continue
			}
		}
		out.WriteByte(value[i])
	}
	return out.String()
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// Resolver turns signed session cookies into resolved actors.
type Resolver struct {
	pool   *pgxpool.Pool
	secret string
	// now is injectable so expiry and cutoff behaviour is testable.
	now func() time.Time
	// stub replaces resolution entirely. It exists so the HTTP middleware can
	// be tested without a database; production never sets it.
	stub func(ctx context.Context, cookie, activeOrg string) (*ResolvedUser, error)
}

// NewResolver builds a resolver. It refuses a short secret so a deployment
// cannot silently authorize traffic with a guessable MAC key.
func NewResolver(pool *pgxpool.Pool, secret string) (*Resolver, error) {
	if pool == nil {
		return nil, errors.New("session resolver requires a database pool")
	}
	if len([]byte(secret)) < minSecretBytes {
		return nil, ErrSecretTooShort
	}
	return &Resolver{pool: pool, secret: secret, now: time.Now}, nil
}

// setClock replaces the clock. It is deliberately unexported: a caller able to
// rewind this clock would silently extend every session's lifetime, so only
// same-package tests may do it and production always uses the wall clock.
func (r *Resolver) setClock(now func() time.Time) {
	if now != nil {
		r.now = now
	}
}

// Resolve turns a raw signed cookie value plus the active-org cookie into a
// resolved actor, or ErrNoSession when the session is not usable.
func (r *Resolver) Resolve(ctx context.Context, signedCookie, activeOrgCookie string) (*ResolvedUser, error) {
	if r.stub != nil {
		return r.stub(ctx, signedCookie, activeOrgCookie)
	}
	token, err := VerifySignedCookie(signedCookie, r.secret)
	if err != nil {
		return nil, err
	}
	return r.resolveToken(ctx, token, activeOrgCookie)
}

// ResolveBearerToken resolves an opaque Better Auth session token presented
// through Authorization: Bearer. The bearer value remains a random token
// backed by auth_session, so deleting that row revokes both bearer and cookie
// access. Organization and permission claims are never accepted from the
// bearer client.
func (r *Resolver) ResolveBearerToken(ctx context.Context, token, activeOrgCookie string) (*ResolvedUser, error) {
	if r.stub != nil {
		return r.stub(ctx, token, activeOrgCookie)
	}
	if token == "" || len(token) > 512 || strings.ContainsAny(token, " \t\r\n") {
		return nil, ErrNoSession
	}
	return r.resolveToken(ctx, token, activeOrgCookie)
}

func (r *Resolver) resolveToken(ctx context.Context, token, activeOrgCookie string) (*ResolvedUser, error) {

	// The narrowly granted database function resolves the auth session to the
	// domain identity. It can see the RLS-protected users table without giving
	// the API role general access to identities across organizations.
	var sessionID, userID, authEmail string
	var authName *string
	var emailVerified bool
	var orgIDs []string
	err := r.pool.QueryRow(ctx, `
		SELECT auth_session_id, user_id::text, email, name, email_verified, org_ids
		FROM public.chaste_resolve_better_auth_session($1, $2)`, token, r.now()).Scan(
		&sessionID, &userID, &authEmail, &authName, &emailVerified, &orgIDs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNoSession
		}
		return nil, fmt.Errorf("session identity lookup: %w", err)
	}

	resolved, err := r.resolveActor(ctx, userID, authEmail, authName, emailVerified, sessionID, orgIDs)
	if err != nil {
		return nil, err
	}

	// An unverified mailbox stops here: bare identity, no memberships, no
	// permissions, and no organization even if a cookie asks for one.
	if !emailVerified {
		return resolved, nil
	}

	if len(resolved.AllOrgIDs) == 0 {
		return resolved, nil
	}

	// The active-org cookie is honored only for an organization the user
	// actually belongs to. A tampered or stale cookie falls back rather than
	// widening access.
	activeOrgID := resolved.OrgID
	if activeOrgID == nil {
		activeOrgID = &resolved.AllOrgIDs[0]
	}
	if requested := strings.TrimSpace(activeOrgCookie); requested != "" {
		for _, candidate := range resolved.AllOrgIDs {
			if candidate == requested {
				activeOrgID = &candidate
				break
			}
		}
	}

	orgPermissions, enabledModules, restricted, currency, err := r.loadOrg(ctx, resolved.UserID, *activeOrgID)
	if err != nil {
		return nil, err
	}
	resolved.OrgID = activeOrgID
	resolved.Permissions = orgPermissions
	resolved.EnabledModules = enabledModules
	resolved.ModulesRestricted = restricted
	resolved.BaseCurrency = currency
	return resolved, nil
}

// resolveActor mirrors resolveActorFromAuth: it finds or creates the stable
// domain identity and reads its base membership and permissions.
func (r *Resolver) resolveActor(ctx context.Context, userID, authEmail string, authName *string, emailVerified bool, authSessionID string, orgIDs []string) (*ResolvedUser, error) {
	resolved := &ResolvedUser{
		UserID:        userID,
		Email:         authEmail,
		Name:          authName,
		Permissions:   map[string]bool{},
		AllOrgIDs:     orgIDs,
		EmailVerified: emailVerified,
		AuthSessionID: authSessionID,
	}

	// The unverified path deliberately does not read memberships, so an
	// unverified account can never inherit a pre-provisioned identity.
	if !emailVerified {
		return resolved, nil
	}

	// The base organization mirrors the legacy module, which reads the first
	// membership row without ordering. The active-org resolution below then
	// replaces these fields for whichever organization is actually selected.
	if len(orgIDs) > 0 {
		base := orgIDs[0]
		permissions, enabledModules, restricted, currency, err := r.loadOrg(ctx, userID, base)
		if err != nil {
			return nil, err
		}
		resolved.OrgID = &base
		resolved.Permissions = permissions
		resolved.EnabledModules = enabledModules
		resolved.ModulesRestricted = restricted
		resolved.BaseCurrency = currency
	}
	return resolved, nil
}

// loadOrg reads permissions, module state, and currency for one user in one
// organization. The role join is scoped by org on both sides so a role id
// reused across tenants cannot leak another tenant's permission keys.
func (r *Resolver) loadOrg(ctx context.Context, userID, orgID string) (map[string]bool, []string, bool, *string, error) {
	type orgAccess struct {
		permissions map[string]bool
		modules     []string
		restricted  bool
		currency    *string
	}
	access, err := dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (orgAccess, error) {
		var isMember bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid
			)`, orgID, userID).Scan(&isMember); err != nil {
			return orgAccess{}, fmt.Errorf("membership verification: %w", err)
		}
		if !isMember {
			return orgAccess{}, ErrNoSession
		}

		rows, err := tx.Query(ctx, `
		SELECT DISTINCT rp.permission_key
		FROM user_roles ur
		JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.org_id = ur.org_id
		WHERE ur.org_id = $1::uuid AND ur.user_id = $2::uuid`, orgID, userID)
		if err != nil {
			return orgAccess{}, fmt.Errorf("permission lookup: %w", err)
		}
		permissions := map[string]bool{}
		for rows.Next() {
			var key string
			if err := rows.Scan(&key); err != nil {
				rows.Close()
				return orgAccess{}, fmt.Errorf("permission scan: %w", err)
			}
			permissions[key] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return orgAccess{}, fmt.Errorf("permission rows: %w", err)
		}

		var rawModules []byte
		var currency string
		err = tx.QueryRow(ctx, `
		SELECT enabled_modules, base_currency
		FROM organizations
		WHERE id = $1::uuid`, orgID).Scan(&rawModules, &currency)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return orgAccess{}, fmt.Errorf("organization lookup: %w", err)
		}

		// A NULL enabled_modules means every standard module is available, which
		// is different from a saved empty list that disables optional modules.
		restricted := rawModules != nil
		var modules []string
		if restricted {
			if err := decodeStringArray(rawModules, &modules); err != nil {
				return orgAccess{}, fmt.Errorf("enabled_modules decode: %w", err)
			}
		}
		return orgAccess{permissions: permissions, modules: modules, restricted: restricted, currency: &currency}, nil
	})
	if err != nil {
		return nil, nil, false, nil, err
	}
	return access.permissions, access.modules, access.restricted, access.currency, nil
}

// SignSessionCookie produces the signed cookie value Better Auth would set for a
// session token. It exists so test harnesses and local tooling can mint a
// session without a browser; production never signs, it only verifies.
func SignSessionCookie(token, secret string) (string, error) {
	if len([]byte(secret)) < minSecretBytes {
		return "", ErrSecretTooShort
	}
	return token + "." + signCookieValue(token, secret), nil
}
