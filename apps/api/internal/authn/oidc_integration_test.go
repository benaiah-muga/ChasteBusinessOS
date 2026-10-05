package authn

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOIDCNativeHandoffIsPKCEBoundAndSingleUse(t *testing.T) {
	databaseURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := NewService(pool, "oidc-integration-test-secret-0123456789", Options{BaseURL: "https://api.example.test/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	verifier := "native-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	stamp := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "oidc-handoff-" + stamp + "@fixture.test"
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM auth_user WHERE email = $1`, email) })
	identity, err := service.SignInOIDC(ctx, "https://issuer.fixture.test", "native-handoff-"+stamp, email, "Native Handoff Fixture", true, true)
	if err != nil {
		t.Fatalf("create OIDC session for handoff test: %v", err)
	}
	code, err := service.CreateOIDCNativeHandoff(ctx, challenge, identity.Session.ID)
	if err != nil {
		t.Fatalf("create native handoff: %v", err)
	}
	if code == identity.Session.Token || code == "" {
		t.Fatal("handoff code must be an opaque value distinct from the session token")
	}
	if _, err := service.ConsumeOIDCNativeHandoff(ctx, code, verifier+"x"); !errors.Is(err, ErrInvalidOIDCNativeHandoff) {
		t.Fatalf("wrong verifier error=%v, want invalid handoff", err)
	}
	if _, err := service.ConsumeOIDCNativeHandoff(ctx, code, verifier); !errors.Is(err, ErrInvalidOIDCNativeHandoff) {
		t.Fatalf("code remained usable after failed verification: %v", err)
	}

	code, err = service.CreateOIDCNativeHandoff(ctx, challenge, identity.Session.ID)
	if err != nil {
		t.Fatalf("create second native handoff: %v", err)
	}
	token, err := service.ConsumeOIDCNativeHandoff(ctx, code, verifier)
	if err != nil || token != identity.Session.Token {
		t.Fatalf("consume native handoff token=%q err=%v", token, err)
	}
	if _, err := service.ConsumeOIDCNativeHandoff(ctx, code, verifier); !errors.Is(err, ErrInvalidOIDCNativeHandoff) {
		t.Fatalf("replay error=%v, want invalid handoff", err)
	}
	code, err = service.CreateOIDCNativeHandoff(ctx, challenge, identity.Session.ID)
	if err != nil {
		t.Fatalf("create handoff for revoked session: %v", err)
	}
	if err := service.RevokeSession(ctx, identity.Session.Token); err != nil {
		t.Fatalf("revoke test session: %v", err)
	}
	if _, err := service.ConsumeOIDCNativeHandoff(ctx, code, verifier); !errors.Is(err, ErrInvalidOIDCNativeHandoff) {
		t.Fatalf("revoked session handoff error=%v, want invalid handoff", err)
	}
}

func TestOIDCIdentityLinkingRequiresExplicitVerifiedEmailTrust(t *testing.T) {
	databaseURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := NewService(pool, "oidc-integration-test-secret-0123456789", Options{BaseURL: "https://api.example.test/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	state := "state-" + fmt.Sprintf("%040x", time.Now().UnixNano())
	transaction := OIDCTransaction{Nonce: "nonce-0123456789-0123456789-0123456789", CodeVerifier: "verifier-0123456789-0123456789-0123456789-0123456789", ReturnTo: "/settings"}
	if err := service.CreateOIDCTransaction(ctx, state, transaction); err != nil {
		t.Fatalf("create state transaction: %v", err)
	}
	consumed, err := service.ConsumeOIDCTransaction(ctx, state)
	if err != nil || consumed != transaction {
		t.Fatalf("consume state transaction = %#v, %v", consumed, err)
	}
	if _, err := service.ConsumeOIDCTransaction(ctx, state); !errors.Is(err, ErrInvalidOIDCTransaction) {
		t.Fatalf("state replay error=%v, want invalid transaction", err)
	}
	stamp := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "oidc-" + stamp + "@fixture.test"
	issuer, subject := "https://issuer.fixture.test", "subject-"+stamp
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM auth_user WHERE email = $1`, email)
	})
	if _, err := service.SignInOIDC(ctx, issuer, subject, email, "OIDC Fixture", true, false); !errors.Is(err, ErrOIDCEmailUntrusted) {
		t.Fatalf("untrusted email linking error=%v, want ErrOIDCEmailUntrusted", err)
	}
	var usersBefore int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_user WHERE email = $1`, email).Scan(&usersBefore); err != nil {
		t.Fatal(err)
	}
	if usersBefore != 0 {
		t.Fatal("untrusted issuer created an account")
	}
	identity, err := service.SignInOIDC(ctx, issuer, subject, email, "OIDC Fixture", true, true)
	if err != nil {
		t.Fatalf("trusted first sign-in: %v", err)
	}
	if identity.User.Email != email || !identity.User.EmailVerified || identity.Session.Token == "" {
		t.Fatal("OIDC sign-in did not return the verified Go-owned identity and session")
	}
	if _, err := service.SignInOIDC(ctx, issuer, subject, email, "OIDC Fixture", true, false); err != nil {
		t.Fatalf("existing issuer+subject should remain usable without email-link trust: %v", err)
	}
	if _, err := service.SignInOIDC(ctx, issuer, subject, "changed-"+stamp+"@fixture.test", "OIDC Fixture", true, true); !errors.Is(err, ErrOIDCEmailChanged) {
		t.Fatalf("changed subject email error=%v, want ErrOIDCEmailChanged", err)
	}
	var linked int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_account WHERE provider_id = 'oidc' AND issuer = $1 AND account_id = $2 AND user_id = $3`, issuer, subject, identity.User.ID).Scan(&linked); err != nil {
		t.Fatal(err)
	}
	if linked != 1 {
		t.Fatalf("issuer+subject links=%d, want one", linked)
	}
}
