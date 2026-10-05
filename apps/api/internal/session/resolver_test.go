package session

import (
	"encoding/base64"
	"strings"
	"testing"
)

const testSecret = "0123456789abcdef0123456789abcdef"

func TestVerifySignedCookieAcceptsAGenuineSignature(t *testing.T) {
	value := "abc123"
	signed := value + "." + signCookieValue(value, testSecret)
	token, err := VerifySignedCookie(signed, testSecret)
	if err != nil {
		t.Fatalf("VerifySignedCookie(%q) = %v", signed, err)
	}
	if token != value {
		t.Fatalf("token = %q, want %q", token, value)
	}
}

func TestVerifySignedCookieRejectsEveryForgery(t *testing.T) {
	token := "abc123"
	good := signCookieValue(token, testSecret)

	cases := []struct {
		name  string
		input string
	}{
		{"empty", ""},
		{"no separator", token},
		{"token only with dot", "."},
		{"signature only with dot", token + "."},
		{"empty token", "." + good},
		{"wrong secret", token + "." + signCookieValue(token, strings.Repeat("z", 32))},
		{"swapped token", "xyz789." + good},
		{"truncated signature", token + "." + good[:len(good)-4]},
		{"extended signature", token + "." + good + "AAAA"},
		{"flipped signature byte", token + "." + flipLast(good)},
		{"signature of empty", token + "." + signCookieValue("", testSecret)},
		{"non base64 signature", token + "." + strings.Repeat("!", 44)},
		{"whitespace padded", " " + token + "." + good + " "},
		{"newline injected", token + "." + good + "\n"},
		{"null byte in token", "ab\x00c." + good},
		{"only a dot pair of dots", token + ".." + good},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := VerifySignedCookie(tc.input, testSecret); err == nil {
				t.Fatalf("VerifySignedCookie(%q) accepted a forgery", tc.input)
			}
		})
	}
}

func flipLast(s string) string {
	if s == "" {
		return "x"
	}
	last := s[len(s)-1]
	replacement := byte('A')
	if last == 'A' {
		replacement = 'B'
	}
	return s[:len(s)-1] + string(replacement)
}

func TestVerifySignedCookieRefusesAShortSecret(t *testing.T) {
	value := "abc123"
	short := strings.Repeat("a", 8)
	signed := value + "." + signCookieValue(value, short)

	// A short secret must never verify, because HMAC with a guessable key is
	// not a signature. This is the fail-closed direction.
	if _, err := VerifySignedCookie(signed, short); err != ErrSecretTooShort {
		t.Fatalf("short secret error = %v, want ErrSecretTooShort", err)
	}
	if _, err := VerifySignedCookie(signed, strings.Repeat("a", 31)); err != ErrSecretTooShort {
		t.Fatalf("31-byte secret error = %v, want ErrSecretTooShort", err)
	}
	// Exactly at the floor the signature is checked normally and passes.
	if _, err := VerifySignedCookie(signed, short+strings.Repeat("a", 24)); err == nil {
		t.Fatal("a signature made with a different key verified at the length floor")
	}
	ok := value + "." + signCookieValue(value, strings.Repeat("a", 32))
	if _, err := VerifySignedCookie(ok, strings.Repeat("a", 32)); err != nil {
		t.Fatalf("32-byte secret rejected its own signature: %v", err)
	}
}

func TestSignatureMatchesRealBetterAuthCookie(t *testing.T) {
	// Golden vector captured from a real signed-in browser session. It pins the
	// algorithm to Better Auth's actual output: HMAC-SHA256 over the raw token
	// with the secret's UTF-8 bytes, encoded with STANDARD base64. A switch to
	// url-safe base64, or a hash of the secret, would invalidate every live
	// session and this test would catch it.
	const secret = "test-secret-0123456789abcdef-0123456789"
	const token = "EG38mh5xL7Qqs4FHeU5NNk1jPBUOsirG"
	const signature = "W++Or0R4eplcBDiOvPk70dItq3C9UEk3OKQEIv1DZfk="

	if got := signCookieValue(token, secret); got != signature {
		t.Fatalf("signCookieValue = %q, want %q", got, signature)
	}

	// Standard base64, not the url-safe alphabet.
	if strings.ContainsAny(signature, "-_") {
		t.Fatalf("golden signature is not standard base64: %q", signature)
	}
	if _, err := base64.StdEncoding.DecodeString(signature); err != nil {
		t.Fatalf("golden signature does not decode as standard base64: %v", err)
	}

	verified, err := VerifySignedCookie(token+"."+signature, secret)
	if err != nil {
		t.Fatalf("VerifySignedCookie on the golden vector = %v", err)
	}
	if verified != token {
		t.Fatalf("verified token = %q, want %q", verified, token)
	}
}

func TestSplitSignedCookieKeepsExtraDotsVisible(t *testing.T) {
	// A token containing a dot must not be silently truncated into a
	// different value that happens to verify.
	token, signature, err := SplitSignedCookie("a.b.c")
	if err != nil {
		t.Fatalf("SplitSignedCookie = %v", err)
	}
	if token != "a" || signature != "b.c" {
		t.Fatalf("SplitSignedCookie = %q, %q", token, signature)
	}
	if _, err := VerifySignedCookie("a.b.c", testSecret); err == nil {
		t.Fatal("multi-dot cookie with an invalid signature was accepted")
	}
}

func TestURLEscapedCookieRoundTrips(t *testing.T) {
	value := "abc+/=def"
	signed := value + "." + signCookieValue(value, testSecret)
	// Browsers and proxies may percent-encode the base64 alphabet.
	escaped := strings.NewReplacer("+", "%2B", "/", "%2F", "=", "%3D").Replace(signed)
	if escaped == signed {
		t.Fatal("fixture did not actually contain characters needing escaping")
	}
	token, err := VerifySignedCookie(urlUnescapeCookie(escaped), testSecret)
	if err != nil {
		t.Fatalf("escaped cookie rejected: %v", err)
	}
	if token != value {
		t.Fatalf("token = %q, want %q", token, value)
	}
}

func TestURLEscapedCookieLeavesMalformedEncodingAlone(t *testing.T) {
	// A stray percent must not be dropped, because that would change the
	// signed bytes and could turn a bad signature into a good one.
	cases := []struct{ in, want string }{
		{"abc%", "abc%"},
		{"abc%zz", "abc%zz"},
		{"abc%2", "abc%2"},
		{"%41BC", "ABC"},
		{"a%2541", "a%41"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := urlUnescapeCookie(tc.in); got != tc.want {
			t.Errorf("urlUnescapeCookie(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestNormalizeEmailCollapsesCaseAndSpace(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Ada@Example.COM", "ada@example.com"},
		{"  ada@example.com  ", "ada@example.com"},
		{"\tAda@EXAMPLE.com\n", "ada@example.com"},
		{"", ""},
		{"   ", ""},
		{"ada@example.com", "ada@example.com"},
	}
	for _, tc := range cases {
		if got := normalizeEmail(tc.in); got != tc.want {
			t.Errorf("normalizeEmail(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestHasPermissionAndMembershipRefuseAnUnresolvedActor(t *testing.T) {
	var nilUser *ResolvedUser
	if nilUser.HasPermission("iam.admin") {
		t.Error("nil actor reported a permission")
	}
	if nilUser.IsMemberOf("org") {
		t.Error("nil actor reported membership")
	}

	// An identity with no active organization must never authorize, even if a
	// permission map was somehow populated.
	noOrg := &ResolvedUser{Permissions: map[string]bool{"iam.admin": true}}
	if noOrg.HasPermission("iam.admin") {
		t.Error("actor without an organization authorized a permission")
	}
	if noOrg.IsMemberOf("org") {
		t.Error("actor without an organization claimed membership")
	}
}

func TestIsMemberOfIgnoresEmptyAndPartialTargets(t *testing.T) {
	resolved := &ResolvedUser{AllOrgIDs: []string{"org-a", "org-b"}}
	cases := []struct {
		org  string
		want bool
	}{
		{"org-a", true},
		{"org-b", true},
		{"org-c", false},
		{"", false},
		{"org", false},
		{"org-a ", false},
		{"ORG-A", false},
	}
	for _, tc := range cases {
		if got := resolved.IsMemberOf(tc.org); got != tc.want {
			t.Errorf("IsMemberOf(%q) = %v, want %v", tc.org, got, tc.want)
		}
	}
}
