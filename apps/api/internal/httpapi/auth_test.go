package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAuthMutationRequiresTrustedOriginForBrowserRequests(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := authn.NewService(pool, "this-is-a-long-enough-test-auth-secret", authn.Options{
		BaseURL: "http://localhost:3000/api/auth", TrustedOrigins: []string{"http://localhost:3001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAuthHandler(service, "this-is-a-long-enough-test-auth-secret", false, nil)
	for _, tc := range []struct {
		name       string
		origin     string
		cookie     bool
		fetchSite  string
		fetchMode  string
		wantStatus int
	}{
		{name: "trusted browser origin", origin: "http://localhost:3000", wantStatus: http.StatusServiceUnavailable},
		{name: "trusted dev compatibility origin", origin: "http://localhost:3001", wantStatus: http.StatusServiceUnavailable},
		{name: "untrusted origin", origin: "https://attacker.example", wantStatus: http.StatusForbidden},
		{name: "cookie request without origin", cookie: true, wantStatus: http.StatusForbidden},
		{name: "cross-site login navigation", origin: "http://localhost:3000", fetchSite: "cross-site", fetchMode: "navigate", wantStatus: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader("not-json"))
			request.RemoteAddr = "192.0.2.10:4321"
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			if tc.cookie {
				request.Header.Set("Cookie", "other=value")
			}
			if tc.fetchSite != "" {
				request.Header.Set("Sec-Fetch-Site", tc.fetchSite)
				request.Header.Set("Sec-Fetch-Mode", tc.fetchMode)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != tc.wantStatus {
				t.Fatalf("status=%d, want %d: %s", response.Code, tc.wantStatus, response.Body.String())
			}
		})
	}
}

func TestAuthMutationRejectsAmbiguousOriginHeaders(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := authn.NewService(pool, "this-is-a-long-enough-test-auth-secret", authn.Options{
		BaseURL: "http://localhost:3000/api/auth", TrustedOrigins: []string{"http://localhost:3001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAuthHandler(service, "this-is-a-long-enough-test-auth-secret", false, nil)
	for _, tc := range []struct {
		name   string
		header string
		values []string
	}{
		{name: "origin", header: "Origin", values: []string{"http://localhost:3000", "https://attacker.example"}},
		{name: "referer", header: "Referer", values: []string{"http://localhost:3000/login", "https://attacker.example/"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader(`{"email":"user@example.test","password":"password123"}`))
			request.RemoteAddr = "192.0.2.12:4321"
			for _, value := range tc.values {
				request.Header.Add(tc.header, value)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status=%d, want %d: %s", response.Code, http.StatusForbidden, response.Body.String())
			}
		})
	}
}

func TestAuthMutationAllowsNativeRequestWithoutAmbientBrowserState(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service, err := authn.NewService(pool, "this-is-a-long-enough-test-auth-secret", authn.Options{BaseURL: "http://localhost:3000/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAuthHandler(service, "this-is-a-long-enough-test-auth-secret", false, nil)
	request := httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader(`{"email":"invalid","password":"password123"}`))
	request.RemoteAddr = "192.0.2.11:4321"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("native request status=%d, body=%s", response.Code, response.Body.String())
	}
}

func TestAuthRateLimitUsesOnlyTrustedPeerAddress(t *testing.T) {
	if got := clientIP("[2001:db8::1]:4321"); got != "2001:db8::1" {
		t.Fatalf("IPv6 peer address = %q", got)
	}
	if got := clientIP("198.51.100.9:4321"); got != "198.51.100.9" {
		t.Fatalf("IPv4 peer address = %q", got)
	}
	if got := clientIP("not-an-ip:4321"); got != "" {
		t.Fatalf("invalid peer address was trusted: %q", got)
	}
}

func TestRequestClientIPHonorsForwardedChainOnlyFromTrustedProxies(t *testing.T) {
	trusted, err := ParseTrustedProxyCIDRs("10.0.0.0/8, 2001:db8:ffff::/48")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request.RemoteAddr = "198.51.100.8:443"
	request.Header.Set("X-Forwarded-For", "203.0.113.99")
	if got := requestClientIP(request, trusted); got != "198.51.100.8" {
		t.Fatalf("untrusted peer spoofed forwarded client address: %q", got)
	}
	request.RemoteAddr = "10.0.0.2:443"
	request.Header.Set("X-Forwarded-For", "198.51.100.2, 10.0.0.1")
	if got := requestClientIP(request, trusted); got != "198.51.100.2" {
		t.Fatalf("trusted proxy chain client address = %q", got)
	}
	request.Header.Set("X-Forwarded-For", "invalid")
	if got := requestClientIP(request, trusted); got != "" {
		t.Fatalf("malformed trusted proxy header did not fail closed: %q", got)
	}
	if _, err := ParseTrustedProxyCIDRs("10.0.0.0/8,not-a-cidr"); err == nil {
		t.Fatal("invalid trusted proxy CIDR configuration was accepted")
	}
}

func TestAuthRateLimitIsSharedAcrossHandlersAndIgnoresForwardedHeaders(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	secret := fmt.Sprintf("go-auth-throttle-runtime-test-secret-%d", time.Now().UnixNano())
	newHandler := func() http.Handler {
		pool, err := pgxpool.New(t.Context(), runtimeURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		service, err := authn.NewService(pool, secret, authn.Options{BaseURL: "http://localhost:3000/api/auth"})
		if err != nil {
			t.Fatal(err)
		}
		return NewAuthHandler(service, secret, false, nil)
	}
	first, second := newHandler(), newHandler()
	for attempt := 1; attempt <= authn.AuthRateLimitMax; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader(`{"email":"unknown@example.test","password":"invalid password"}`))
		request.RemoteAddr = "192.0.2.145:4321"
		request.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", attempt))
		response := httptest.NewRecorder()
		first.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status=%d, body=%s", attempt, response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader(`{"email":"unknown@example.test","password":"invalid password"}`))
	request.RemoteAddr = "192.0.2.145:4321"
	request.Header.Set("X-Forwarded-For", "203.0.113.200")
	response := httptest.NewRecorder()
	second.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("shared 11th attempt status=%d, body=%s", response.Code, response.Body.String())
	}
}

func TestGoAuthRouteMountIsExplicitAndUsesBetterAuthPaths(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	secret := "this-is-a-long-enough-test-auth-secret"
	service, err := authn.NewService(pool, secret, authn.Options{BaseURL: "http://localhost:3000/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	base := NewRouterWithAuthAndOrgRoute(nil, nil, "", nil, nil, nil, nil, nil, nil, nil, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/auth/get-session", nil)
	response := httptest.NewRecorder()
	base.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("auth endpoint without an explicit handler status=%d", response.Code)
	}
	authRoute := NewAuthHandler(service, secret, false, nil)
	mounted := NewRouterWithAuthAndOrgRoute(nil, nil, "", nil, nil, nil, nil, nil, nil, nil, authRoute)
	response = httptest.NewRecorder()
	mounted.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "null" {
		t.Fatalf("mounted auth endpoint status=%d body=%q", response.Code, response.Body.String())
	}
	for _, path := range []string{"/api/auth", "/api/auth/", "/api/auth/unsupported/compatibility/path"} {
		request = httptest.NewRequest(http.MethodGet, path, nil)
		response = httptest.NewRecorder()
		mounted.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Errorf("unsupported Go auth path %q status=%d body=%q", path, response.Code, response.Body.String())
		}
	}
	request = httptest.NewRequest(http.MethodDelete, "/api/auth/get-session", nil)
	response = httptest.NewRecorder()
	mounted.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Errorf("unsupported Go auth method status=%d body=%q", response.Code, response.Body.String())
	}

	oidcRoutes := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/native/exchange" {
			t.Errorf("OIDC route received path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	withOIDC, err := NewAuthHandlerWithOIDCRoutes(service, secret, false, nil, nil, oidcRoutes)
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/native/exchange", nil)
	response = httptest.NewRecorder()
	withOIDC.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("native OIDC exchange route status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestGoAuthRouteMountOwnsRootAndArbitraryNestedPaths(t *testing.T) {
	var dispatched []string
	authRoute := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dispatched = append(dispatched, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	})
	mounted := NewRouterWithAuthAndOrgRoute(nil, nil, "", nil, nil, nil, nil, nil, nil, nil, authRoute)
	rootRequest := httptest.NewRequest(http.MethodGet, "/api/auth", nil)
	rootResponse := httptest.NewRecorder()
	mounted.ServeHTTP(rootResponse, rootRequest)
	if rootResponse.Code != http.StatusNotFound {
		t.Fatalf("Go auth namespace root status=%d, want fail-closed 404", rootResponse.Code)
	}
	for _, test := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPatch, path: "/api/auth/unimplemented/nested?source=compat"},
	} {
		request := httptest.NewRequest(test.method, test.path, nil)
		response := httptest.NewRecorder()
		mounted.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Errorf("%s %s reached status=%d, want auth handler", test.method, test.path, response.Code)
		}
	}
	if strings.Join(dispatched, ",") != "PATCH /unimplemented/nested" {
		t.Fatalf("Go auth handler dispatches=%v", dispatched)
	}
}

func TestVerifyEmailHTTPAcceptsSignedVerificationToken(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(t.Context(), runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	const secret = "better-auth-http-verification-secret-0123456789"
	service, err := authn.NewService(pool, secret, authn.Options{BaseURL: "http://localhost:3000/api/auth"})
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().UTC().UnixNano()
	userID := fmt.Sprintf("go-http-verify-%d", stamp)
	email := fmt.Sprintf("go-http-verify-%d@example.test", stamp)
	if _, err := pool.Exec(t.Context(), `INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'Go Verify Fixture', $2, false)`, userID, email); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM auth_user WHERE id = $1`, userID); err != nil {
			t.Errorf("remove user fixture: %v", err)
		}
	})
	token := verificationTokenForHTTPTest(email, secret, time.Now().UTC())
	handler := NewAuthHandler(service, secret, false, nil)
	request := httptest.NewRequest(http.MethodGet, "/verify-email?token="+url.QueryEscape(token), nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"status":true,"user":null}` {
		t.Fatalf("verification status=%d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("verification response lacks token privacy headers: %v", response.Header())
	}
	var verified bool
	if err := pool.QueryRow(t.Context(), `SELECT email_verified FROM auth_user WHERE id = $1`, userID).Scan(&verified); err != nil || !verified {
		t.Fatalf("HTTP verification state=%t err=%v", verified, err)
	}
}

// Keep the handler proof independent of the shared email outbox worker.
func verificationTokenForHTTPTest(email, secret string, now time.Time) string {
	encode := base64.RawURLEncoding.EncodeToString
	header := encode([]byte(`{"alg":"HS256"}`))
	claims, _ := json.Marshal(struct {
		Email     string `json:"email"`
		IssuedAt  int64  `json:"iat"`
		ExpiresAt int64  `json:"exp"`
	}{Email: email, IssuedAt: now.Unix(), ExpiresAt: now.Add(authn.VerificationLifetime).Unix()})
	unsigned := header + "." + encode(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + encode(mac.Sum(nil))
}

func TestAuthHTTPIssuesCompatibleCookieAndBearerSharesRevocation(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(t.Context(), runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	secret := "better-auth-http-compat-secret-0123456789"
	service, err := authn.NewService(pool, secret, authn.Options{
		BaseURL: "http://localhost:3000/api/auth",
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAuthHandler(service, secret, false, nil)
	verifyRequest := httptest.NewRequest(http.MethodGet, "/verify-email?token=invalid&callbackURL=http%3A%2F%2Flocalhost%3A3000%2Flogin", nil)
	verifyResponse := httptest.NewRecorder()
	handler.ServeHTTP(verifyResponse, verifyRequest)
	if verifyResponse.Code != http.StatusUnauthorized || verifyResponse.Header().Get("Cache-Control") != "no-store" || verifyResponse.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("verification response lacks token privacy headers: status=%d headers=%v", verifyResponse.Code, verifyResponse.Header())
	}
	stamp := time.Now().UTC().UnixNano()
	userID := fmt.Sprintf("go-http-auth-%d", stamp)
	email := fmt.Sprintf("go-http-auth-%d@example.test", stamp)
	const passwordHash = "00112233445566778899aabbccddeeff:f5b22309b28fe412c82a4b2cab57498b8f8a42c849af16cb908974048f61c13933421858db3a8f111430bdc493c7cef90f61f904061c77206e3820a2e8b11bc2"
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO auth_user (id, name, email, email_verified)
		VALUES ($1, 'Go HTTP compatibility fixture', $2, true)`, userID, email); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM auth_user WHERE id = $1`, userID); err != nil {
			t.Errorf("remove HTTP auth fixture: %v", err)
		}
	})
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO auth_account (id, account_id, provider_id, user_id, password, issuer)
		VALUES ($1, $2, 'credential', $2, $3, 'local:credential')`, "go-http-auth-account-"+fmt.Sprint(stamp), userID, passwordHash); err != nil {
		t.Fatal(err)
	}
	var unavailableBodies []string
	for index, emailCandidate := range []string{email, "absent-" + email} {
		request := httptest.NewRequest(http.MethodPost, "/request-password-reset", strings.NewReader(`{"email":"`+emailCandidate+`"}`))
		request.RemoteAddr = fmt.Sprintf("192.0.2.%d:4321", 60+index)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("recovery without SMTP status=%d body=%s", response.Code, response.Body.String())
		}
		unavailableBodies = append(unavailableBodies, response.Body.String())
	}
	if unavailableBodies[0] != unavailableBodies[1] {
		t.Fatalf("recovery provider absence exposed account existence: %q vs %q", unavailableBodies[0], unavailableBodies[1])
	}
	request := httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader(`{"email":"`+email+`","password":"correct horse battery staple"}`))
	request.RemoteAddr = "192.0.2.44:4321"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("sign-in status=%d", response.Code)
	}
	var signInBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &signInBody); err != nil || signInBody.Token == "" {
		t.Fatalf("sign-in response did not return an opaque bearer session (status %d)", response.Code)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("sign-in response must not be cached")
	}
	browserRequest := httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader(`{"email":"`+email+`","password":"correct horse battery staple"}`))
	browserRequest.RemoteAddr = "192.0.2.45:4321"
	browserRequest.Header.Set("Origin", "http://localhost:3000")
	browserResponse := httptest.NewRecorder()
	handler.ServeHTTP(browserResponse, browserRequest)
	var browserSignInBody struct {
		Token *string `json:"token"`
	}
	if browserResponse.Code != http.StatusOK || json.Unmarshal(browserResponse.Body.Bytes(), &browserSignInBody) != nil || browserSignInBody.Token != nil {
		t.Fatalf("browser sign-in exposed bearer token: status=%d body=%s", browserResponse.Code, browserResponse.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, candidate := range response.Result().Cookies() {
		if candidate.Name == session.SessionCookieName {
			sessionCookie = candidate
			break
		}
	}
	if sessionCookie == nil || !sessionCookie.HttpOnly || sessionCookie.Path != "/" || sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Fatal("sign-in did not set the expected Better Auth browser session cookie")
	}
	cookieToken, err := session.VerifySignedCookie(sessionCookie.Value, secret)
	if err != nil || cookieToken != signInBody.Token {
		t.Fatal("browser cookie signature did not match the issued server-side session")
	}
	if _, err := pool.Exec(t.Context(), `UPDATE auth_session SET expires_at = now() + ($2 * interval '1 second') WHERE token = $1`, signInBody.Token, int64((authn.SessionLifetime - authn.SessionRefreshUpdateAge - time.Second).Seconds())); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/get-session", nil)
	request.AddCookie(sessionCookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var refreshedCookie *http.Cookie
	for _, candidate := range response.Result().Cookies() {
		if candidate.Name == session.SessionCookieName {
			refreshedCookie = candidate
		}
	}
	if response.Code != http.StatusOK || refreshedCookie == nil || refreshedCookie.MaxAge <= 0 || refreshedCookie.Expires.IsZero() {
		t.Fatalf("remembered session did not refresh its persistent cookie: status=%d cookie=%+v", response.Code, refreshedCookie)
	}
	request = httptest.NewRequest(http.MethodPost, "/sign-in/email", strings.NewReader(`{"email":"`+email+`","password":"correct horse battery staple","rememberMe":false}`))
	request.RemoteAddr = "192.0.2.44:4321"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("non-remembered sign-in status=%d", response.Code)
	}
	var shortSessionBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &shortSessionBody); err != nil || shortSessionBody.Token == "" {
		t.Fatal("non-remembered sign-in did not return its opaque bearer")
	}
	var shortCookie *http.Cookie
	for _, candidate := range response.Result().Cookies() {
		if candidate.Name == session.SessionCookieName {
			shortCookie = candidate
		}
	}
	if shortCookie == nil || shortCookie.MaxAge != 0 || !shortCookie.Expires.IsZero() {
		t.Fatalf("rememberMe=false cookie is persistent: %+v", shortCookie)
	}
	shortIdentity, err := service.GetSession(t.Context(), shortSessionBody.Token)
	if err != nil || shortIdentity.Session.ExpiresAt.Sub(shortIdentity.Session.CreatedAt) != authn.NonRememberedSessionLifetime {
		t.Fatalf("rememberMe=false server expiry=%v err=%v", shortIdentity.Session.ExpiresAt.Sub(shortIdentity.Session.CreatedAt), err)
	}
	for _, authMode := range []string{"cookie", "bearer"} {
		t.Run(authMode, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/get-session", nil)
			if authMode == "cookie" {
				request.AddCookie(sessionCookie)
			} else {
				request.Header.Set("Authorization", "Bearer "+signInBody.Token)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("get-session status=%d", response.Code)
			}
			var identity map[string]json.RawMessage
			if err := json.Unmarshal(response.Body.Bytes(), &identity); err != nil {
				t.Fatalf("decode get-session identity: %v", err)
			}
			var sessionFields map[string]json.RawMessage
			if err := json.Unmarshal(identity["session"], &sessionFields); err != nil {
				t.Fatalf("decode get-session session: %v", err)
			}
			if _, leaked := sessionFields["token"]; leaked {
				t.Fatalf("get-session exposed a reusable bearer token: %s", response.Body.String())
			}
			var body struct {
				User authn.User `json:"user"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.User.ID != userID {
				t.Fatalf("get-session did not resolve the fixture identity (status %d)", response.Code)
			}
		})
	}
	request = httptest.NewRequest(http.MethodPost, "/sign-out", nil)
	request.RemoteAddr = "192.0.2.44:4321"
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("Authorization", "Bearer "+signInBody.Token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("bearer sign-out status=%d", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "/get-session", nil)
	request.AddCookie(refreshedCookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "null" {
		t.Fatalf("cookie session survived bearer revocation: status=%d", response.Code)
	}
}
