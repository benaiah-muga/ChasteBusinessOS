package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

type aiToolsTestEvent struct {
	role    string
	content any
}

type aiToolsTestStore struct {
	connection    bool
	member        bool
	sessionExists bool
	permissions   map[string]bool
	authSession   string
	authFound     bool

	connErr        error
	memberErr      error
	permissionsErr error
	ensureErr      error

	ensuredSession string
	events         []aiToolsTestEvent
}

func aiToolsTestStoreReady() *aiToolsTestStore {
	return &aiToolsTestStore{
		connection: true, member: true, sessionExists: true,
		permissions: map[string]bool{"*": true}, authSession: "auth-session-1", authFound: true,
	}
}

func (s *aiToolsTestStore) ActiveConnection(context.Context, string, string, string) (bool, error) {
	return s.connection, s.connErr
}

func (s *aiToolsTestStore) Member(context.Context, string, string) (bool, error) {
	return s.member, s.memberErr
}

func (s *aiToolsTestStore) SessionExists(context.Context, string, string, string) (bool, error) {
	return s.sessionExists, nil
}

func (s *aiToolsTestStore) EnsureSession(_ context.Context, sessionID, _, _ string) error {
	s.ensuredSession = sessionID
	return s.ensureErr
}

func (s *aiToolsTestStore) EffectivePermissions(context.Context, string, string) (map[string]bool, error) {
	return s.permissions, s.permissionsErr
}

func (s *aiToolsTestStore) ActiveAuthSession(context.Context, string, string) (string, bool, error) {
	return s.authSession, s.authFound, nil
}

func (s *aiToolsTestStore) AppendSessionEvent(_ context.Context, _, _, role string, content any) error {
	s.events = append(s.events, aiToolsTestEvent{role: role, content: content})
	return nil
}

func aiToolsTestToken(t *testing.T, sessionID string, tools ...string) string {
	t.Helper()
	token, err := signAIToolAccessToken(aiToolAccessClaims{
		OrgID: platformTestOrgID, UserID: platformTestUserID, ConnectionID: platformTestProposalID,
		SessionID: sessionID, AllowedTools: tools,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func aiToolsTestCall(handler http.Handler, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/ai-tools/mcp", strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func aiToolsTestRPC(t *testing.T, method string, params any) string {
	t.Helper()
	payload := map[string]any{"jsonrpc": "2.0", "id": 7, "method": method}
	if params != nil {
		payload["params"] = params
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func aiToolsTestErrorCode(t *testing.T, body map[string]any) float64 {
	t.Helper()
	rpcError, _ := body["error"].(map[string]any)
	code, _ := rpcError["code"].(float64)
	return code
}

func aiToolsTestToolText(t *testing.T, body map[string]any) (string, bool) {
	t.Helper()
	result, _ := body["result"].(map[string]any)
	isError, _ := result["isError"].(bool)
	content, _ := result["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("tool result content=%v, want one text block", result["content"])
	}
	block, _ := content[0].(map[string]any)
	text, _ := block["text"].(string)
	return text, isError
}

func TestAIToolsMCPBridgeContract(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")
	store := aiToolsTestStoreReady()
	executor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"customers":[]}`)}, nil
	}}
	handler := newAIToolsMCPHandler(store, executor, platformTestLogger(), newAIToolsRateLimiter())

	response := aiToolsTestCall(handler, "", aiToolsTestRPC(t, "initialize", nil))
	body := platformTestDecode(t, response)
	if response.Code != http.StatusUnauthorized || aiToolsTestErrorCode(t, body) != -32001 {
		t.Fatalf("invalid token status=%d body=%s, want 401 -32001", response.Code, response.Body.String())
	}

	token := aiToolsTestToken(t, "", "crm_listCustomers")

	response = aiToolsTestCall(handler, token, aiToolsTestRPC(t, "initialize", nil))
	body = platformTestDecode(t, response)
	result, _ := body["result"].(map[string]any)
	if response.Code != http.StatusOK || result["protocolVersion"] != "2025-11-25" {
		t.Fatalf("initialize status=%d body=%s, want the 2025-11-25 protocol", response.Code, response.Body.String())
	}
	if response.Header().Get("MCP-Protocol-Version") != "2025-11-25" {
		t.Fatalf("MCP-Protocol-Version=%q, want 2025-11-25", response.Header().Get("MCP-Protocol-Version"))
	}

	response = aiToolsTestCall(handler, token, aiToolsTestRPC(t, "ping", nil))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusOK || body["result"] == nil {
		t.Fatalf("ping status=%d body=%s, want an empty result", response.Code, response.Body.String())
	}

	response = aiToolsTestCall(handler, token, aiToolsTestRPC(t, "notifications/initialized", nil))
	if response.Code != http.StatusAccepted || response.Body.Len() != 0 {
		t.Fatalf("notification status=%d body=%q, want 202 with no body", response.Code, response.Body.String())
	}

	response = aiToolsTestCall(handler, token, aiToolsTestRPC(t, "prompts/list", nil))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusOK || aiToolsTestErrorCode(t, body) != -32601 {
		t.Fatalf("unknown method status=%d body=%s, want -32601", response.Code, response.Body.String())
	}

	response = aiToolsTestCall(handler, token, aiToolsTestRPC(t, "tools/list", nil))
	body = platformTestDecode(t, response)
	result, _ = body["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	if response.Code != http.StatusOK || len(tools) != 4 {
		t.Fatalf("tools/list status=%d body=%s, want three meta tools plus the pinned tool", response.Code, response.Body.String())
	}
	advertised := map[string]map[string]any{}
	for _, entry := range tools {
		tool, _ := entry.(map[string]any)
		name, _ := tool["name"].(string)
		advertised[name] = tool
	}
	for _, name := range []string{aiToolsDiscoverToolName, aiToolsDescribeToolName, aiToolsDispatchToolName} {
		if advertised[name] == nil || advertised[name]["inputSchema"] == nil {
			t.Fatalf("meta tool %q missing from %v", name, tools)
		}
	}
	if tool := advertised["crm_listCustomers"]; tool == nil || tool["inputSchema"] == nil {
		t.Fatalf("pinned direct tool missing from %v", tools)
	}

	call := map[string]any{"name": "crm_listCustomers", "arguments": map[string]any{"query": "acme"}}
	response = aiToolsTestCall(handler, token, aiToolsTestRPC(t, "tools/call", call))
	body = platformTestDecode(t, response)
	text, isError := aiToolsTestToolText(t, body)
	if response.Code != http.StatusOK || isError || text != `{"customers":[]}` {
		t.Fatalf("tools/call status=%d text=%q isError=%v, want the capability output", response.Code, text, isError)
	}
	if executor.lastCapability != "crm.listCustomers" || executor.lastClaims.ActorType != "agent" {
		t.Fatalf("execution capability=%q actor=%q, want an agent capability call", executor.lastCapability, executor.lastClaims.ActorType)
	}
	if executor.lastClaims.AuthSessionID != "auth-session-1" {
		t.Fatalf("execution auth session=%q, want the live auth session", executor.lastClaims.AuthSessionID)
	}
	if executor.lastClaims.AgentSessionID != aiToolsSessionUUID(platformTestProposalID) || store.ensuredSession != executor.lastClaims.AgentSessionID {
		t.Fatalf("agent session=%q ensured=%q, want the synthesized durable session", executor.lastClaims.AgentSessionID, store.ensuredSession)
	}

	response = aiToolsTestCall(handler, token, aiToolsTestRPC(t, "tools/call", map[string]any{"name": "crm_hackAll"}))
	body = platformTestDecode(t, response)
	text, isError = aiToolsTestToolText(t, body)
	if !isError || text != "That business action is not available to this user." {
		t.Fatalf("unknown tool text=%q isError=%v, want the refusal text", text, isError)
	}
}

func TestAIToolsMCPAuthorization(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")
	call := map[string]any{"name": "crm_listCustomers", "arguments": map[string]any{}}
	token := aiToolsTestToken(t, "", "crm_listCustomers")

	revokedStore := aiToolsTestStoreReady()
	revokedStore.connection = false
	response := aiToolsTestCall(newAIToolsMCPHandler(revokedStore, &platformTestExecutor{}, platformTestLogger(), newAIToolsRateLimiter()), token, aiToolsTestRPC(t, "tools/call", call))
	body := platformTestDecode(t, response)
	rpcError, _ := body["error"].(map[string]any)
	if response.Code != http.StatusUnauthorized || rpcError["message"] != "This coding-agent connection has been revoked." {
		t.Fatalf("revoked status=%d body=%s, want 401 revoked message", response.Code, response.Body.String())
	}

	foreignStore := aiToolsTestStoreReady()
	foreignStore.member = false
	response = aiToolsTestCall(newAIToolsMCPHandler(foreignStore, &platformTestExecutor{}, platformTestLogger(), newAIToolsRateLimiter()), token, aiToolsTestRPC(t, "tools/call", call))
	body = platformTestDecode(t, response)
	rpcError, _ = body["error"].(map[string]any)
	if response.Code != http.StatusUnauthorized || rpcError["message"] != "The connected user no longer belongs to this workspace." {
		t.Fatalf("foreign user status=%d body=%s, want 401 workspace message", response.Code, response.Body.String())
	}

	deadSessionStore := aiToolsTestStoreReady()
	deadSessionStore.sessionExists = false
	sessionToken := aiToolsTestToken(t, platformTestSessionID, "crm_listCustomers")
	response = aiToolsTestCall(newAIToolsMCPHandler(deadSessionStore, &platformTestExecutor{}, platformTestLogger(), newAIToolsRateLimiter()), sessionToken, aiToolsTestRPC(t, "tools/call", call))
	body = platformTestDecode(t, response)
	rpcError, _ = body["error"].(map[string]any)
	if response.Code != http.StatusUnauthorized || rpcError["message"] != "The assistant session is no longer available." {
		t.Fatalf("dead session status=%d body=%s, want 401 session message", response.Code, response.Body.String())
	}

	noAuthStore := aiToolsTestStoreReady()
	noAuthStore.authFound = false
	response = aiToolsTestCall(newAIToolsMCPHandler(noAuthStore, &platformTestExecutor{}, platformTestLogger(), newAIToolsRateLimiter()), token, aiToolsTestRPC(t, "tools/call", call))
	body = platformTestDecode(t, response)
	rpcError, _ = body["error"].(map[string]any)
	if response.Code != http.StatusUnauthorized || rpcError["message"] != "The connected user is not available." {
		t.Fatalf("missing auth session status=%d body=%s, want 401 unavailable message", response.Code, response.Body.String())
	}

	eventStore := aiToolsTestStoreReady()
	executor := &platformTestExecutor{}
	eventHandler := newAIToolsMCPHandler(eventStore, executor, platformTestLogger(), newAIToolsRateLimiter())
	response = aiToolsTestCall(eventHandler, sessionToken, aiToolsTestRPC(t, "tools/call", call))
	if response.Code != http.StatusOK || len(eventStore.events) != 2 {
		t.Fatalf("session events status=%d events=%d, want tool_call and tool_result", response.Code, len(eventStore.events))
	}
	if eventStore.events[0].role != "tool_call" || eventStore.events[1].role != "tool_result" {
		t.Fatalf("event roles=%q/%q, want tool_call then tool_result", eventStore.events[0].role, eventStore.events[1].role)
	}
	if eventStore.ensuredSession != "" {
		t.Fatalf("ensured session=%q, want none for a session-scoped token", eventStore.ensuredSession)
	}

	sessionlessStore := aiToolsTestStoreReady()
	response = aiToolsTestCall(newAIToolsMCPHandler(sessionlessStore, &platformTestExecutor{}, platformTestLogger(), newAIToolsRateLimiter()), token, aiToolsTestRPC(t, "tools/call", call))
	if response.Code != http.StatusOK || len(sessionlessStore.events) != 0 {
		t.Fatalf("session-less events status=%d events=%d, want none", response.Code, len(sessionlessStore.events))
	}
}

func TestAIToolsMCPToolFilteringAndRateLimit(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")

	noToolsStore := aiToolsTestStoreReady()
	noTools := newAIToolsMCPHandler(noToolsStore, &platformTestExecutor{}, platformTestLogger(), newAIToolsRateLimiter())
	emptyToken := aiToolsTestToken(t, "")
	response := aiToolsTestCall(noTools, emptyToken, aiToolsTestRPC(t, "tools/list", nil))
	body := platformTestDecode(t, response)
	result, _ := body["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	if response.Code != http.StatusOK || len(tools) != 3 {
		t.Fatalf("empty allowlist status=%d tools=%v, want the three meta tools only", response.Code, result["tools"])
	}
	names := map[string]bool{}
	for _, entry := range tools {
		tool, _ := entry.(map[string]any)
		name, _ := tool["name"].(string)
		names[name] = true
	}
	if !names[aiToolsDiscoverToolName] || !names[aiToolsDescribeToolName] || !names[aiToolsDispatchToolName] {
		t.Fatalf("meta tools=%v", names)
	}

	limiter := newAIToolsRateLimiter()
	now := time.Now()
	for i := 0; i < 180; i++ {
		if !limiter.Allow("key", 180, time.Minute, now) {
			t.Fatalf("allowance %d rejected below the limit", i+1)
		}
	}
	if limiter.Allow("key", 180, time.Minute, now) {
		t.Fatal("rate limit did not reject the request past the window maximum")
	}
	if !limiter.Allow("key", 180, time.Minute, now.Add(time.Minute)) {
		t.Fatal("rate limit did not reset after the window elapsed")
	}

	limited := newAIToolsRateLimiter()
	limited.windows["coding-tools:"+platformTestUserID+":"+platformTestProposalID] = aiToolsRateWindow{start: time.Now(), count: 180}
	response = aiToolsTestCall(
		newAIToolsMCPHandler(aiToolsTestStoreReady(), &platformTestExecutor{}, platformTestLogger(), limited),
		aiToolsTestToken(t, "", "crm_listCustomers"),
		aiToolsTestRPC(t, "tools/call", map[string]any{"name": "crm_listCustomers"}))
	body = platformTestDecode(t, response)
	if response.Code != http.StatusTooManyRequests || aiToolsTestErrorCode(t, body) != -32029 {
		t.Fatalf("limited status=%d body=%s, want 429 -32029", response.Code, response.Body.String())
	}
}

func TestAIToolsMCPProgressiveDisclosure(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")
	store := aiToolsTestStoreReady()
	executor := &platformTestExecutor{fn: func(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"customers":[]}`)}, nil
	}}
	handler := newAIToolsMCPHandler(store, executor, platformTestLogger(), newAIToolsRateLimiter())
	token := aiToolsTestToken(t, "session-progressive")

	call := func(name string, arguments map[string]any) (string, bool) {
		t.Helper()
		response := aiToolsTestCall(handler, token, aiToolsTestRPC(t, "tools/call", map[string]any{"name": name, "arguments": arguments}))
		body := platformTestDecode(t, response)
		text, isError := aiToolsTestToolText(t, body)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", name, response.Code, response.Body.String())
		}
		return text, isError
	}

	text, isError := call(aiToolsDiscoverToolName, map[string]any{"query": "find a customer"})
	if isError {
		t.Fatalf("discover refused: %s", text)
	}
	var discovery struct {
		Count        int `json:"count"`
		Capabilities []struct {
			ID     string `json:"id"`
			Intent string `json:"intent"`
			Risk   string `json:"risk"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal([]byte(text), &discovery); err != nil {
		t.Fatalf("discover returned invalid JSON: %v (%s)", err, text)
	}
	if discovery.Count == 0 {
		t.Fatalf("discover found nothing for a customer query: %s", text)
	}
	found := false
	for _, row := range discovery.Capabilities {
		if row.ID == "crm.listCustomers" {
			found = true
		}
		if row.Intent == "" {
			t.Fatalf("discover row is missing its intent: %+v", row)
		}
	}
	if !found {
		t.Fatalf("discover did not return crm.listCustomers: %s", text)
	}
	if strings.Contains(text, "inputSchema") {
		t.Fatalf("discover must stay short and leave schemas to describe: %s", text)
	}

	text, isError = call(aiToolsDescribeToolName, map[string]any{"capabilityId": "crm.listCustomers"})
	if isError {
		t.Fatalf("describe refused: %s", text)
	}
	for _, want := range []string{`"id":"crm.listCustomers"`, `"permission":"crm.read"`, `"risk":"read"`, `"inputSchema"`, `"skills"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("describe missing %q: %s", want, text)
		}
	}

	text, isError = call(aiToolsDispatchToolName, map[string]any{"capabilityId": "crm.listCustomers", "input": map[string]any{"query": "acme"}})
	if isError || text != `{"customers":[]}` {
		t.Fatalf("dispatch text=%q isError=%v", text, isError)
	}
	if executor.lastCapability != "crm.listCustomers" || executor.lastClaims.ActorType != "agent" {
		t.Fatalf("execution capability=%q actor=%q", executor.lastCapability, executor.lastClaims.ActorType)
	}
	if len(store.events) != 2 || store.events[0].role != "tool_call" || store.events[1].role != "tool_result" {
		t.Fatalf("a dispatched capability must be in the trajectory: %+v", store.events)
	}

	if text, isError = call(aiToolsDispatchToolName, map[string]any{"capabilityId": "crm.notARealCapability", "input": map[string]any{}}); !isError {
		t.Fatalf("an unknown capability must be refused, got %s", text)
	}
	if text, isError = call(aiToolsDescribeToolName, map[string]any{"capabilityId": "crm.notARealCapability"}); !isError {
		t.Fatalf("describing an unknown capability must be refused, got %s", text)
	}
	response := aiToolsTestCall(handler, token, aiToolsTestRPC(t, "tools/call", map[string]any{
		"name":      aiToolsDispatchToolName,
		"arguments": map[string]any{"capabilityId": "crm.listCustomers", "input": "not-an-object"},
	}))
	if code := aiToolsTestErrorCode(t, platformTestDecode(t, response)); code != -32602 {
		t.Fatalf("non-object input error code=%v, want -32602", code)
	}
}
