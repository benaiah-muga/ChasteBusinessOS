package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
)

// orgParityEnv returns the connection string for a schema-owner connection, for
// tests that must seed identities directly rather than through the RLS runtime
// role the API itself uses.
func orgParityEnv(t *testing.T) string {
	t.Helper()
	for _, key := range []string{"GO_RUNTIME_INTEGRATION_DATABASE_URL", "DATABASE_URL"} {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	t.Skip("DATABASE_URL is required for the organization route integration tests")
	return ""
}

// orgParityLegacyOrigin is the running legacy app, which is the oracle.
func orgParityLegacyOrigin(t *testing.T) string {
	t.Helper()
	origin := os.Getenv("LEGACY_WEB_ORIGIN")
	if origin == "" {
		origin = "http://localhost:3001"
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(origin + "/api/org")
	if err != nil {
		t.Skipf("legacy app is not reachable at %s: %v", origin, err)
	}
	_ = resp.Body.Close()
	return origin
}

// orgParityFixture is a verified user in two organizations with different roles
// and currency, plus an unverified user that also holds an Owner role.
type orgParityFixture struct {
	userID     string
	orgA       string
	orgB       string
	cookie     string
	unverified string
}

func seedOrgParityFixture(t *testing.T, pool *pgxpool.Pool, secret string) orgParityFixture {
	t.Helper()
	ctx := context.Background()
	run := fmt.Sprintf("%d", time.Now().UnixNano())
	suffix := run[len(run)-8:]

	var userID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, 'Parity')
		 ON CONFLICT (email) DO UPDATE SET name = 'Parity' RETURNING id`,
		"org-parity-"+suffix+"@example.test").Scan(&userID); err != nil {
		t.Fatal(err)
	}

	var orgA, orgB string
	if err := pool.QueryRow(ctx,
		`INSERT INTO organizations (name, slug, base_currency, enabled_modules)
		 VALUES ('Parity Org A', $1, 'USD', NULL) RETURNING id`, "parity-a-"+suffix).Scan(&orgA); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO organizations (name, slug, base_currency, enabled_modules)
		 VALUES ('Parity Org B', $1, 'EUR', '["crm"]'::jsonb) RETURNING id`, "parity-b-"+suffix).Scan(&orgB); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_session WHERE token LIKE $1`, "org-parity-token-"+suffix+"%")
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id LIKE $1`, "orgparity"+suffix+"%")
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, userID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = ANY($1::uuid[])`, []string{orgA, orgB})
	})

	for _, orgID := range []string{orgA, orgB} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgID, userID); err != nil {
			t.Fatal(err)
		}
	}

	// Distinct roles so the permission set proves which organization was chosen.
	ownerRole := seedRole(t, pool, orgA, "parity-owner-"+suffix, "iam.admin")
	readerRole := seedRole(t, pool, orgB, "parity-reader-"+suffix, "crm.read")
	if _, err := pool.Exec(ctx,
		`INSERT INTO user_roles (user_id, role_id, org_id) VALUES
		 ($1::uuid, $2::uuid, $3::uuid), ($1::uuid, $4::uuid, $5::uuid)`,
		userID, ownerRole, orgA, readerRole, orgB); err != nil {
		t.Fatal(err)
	}

	token := "org-parity-token-" + suffix
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_user (id, name, email, email_verified)
		VALUES ($1, 'Parity', $2, true)`, "orgparity"+suffix, "org-parity-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_session (id, expires_at, token, user_id)
		VALUES ($1, now() + interval '1 day', $2, $3)`,
		"orgparitysess"+suffix, token, "orgparity"+suffix); err != nil {
		t.Fatal(err)
	}

	unverifiedSuffix := suffix + "u"
	unverifiedUser := "org-parity-unverified-" + unverifiedSuffix + "@example.test"
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (email, name) VALUES ($1, 'Parity Unverified')
		 ON CONFLICT (email) DO UPDATE SET name = 'Parity Unverified' RETURNING id`, unverifiedUser); err != nil {
		t.Fatal(err)
	}
	// The unverified account needs its own domain identity, otherwise it would
	// collide with the verified user's membership in the same organization.
	var unverifiedUserID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, 'Parity Unverified')
		 ON CONFLICT (email) DO UPDATE SET name = 'Parity Unverified' RETURNING id`, unverifiedUser).Scan(&unverifiedUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgA, unverifiedUserID); err != nil {
		t.Fatal(err)
	}
	unverifiedRole := seedRole(t, pool, orgA, "parity-unverified-owner-"+unverifiedSuffix, "iam.admin")
	if _, err := pool.Exec(ctx,
		`INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
		unverifiedUserID, unverifiedRole, orgA); err != nil {
		t.Fatal(err)
	}
	unverifiedToken := "org-parity-unverified-token-" + unverifiedSuffix
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_user (id, name, email, email_verified)
		VALUES ($1, 'Parity Unverified', $2, false)`,
		"orgparityunverif"+unverifiedSuffix, unverifiedUser); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_session (id, expires_at, token, user_id)
		VALUES ($1, now() + interval '1 day', $2, $3)`,
		"orgparityunverifsess"+unverifiedSuffix, unverifiedToken, "orgparityunverif"+unverifiedSuffix); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_session WHERE token = $1`, unverifiedToken)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id = $1`, "orgparityunverif"+unverifiedSuffix)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM users WHERE email = $1`, unverifiedUser)
	})

	return orgParityFixture{
		userID:     userID,
		orgA:       orgA,
		orgB:       orgB,
		cookie:     signSessionToken(t, token, secret),
		unverified: signSessionToken(t, unverifiedToken, secret),
	}
}

func seedRole(t *testing.T, pool *pgxpool.Pool, orgID, key, permission string) string {
	t.Helper()
	ctx := context.Background()
	var roleID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO roles (org_id, key, name) VALUES ($1::uuid, $2, $3) RETURNING id`,
		orgID, key, key).Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)`,
		roleID, permission, orgID); err != nil {
		t.Fatal(err)
	}
	return roleID
}

// signSessionToken mirrors Better Auth's cookie signing so the fixture can
// present a session the resolver accepts.
func signSessionToken(t *testing.T, token, secret string) string {
	t.Helper()
	signed, err := signForTest(token, secret)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

type orgParityServer struct {
	goServer *httptest.Server
	repo     *PgOrgRepository
	secret   string
}

func startOrgParityServer(t *testing.T) orgParityServer {
	t.Helper()
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		t.Skip("BETTER_AUTH_SECRET is required")
	}
	pool, err := pgxpool.New(context.Background(), orgParityEnv(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	resolver, err := newOrgSessionResolver(pool, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewOrgHandler(NewPgOrgRepository(pool), resolver, secret, nil)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return orgParityServer{goServer: server, repo: NewPgOrgRepository(pool), secret: secret}
}

// TestGoOrgRouteMatchesTheLegacyApp is the differential proof: the same cookie
// must produce the same body and status from Go and from the running legacy
// app, for every method and for a tampered active-organization cookie.
func TestGoOrgRouteMatchesTheLegacyApp(t *testing.T) {
	legacyOrigin := orgParityLegacyOrigin(t)
	goServer := startOrgParityServer(t)

	pool, err := pgxpool.New(context.Background(), orgParityEnv(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	fixture := seedOrgParityFixture(t, pool, goServer.secret)

	foreign := "99999999-9999-4999-8999-999999999999"
	cases := []struct {
		label     string
		method    string
		body      string
		cookie    string
		activeOrg string
	}{
		{"GET default org", http.MethodGet, "", fixture.cookie, ""},
		{"GET org A", http.MethodGet, "", fixture.cookie, fixture.orgA},
		{"GET org B", http.MethodGet, "", fixture.cookie, fixture.orgB},
		{"GET tampered org", http.MethodGet, "", fixture.cookie, foreign},
		{"GET uppercased org", http.MethodGet, "", fixture.cookie, strings.ToUpper(fixture.orgA)},
		{"GET no session", http.MethodGet, "", "", ""},
		{"GET unverified", http.MethodGet, "", fixture.unverified, ""},
		{"GET unverified claiming org A", http.MethodGet, "", fixture.unverified, fixture.orgA},
		{"PUT default org", http.MethodPut, "", fixture.cookie, ""},
		{"PUT no session", http.MethodPut, "", "", ""},
		{"POST invalid body", http.MethodPost, `{"orgId":"nope"}`, fixture.cookie, ""},
		{"POST missing field", http.MethodPost, `{}`, fixture.cookie, ""},
		{"POST unknown field", http.MethodPost, `{"orgId":"` + fixture.orgA + `","x":1}`, fixture.cookie, ""},
		{"POST non-member", http.MethodPost, `{"orgId":"` + foreign + `"}`, fixture.cookie, ""},
		{"POST unverified", http.MethodPost, `{"orgId":"` + fixture.orgA + `"}`, fixture.unverified, ""},
		{"POST no session", http.MethodPost, `{"orgId":"` + fixture.orgA + `"}`, "", ""},
		{"PATCH missing field", http.MethodPatch, `{}`, fixture.cookie, ""},
		{"PATCH unknown field", http.MethodPatch, `{"agentSoul":"x","y":1}`, fixture.cookie, ""},
		{"PATCH too long", http.MethodPatch, `{"agentSoul":"` + strings.Repeat("a", maxSoulLength+1) + `"}`, fixture.cookie, ""},
		{"PATCH no session", http.MethodPatch, `{"agentSoul":"x"}`, "", ""},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			legacyStatus, legacyBody := legacyOrg(t, legacyOrigin, tc.method, tc.body, tc.cookie, tc.activeOrg)
			goStatus, goBody := goOrg(t, goServer.goServer.URL, tc.method, tc.body, tc.cookie, tc.activeOrg)

			if legacyStatus != goStatus {
				t.Fatalf("status: legacy %d vs Go %d (legacy=%s go=%s)", legacyStatus, goStatus, legacyBody, goBody)
			}
			if !sameJSON(t, legacyBody, goBody) {
				t.Fatalf("body mismatch:\n  legacy %s\n  go     %s", legacyBody, goBody)
			}
		})
	}
}

func TestGoOrgRouteWorksThroughRuntimeRLS(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed the runtime-RLS organization proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is required for the runtime-RLS organization proof")
	}
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("verify runtime role: %v", err)
	}

	secret := "org-runtime-test-secret-0123456789abcdef"
	fixture := seedOrgParityFixture(t, owner, secret)
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := resolver.Resolve(ctx, fixture.cookie, fixture.orgA)
	if err != nil {
		t.Fatalf("resolve through runtime RLS: %v", err)
	}
	if resolved.OrgID == nil || *resolved.OrgID != fixture.orgA || !resolved.HasPermission("iam.admin") {
		t.Fatalf("runtime resolver returned the wrong organization or grants: %+v", resolved)
	}

	handler := NewOrgHandler(NewPgOrgRepository(runtime), resolver, secret, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/org", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: fixture.orgA})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("runtime organization list status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		ActiveOrgID string       `json:"activeOrgId"`
		Orgs        []OrgSummary `json:"orgs"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ActiveOrgID != fixture.orgA || len(body.Orgs) != 2 {
		t.Fatalf("runtime organization list = %+v, want active org %s and both memberships", body, fixture.orgA)
	}
	if body.Orgs[0].Name == "" || body.Orgs[0].BaseCurrency == "" || body.Orgs[1].Name == "" || body.Orgs[1].BaseCurrency == "" {
		t.Fatalf("runtime organization projection omitted RLS-protected fields: %+v", body.Orgs)
	}

	putRequest := httptest.NewRequest(http.MethodPut, "/api/org", nil)
	putRequest.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
	putRequest.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: fixture.orgA})
	putResponse := httptest.NewRecorder()
	handler.ServeHTTP(putResponse, putRequest)
	if putResponse.Code != http.StatusOK {
		t.Fatalf("runtime agent persona read status = %d, body = %s", putResponse.Code, putResponse.Body.String())
	}

	patchRequest := httptest.NewRequest(http.MethodPatch, "/api/org", strings.NewReader(`{"agentSoul":"runtime proof"}`))
	patchRequest.Header.Set("Content-Type", "application/json")
	patchRequest.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
	patchRequest.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: fixture.orgA})
	patchResponse := httptest.NewRecorder()
	handler.ServeHTTP(patchResponse, patchRequest)
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("runtime agent persona write status = %d, body = %s", patchResponse.Code, patchResponse.Body.String())
	}
	readRequest := httptest.NewRequest(http.MethodPut, "/api/org", nil)
	readRequest.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
	readRequest.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: fixture.orgA})
	readResponse := httptest.NewRecorder()
	handler.ServeHTTP(readResponse, readRequest)
	var persona struct {
		AgentSoul string `json:"agentSoul"`
	}
	if readResponse.Code != http.StatusOK || json.Unmarshal(readResponse.Body.Bytes(), &persona) != nil || persona.AgentSoul != "runtime proof" {
		t.Fatalf("runtime agent persona read status=%d body=%s", readResponse.Code, readResponse.Body.String())
	}
}

func legacyOrg(t *testing.T, origin, method, body, cookie, activeOrg string) (int, string) {
	t.Helper()
	var reader io.Reader = strings.NewReader(body)
	req, err := http.NewRequest(method, origin+"/api/org", reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "better-auth.session_token", Value: cookie})
	}
	if activeOrg != "" {
		req.AddCookie(&http.Cookie{Name: "chaste_active_org", Value: activeOrg})
	}
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("legacy request failed: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(raw))
}

func goOrg(t *testing.T, origin, method, body, cookie, activeOrg string) (int, string) {
	t.Helper()
	var reader io.Reader = strings.NewReader(body)
	req, err := http.NewRequest(method, origin+"/api/org", reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "better-auth.session_token", Value: cookie})
	}
	if activeOrg != "" {
		req.AddCookie(&http.Cookie{Name: "chaste_active_org", Value: activeOrg})
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("go request failed: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(raw))
}

// sameJSON compares two bodies structurally, because key order and formatting
// are not part of the contract.
func sameJSON(t *testing.T, left, right string) bool {
	t.Helper()
	var a, b any
	if err := json.Unmarshal([]byte(left), &a); err != nil {
		return false
	}
	if err := json.Unmarshal([]byte(right), &b); err != nil {
		return false
	}
	leftJSON, _ := json.Marshal(a)
	rightJSON, _ := json.Marshal(b)
	return string(leftJSON) == string(rightJSON)
}

// newOrgSessionResolver uses the production resolver, so the parity test proves
// the real thing rather than a stub.
func newOrgSessionResolver(pool *pgxpool.Pool, secret string) (SessionResolver, error) {
	return session.NewResolver(pool, secret)
}

// signForTest uses the production cookie signing.
func signForTest(token, secret string) (string, error) {
	return session.SignSessionCookie(token, secret)
}
