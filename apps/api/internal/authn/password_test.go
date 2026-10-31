package authn

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// This fixed vector was derived from Better Auth 1.7.1's installed
// @better-auth/utils 0.4.2 password.node.mjs implementation.
func TestVerifyPasswordReadsBetterAuth171ScryptHashes(t *testing.T) {
	const encoded = "00112233445566778899aabbccddeeff:f5b22309b28fe412c82a4b2cab57498b8f8a42c849af16cb908974048f61c13933421858db3a8f111430bdc493c7cef90f61f904061c77206e3820a2e8b11bc2"
	valid, err := VerifyPassword(encoded, "correct horse battery staple")
	if err != nil || !valid {
		t.Fatalf("Better Auth fixture did not verify: valid=%t err=%v", valid, err)
	}
	valid, err = VerifyPassword(encoded, "incorrect horse battery staple")
	if err != nil || valid {
		t.Fatalf("wrong password result: valid=%t err=%v", valid, err)
	}
}

func TestHashPasswordIsNFKCCompatible(t *testing.T) {
	encoded, err := HashPassword("Cafe\u0301 123")
	if err != nil {
		t.Fatal(err)
	}
	valid, err := VerifyPassword(encoded, "Caf\u00e9 123")
	if err != nil || !valid {
		t.Fatalf("NFKC-equivalent password did not verify: valid=%t err=%v", valid, err)
	}
}

func TestPasswordLengthUsesJavaScriptStringUnits(t *testing.T) {
	if got := PasswordLength(strings.Repeat("a", 8)); got != 8 {
		t.Fatalf("ASCII length = %d, want 8", got)
	}
	if got := PasswordLength("😀😀😀😀"); got != 8 {
		t.Fatalf("supplementary character length = %d, want 8 UTF-16 units", got)
	}
}

func TestBetterAuthVerificationJWTCompatibilityAndExpiry(t *testing.T) {
	secret := "a-test-secret-with-at-least-32-bytes"
	now := time.Unix(1_800_000_000, 0)
	// jose/Better Auth uses a compact HS256 JWT with email, iat, and exp claims.
	token, err := signJWT(secret, map[string]any{"email": "person@example.test", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	email, err := verifyJWT(secret, token, now)
	if err != nil || email != "person@example.test" {
		t.Fatalf("verification = %q, %v", email, err)
	}
	if _, err := verifyJWT(secret+"x", token, now); err == nil {
		t.Fatal("JWT signed by a different secret was accepted")
	}
	if _, err := verifyJWT(secret, token, now.Add(2*time.Hour)); err == nil {
		t.Fatal("expired verification token was accepted")
	}
}

func TestRecoveryWithoutDeliveryProviderFailsClosedWithoutAccountLookup(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := NewService(pool, "this-is-a-long-enough-test-auth-secret", Options{BaseURL: "http://localhost:3000/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	message, err := service.RequestPasswordReset(t.Context(), "nobody@example.test", "")
	if !errors.Is(err, ErrDeliveryUnavailable) || message != "" {
		t.Fatalf("response=%q err=%v", message, err)
	}
}

func TestSignUpWithoutVerificationProviderFailsClosedBeforeDatabaseLookup(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := NewService(pool, "this-is-a-long-enough-test-auth-secret", Options{BaseURL: "http://localhost:3000/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.SignUp(t.Context(), "new@example.test", "correct horse battery staple", "New User"); !errors.Is(err, ErrDeliveryUnavailable) {
		t.Fatalf("sign-up without SMTP error=%v, want ErrDeliveryUnavailable", err)
	}
}

func TestAuthEmailRetryDelayIsBounded(t *testing.T) {
	if got := authEmailRetryDelay(1); got != time.Second {
		t.Fatalf("first retry delay=%v, want 1s", got)
	}
	if got := authEmailRetryDelay(100); got != mailRetryMax {
		t.Fatalf("maximum retry delay=%v, want %v", got, mailRetryMax)
	}
}
