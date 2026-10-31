package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoAuthHTTPClientLifecycleUsesBetterAuthSessionForProtectedRoute(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal("resolve runtime database connection")
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed protected-route membership")
	}
	runtimeConfig, err := pgxpool.ParseConfig(runtimeURL)
	if err != nil {
		t.Fatal("parse runtime database connection")
	}
	runtimeConfig.MaxConns = 1
	runtime, err := pgxpool.NewWithConfig(ctx, runtimeConfig)
	if err != nil {
		t.Fatal("connect runtime database")
	}
	t.Cleanup(runtime.Close)
	connection, err := runtime.Acquire(ctx)
	if err != nil {
		t.Fatal("acquire isolated auth test connection")
	}
	if _, err := connection.Exec(ctx, `
		CREATE TEMP TABLE auth_email_outbox (LIKE public.auth_email_outbox INCLUDING ALL) ON COMMIT PRESERVE ROWS;
		CREATE TEMP TABLE auth_verification (LIKE public.auth_verification INCLUDING ALL) ON COMMIT PRESERVE ROWS;
	`); err != nil {
		connection.Release()
		t.Fatal("isolate auth lifecycle email state from background workers")
	}
	connection.Release()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal("connect fixture database owner")
	}
	t.Cleanup(owner.Close)

	stamp := time.Now().UTC().UnixNano()
	email := fmt.Sprintf("go-http-lifecycle-%d@example.test", stamp)
	orgID := authLifecycleUUID(t)
	nonMemberOrgID := authLifecycleUUID(t)
	roleID := authLifecycleUUID(t)
	const secret = "go-auth-http-lifecycle-test-secret-0123456789"
	verificationLinks := make(chan string, 2)
	recoveryLinks := make(chan string, 2)
	var routes http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if routes == nil {
			http.Error(w, "auth routes are not ready", http.StatusServiceUnavailable)
			return
		}
		routes.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	service, err := authn.NewService(runtime, secret, authn.Options{
		BaseURL: server.URL + "/api/auth",
		VerificationLinkSender: func(_ context.Context, recipient, link string) error {
			if recipient != email {
				return errors.New("verification test sink received an unexpected recipient")
			}
			verificationLinks <- link
			return nil
		},
		RecoveryLinkSender: func(_ context.Context, recipient, link string) error {
			if recipient != email {
				return errors.New("recovery test sink received an unexpected recipient")
			}
			recoveryLinks <- link
			return nil
		},
	})
	if err != nil {
		t.Fatal("create auth service")
	}
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal("create Better Auth session resolver")
	}
	setupReader := &fakeSetupReader{payload: dashboard.SetupPayload{Items: []dashboard.SetupItem{}, Remaining: 0}}
	mux := http.NewServeMux()
	mux.Handle("/api/auth/", http.StripPrefix("/api/auth", NewAuthHandler(service, secret, false, nil)))
	mux.Handle("GET /api/setup", NewSetupSessionHandler(resolver, setupReader, nil))
	routes = mux

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1::uuid`, orgID); err != nil {
			t.Errorf("remove auth lifecycle organization fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1::uuid`, nonMemberOrgID); err != nil {
			t.Errorf("remove auth lifecycle non-member organization fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE email = $1`, email); err != nil {
			t.Errorf("remove auth lifecycle domain user fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_email_outbox WHERE recipient = $1`, email); err != nil {
			t.Errorf("remove auth lifecycle email outbox fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_verification WHERE value IN (SELECT id FROM auth_user WHERE email = $1)`, email); err != nil {
			t.Errorf("remove auth lifecycle verification fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE email = $1`, email); err != nil {
			t.Errorf("remove auth lifecycle Better Auth user fixture")
		}
	})

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal("create direct HTTP client's cookie jar")
	}
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	origin := server.URL
	status, headers, body := authLifecycleJSON(t, client, http.MethodPost, server.URL+"/api/auth/sign-up/email", origin,
		map[string]string{"email": email, "password": "correct horse battery staple", "name": "Auth Lifecycle", "callbackURL": "/login?verified=1"})
	if status != http.StatusOK {
		t.Fatalf("direct signup status=%d", status)
	}
	var signup struct {
		Token *string    `json:"token"`
		User  authn.User `json:"user"`
	}
	if err := json.Unmarshal(body, &signup); err != nil || signup.Token != nil || signup.User.Email != email || signup.User.EmailVerified {
		t.Fatalf("signup did not return the unverified Better Auth user contract (status=%d)", status)
	}
	if len(headers.Values("Set-Cookie")) != 0 {
		t.Fatal("signup issued a session before email verification")
	}
	if worked, err := service.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("deliver verification message through the configured test sink, worked=%t", worked)
	}
	verificationURL := receiveAuthLifecycleLink(t, ctx, verificationLinks)
	verificationToken := verificationURL.Query().Get("token")
	if verificationToken == "" {
		t.Fatal("verification sink returned a message without a token")
	}
	status, _, _ = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/auth/verify-email?token="+url.QueryEscape(verificationToken), "", nil)
	if status != http.StatusOK {
		t.Fatalf("direct verification status=%d", status)
	}

	if _, err := owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug, base_currency)
		VALUES ($1::uuid, 'Go Auth Lifecycle', $2, 'UGX')`, orgID, "go-auth-lifecycle-"+orgID[:8]); err != nil {
		t.Fatal("seed protected-route organization fixture")
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug, base_currency)
		VALUES ($1::uuid, 'Go Auth Lifecycle Non Member', $2, 'UGX')`, nonMemberOrgID, "go-auth-lifecycle-nonmember-"+nonMemberOrgID[:8]); err != nil {
		t.Fatal("seed non-member organization fixture")
	}
	var domainUserID string
	if err := owner.QueryRow(ctx, `INSERT INTO users (email, name) VALUES ($1, 'Auth Lifecycle') RETURNING id::text`, email).Scan(&domainUserID); err != nil {
		t.Fatal("seed protected-route domain identity")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgID, domainUserID); err != nil {
		t.Fatal("seed protected-route membership")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO roles (id, org_id, key, name) VALUES ($1::uuid, $2::uuid, 'owner', 'Owner')`, roleID, orgID); err != nil {
		t.Fatal("seed protected-route owner role")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, domainUserID, roleID, orgID); err != nil {
		t.Fatal("seed protected-route user role")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'iam.admin', $2::uuid)`, roleID, orgID); err != nil {
		t.Fatal("seed protected-route permission")
	}

	status, headers, body = authLifecycleJSON(t, client, http.MethodPost, server.URL+"/api/auth/sign-in/email", origin,
		map[string]string{"email": email, "password": "correct horse battery staple"})
	var signIn struct {
		Token *string `json:"token"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &signIn) != nil || signIn.Token != nil || len(headers.Values("Set-Cookie")) == 0 {
		t.Fatalf("direct cookie sign-in did not preserve the Vite auth response shape (status=%d)", status)
	}
	if cookies := jar.Cookies(mustAuthLifecycleURL(t, server.URL)); len(cookies) != 1 || cookies[0].Name != session.SessionCookieName {
		t.Fatal("direct HTTP client did not retain the Better Auth session cookie")
	}
	status, _, body = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/auth/get-session", "", nil)
	var current struct {
		User    authn.User    `json:"user"`
		Session authn.Session `json:"session"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &current) != nil || current.User.ID != signup.User.ID || current.Session.ID == "" {
		t.Fatalf("direct session read did not resolve the signed-in account (status=%d)", status)
	}
	if status, _, _ = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/setup", "", nil); status != http.StatusOK || setupReader.orgID != orgID {
		t.Fatalf("protected Go endpoint rejected the auth cookie or used the wrong tenant (status=%d)", status)
	}
	readerCalls := setupReader.calls
	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/setup", nil)
	if err != nil {
		t.Fatal("create protected request with a tampered active-organization cookie")
	}
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: nonMemberOrgID})
	status, _, _ = authLifecycleDo(t, client, request)
	if status != http.StatusOK || setupReader.calls != readerCalls+1 || setupReader.orgID != orgID {
		t.Fatalf("tampered active organization cookie escaped tenant fallback (status=%d org=%q calls=%d)", status, setupReader.orgID, setupReader.calls)
	}
	readerCalls = setupReader.calls
	request, err = http.NewRequest(http.MethodGet, server.URL+"/api/setup", nil)
	if err != nil {
		t.Fatal("create protected request with an explicit non-member organization")
	}
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: nonMemberOrgID})
	request.Header.Set("X-Organization-ID", nonMemberOrgID)
	status, _, _ = authLifecycleDo(t, client, request)
	if status != http.StatusForbidden || setupReader.calls != readerCalls {
		t.Fatalf("protected endpoint did not reject explicit non-member organization before reading tenant data (status=%d calls=%d)", status, setupReader.calls)
	}

	var storedToken string
	if err := owner.QueryRow(ctx, `SELECT token FROM auth_session WHERE user_id = $1`, signup.User.ID).Scan(&storedToken); err != nil {
		t.Fatal("load Better Auth session token for refresh fixture")
	}
	if _, err := owner.Exec(ctx, `UPDATE auth_session SET expires_at = now() + ($2 * interval '1 second') WHERE token = $1`, storedToken, int64((authn.SessionLifetime - authn.SessionRefreshUpdateAge - time.Second).Seconds())); err != nil {
		t.Fatal("prepare session refresh fixture")
	}
	status, headers, _ = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/auth/get-session", "", nil)
	if status != http.StatusOK || len(headers.Values("Set-Cookie")) == 0 {
		t.Fatalf("direct HTTP session refresh did not renew the cookie (status=%d)", status)
	}
	if status, _, _ = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/setup", "", nil); status != http.StatusOK {
		t.Fatalf("protected Go endpoint rejected the refreshed cookie (status=%d)", status)
	}

	status, _, body = authLifecycleJSON(t, client, http.MethodPost, server.URL+"/api/auth/request-password-reset", origin, map[string]string{"email": email, "redirectTo": "/reset-password"})
	var recovery struct {
		Message string `json:"message"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &recovery) != nil || recovery.Message == "" {
		t.Fatalf("direct password recovery request failed (status=%d)", status)
	}
	var pendingRecovery int
	if err := runtime.QueryRow(ctx, `SELECT count(*) FROM pg_temp.auth_email_outbox WHERE recipient=$1 AND kind='recovery'`, email).Scan(&pendingRecovery); err != nil {
		t.Fatal("inspect recovery outbox fixture")
	}
	if pendingRecovery != 1 {
		t.Fatalf("direct password recovery did not leave exactly one pending delivery (count=%d)", pendingRecovery)
	}
	if worked, err := service.ProcessEmailOutboxOnce(ctx); err != nil || !worked {
		t.Fatalf("deliver recovery message through the configured test sink, worked=%t", worked)
	}
	recoveryURL := receiveAuthLifecycleLink(t, ctx, recoveryLinks)
	recoveryParts := strings.Split(strings.Trim(recoveryURL.Path, "/"), "/")
	recoveryToken := recoveryParts[len(recoveryParts)-1]
	if recoveryToken == "" {
		t.Fatal("recovery sink returned a message without a token")
	}
	status, _, body = authLifecycleJSON(t, client, http.MethodPost, server.URL+"/api/auth/request-password-reset", origin, map[string]string{"email": "missing-" + email, "redirectTo": "/reset-password"})
	var unknownRecovery struct {
		Message string `json:"message"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &unknownRecovery) != nil || unknownRecovery.Message != recovery.Message {
		t.Fatalf("recovery response exposed account existence (status=%d)", status)
	}
	status, _, _ = authLifecycleJSON(t, client, http.MethodPost, server.URL+"/api/auth/reset-password", origin,
		map[string]string{"token": recoveryToken, "newPassword": "new correct horse battery staple"})
	if status != http.StatusOK {
		t.Fatalf("direct password reset failed (status=%d)", status)
	}
	status, _, body = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/auth/get-session", "", nil)
	if status != http.StatusOK || string(body) != "null\n" {
		t.Fatal("password recovery did not revoke the existing cookie session")
	}
	if status, _, _ = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/setup", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("protected Go endpoint accepted a revoked cookie (status=%d)", status)
	}

	status, headers, body = authLifecycleJSON(t, client, http.MethodPost, server.URL+"/api/auth/sign-in/email", origin,
		map[string]string{"email": email, "password": "new correct horse battery staple"})
	if status != http.StatusOK || len(headers.Values("Set-Cookie")) == 0 {
		t.Fatalf("direct sign-in with recovered password failed (status=%d)", status)
	}
	if status, _, _ = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/setup", "", nil); status != http.StatusOK {
		t.Fatalf("protected Go endpoint rejected the recovered account session (status=%d)", status)
	}
	status, _, _ = authLifecycleJSON(t, client, http.MethodPost, server.URL+"/api/auth/sign-out", origin, map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("direct sign-out failed (status=%d)", status)
	}
	if status, _, _ = authLifecycleRequest(t, client, http.MethodGet, server.URL+"/api/setup", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("protected Go endpoint accepted a signed-out cookie (status=%d)", status)
	}
}

func authLifecycleJSON(t *testing.T, client *http.Client, method, target, origin string, body any) (int, http.Header, []byte) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal("encode direct auth request")
	}
	request, err := http.NewRequest(method, target, strings.NewReader(string(encoded)))
	if err != nil {
		t.Fatal("create direct auth request")
	}
	request.Header.Set("Content-Type", "application/json")
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	return authLifecycleDo(t, client, request)
}

func authLifecycleRequest(t *testing.T, client *http.Client, method, target, origin string, body io.Reader) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, target, body)
	if err != nil {
		t.Fatal("create direct HTTP request")
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	return authLifecycleDo(t, client, request)
}

func authLifecycleDo(t *testing.T, client *http.Client, request *http.Request) (int, http.Header, []byte) {
	t.Helper()
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("send direct HTTP request")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal("read direct HTTP response")
	}
	return response.StatusCode, response.Header.Clone(), body
}

func receiveAuthLifecycleLink(t *testing.T, ctx context.Context, links <-chan string) *url.URL {
	t.Helper()
	select {
	case link := <-links:
		parsed, err := url.Parse(link)
		if err != nil || parsed == nil {
			t.Fatal("configured auth email sink received a malformed link")
		}
		return parsed
	case <-ctx.Done():
		t.Fatal("configured auth email sink did not receive the lifecycle message")
		return nil
	}
}

func mustAuthLifecycleURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal("parse direct auth server URL")
	}
	return parsed
}

func authLifecycleUUID(t *testing.T) string {
	t.Helper()
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal("create auth lifecycle UUID fixture")
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}
