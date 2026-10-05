package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ownerURL returns a schema-owner connection for seeding fixtures, skipping
// when no database is configured so the pure tests still run in CI.
// hexTail renders a run stamp as exactly 12 hex characters for uuid suffixes.
func derefOrNil(v *string) string {
	if v == nil {
		return "<nil>"
	}
	return *v
}

func hexTail(stamp int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d", stamp)))
	return hex.EncodeToString(sum[:])[:12]
}

func ownerURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("GO_RUNTIME_INTEGRATION_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("DATABASE_URL is required for session integration tests")
	}
	return url
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), ownerURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// harness seeds a realistic identity graph and returns a resolver plus the ids
// a test needs to assert against.
type harness struct {
	resolver   *Resolver
	pool       *pgxpool.Pool
	secret     string
	sessionID  string
	sessionTok string
	authUserID string
	domainUser string
	orgA       string
	orgB       string
	roleA      string
	roleB      string
	cookie     string
}

func newHarness(t *testing.T, emailVerified bool) *harness {
	t.Helper()
	ctx := context.Background()
	pool := testPool(t)

	secret := "session-test-secret-0123456789abcdef-0123456789"
	stamp := time.Now().UnixNano()
	suffix := fmt.Sprintf("%d", stamp)

	// Derive distinct-but-valid uuid v4 shaped ids from the run stamp so a
	// leftover row from a failed run cannot contaminate the next one.
	hexTail := hexTail(stamp)
	orgA := "aaaaaaaa-0000-4000-8000-" + hexTail
	orgB := "bbbbbbbb-0000-4000-8000-" + hexTail
	h := &harness{
		pool:       pool,
		secret:     secret,
		sessionID:  "sess-" + suffix,
		sessionTok: "tok-" + suffix,
		orgA:       orgA,
		orgB:       orgB,
		roleA:      "dddddddd-0000-4000-8000-" + hexTail,
		roleB:      "eeeeeeee-0000-4000-8000-" + hexTail,
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organizations (id, name, slug, enabled_modules)
		VALUES ($1, 'Org A ' || $3, 'org-a-' || $3, NULL),
		       ($2, 'Org B ' || $3, 'org-b-' || $3, '["crm"]'::jsonb)`,
		h.orgA, h.orgB, suffix); err != nil {
		t.Fatal(err)
	}

	email := "sess-user-" + suffix + "@example.test"
	h.authUserID = "authuser-" + suffix
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_user (id, name, email, email_verified)
		VALUES ($1, 'Session User', $2, $3)`, h.authUserID, email, emailVerified); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_session (id, expires_at, token, user_id)
		VALUES ($1, now() + interval '1 day', $2, $3)`, h.sessionID, h.sessionTok, h.authUserID); err != nil {
		t.Fatal(err)
	}

	resolver, err := NewResolver(pool, secret)
	if err != nil {
		t.Fatal(err)
	}
	h.resolver = resolver
	h.cookie = h.sessionTok + "." + signCookieValue(h.sessionTok, secret)

	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = ANY($1::uuid[])`, []string{h.orgA, h.orgB})
		_, _ = pool.Exec(ctx, `DELETE FROM auth_session WHERE id = $1`, h.sessionID)
		_, _ = pool.Exec(ctx, `DELETE FROM auth_user WHERE id = $1`, h.authUserID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
	})
	return h
}

// addMembership creates the domain identity, membership, role and permission
// rows that a verified user would normally already have.
func (h *harness) addMembership(t *testing.T, orgID, roleID, roleName, permissionKey string) string {
	t.Helper()
	ctx := context.Background()
	email := "sess-user-" + h.sessionTok[4:] + "@example.test"
	if err := h.pool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, 'Session User')
		 ON CONFLICT (email) DO UPDATE SET name = 'Session User' RETURNING id`, email).Scan(&h.domainUser); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)
		 ON CONFLICT DO NOTHING`, orgID, h.domainUser); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO roles (id, org_id, key, name) VALUES ($1::uuid, $2::uuid, $3, $3)
		 ON CONFLICT DO NOTHING`, roleID, orgID, roleName); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
		h.domainUser, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)
		 ON CONFLICT DO NOTHING`, roleID, permissionKey, orgID); err != nil {
		t.Fatal(err)
	}
	return h.domainUser
}

// An unverified mailbox must resolve to a bare identity even when the domain
// identity has memberships and roles. This is the N03 pre-provisioning guard.
func TestUnverifiedEmailNeverInheritsMembershipOrPermissions(t *testing.T) {
	h := newHarness(t, false)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	// Even asking for org A explicitly must not grant it.
	for _, requested := range []string{"", h.orgA, h.orgB} {
		resolved, err := h.resolver.Resolve(context.Background(), h.cookie, requested)
		if err != nil {
			t.Fatalf("Resolve(requested=%q) = %v", requested, err)
		}
		if resolved.EmailVerified {
			t.Fatalf("requested=%q: unverified session reported verified", requested)
		}
		if resolved.OrgID != nil {
			t.Errorf("requested=%q: unverified session got org %q", requested, *resolved.OrgID)
		}
		if len(resolved.AllOrgIDs) != 0 {
			t.Errorf("requested=%q: unverified session surfaced memberships %v", requested, resolved.AllOrgIDs)
		}
		if len(resolved.Permissions) != 0 {
			t.Errorf("requested=%q: unverified session surfaced permissions %v", requested, resolved.Permissions)
		}
		if resolved.HasPermission("iam.admin") {
			t.Errorf("requested=%q: unverified session authorized iam.admin", requested)
		}
	}
}

// A verified mailbox resolves permissions for the organization the user
// actually belongs to.
func TestVerifiedEmailResolvesPermissionsForItsOrganization(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	resolved, err := h.resolver.Resolve(context.Background(), h.cookie, "")
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.EmailVerified {
		t.Fatal("verified session reported unverified")
	}
	if resolved.OrgID == nil || *resolved.OrgID != h.orgA {
		t.Fatalf("OrgID = %v, want %s", resolved.OrgID, h.orgA)
	}
	if !resolved.HasPermission("iam.admin") {
		t.Fatalf("permissions = %v, want iam.admin", resolved.Permissions)
	}
	if len(resolved.AllOrgIDs) != 1 || resolved.AllOrgIDs[0] != h.orgA {
		t.Fatalf("AllOrgIDs = %v, want [%s]", resolved.AllOrgIDs, h.orgA)
	}
}

// The active-org cookie may only select an organization the user belongs to.
// A tampered cookie must fall back rather than widen access, and must never
// surface that organization's permissions.
func TestActiveOrgCookieCannotEscalateToAnotherTenant(t *testing.T) {
	h := newHarness(t, true)
	// Owner in org A, member of both, but with no role in org B.
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")
	h.addMembership(t, h.orgB, h.roleB, "Reader", "crm.read")

	t.Run("tampered cookie falls back", func(t *testing.T) {
		resolved, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgB)
		if err != nil {
			t.Fatal(err)
		}
		// orgB is a real membership here, so it must be honored.
		if resolved.OrgID == nil || *resolved.OrgID != h.orgB {
			t.Fatalf("OrgID = %v, want %s", resolved.OrgID, h.orgB)
		}
		if resolved.HasPermission("iam.admin") {
			t.Fatalf("permissions in org B leaked iam.admin: %v", resolved.Permissions)
		}
		if !resolved.HasPermission("crm.read") {
			t.Fatalf("permissions = %v, want crm.read", resolved.Permissions)
		}
	})

	t.Run("foreign org is never honored", func(t *testing.T) {
		foreign := "00000000-0000-4000-8000-0000000000ff"
		resolved, err := h.resolver.Resolve(context.Background(), h.cookie, foreign)
		if err != nil {
			t.Fatal(err)
		}
		if resolved.IsMemberOf(foreign) {
			t.Fatal("resolver reported membership in a foreign organization")
		}
		if resolved.OrgID != nil && *resolved.OrgID == foreign {
			t.Fatalf("resolver adopted a foreign organization: %s", foreign)
		}
	})

	t.Run("garbage cookie falls back", func(t *testing.T) {
		for _, junk := range []string{"", "   ", "not-a-uuid", "../../etc/passwd", "'; DROP TABLE organizations;--", strings_Upper(h.orgA)} {
			resolved, err := h.resolver.Resolve(context.Background(), h.cookie, junk)
			if err != nil {
				t.Fatalf("Resolve(junk=%q) = %v", junk, err)
			}
			if resolved.OrgID == nil {
				continue
			}
			if *resolved.OrgID != h.orgA && *resolved.OrgID != h.orgB {
				t.Fatalf("junk cookie %q selected organization %s", junk, *resolved.OrgID)
			}
		}
	})
}

func strings_Upper(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'a' && r <= 'z' {
			out[i] = r - 32
		}
	}
	return string(out)
}

// The same role id reused in two organizations must not leak one tenant's
// permission keys into the other, because the join is org-scoped on both sides.
func TestRoleReusedAcrossOrganizationsDoesNotLeakPermissions(t *testing.T) {
	ctx := context.Background()
	t0 := time.Now().UnixNano()
	h := newHarness(t, true)
	roleInA := "eeeeeeee-0000-4000-8000-" + hexTail(t0)
	h.addMembership(t, h.orgA, roleInA, "Shared", "iam.admin")
	// Org B gets its own role, but a stray role_permissions row claiming the
	// org-A role id under org B must not grant anything in org B.
	roleInB := "ffffffff-0000-4000-8000-" + hexTail(t0)
	h.addMembership(t, h.orgB, roleInB, "Shared", "crm.read")
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'iam.admin', $2::uuid)
		 ON CONFLICT DO NOTHING`, roleInA, h.orgB); err != nil {
		t.Fatal(err)
	}

	inA, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if !inA.HasPermission("iam.admin") || inA.HasPermission("crm.read") {
		t.Fatalf("org A permissions = %v, want iam.admin only", inA.Permissions)
	}

	inB, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgB)
	if err != nil {
		t.Fatal(err)
	}
	if !inB.HasPermission("crm.read") || inB.HasPermission("iam.admin") {
		t.Fatalf("org B permissions = %v, want crm.read only", inB.Permissions)
	}
}

// A revoked session and an expired session must both be indistinguishable
// from no session at all.
func TestRevokedAndExpiredSessionsAreRefused(t *testing.T) {
	ctx := context.Background()

	t.Run("revoked", func(t *testing.T) {
		h := newHarness(t, true)
		if _, err := h.resolver.Resolve(ctx, h.cookie, ""); err != nil {
			t.Fatalf("session should resolve before revocation: %v", err)
		}
		if _, err := h.pool.Exec(ctx, `DELETE FROM auth_session WHERE id = $1`, h.sessionID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.resolver.Resolve(ctx, h.cookie, ""); err != ErrNoSession {
			t.Fatalf("revoked session error = %v, want ErrNoSession", err)
		}
	})

	t.Run("expired", func(t *testing.T) {
		h := newHarness(t, true)
		if _, err := h.pool.Exec(ctx,
			`UPDATE auth_session SET expires_at = now() - interval '1 minute' WHERE id = $1`, h.sessionID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.resolver.Resolve(ctx, h.cookie, ""); err != ErrNoSession {
			t.Fatalf("expired session error = %v, want ErrNoSession", err)
		}
	})

	t.Run("expiring exactly now is refused", func(t *testing.T) {
		h := newHarness(t, true)
		if _, err := h.pool.Exec(ctx,
			`UPDATE auth_session SET expires_at = now() WHERE id = $1`, h.sessionID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.resolver.Resolve(ctx, h.cookie, ""); err != ErrNoSession {
			t.Fatalf("boundary expiry error = %v, want ErrNoSession", err)
		}
	})

	t.Run("session row removed out from under a user", func(t *testing.T) {
		h := newHarness(t, true)
		if _, err := h.pool.Exec(ctx, `DELETE FROM auth_user WHERE id = $1`, h.authUserID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.resolver.Resolve(ctx, h.cookie, ""); err != ErrNoSession {
			t.Fatalf("orphaned session error = %v, want ErrNoSession", err)
		}
	})
}

// A verified user with no membership resolves without an organization and
// without permissions rather than erroring, matching the legacy behavior.
func TestVerifiedUserWithoutMembershipGetsNoOrganization(t *testing.T) {
	h := newHarness(t, true)

	resolved, err := h.resolver.Resolve(context.Background(), h.cookie, "")
	if err != nil {
		t.Fatalf("Resolve = %v", err)
	}
	if resolved.OrgID != nil {
		t.Fatalf("OrgID = %v, want nil", resolved.OrgID)
	}
	if len(resolved.Permissions) != 0 {
		t.Fatalf("permissions = %v, want empty", resolved.Permissions)
	}
	if len(resolved.AllOrgIDs) != 0 {
		t.Fatalf("AllOrgIDs = %v, want empty", resolved.AllOrgIDs)
	}
}

func TestBearerSessionUsesTheSameDatabaseIdentityAndRevocationAsCookie(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Bearer fixture", "crm.read")
	cookieResolved, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	bearerResolved, err := h.resolver.ResolveBearerToken(context.Background(), h.sessionTok, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if bearerResolved.UserID != cookieResolved.UserID || bearerResolved.OrgID == nil || *bearerResolved.OrgID != h.orgA || !bearerResolved.HasPermission("crm.read") {
		t.Fatalf("bearer resolution diverged from cookie identity: cookie=%+v bearer=%+v", cookieResolved, bearerResolved)
	}
	otherOrg, err := h.resolver.ResolveBearerToken(context.Background(), h.sessionTok, h.orgB)
	if err != nil || otherOrg.OrgID == nil || *otherOrg.OrgID != h.orgA || !otherOrg.HasPermission("crm.read") {
		t.Fatalf("bearer token did not safely fall back from a non-member organization: %+v err=%v", otherOrg, err)
	}
	if _, err := h.pool.Exec(context.Background(), `DELETE FROM auth_session WHERE id = $1`, h.sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.resolver.ResolveBearerToken(context.Background(), h.sessionTok, h.orgA); err != ErrNoSession {
		t.Fatalf("revoked bearer session still resolved: %v", err)
	}
}

// The resolver mirrors the auth identity into the domain users table, and two
// concurrent first sign-ins for the same address must converge on one identity
// rather than creating two or failing.
func TestConcurrentFirstSignInCreatesExactlyOneDomainIdentity(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	secret := "race-test-secret-0123456789abcdef-0123456789"
	stamp := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "race-" + stamp + "@example.test"
	authUserID := "race-auth-" + stamp

	if _, err := pool.Exec(ctx,
		`INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'Race', $2, true)`,
		authUserID, email); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM auth_user WHERE id = $1`, authUserID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
	})

	const racers = 8
	var wg sync.WaitGroup
	ids := make([]string, racers)
	errs := make([]error, racers)
	start := make(chan struct{})

	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sessionID := fmt.Sprintf("race-sess-%s-%d", stamp, idx)
			token := fmt.Sprintf("race-tok-%s-%d", stamp, idx)
			if _, err := pool.Exec(ctx,
				`INSERT INTO auth_session (id, expires_at, token, user_id)
				 VALUES ($1, now() + interval '1 day', $2, $3)`, sessionID, token, authUserID); err != nil {
				errs[idx] = err
				return
			}
			t.Cleanup(func() {
				_, _ = pool.Exec(context.Background(), `DELETE FROM auth_session WHERE id = $1`, sessionID)
			})
			resolver, err := NewResolver(pool, secret)
			if err != nil {
				errs[idx] = err
				return
			}
			cookie := token + "." + signCookieValue(token, secret)
			<-start
			resolved, err := resolver.Resolve(ctx, cookie, "")
			if err != nil {
				errs[idx] = err
				return
			}
			ids[idx] = resolved.UserID
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("racer %d failed: %v", i, err)
		}
	}
	for i := 1; i < racers; i++ {
		if ids[i] != ids[0] {
			t.Fatalf("racers split into two identities: %q vs %q", ids[0], ids[i])
		}
	}

	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE email = $1`, email).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("concurrent first sign-in created %d domain users, want 1", count)
	}
}

// A NULL enabled_modules means every module is available, while a saved empty
// list is a real restriction. Collapsing the two would silently re-enable or
// silently disable modules.
func TestNullModuleListIsDistinctFromASavedEmptyList(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")
	h.addMembership(t, h.orgB, h.roleB, "Reader", "crm.read")

	restricted, err := h.resolver.Resolve(ctx, h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	var isNull bool
	if err := h.pool.QueryRow(ctx,
		`SELECT enabled_modules IS NULL FROM organizations WHERE id = $1::uuid`, h.orgA).Scan(&isNull); err != nil {
		t.Fatal(err)
	}
	t.Logf("orgA db-is-null=%v resolved-restricted=%v resolved-org=%q", isNull, restricted.ModulesRestricted, derefOrNil(restricted.OrgID))
	if !isNull {
		t.Fatal("fixture is wrong: org A was supposed to have a NULL module list")
	}
	if restricted.ModulesRestricted {
		t.Fatal("org A has a NULL module list, which must not read as restricted")
	}

	// org B was seeded with a saved list.
	inB, err := h.resolver.Resolve(ctx, h.cookie, h.orgB)
	if err != nil {
		t.Fatal(err)
	}
	if !inB.ModulesRestricted {
		t.Fatal("org B has a saved module list and should read as restricted")
	}
	if len(inB.EnabledModules) != 1 || inB.EnabledModules[0] != "crm" {
		t.Fatalf("org B enabled modules = %v, want [crm]", inB.EnabledModules)
	}
}

// A malformed enabled_modules value must fail closed instead of degrading into
// "every module enabled".
func TestMalformedEnabledModulesFailsClosed(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	if _, err := h.pool.Exec(ctx,
		`UPDATE organizations SET enabled_modules = '"not-an-array"'::jsonb WHERE id = $1::uuid`, h.orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := h.resolver.Resolve(ctx, h.cookie, h.orgA); err == nil {
		t.Fatal("a malformed enabled_modules value resolved instead of failing closed")
	}
}

// A wildcard grant must not become an empty permission set.
func TestWildcardGrantResolves(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Superuser", "*")

	resolved, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.HasPermission("*") {
		t.Fatalf("permissions = %v, want the wildcard grant", resolved.Permissions)
	}
}

// The resolver must not be constructible with a short secret, because that
// would silently weaken every signature check it performs.
func TestNewResolverRefusesAShortSecret(t *testing.T) {
	pool := testPool(t)
	for _, secret := range []string{"", "short", "0123456789abcdef0123456789abcde"} {
		if _, err := NewResolver(pool, secret); err != ErrSecretTooShort {
			t.Fatalf("NewResolver(secret=%d bytes) error = %v, want ErrSecretTooShort", len(secret), err)
		}
	}
	if _, err := NewResolver(nil, "0123456789abcdef0123456789abcdef"); err == nil {
		t.Fatal("NewResolver accepted a nil pool")
	}
}

// A tampered cookie must never resolve, even with a valid session row present.
func TestTamperedCookieNeverResolvesAgainstARealSession(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	token := h.sessionTok
	forged := []string{
		token + "." + signCookieValue(token, "attacker-secret-0123456789abcdef-01234"),
		signCookieValue("other-token", h.secret) + "." + signCookieValue(token, h.secret),
		token + "." + signCookieValue(token+"x", h.secret),
		"",
		token,
	}
	for _, cookie := range forged {
		if _, err := h.resolver.Resolve(context.Background(), cookie, ""); err == nil {
			t.Fatalf("forged cookie resolved: %q", cookie)
		}
	}
}
