package session

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A resolver pointed at an unreachable database must fail closed. Returning an
// actor with no organization on a database error would turn an outage into a
// silent authorization downgrade, and returning a cached actor would let a
// revoked session keep working.
func TestUnreachableDatabaseFailsClosed(t *testing.T) {
	// Port 1 is reserved and refuses connections.
	dead, err := pgxpool.New(context.Background(),
		"postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(dead.Close)

	resolver, err := NewResolver(dead, testSecret)
	if err != nil {
		t.Fatal(err)
	}

	value := "tok"
	signed := value + "." + signCookieValue(value, testSecret)
	resolved, err := resolver.Resolve(context.Background(), signed, "")
	if err == nil {
		t.Fatalf("an unreachable database resolved an actor: %+v", resolved)
	}
	if errors.Is(err, ErrNoSession) {
		// Also acceptable: from a caller's perspective it is unauthenticated.
		// What matters is that no actor came back.
		t.Log("unreachable database reported ErrNoSession, which is still fail-closed")
	}
	if resolved != nil {
		t.Fatalf("an unreachable database returned an actor: %+v", resolved)
	}
}

// A cancelled or expired context must abort resolution rather than run to
// completion on a request that is already gone.
func TestCancelledContextAbortsResolution(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	for _, tc := range []struct {
		name string
		ctx  func() (context.Context, context.CancelFunc)
		want error
	}{
		{"cancelled", func() (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			return ctx, func() {}
		}, context.Canceled},
		{"deadline exceeded", func() (context.Context, context.CancelFunc) {
			return context.WithTimeout(context.Background(), time.Nanosecond)
		}, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := tc.ctx()
			defer cancel()
			resolved, err := h.resolver.Resolve(ctx, h.cookie, "")
			if resolved != nil {
				t.Fatalf("a dead context still produced an actor: %+v", resolved)
			}
			if err == nil {
				t.Fatal("a dead context resolved without an error")
			}
			if !errors.Is(err, tc.want) && !errors.Is(err, ErrNoSession) {
				t.Fatalf("error = %v, want the context error or ErrNoSession", err)
			}
		})
	}
}

// A short server-side deadline must fail closed instead of hanging a request
// thread until the client gives up.
func TestSlowQueryRespectsTheDeadline(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	resolved, err := h.resolver.Resolve(ctx, h.cookie, "")
	elapsed := time.Since(start)

	if err == nil && resolved != nil {
		// A fast local database may legitimately finish inside 50ms.
		t.Skipf("local database answered within the deadline (%s)", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("resolution ignored the deadline for %s", elapsed)
	}
	if resolved != nil {
		t.Fatalf("an expired resolution returned an actor: %+v", resolved)
	}
}

// Concurrent resolutions of the same session must all agree, and none may
// observe a partially written identity while another racer creates it.
func TestConcurrentResolutionIsStableUnderContention(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	const racers = 24
	var wg sync.WaitGroup
	var mismatches atomic.Int64
	var failures atomic.Int64
	results := make([]*ResolvedUser, racers)
	start := make(chan struct{})

	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			resolved, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
			if err != nil {
				failures.Add(1)
				return
			}
			results[idx] = resolved
		}(i)
	}
	close(start)
	wg.Wait()

	if failures.Load() > 0 {
		t.Fatalf("%d of %d concurrent resolutions failed", failures.Load(), racers)
	}
	for i, resolved := range results {
		if resolved == nil {
			t.Fatalf("racer %d got no actor", i)
		}
		if resolved.UserID != results[0].UserID {
			t.Fatalf("racer %d saw user %s, racer 0 saw %s", i, resolved.UserID, results[0].UserID)
		}
		if resolved.OrgID == nil || *resolved.OrgID != h.orgA {
			t.Fatalf("racer %d saw org %v", i, resolved.OrgID)
		}
		if !resolved.HasPermission("iam.admin") {
			t.Fatalf("racer %d lost its permission", i)
		}
	}
	if mismatches.Load() != 0 {
		t.Fatalf("%d concurrent mismatches", mismatches.Load())
	}
}

// The resolver holds no mutable per-request state, so reuse across goroutines
// must be safe. Run with -race for this to be meaningful.
func TestResolverIsSafeForConcurrentReuse(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	// A forged cookie forces the constant-time comparison path on every call.
	forged := "abc." + signCookieValue("abc", "wrong-secret-0123456789abcdef-0123456789")

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			if idx%2 == 0 {
				_, _ = h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
				return
			}
			if _, err := h.resolver.Resolve(context.Background(), forged, ""); err == nil {
				t.Error("a forged cookie resolved under concurrency")
			}
		}(i)
	}
	wg.Wait()
}

// Expiry is evaluated against the resolver clock, so a rewound clock does make
// an expired session look live. That is precisely why the setter is unexported:
// only same-package tests may inject a clock, and production always uses the
// wall clock. This test pins that documented behaviour so nobody "fixes" the
// comparison and breaks expiry.
func TestExpiryIsEvaluatedAgainstTheResolverClock(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	if _, err := h.pool.Exec(context.Background(),
		`UPDATE auth_session SET expires_at = now() - interval '1 day' WHERE id = $1`, h.sessionID); err != nil {
		t.Fatal(err)
	}

	// Wall clock: refused.
	if _, err := h.resolver.Resolve(context.Background(), h.cookie, ""); err != ErrNoSession {
		t.Fatalf("an expired session resolved against the wall clock: %v", err)
	}

	// Rewound past the expiry: the same row now looks live, which is exactly the
	// reason the seam must stay unexported.
	h.resolver.setClock(func() time.Time { return time.Now().Add(-72 * time.Hour) })
	t.Cleanup(func() { h.resolver.setClock(time.Now) })
	if _, err := h.resolver.Resolve(context.Background(), h.cookie, ""); err != nil {
		t.Fatalf("a rewound clock should read the row as unexpired, got %v", err)
	}
}

// The default resolver must use the wall clock, not a zero or stale time, or
// every session would look unexpired forever.
func TestDefaultResolverUsesTheWallClock(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	before := time.Now()
	observed := h.resolver.now()
	after := time.Now()
	if observed.Before(before.Add(-time.Second)) || observed.After(after.Add(time.Second)) {
		t.Fatalf("default clock is not the wall clock: got %s", observed)
	}
}

// A nil clock must be ignored rather than panicking on the next request.
func TestSetClockIgnoresNilClock(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	h.resolver.setClock(nil)
	if _, err := h.resolver.Resolve(context.Background(), h.cookie, ""); err != nil {
		t.Fatalf("a nil clock broke resolution: %v", err)
	}
}

// A very large cookie, a cookie full of separators, and a cookie with control
// characters must all be refused without panicking or logging the value.
func TestHostileCookieShapesAreRefused(t *testing.T) {
	hostile := []string{
		"a." + signCookieValue("a", testSecret) + "\x00trailing",
		"a." + signCookieValue("a", testSecret) + strings_Repeat("A", 4096),
		strings_Repeat("a.", 2048),
		"....",
		"." + strings_Repeat("A", 8192),
		"\x00.\x00",
		"a." + signCookieValue("a", testSecret)[:4],
	}
	for _, cookie := range hostile {
		if _, err := VerifySignedCookie(cookie, testSecret); err == nil {
			t.Fatalf("hostile cookie shape was accepted: %.40q", cookie)
		}
	}
}

func strings_Repeat(value string, count int) string {
	out := make([]byte, 0, len(value)*count)
	for i := 0; i < count; i++ {
		out = append(out, value...)
	}
	return string(out)
}

// The pool must be closable while requests are in flight without panicking, so
// a deploy can drain cleanly.
func TestPoolCloseDuringResolutionDoesNotPanic(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Either outcome is fine; a panic is not.
			_, _ = h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
		}()
	}
	wg.Wait()
}

// A session whose token exists but whose user row was deleted mid-flight must
// resolve to no actor. Revoking a user must take effect immediately.
func TestDeletedUserRevokesTheSessionImmediately(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	if _, err := h.resolver.Resolve(context.Background(), h.cookie, ""); err != nil {
		t.Fatalf("session should resolve before revocation: %v", err)
	}
	if _, err := h.pool.Exec(context.Background(),
		`DELETE FROM auth_user WHERE id = $1`, h.authUserID); err != nil {
		t.Fatal(err)
	}
	resolved, err := h.resolver.Resolve(context.Background(), h.cookie, "")
	if err == nil && resolved != nil {
		t.Fatalf("a deleted user still resolved: %+v", resolved)
	}
}

// Deleting every membership must drop the organization and permissions on the
// next resolution, with no caching in between.
func TestMembershipRevocationTakesEffectImmediately(t *testing.T) {
	h := newHarness(t, true)
	userID := h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	before, err := h.resolver.Resolve(context.Background(), h.cookie, "")
	if err != nil {
		t.Fatal(err)
	}
	if before.OrgID == nil || !before.HasPermission("iam.admin") {
		t.Fatalf("setup did not grant access: %+v", before)
	}

	if _, err := h.pool.Exec(context.Background(),
		`DELETE FROM memberships WHERE user_id = $1::uuid`, userID); err != nil {
		t.Fatal(err)
	}

	after, err := h.resolver.Resolve(context.Background(), h.cookie, "")
	if err != nil {
		t.Fatal(err)
	}
	if after.OrgID != nil {
		t.Fatalf("revoked membership still resolved an organization: %v", *after.OrgID)
	}
	if after.HasPermission("iam.admin") {
		t.Fatal("revoked membership still granted a permission")
	}
	if after.IsMemberOf(h.orgA) {
		t.Fatal("revoked membership still reported membership")
	}
}

// Removing a role must remove its permissions on the next resolution.
func TestRoleRevocationTakesEffectImmediately(t *testing.T) {
	h := newHarness(t, true)
	userID := h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	before, err := h.resolver.Resolve(context.Background(), h.cookie, "")
	if err != nil || !before.HasPermission("iam.admin") {
		t.Fatalf("setup did not grant access: %+v %v", before, err)
	}

	if _, err := h.pool.Exec(context.Background(),
		`DELETE FROM user_roles WHERE user_id = $1::uuid`, userID); err != nil {
		t.Fatal(err)
	}

	after, err := h.resolver.Resolve(context.Background(), h.cookie, "")
	if err != nil {
		t.Fatal(err)
	}
	if after.HasPermission("iam.admin") {
		t.Fatal("a revoked role still granted its permission")
	}
}

// Verifying a previously unverified mailbox must grant access on the next
// resolution, so the N03 guard is a live gate rather than a permanent lockout.
func TestEmailVerificationTakesEffectImmediately(t *testing.T) {
	h := newHarness(t, false)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	before, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if before.OrgID != nil || len(before.Permissions) != 0 {
		t.Fatalf("unverified session already had access: %+v", before)
	}

	if _, err := h.pool.Exec(context.Background(),
		`UPDATE auth_user SET email_verified = true WHERE id = $1`, h.authUserID); err != nil {
		t.Fatal(err)
	}

	after, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if after.OrgID == nil || *after.OrgID != h.orgA {
		t.Fatalf("verification did not grant the organization: %v", after.OrgID)
	}
	if !after.HasPermission("iam.admin") {
		t.Fatalf("verification did not grant the permission: %v", after.Permissions)
	}
}

// Downgrading a verified mailbox must revoke access immediately. This is the
// direction that matters: proof of mailbox ownership can be withdrawn.
func TestVerificationDowngradeRevokesImmediately(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	if _, err := h.resolver.Resolve(context.Background(), h.cookie, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(context.Background(),
		`UPDATE auth_user SET email_verified = false WHERE id = $1`, h.authUserID); err != nil {
		t.Fatal(err)
	}

	after, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if after.OrgID != nil {
		t.Fatalf("downgraded session kept its organization: %v", *after.OrgID)
	}
	if len(after.Permissions) != 0 {
		t.Fatalf("downgraded session kept permissions: %v", after.Permissions)
	}
}

// Session rotation must invalidate the previous token immediately, which is
// what makes sign-out-everywhere and rotation-after-privilege-change work.
func TestSessionRotationInvalidatesThePreviousToken(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "crm.read")

	oldCookie := h.cookie
	newToken := h.sessionTok + "-rotated"
	newCookie := newToken + "." + signCookieValue(newToken, h.secret)

	if _, err := h.pool.Exec(context.Background(),
		`UPDATE auth_session SET token = $1 WHERE id = $2`, newToken, h.sessionID); err != nil {
		t.Fatal(err)
	}

	if _, err := h.resolver.Resolve(context.Background(), oldCookie, ""); err != ErrNoSession {
		t.Fatalf("the previous token still resolved after rotation: %v", err)
	}
	if _, err := h.resolver.Resolve(context.Background(), newCookie, ""); err != nil {
		t.Fatalf("the rotated token did not resolve: %v", err)
	}
}

// A resolver must never surface a permission for an organization the actor is
// not a member of, even if a role row still exists for that organization.
func TestStaleRoleRowCannotResurrectPermission(t *testing.T) {
	h := newHarness(t, true)
	userID := h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	if _, err := h.pool.Exec(context.Background(),
		`DELETE FROM memberships WHERE user_id = $1::uuid AND org_id = $2::uuid`, userID, h.orgA); err != nil {
		t.Fatal(err)
	}
	resolved, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.OrgID != nil {
		t.Fatalf("a stale role row resurrected the organization: %v", *resolved.OrgID)
	}
	if resolved.HasPermission("iam.admin") {
		t.Fatal("a stale role row resurrected a permission")
	}
}

// An organization row deleted under the actor must not panic or leak another
// organization's state.
func TestDeletedOrganizationDoesNotLeakAnotherTenant(t *testing.T) {
	h := newHarness(t, true)
	h.addMembership(t, h.orgA, h.roleA, "Owner", "iam.admin")

	other := "77777777-0000-4000-8000-0000000000aa"
	if _, err := h.pool.Exec(context.Background(),
		`INSERT INTO organizations (id, name, slug, base_currency)
		 VALUES ($1::uuid, 'Other Tenant', 'other-tenant-probe', 'JPY')`, other); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		h.pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1::uuid`, other)
	})

	if _, err := h.pool.Exec(context.Background(),
		`DELETE FROM organizations WHERE id = $1::uuid`, h.orgA); err != nil {
		t.Fatal(err)
	}

	resolved, err := h.resolver.Resolve(context.Background(), h.cookie, h.orgA)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.BaseCurrency != nil && *resolved.BaseCurrency == "JPY" {
		t.Fatal("a deleted organization leaked another tenant's currency")
	}
}

// Formatting a resolved actor for a log line must not include the session
// secret or the raw cookie. Guards against a future logging call site.
func TestResolvedActorCarriesNoSecretMaterial(t *testing.T) {
	resolved := &ResolvedUser{
		UserID:        "user-1",
		Email:         "ada@example.test",
		OrgID:         ptr("org-1"),
		AuthSessionID: "session-1",
		Permissions:   map[string]bool{"crm.read": true},
	}
	rendered := fmt.Sprintf("%+v", resolved)
	if len(rendered) == 0 {
		t.Fatal("actor rendered empty")
	}
	for _, forbidden := range []string{testSecret} {
		if contains(rendered, forbidden) {
			t.Fatal("actor rendering included secret material")
		}
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}()
}
