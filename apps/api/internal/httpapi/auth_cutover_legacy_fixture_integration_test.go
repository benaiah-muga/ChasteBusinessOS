package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoAuthCutoverAcceptsLegacyBetterAuthCredentialAndSessionCookie(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal("resolve runtime database connection")
	}
	ownerURL := os.Getenv("GO_RUNTIME_INTEGRATION_DATABASE_URL")
	if ownerURL == "" {
		ownerURL = os.Getenv("DATABASE_URL")
	}
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed the pre-cutover Better Auth fixture")
	}

	runtimeConfig, err := pgxpool.ParseConfig(runtimeURL)
	if err != nil {
		t.Fatal("parse runtime database connection")
	}
	runtimeConfig.MaxConns = 2
	runtime, err := pgxpool.NewWithConfig(ctx, runtimeConfig)
	if err != nil {
		t.Fatal("connect runtime database")
	}
	t.Cleanup(runtime.Close)
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal("connect fixture database owner")
	}
	t.Cleanup(owner.Close)

	userSuffix := legacyAuthCutoverRandomID(t)
	legacyAuthUserID := "legacy-user-" + userSuffix
	legacyAuthAccountID := "legacy-account-" + userSuffix
	legacyAuthSessionID := "legacy-session-" + userSuffix
	legacySessionToken := "legacy-cookie-token-" + userSuffix
	domainUserID := legacyAuthCutoverUUID(t)
	orgID := legacyAuthCutoverUUID(t)
	roleID := legacyAuthCutoverUUID(t)
	email := "go-auth-cutover-" + userSuffix + "@example.test"
	secret := "go-auth-cutover-existing-session-secret-0123456789"
	now := time.Now().UTC().Truncate(time.Microsecond)
	legacyCreatedAt := now.Add(-48 * time.Hour)
	legacySessionExpiry := legacyCreatedAt.Add(authn.SessionLifetime)
	const legacyPasswordHash = "00112233445566778899aabbccddeeff:f5b22309b28fe412c82a4b2cab57498b8f8a42c849af16cb908974048f61c13933421858db3a8f111430bdc493c7cef90f61f904061c77206e3820a2e8b11bc2"
	const fixturePassword = "correct horse battery staple"

	// Register cleanup before inserting any fixture rows so partial setup is safe.
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		limiterID := legacyAuthCutoverRateLimitID(secret, "198.51.100.42", "sign-in/email")
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_verification WHERE identifier = $1`, limiterID); err != nil {
			t.Errorf("remove auth cutover limiter fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_session WHERE user_id = $1`, legacyAuthUserID); err != nil {
			t.Errorf("remove auth cutover session fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_account WHERE user_id = $1`, legacyAuthUserID); err != nil {
			t.Errorf("remove auth cutover account fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id = $1`, legacyAuthUserID); err != nil {
			t.Errorf("remove auth cutover user fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM role_permissions WHERE org_id = $1::uuid`, orgID); err != nil {
			t.Errorf("remove auth cutover permission fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM user_roles WHERE org_id = $1::uuid`, orgID); err != nil {
			t.Errorf("remove auth cutover role assignment fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM memberships WHERE org_id = $1::uuid`, orgID); err != nil {
			t.Errorf("remove auth cutover membership fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM roles WHERE id = $1::uuid`, roleID); err != nil {
			t.Errorf("remove auth cutover role fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1::uuid`, orgID); err != nil {
			t.Errorf("remove auth cutover organization fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, domainUserID); err != nil {
			t.Errorf("remove auth cutover domain identity fixture")
		}
	})

	seedTx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal("begin legacy auth fixture seed")
	}
	defer seedTx.Rollback(context.Background())
	if _, err := seedTx.Exec(ctx, `
		INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at)
		VALUES ($1, 'Legacy Auth User', $2, true, $3, $3)`, legacyAuthUserID, email, legacyCreatedAt); err != nil {
		t.Fatal("seed pre-cutover Better Auth user")
	}
	if _, err := seedTx.Exec(ctx, `
		INSERT INTO auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
		VALUES ($1, $2, 'credential', $2, $3, $4, $4)`, legacyAuthAccountID, legacyAuthUserID, legacyPasswordHash, legacyCreatedAt); err != nil {
		t.Fatal("seed pre-cutover Better Auth credential")
	}
	if _, err := seedTx.Exec(ctx, `
		INSERT INTO auth_session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
		VALUES ($1, $2, $3, $4, $4, '198.51.100.42', 'legacy-browser-fixture', $5)`, legacyAuthSessionID, legacySessionExpiry, legacySessionToken, legacyCreatedAt, legacyAuthUserID); err != nil {
		t.Fatal("seed persisted pre-cutover Better Auth session")
	}
	if _, err := seedTx.Exec(ctx, `
		INSERT INTO organizations (id, name, slug, base_currency)
		VALUES ($1::uuid, 'Auth Cutover Fixture', $2, 'UGX')`, orgID, "auth-cutover-"+userSuffix[:12]); err != nil {
		t.Fatal("seed protected-route organization")
	}
	if _, err := seedTx.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Legacy Auth User')`, domainUserID, email); err != nil {
		t.Fatal("seed domain identity")
	}
	if _, err := seedTx.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgID, domainUserID); err != nil {
		t.Fatal("seed organization membership")
	}
	if _, err := seedTx.Exec(ctx, `INSERT INTO roles (id, org_id, key, name) VALUES ($1::uuid, $2::uuid, 'owner', 'Owner')`, roleID, orgID); err != nil {
		t.Fatal("seed owner role")
	}
	if _, err := seedTx.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, domainUserID, roleID, orgID); err != nil {
		t.Fatal("seed owner role assignment")
	}
	if _, err := seedTx.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'iam.admin', $2::uuid)`, roleID, orgID); err != nil {
		t.Fatal("seed protected-route permission")
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatal("commit legacy auth fixture")
	}

	var routes http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Keep the rate-limit fixture deterministic and unique through its test secret.
		r.RemoteAddr = "198.51.100.42:12345"
		if routes == nil {
			http.Error(w, "auth cutover routes are not ready", http.StatusServiceUnavailable)
			return
		}
		routes.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	service, err := authn.NewService(runtime, secret, authn.Options{BaseURL: server.URL + "/api/auth"})
	if err != nil {
		t.Fatal("create Go auth service")
	}
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal("create Go session resolver")
	}
	reader := &legacyAuthCutoverSetupReader{payload: dashboard.SetupPayload{Items: []dashboard.SetupItem{}, Remaining: 0}}
	mux := http.NewServeMux()
	mux.Handle("/api/auth/", http.StripPrefix("/api/auth", NewAuthHandler(service, secret, false, nil)))
	mux.Handle("GET /api/setup", NewSetupSessionHandler(resolver, reader, nil))
	routes = mux

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal("create auth cutover cookie jar")
	}
	serverURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal("parse auth cutover server URL")
	}
	legacyCookie := legacyAuthCutoverSignCookie(legacySessionToken, secret)
	jar.SetCookies(serverURL, []*http.Cookie{
		{Name: session.SessionCookieName, Value: legacyCookie, Path: "/", HttpOnly: true},
		{Name: session.ActiveOrgCookieName, Value: orgID, Path: "/", HttpOnly: true},
	})
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}

	status, _, body := legacyAuthCutoverRequest(t, client, http.MethodGet, server.URL+"/api/auth/get-session", nil)
	var current struct {
		User    authn.User    `json:"user"`
		Session authn.Session `json:"session"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &current) != nil || current.User.ID != legacyAuthUserID || current.Session.ID != legacyAuthSessionID {
		t.Fatalf("Go auth handler rejected the persisted pre-cutover session (status=%d)", status)
	}
	status, _, _ = legacyAuthCutoverRequest(t, client, http.MethodGet, server.URL+"/api/setup", nil)
	if status != http.StatusOK || reader.orgID != orgID {
		t.Fatalf("Go protected endpoint rejected the pre-cutover cookie (status=%d)", status)
	}

	status, _, body = legacyAuthCutoverJSON(t, client, http.MethodPost, server.URL+"/api/auth/sign-in/email", server.URL,
		map[string]string{"email": email, "password": fixturePassword})
	var signedIn struct {
		Token *string    `json:"token"`
		User  authn.User `json:"user"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &signedIn) != nil || signedIn.User.ID != legacyAuthUserID || signedIn.Token != nil {
		t.Fatalf("Go auth handler rejected the pre-cutover Better Auth credential (status=%d)", status)
	}
	if cookies := jar.Cookies(serverURL); len(cookies) != 2 {
		t.Fatal("Go sign-in did not preserve the active organization and issue a session cookie")
	}
	status, _, _ = legacyAuthCutoverRequest(t, client, http.MethodGet, server.URL+"/api/setup", nil)
	if status != http.StatusOK || reader.orgID != orgID {
		t.Fatalf("Go protected endpoint rejected the sign-in cookie for the pre-cutover identity (status=%d)", status)
	}
}

type legacyAuthCutoverSetupReader struct {
	orgID   string
	payload dashboard.SetupPayload
}

func (r *legacyAuthCutoverSetupReader) ForOrg(_ context.Context, orgID string) (dashboard.SetupPayload, error) {
	r.orgID = orgID
	return r.payload, nil
}

func legacyAuthCutoverRequest(t *testing.T, client *http.Client, method, target string, body io.Reader) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, target, body)
	if err != nil {
		t.Fatal("build auth cutover HTTP request")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("send auth cutover HTTP request")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal("read auth cutover HTTP response")
	}
	return response.StatusCode, response.Header, responseBody
}

func legacyAuthCutoverJSON(t *testing.T, client *http.Client, method, target, origin string, value any) (int, http.Header, []byte) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal("encode auth cutover request")
	}
	request, err := http.NewRequest(method, target, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal("build auth cutover JSON request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", origin)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("send auth cutover JSON request")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal("read auth cutover JSON response")
	}
	return response.StatusCode, response.Header, responseBody
}

func legacyAuthCutoverRandomID(t *testing.T) string {
	t.Helper()
	var value [24]byte
	if _, err := rand.Read(value[:]); err != nil {
		t.Fatal("generate auth cutover fixture identifier")
	}
	return hex.EncodeToString(value[:])
}

func legacyAuthCutoverUUID(t *testing.T) string {
	t.Helper()
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		t.Fatal("generate auth cutover organization identifier")
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

func legacyAuthCutoverRateLimitID(secret, ip, endpoint string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(endpoint + "\x00" + ip))
	return "go-auth-rate-v1:" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func legacyAuthCutoverSignCookie(token, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(token))
	return token + "." + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
