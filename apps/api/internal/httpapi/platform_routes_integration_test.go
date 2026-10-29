package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func platformIntegrationPools(t *testing.T) (context.Context, *pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the platform route integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the platform route integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
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
		t.Fatalf("runtime database role is unsafe: %v", err)
	}
	return ctx, owner, runtime
}

func platformIntegrationRequest(handler http.Handler, method, target, body, orgID, cookie string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Origin", "https://app.example.test")
	request.Header.Set("X-Organization-ID", orgID)
	request.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestPlatformRoutesIntegration(t *testing.T) {
	ctx, owner, runtime := platformIntegrationPools(t)
	secret := os.Getenv("BETTER_AUTH_SECRET")
	fixture := seedOrgParityFixture(t, owner, secret)

	if _, err := owner.Exec(ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		SELECT id, 'platform.creator', org_id FROM roles
		WHERE org_id=$1::uuid AND key LIKE 'parity-owner-%'
		ON CONFLICT DO NOTHING`, fixture.orgA); err != nil {
		t.Fatalf("grant platform.creator in the fixture organization: %v", err)
	}
	// Org B needs the Creator module and permission too, so the empty org B
	// proposal list proves tenant isolation rather than a module gate.
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm","creator"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("enable the Creator module in the second fixture organization: %v", err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		SELECT id, 'platform.creator', org_id FROM roles
		WHERE org_id=$1::uuid AND key LIKE 'parity-reader-%'
		ON CONFLICT DO NOTHING`, fixture.orgB); err != nil {
		t.Fatalf("grant Creator access in the second fixture organization: %v", err)
	}

	var proposalID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO creator_proposals (org_id, title, summary, diff_text, proposed_by_actor_type)
		VALUES ($1::uuid, 'Integration proposal', 'A proposal seeded for the HTTP parity proof.', 'diff --git a/x b/x', 'system')
		RETURNING id`, fixture.orgA).Scan(&proposalID); err != nil {
		t.Fatalf("seed creator proposal: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	executor := capability.NewExecutor(runtime, "", "", "")
	proposals, err := NewProposalsHandler(resolver, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}

	response := platformIntegrationRequest(proposals, http.MethodGet, "/api/proposals", "", fixture.orgA, "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated proposals status=%d body=%s, want 401", response.Code, response.Body.String())
	}

	response = platformIntegrationRequest(proposals, http.MethodGet, "/api/proposals", "", fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("org A proposals status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	var listed capability.CreatorListProposalsOutput
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode proposals %s: %v", response.Body.String(), err)
	}
	if len(listed.Proposals) != 1 || listed.Proposals[0].ID != proposalID || listed.Proposals[0].Title != "Integration proposal" {
		t.Fatalf("org A proposals=%+v, want only the seeded proposal", listed.Proposals)
	}

	response = platformIntegrationRequest(proposals, http.MethodGet, "/api/proposals", "", fixture.orgB, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("org B proposals status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Proposals) != 0 {
		t.Fatalf("org B proposals=%+v, want the other organization's proposal hidden", listed.Proposals)
	}

	response = platformIntegrationRequest(proposals, http.MethodGet, "/api/proposals", "", fixture.orgA, fixture.unverified)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unverified proposals status=%d body=%s, want 401", response.Code, response.Body.String())
	}

	response = platformIntegrationRequest(proposals, http.MethodPost, "/api/proposals",
		`{"proposalId":"`+proposalID+`","decision":"approved","comment":"Reviewed over HTTP"}`, fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("review status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	body := platformTestDecode(t, response)
	if body["ok"] != true || body["note"] != "decision recorded; merge the change through your normal PR flow" {
		t.Fatalf("review body=%s, want the recorded decision note", response.Body.String())
	}
	var status string
	if err := owner.QueryRow(ctx, `SELECT status FROM creator_proposals WHERE id=$1::uuid`, proposalID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "approved" {
		t.Fatalf("proposal status=%q, want approved", status)
	}

	gaps, err := NewCapabilityGapsHandler(resolver, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = platformIntegrationRequest(gaps, http.MethodGet, "/api/capability-gaps", "", fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("capability gaps status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	if _, present := platformTestDecode(t, response)["gaps"]; !present {
		t.Fatalf("capability gaps body=%s, want a gaps array", response.Body.String())
	}

	marketplace, err := NewMarketplaceHandler(resolver, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = platformIntegrationRequest(marketplace, http.MethodGet, "/api/marketplace", "", fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("marketplace status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	if _, present := platformTestDecode(t, response)["listings"]; !present {
		t.Fatalf("marketplace body=%s, want a listings array", response.Body.String())
	}

	harness, err := NewHarnessCompositionsHandler(resolver, executor, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	response = platformIntegrationRequest(harness, http.MethodGet, "/api/harness/compositions", "", fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("harness status=%d body=%s, want 200 for the iam.admin inspection bypass", response.Code, response.Body.String())
	}
}

func TestAIConnectionsIntegration(t *testing.T) {
	ctx, owner, runtime := platformIntegrationPools(t)
	secret := os.Getenv("BETTER_AUTH_SECRET")
	fixture := seedOrgParityFixture(t, owner, secret)
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", secret)
	t.Setenv("NODE_ENV", "test")
	t.Setenv("GO_ENV", "test")
	t.Setenv("APP_ENV", "test")
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_, _ = owner.Exec(cleanupCtx, `DELETE FROM coding_agent_connections WHERE org_id = ANY($1::uuid[])`, []string{fixture.orgA, fixture.orgB})
	})

	var mcpName string
	var mcpBearer string
	var mcpURL string
	openCode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/global/health":
			_, _ = io.WriteString(w, `{"healthy":true}`)
		case "/provider":
			_, _ = io.WriteString(w, `{"connected":[{"id":"anthropic"}]}`)
		case "/mcp":
			var payload struct {
				Name   string `json:"name"`
				Config struct {
					URL     string            `json:"url"`
					Headers map[string]string `json:"headers"`
				} `json:"config"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode /mcp payload: %v", err)
			}
			mcpName, mcpURL = payload.Name, payload.Config.URL
			mcpBearer = payload.Config.Headers["Authorization"]
			_, _ = io.WriteString(w, `{"status":"configured"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(openCode.Close)

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, err := NewAIConnectionsHandler(runtime, resolver, nil, logger)
	if err != nil {
		t.Fatal(err)
	}

	response := platformIntegrationRequest(handler, http.MethodPost, "/api/ai-connections",
		`{"action":"connect_opencode","endpoint":"`+openCode.URL+`","password":"secret-pass"}`, fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("connect status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	body := platformTestDecode(t, response)
	connection, _ := body["connection"].(map[string]any)
	connectionID, _ := connection["id"].(string)
	if body["ok"] != true || connectionID == "" {
		t.Fatalf("connect body=%s, want a stored connection", response.Body.String())
	}
	if mcpName != "chaste_"+strings.ReplaceAll(connectionID, "-", "")[:12] {
		t.Fatalf("mcp name=%q, want the connection-derived bridge name", mcpName)
	}
	if !strings.HasSuffix(mcpURL, "/api/ai-tools/mcp") {
		t.Fatalf("mcp url=%q, want the Chaste tool bridge", mcpURL)
	}
	token := strings.TrimPrefix(mcpBearer, "Bearer ")
	if token == "" {
		t.Fatal("the bridge configuration carried no bearer token")
	}
	claims, ok := verifyAIToolAccessToken(token, time.Now())
	if !ok || claims.ConnectionID != connectionID || claims.OrgID != fixture.orgA || claims.UserID != fixture.userID {
		t.Fatalf("bridge claims=%+v ok=%v, want a scoped Chaste tool token", claims, ok)
	}

	var stored string
	if err := owner.QueryRow(ctx, `SELECT status FROM coding_agent_connections WHERE id=$1::uuid`, connectionID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "connected" {
		t.Fatalf("stored status=%q, want connected", stored)
	}

	response = platformIntegrationRequest(handler, http.MethodGet, "/api/ai-connections", "", fixture.orgA, fixture.cookie)
	body = platformTestDecode(t, response)
	connections, _ := body["connections"].([]any)
	if response.Code != http.StatusOK || len(connections) != 1 {
		t.Fatalf("list status=%d body=%s, want the stored connection", response.Code, response.Body.String())
	}

	response = platformIntegrationRequest(handler, http.MethodGet, "/api/ai-connections", "", fixture.orgB, fixture.cookie)
	body = platformTestDecode(t, response)
	connections, _ = body["connections"].([]any)
	if response.Code != http.StatusOK || len(connections) != 0 {
		t.Fatalf("cross-org list status=%d body=%s, want isolation", response.Code, response.Body.String())
	}

	response = platformIntegrationRequest(handler, http.MethodPost, "/api/ai-connections",
		`{"action":"connect_opencode","endpoint":"https://192.168.1.10","password":"secret-pass"}`, fixture.orgA, fixture.cookie)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("private address status=%d body=%s, want 422", response.Code, response.Body.String())
	}

	response = platformIntegrationRequest(handler, http.MethodPost, "/api/ai-connections",
		`{"action":"set_default","connectionId":"`+connectionID+`"}`, fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("set default status=%d body=%s, want 200", response.Code, response.Body.String())
	}

	response = platformIntegrationRequest(handler, http.MethodPost, "/api/ai-connections",
		`{"action":"disconnect","provider":"opencode"}`, fixture.orgA, fixture.cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("disconnect status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM coding_agent_connections WHERE id=$1::uuid`, connectionID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "disconnected" {
		t.Fatalf("stored status=%q after disconnect, want disconnected", stored)
	}
}

func TestAIToolsMCPStoreIntegration(t *testing.T) {
	ctx, owner, runtime := platformIntegrationPools(t)
	secret := os.Getenv("BETTER_AUTH_SECRET")
	fixture := seedOrgParityFixture(t, owner, secret)
	if _, err := owner.Exec(ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		SELECT id, 'platform.creator', org_id FROM roles
		WHERE org_id=$1::uuid AND key LIKE 'parity-owner-%'
		ON CONFLICT DO NOTHING`, fixture.orgA); err != nil {
		t.Fatalf("grant platform.creator in the fixture organization: %v", err)
	}

	var connectionID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO coding_agent_connections (org_id, user_id, provider, endpoint, status)
		VALUES ($1::uuid, $2::uuid, 'opencode', 'https://opencode.example.test', 'connected')
		RETURNING id`, fixture.orgA, fixture.userID).Scan(&connectionID); err != nil {
		t.Fatalf("seed coding agent connection: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_, _ = owner.Exec(cleanupCtx, `DELETE FROM coding_agent_connections WHERE id=$1::uuid`, connectionID)
	})

	store := newPgAIToolsMCPStore(runtime)
	active, err := store.ActiveConnection(ctx, connectionID, fixture.orgA, fixture.userID)
	if err != nil || !active {
		t.Fatalf("ActiveConnection=%v err=%v, want true", active, err)
	}
	foreign, err := store.ActiveConnection(ctx, connectionID, fixture.orgB, fixture.userID)
	if err != nil || foreign {
		t.Fatalf("cross-org ActiveConnection=%v err=%v, want false", foreign, err)
	}
	member, err := store.Member(ctx, fixture.orgA, fixture.userID)
	if err != nil || !member {
		t.Fatalf("Member=%v err=%v, want true", member, err)
	}

	sessionID := aiToolsSessionUUID(connectionID)
	if err := store.EnsureSession(ctx, sessionID, fixture.orgA, fixture.userID); err != nil {
		t.Fatalf("EnsureSession: %v", err)
	}
	if err := store.EnsureSession(ctx, sessionID, fixture.orgA, fixture.userID); err != nil {
		t.Fatalf("EnsureSession replay: %v", err)
	}
	exists, err := store.SessionExists(ctx, sessionID, fixture.orgA, fixture.userID)
	if err != nil || !exists {
		t.Fatalf("SessionExists=%v err=%v, want the ensured session", exists, err)
	}
	missing, err := store.SessionExists(ctx, sessionID, fixture.orgB, fixture.userID)
	if err != nil || missing {
		t.Fatalf("cross-org SessionExists=%v err=%v, want false", missing, err)
	}

	permissions, err := store.EffectivePermissions(ctx, fixture.orgA, fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	if !permissions["platform.creator"] || !permissions["iam.admin"] {
		t.Fatalf("permissions=%v, want the granted role permissions", permissions)
	}

	authSession, found, err := store.ActiveAuthSession(ctx, fixture.orgA, fixture.userID)
	if err != nil || !found || authSession == "" {
		t.Fatalf("ActiveAuthSession=%q found=%v err=%v, want the fixture session", authSession, found, err)
	}

	// The connection the product configures carries an empty direct-tool
	// allowlist. It must still reach the governed catalog through the three
	// meta tools, not advertise nothing.
	handler := newAIToolsMCPHandler(store, &platformTestExecutor{}, platformTestLogger(), newAIToolsRateLimiter())
	token, err := signAIToolAccessToken(aiToolAccessClaims{
		OrgID: fixture.orgA, UserID: fixture.userID, ConnectionID: connectionID, AllowedTools: []string{},
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	response := aiToolsTestCall(handler, token, aiToolsTestRPC(t, "tools/list", nil))
	body := platformTestDecode(t, response)
	result, _ := body["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	if len(tools) != 3 {
		t.Fatalf("production bridge advertised %d tools, want the three meta tools: %s", len(tools), response.Body.String())
	}

	if err := store.AppendSessionEvent(ctx, fixture.orgA, sessionID, "tool_call", map[string]any{"name": "crm.listCustomers", "args": map[string]any{}}); err != nil {
		t.Fatalf("AppendSessionEvent: %v", err)
	}
	var seq int
	if err := owner.QueryRow(ctx, `SELECT COALESCE(MAX(seq),0) FROM session_events WHERE session_id=$1::uuid`, sessionID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if seq != 1 {
		t.Fatalf("session event seq=%d, want one appended event", seq)
	}
}
