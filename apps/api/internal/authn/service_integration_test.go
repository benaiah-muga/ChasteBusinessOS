package authn

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAuthFlowIsCompatibleWithRuntimeBetterAuthSchema(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	secret := "better-auth-compatibility-test-secret-0123456789"
	recoveryLink := make(chan string, 4)
	verificationLinks := make(chan string, 4)
	var serviceLogs strings.Builder
	service, err := NewService(pool, secret, Options{
		BaseURL: "http://localhost:3000/api/auth",
		Logger:  slog.New(slog.NewTextHandler(&serviceLogs, nil)),
		VerificationLinkSender: func(_ context.Context, _ string, link string) error {
			verificationLinks <- link
			return nil
		},
		RecoveryLinkSender: func(_ context.Context, _ string, link string) error {
			recoveryLink <- link
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	email := "go-auth-" + time.Now().UTC().Format("20060102150405.000000000") + "@fixture.test"
	user, created, err := service.SignUp(ctx, email, "correct horse battery staple", "Go Auth Fixture")
	if err != nil {
		t.Fatal(err)
	}
	if !created || user.EmailVerified {
		t.Fatalf("signup = created %t, verified %t", created, user.EmailVerified)
	}
	if worked, err := service.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("verification outbox processing worked=%t err=%v", worked, err)
	}
	select {
	case link := <-verificationLinks:
		parsed, err := url.Parse(link)
		if err != nil || parsed.Query().Get("token") == "" {
			t.Fatalf("verification sender received malformed link %q, err=%v", link, err)
		}
	case <-ctx.Done():
		t.Fatal("verification sender did not receive signup link")
	}
	if strings.Contains(serviceLogs.String(), "verify-email") || strings.Contains(serviceLogs.String(), "token=") {
		t.Fatal("verification URL or token was written to logs")
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM auth_verification WHERE value = $1`, user.ID); err != nil {
			t.Errorf("remove auth verification fixtures: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `DELETE FROM auth_user WHERE id = $1`, user.ID); err != nil {
			t.Errorf("remove auth fixture: %v", err)
		}
	})
	if _, _, err := service.SignUp(ctx, email, "different password 123", "Another Name"); err != nil {
		t.Fatalf("duplicate sign-up did not use the generic success branch: %v", err)
	}
	if _, err := service.SignIn(ctx, email, "correct horse battery staple"); !errors.Is(err, ErrEmailNotVerified) {
		t.Fatalf("unverified sign-in error = %v, want ErrEmailNotVerified", err)
	}
	if worked, err := service.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("sign-in verification outbox processing worked=%t err=%v", worked, err)
	}
	verificationToken, err := service.signVerificationToken(email)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.VerifyEmail(ctx, verificationToken); err != nil {
		t.Fatal(err)
	}
	identity, err := service.SignIn(ctx, email, "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if identity.Session.Token == "" || !identity.User.EmailVerified {
		t.Fatalf("sign-in did not issue a verified session: %+v", identity)
	}
	if identity.Session.ExpiresAt.Sub(identity.Session.CreatedAt) != SessionLifetime {
		t.Fatalf("session lifetime = %v, want %v", identity.Session.ExpiresAt.Sub(identity.Session.CreatedAt), SessionLifetime)
	}
	resolved, err := service.GetSession(ctx, identity.Session.Token)
	if err != nil || resolved.User.ID != user.ID {
		t.Fatalf("get-session identity = %+v, err=%v", resolved, err)
	}
	shortSession, err := service.SignInWithRememberMeCallback(ctx, email, "correct horse battery staple", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if shortSession.Session.ExpiresAt.Sub(shortSession.Session.CreatedAt) != NonRememberedSessionLifetime {
		t.Fatalf("non-remembered lifetime = %v, want %v", shortSession.Session.ExpiresAt.Sub(shortSession.Session.CreatedAt), NonRememberedSessionLifetime)
	}
	shortResolved, err := service.GetSession(ctx, shortSession.Session.Token)
	if err != nil || shortResolved.Session.Refreshed {
		t.Fatalf("non-remembered session refreshed: refreshed=%t err=%v", shortResolved.Session.Refreshed, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_session SET expires_at = now() + ($2 * interval '1 second') WHERE token = $1`, identity.Session.Token, int64((SessionLifetime - SessionRefreshUpdateAge - time.Second).Seconds())); err != nil {
		t.Fatal(err)
	}
	refreshed, err := service.GetSession(ctx, identity.Session.Token)
	if err != nil || !refreshed.Session.Refreshed || refreshed.Session.ExpiresAt.Before(time.Now().Add(SessionLifetime-time.Minute)) {
		t.Fatalf("remembered session did not roll forward: session=%+v err=%v", refreshed.Session, err)
	}
	unknownMessage, err := service.RequestPasswordReset(ctx, "missing-"+email, "")
	if err != nil || unknownMessage != recoveryMessage {
		t.Fatalf("unknown recovery response=%q err=%v", unknownMessage, err)
	}
	var failedDeliveryLogs strings.Builder
	failingService, err := NewService(pool, secret, Options{
		BaseURL: "http://localhost:3000/api/auth",
		Logger:  slog.New(slog.NewTextHandler(&failedDeliveryLogs, nil)),
		RecoveryLinkSender: func(_ context.Context, _, link string) error {
			return errors.New("fixture delivery failure for " + link)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	failureMessage, err := failingService.RequestPasswordReset(ctx, email, "")
	if err != nil || failureMessage != recoveryMessage {
		t.Fatalf("failed delivery response=%q err=%v", failureMessage, err)
	}
	if worked, err := failingService.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("failed recovery attempt worked=%t err=%v", worked, err)
	}
	if strings.Contains(failedDeliveryLogs.String(), "reset-password/") || strings.Contains(failedDeliveryLogs.String(), "token=") {
		t.Fatal("failed delivery log exposed a recovery URL or token")
	}
	waitForRecoveryRows(t, ctx, pool, user.ID, 1)
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT attempts FROM auth_email_outbox WHERE kind = 'recovery' AND recipient = $1 ORDER BY created_at DESC LIMIT 1`, email).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("failed outbox attempts=%d err=%v", attempts, err)
	}
	// Simulate a process that claimed the row and died. A fresh service can
	// reclaim it once its database lease expires.
	if _, err := pool.Exec(ctx, `UPDATE auth_email_outbox SET available_at = now(), lease_owner = 'dead-process', lease_expires_at = now() - interval '1 second' WHERE kind = 'recovery' AND recipient = $1`, email); err != nil {
		t.Fatal(err)
	}
	reclaimService, err := NewService(pool, secret, Options{
		BaseURL: "http://localhost:3000/api/auth",
		RecoveryLinkSender: func(_ context.Context, _ string, link string) error {
			recoveryLink <- link
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := reclaimService.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("reclaimed recovery attempt worked=%t err=%v", worked, err)
	}
	var reclaimedRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_email_outbox WHERE kind = 'recovery' AND recipient = $1`, email).Scan(&reclaimedRows); err != nil || reclaimedRows != 0 {
		t.Fatalf("successfully reclaimed outbox rows=%d err=%v", reclaimedRows, err)
	}
	var deliveredLink string
	select {
	case deliveredLink = <-recoveryLink:
	case <-ctx.Done():
		t.Fatal("configured recovery sender did not receive a reset link")
	}
	parsedLink, err := url.Parse(deliveredLink)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(parsedLink.Path, "/")
	recoveryToken := parts[len(parts)-1]
	if recoveryToken == "" {
		t.Fatal("reset URL did not carry a token in its path")
	}
	if err := service.ResetPassword(ctx, recoveryToken, "new correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetSession(ctx, identity.Session.Token); err == nil {
		t.Fatal("password reset left the old session usable")
	}
	if err := service.ResetPassword(ctx, recoveryToken, "other new correct horse battery staple"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("replayed reset token error=%v, want ErrInvalidToken", err)
	}
	_, err = service.RequestPasswordReset(ctx, email, "")
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := service.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("second recovery outbox processing worked=%t err=%v", worked, err)
	}
	var expiredDeliveredLink string
	select {
	case expiredDeliveredLink = <-recoveryLink:
	case <-ctx.Done():
		t.Fatal("configured recovery sender did not receive the second reset link")
	}
	parsedExpiredLink, err := url.Parse(expiredDeliveredLink)
	if err != nil {
		t.Fatal(err)
	}
	expiredParts := strings.Split(parsedExpiredLink.Path, "/")
	expiredToken := expiredParts[len(expiredParts)-1]
	if _, err := pool.Exec(ctx, `UPDATE auth_verification SET expires_at = now() - interval '1 second' WHERE identifier = $1`, "reset-password:"+expiredToken); err != nil {
		t.Fatal(err)
	}
	if err := service.ResetPassword(ctx, expiredToken, "another correct horse battery staple"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expired reset token error=%v, want ErrInvalidToken", err)
	}
	if _, err := service.RequestPasswordReset(ctx, "missing-"+email, ""); err != nil {
		t.Fatal(err)
	}
	var expiredRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_verification WHERE identifier = $1`, "reset-password:"+expiredToken).Scan(&expiredRows); err != nil {
		t.Fatal(err)
	}
	if expiredRows != 0 {
		t.Fatalf("expired reset row was not pruned: count=%d", expiredRows)
	}
	if _, err := service.RequestPasswordReset(ctx, email, ""); err != nil {
		t.Fatal(err)
	}
	var expiredMailIdentifier string
	if err := pool.QueryRow(ctx, `SELECT token_identifier FROM auth_email_outbox WHERE kind = 'recovery' AND recipient = $1 ORDER BY created_at DESC LIMIT 1`, email).Scan(&expiredMailIdentifier); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_email_outbox SET expires_at = now() - interval '1 second' WHERE token_identifier = $1`, expiredMailIdentifier); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_verification SET expires_at = now() - interval '1 second' WHERE identifier = $1`, expiredMailIdentifier); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ProcessEmailOutboxOnce(ctx); err != nil {
		t.Fatalf("process expired auth mail outbox: %v", err)
	}
	var expiredMailRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_email_outbox WHERE token_identifier = $1`, expiredMailIdentifier).Scan(&expiredMailRows); err != nil || expiredMailRows != 0 {
		t.Fatalf("expired auth mail rows=%d err=%v", expiredMailRows, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_verification WHERE identifier = $1`, expiredMailIdentifier).Scan(&expiredRows); err != nil || expiredRows != 0 {
		t.Fatalf("expired linked recovery rows=%d err=%v", expiredRows, err)
	}
	if _, err := service.SignIn(ctx, email, "correct horse battery staple"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("old password after reset error=%v, want invalid credentials", err)
	}
	newIdentity, err := service.SignIn(ctx, email, "new correct horse battery staple")
	if err != nil {
		t.Fatalf("new password did not sign in: %v", err)
	}
	if err := service.RevokeSession(ctx, newIdentity.Session.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetSession(ctx, newIdentity.Session.Token); err == nil {
		t.Fatal("revoked session remained usable")
	}
	if _, err := service.RequestPasswordReset(ctx, email, ""); err != nil {
		t.Fatalf("queue delayed recovery message: %v", err)
	}
	var delayedIdentifier, delayedLink string
	if err := pool.QueryRow(ctx, `SELECT token_identifier, link FROM auth_email_outbox WHERE kind = 'recovery' AND recipient = $1 ORDER BY created_at DESC LIMIT 1`, email).Scan(&delayedIdentifier, &delayedLink); err != nil {
		t.Fatal(err)
	}
	delayedURL, err := url.Parse(delayedLink)
	if err != nil {
		t.Fatal(err)
	}
	delayedParts := strings.Split(delayedURL.Path, "/")
	delayedToken := delayedParts[len(delayedParts)-1]
	if delayedToken == "" || delayedIdentifier != "reset-password:"+delayedToken {
		t.Fatal("queued recovery token did not match its outbox identifier")
	}
	if err := service.ResetPassword(ctx, delayedToken, "delayed reset correct horse battery staple"); err != nil {
		t.Fatalf("consume delayed recovery token: %v", err)
	}
	var delayedRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_email_outbox WHERE token_identifier = $1`, delayedIdentifier).Scan(&delayedRows); err != nil || delayedRows != 0 {
		t.Fatalf("consumed recovery token left delayed outbox rows=%d err=%v", delayedRows, err)
	}
}

func waitForRecoveryRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_verification WHERE identifier LIKE 'reset-password:%' AND value = $1`, userID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("recovery row count for user %s did not become %d", userID, want)
}
