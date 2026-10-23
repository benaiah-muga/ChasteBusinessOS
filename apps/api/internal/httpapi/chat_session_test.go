package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeChatSessionStore struct {
	mu            sync.Mutex
	owned         map[string]bool
	ownedErr      error
	createID      string
	createErr     error
	createCalls   []fakeChatCreateCall
	touched       []string
	touchErr      error
	orgName       string
	orgSoul       *string
	profileErr    error
	events        []fakeChatEvent
	appendErr     error
	usage         chatUsage
	usageErr      error
	addUsageCalls int
}

type fakeChatCreateCall struct {
	orgID, userID, title, modelRef string
}

type fakeChatEvent struct {
	role    string
	content map[string]any
}

func newFakeChatSessionStore() *fakeChatSessionStore {
	return &fakeChatSessionStore{
		owned:    map[string]bool{},
		createID: "55555555-5555-4555-8555-555555555555",
		orgName:  "Test Org",
	}
}

func (s *fakeChatSessionStore) Owned(_ context.Context, _, sessionID, _ string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.owned[sessionID], s.ownedErr
}

func (s *fakeChatSessionStore) Touch(_ context.Context, _, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.touched = append(s.touched, sessionID)
	return s.touchErr
}

func (s *fakeChatSessionStore) Create(_ context.Context, orgID, userID, title, modelRef string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.createCalls = append(s.createCalls, fakeChatCreateCall{orgID: orgID, userID: userID, title: title, modelRef: modelRef})
	return s.createID, s.createErr
}

func (s *fakeChatSessionStore) OrgProfile(context.Context, string) (string, *string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.orgName, s.orgSoul, s.profileErr
}

func (s *fakeChatSessionStore) AppendEvent(_ context.Context, _, _, role string, content any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.appendErr != nil {
		return s.appendErr
	}
	encoded, _ := json.Marshal(content)
	var decoded map[string]any
	_ = json.Unmarshal(encoded, &decoded)
	s.events = append(s.events, fakeChatEvent{role: role, content: decoded})
	return nil
}

func (s *fakeChatSessionStore) AddUsage(_ context.Context, _, _ string, turn chatUsage) (chatUsage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.addUsageCalls++
	s.usage.Input += turn.Input
	s.usage.Output += turn.Output
	s.usage.CachedInput += turn.CachedInput
	if s.usageErr != nil {
		return turn, s.usageErr
	}
	return s.usage, nil
}

func (s *fakeChatSessionStore) recordedEvents() []fakeChatEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fakeChatEvent(nil), s.events...)
}

func (s *fakeChatSessionStore) created() []fakeChatCreateCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fakeChatCreateCall(nil), s.createCalls...)
}

func (s *fakeChatSessionStore) addUsageCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addUsageCalls
}

type fakeChatConfigReader struct {
	config myWorkSummaryConfig
	err    error
}

func (f *fakeChatConfigReader) LoadForOrg(context.Context, string, string) (myWorkSummaryConfig, error) {
	return f.config, f.err
}

func chatTestIdentity() *session.ResolvedUser {
	orgID := "11111111-1111-4111-8111-111111111111"
	return &session.ResolvedUser{
		UserID: "22222222-2222-4222-8222-222222222222", OrgID: &orgID,
		Permissions: map[string]bool{"crm.read": true, "crm.write": true}, EmailVerified: true,
		AuthSessionID: "33333333-3333-4333-8333-333333333333",
	}
}

type chatTestHandlerOptions struct {
	store    *fakeChatSessionStore
	provider chatProvider
	config   *fakeChatConfigReader
	resolved *session.ResolvedUser
	limiter  *chatRateLimiter
}

type chatTestSuite struct {
	handler  *chatSessionHandler
	resolver *fakeDirectSessionResolver
	store    *fakeChatSessionStore
	executor *scriptedChatExecutor
	config   *fakeChatConfigReader
	provider chatProvider
}

func newChatTestSuite(t *testing.T, options chatTestHandlerOptions) *chatTestSuite {
	t.Helper()
	t.Helper()
	store := options.store
	if store == nil {
		store = newFakeChatSessionStore()
	}
	resolved := options.resolved
	if resolved == nil {
		resolved = chatTestIdentity()
	}
	resolver := &fakeDirectSessionResolver{resolved: resolved}
	config := options.config
	if config == nil {
		config = &fakeChatConfigReader{config: myWorkSummaryConfig{provider: "openai-compat", baseURL: "https://provider.example.test/v1", apiKey: "key", primaryModel: "primary-model"}}
	}
	executor := &scriptedChatExecutor{}
	limiter := options.limiter
	if limiter == nil {
		limiter = newChatRateLimiter(12)
	}
	handler := &chatSessionHandler{
		resolver: resolver, executor: executor, config: config, store: store,
		steering: newChatSteeringStore(), limiter: limiter,
		providerFor: func(myWorkSummaryConfig) chatProvider {
			if options.provider == nil {
				return &scriptedChatProvider{turns: []chatTurn{{message: "hello"}}}
			}
			return options.provider
		},
		contextWindow: chatDefaultContextWindow, reserveTokens: chatDefaultReserveTokens,
	}
	return &chatTestSuite{handler: handler, resolver: resolver, store: store, executor: executor, config: config, provider: options.provider}
}

type chatTestRequestOptions struct {
	cookie bool
	bearer bool
	origin bool
	host   string
	active string
	header map[string]string
}

func chatTestRequest(method, body string, options chatTestRequestOptions) *http.Request {
	request := httptest.NewRequest(method, "/api/chat", strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	if options.host != "" {
		request.Host = options.host
	}
	request.Header.Set("Content-Type", "application/json")
	if options.origin {
		request.Header.Set("Origin", "https://app.example.test")
	}
	if options.bearer {
		request.Header.Set("Authorization", "Bearer session-token")
	} else if options.cookie {
		active := options.active
		if active == "" {
			active = "11111111-1111-4111-8111-111111111111"
		}
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
		request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: active})
	}
	for key, value := range options.header {
		request.Header.Set(key, value)
	}
	return request
}

func defaultCookieChatRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	return chatTestRequest(http.MethodPost, body, chatTestRequestOptions{cookie: true, origin: true})
}

func decodeChatNDJSON(t *testing.T, recorder *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	trimmed := strings.TrimSuffix(recorder.Body.String(), "\n")
	if trimmed == "" {
		return nil
	}
	lines := strings.Split(trimmed, "\n")
	events := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("NDJSON line %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

func chatEventTypes(events []map[string]any) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		value, _ := event["type"].(string)
		types = append(types, value)
	}
	return types
}

func waitForChatEvents(t *testing.T, store *fakeChatSessionStore, roles ...string) []fakeChatEvent {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		events := store.recordedEvents()
		matched := 0
		for _, wanted := range roles {
			for _, event := range events {
				if event.role == wanted {
					matched++
					break
				}
			}
		}
		if matched == len(roles) {
			return events
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for persisted roles %v; got %+v", roles, store.recordedEvents())
	return nil
}

func TestChatSessionHandlerAppliesAuthAndValidationLevels(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		options    chatTestRequestOptions
		mutate     func(*chatTestSuite)
		wantStatus int
		wantError  string
	}{
		{name: "resolver error", body: `{"message":"hi"}`, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(s *chatTestSuite) {
			s.resolver.err = errors.New("bad session")
		}, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "nil session", body: `{"message":"hi"}`, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(s *chatTestSuite) {
			s.resolver.resolved = nil
		}, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "unverified email", body: `{"message":"hi"}`, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(s *chatTestSuite) {
			s.resolver.resolved.EmailVerified = false
		}, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "missing auth session", body: `{"message":"hi"}`, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(s *chatTestSuite) {
			s.resolver.resolved.AuthSessionID = ""
		}, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "no active organization", body: `{"message":"hi"}`, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(s *chatTestSuite) {
			s.resolver.resolved.OrgID = nil
		}, wantStatus: http.StatusPreconditionRequired, wantError: "onboarding required"},
		{name: "organization header mismatch", body: `{"message":"hi"}`, options: chatTestRequestOptions{cookie: true, origin: true, header: map[string]string{"X-Organization-ID": "99999999-9999-4999-8999-999999999999"}}, wantStatus: http.StatusForbidden, wantError: "organization access denied"},
		{name: "cookie without same origin", body: `{"message":"hi"}`, options: chatTestRequestOptions{cookie: true}, wantStatus: http.StatusForbidden, wantError: "forbidden"},
		{name: "unknown field", body: `{"message":"hi","extra":true}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "trailing json", body: `{"message":"hi"}{"message":"again"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "empty message", body: `{"message":""}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "message too long", body: `{"message":"` + strings.Repeat("x", 8001) + `"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "bad session id", body: `{"message":"hi","sessionId":"not-a-uuid"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "null session id", body: `{"message":"hi","sessionId":null}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "bad mode", body: `{"message":"hi","mode":"admin"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "null mode", body: `{"message":"hi","mode":null}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			suite := newChatTestSuite(t, chatTestHandlerOptions{})
			if testCase.mutate != nil {
				testCase.mutate(suite)
			}
			recorder := httptest.NewRecorder()
			suite.handler.ServeHTTP(recorder, chatTestRequest(http.MethodPost, testCase.body, testCase.options))
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status=%d body=%s, want %d", recorder.Code, recorder.Body.String(), testCase.wantStatus)
			}
			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("body=%s", recorder.Body.String())
			}
			if body["error"] != testCase.wantError {
				t.Fatalf("error=%q, want %q", body["error"], testCase.wantError)
			}
			if testCase.wantStatus == http.StatusUnauthorized && recorder.Header().Get("WWW-Authenticate") == "" {
				t.Fatal("401 must carry WWW-Authenticate")
			}
			if suite.provider != nil {
				t.Fatal("no request in this table may reach the provider")
			}
		})
	}
}

func TestChatSessionHandlerRejectsNonPost(t *testing.T) {
	suite := newChatTestSuite(t, chatTestHandlerOptions{})
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, chatTestRequest(http.MethodGet, "", chatTestRequestOptions{cookie: true, origin: true}))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != "POST" {
		t.Fatalf("status=%d allow=%q", recorder.Code, recorder.Header().Get("Allow"))
	}
}

func TestChatSessionHandlerRateLimitsPerUser(t *testing.T) {
	fixed := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	limiter := &chatRateLimiter{buckets: map[string]chatRateBucket{}, max: 2, window: time.Minute, now: func() time.Time { return fixed }}
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}, {message: "ok"}, {message: "ok"}}}
	suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider, limiter: limiter})
	for attempt := 0; attempt < 2; attempt++ {
		recorder := httptest.NewRecorder()
		suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
		if recorder.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d", attempt, recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d, want 429", recorder.Code)
	}
	if recorder.Header().Get("Retry-After") != "60" {
		t.Fatalf("Retry-After=%q, want 60", recorder.Header().Get("Retry-After"))
	}
	var body map[string]string
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	if body["error"] != "too many requests" {
		t.Fatalf("error=%q", body["error"])
	}
	if provider.callCount() != 2 {
		t.Fatalf("provider calls=%d, want only the allowed turns", provider.callCount())
	}
}

func TestChatSessionHandlerNotFoundForUnownedSession(t *testing.T) {
	suite := newChatTestSuite(t, chatTestHandlerOptions{})
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi","sessionId":"66666666-6666-4666-8666-666666666666"}`))
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), "session not found") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestChatSessionHandlerStreamsDoneAndPersistsTrajectory(t *testing.T) {
	store := newFakeChatSessionStore()
	store.usage = chatUsage{Input: 10, Output: 5, CachedInput: 4}
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "Hi there", usage: chatUsage{Input: 2, Output: 1, CachedInput: 1}}}}
	suite := newChatTestSuite(t, chatTestHandlerOptions{store: store, provider: provider})
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hello world"}`))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("X-Session-Id") != store.createID {
		t.Fatalf("X-Session-Id=%q", recorder.Header().Get("X-Session-Id"))
	}
	events := decodeChatNDJSON(t, recorder)
	if types := chatEventTypes(events); strings.Join(types, ",") != "step,delta,done" {
		t.Fatalf("events=%v", types)
	}
	done := events[2]
	if done["sessionId"] != store.createID || done["reply"] != "Hi there" {
		t.Fatalf("done=%v", done)
	}
	usage := done["usage"].(map[string]any)
	turn := usage["turn"].(map[string]any)
	sessionUsage := usage["session"].(map[string]any)
	if turn["input"] != float64(2) || turn["cachedInput"] != float64(1) || sessionUsage["cachedInput"] != float64(5) || sessionUsage["input"] != float64(12) {
		t.Fatalf("usage=%v", usage)
	}
	created := store.created()
	if len(created) != 1 || created[0].title != "hello world" || created[0].modelRef != "primary-model" {
		t.Fatalf("created=%+v", created)
	}
	persisted := store.recordedEvents()
	if len(persisted) != 2 || persisted[0].role != "user" || persisted[1].role != "assistant" {
		t.Fatalf("persisted=%+v", persisted)
	}
	if persisted[1].content["text"] != "Hi there" {
		t.Fatalf("assistant content=%v", persisted[1].content)
	}
	if store.addUsageCount() != 1 || provider.callCount() != 1 {
		t.Fatalf("usage calls=%d provider calls=%d", store.addUsageCount(), provider.callCount())
	}
	first := provider.callMessages(0)
	if len(first) != 2 || first[0].Role != "system" || !strings.Contains(first[0].Content, `for "Test Org"`) {
		t.Fatalf("provider messages=%+v", first)
	}
}

func TestChatSessionHandlerCreatorGateAndAddendum(t *testing.T) {
	t.Run("refused without permission", func(t *testing.T) {
		provider := &scriptedChatProvider{turns: []chatTurn{{message: "never"}}}
		suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider})
		recorder := httptest.NewRecorder()
		suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"change the platform","mode":"creator"}`))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status=%d", recorder.Code)
		}
		events := decodeChatNDJSON(t, recorder)
		if len(events) != 1 || events[0]["type"] != "error" || events[0]["error"] != "your role does not include platform.creator" {
			t.Fatalf("events=%v", events)
		}
		if provider.callCount() != 0 {
			t.Fatal("creator gate must refuse before any model call")
		}
	})
	t.Run("addendum with permission", func(t *testing.T) {
		resolved := chatTestIdentity()
		resolved.Permissions["platform.creator"] = true
		provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}}}
		suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider, resolved: resolved})
		recorder := httptest.NewRecorder()
		suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"change the platform","mode":"creator"}`))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		system := provider.callMessages(0)[0].Content
		if !strings.Contains(system, "Creator Mode is active") {
			t.Fatalf("system prompt missing creator addendum: %q", system)
		}
	})
}

func TestChatSessionHandlerStubsCodingPlanConnections(t *testing.T) {
	config := &fakeChatConfigReader{config: myWorkSummaryConfig{provider: "openai-compat", apiKey: "key", primaryModel: "m", codingAgent: &supportCodingAgentConnection{provider: "opencode", modelID: "plan"}}}
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "never"}}}
	store := newFakeChatSessionStore()
	suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider, config: config, store: store})
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d", recorder.Code)
	}
	events := decodeChatNDJSON(t, recorder)
	if len(events) != 1 || events[0]["type"] != "error" || !strings.Contains(events[0]["error"].(string), "coding-agent connection is not supported") {
		t.Fatalf("events=%v", events)
	}
	if provider.callCount() != 0 {
		t.Fatal("coding-plan stub must not call the API-key provider")
	}
	if len(store.created()) != 1 || store.created()[0].modelRef != "opencode:plan" {
		t.Fatalf("modelRef=%+v, want the coding-plan ref", store.created())
	}
}

func TestChatSessionHandlerModuleFilteredTools(t *testing.T) {
	resolved := chatTestIdentity()
	resolved.ModulesRestricted = true
	resolved.EnabledModules = []string{"crm"}
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}}}
	suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider, resolved: resolved})
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	tools := provider.toolsForCall(t, 0)
	seen := map[string]bool{}
	for _, tool := range tools {
		seen[tool.Name] = true
		if strings.HasPrefix(tool.Name, "support_") || strings.HasPrefix(tool.Name, "documents_") {
			t.Fatalf("module-restricted user was offered %q", tool.Name)
		}
	}
	if !seen["file_ticket"] || !seen["ask_user"] {
		t.Fatalf("built-in tools missing: %v", seen)
	}
}

func TestBuildChatToolsFiltersAndRejectsCollisions(t *testing.T) {
	agentTools := []capability.AgentToolSpec{
		{ID: "crm.listCustomers", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{ID: "documents.searchMemory", InputSchema: json.RawMessage(`{"type":"object"}`)},
	}
	tools, byName, err := buildChatTools(agentTools, map[string]bool{"crm": true}, false)
	if err != nil {
		t.Fatalf("buildChatTools: %v", err)
	}
	if len(tools) != 8 || byName["crm_listCustomers"].ID != "crm.listCustomers" {
		t.Fatalf("tools=%+v byName=%v", tools, byName)
	}
	if _, exists := byName["documents_searchMemory"]; exists {
		t.Fatal("module filter leaked a disabled module tool")
	}
	if tools[1].Name != "file_ticket" || tools[1].Parameters == nil {
		t.Fatalf("file_ticket spec=%+v", tools[1])
	}
	if tools[3].Name != "capability_search" || tools[4].Name != "capability_invoke" ||
		tools[5].Name != "resolve_entity" || tools[6].Name != "notifications_inbox" || tools[7].Name != "approvals_inbox" {
		t.Fatalf("built-in specs=%+v %+v %+v %+v %+v", tools[3], tools[4], tools[5], tools[6], tools[7])
	}
	if _, _, err := buildChatTools([]capability.AgentToolSpec{
		{ID: "crm.a.b", InputSchema: json.RawMessage(`{}`)},
		{ID: "crm.a_b", InputSchema: json.RawMessage(`{}`)},
	}, nil, false); err == nil {
		t.Fatal("collision after sanitization must fail closed")
	}
	if _, _, err := buildChatTools([]capability.AgentToolSpec{{ID: "ask.user", InputSchema: json.RawMessage(`{}`)}}, nil, false); err == nil {
		t.Fatal("capability colliding with a built-in tool must fail closed")
	}
	unfiltered, _, err := buildChatTools(agentTools, nil, false)
	if err != nil || len(unfiltered) != 9 {
		t.Fatalf("unrestricted tools=%d err=%v", len(unfiltered), err)
	}
	briefTools, _, err := buildChatTools(agentTools, nil, true)
	if err != nil || len(briefTools) != 9 {
		t.Fatalf("brief tools=%d err=%v", len(briefTools), err)
	}
	if briefTools[7].Name != "recent_changes" || briefTools[8].Name != "daily_brief" {
		t.Fatalf("brief specs=%+v %+v", briefTools[7], briefTools[8])
	}
	if allowed := chatAllowedModules(&session.ResolvedUser{ModulesRestricted: true, EnabledModules: []string{"crm"}}); !allowed["crm"] || !allowed["iam"] || allowed["documents"] {
		t.Fatalf("allowed modules=%v", allowed)
	}
	if allowed := chatAllowedModules(&session.ResolvedUser{}); allowed != nil {
		t.Fatalf("unrestricted modules=%v, want nil", allowed)
	}
}

func TestChatSessionHandlerProviderFailureFrames(t *testing.T) {
	t.Run("typed provider error", func(t *testing.T) {
		provider := &scriptedChatProvider{errs: []error{chatProviderError{status: http.StatusBadGateway}}}
		suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider})
		recorder := httptest.NewRecorder()
		suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
		events := decodeChatNDJSON(t, recorder)
		if types := chatEventTypes(events); strings.Join(types, ",") != "step,error" {
			t.Fatalf("events=%v", types)
		}
		if events[1]["error"] != "The AI provider is unavailable right now. Try again in a moment." {
			t.Fatalf("error=%v", events[1]["error"])
		}
	})
	t.Run("unexpected error is generic", func(t *testing.T) {
		provider := &scriptedChatProvider{errs: []error{errors.New("dial tcp 1.2.3.4:443: connection refused")}}
		suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider})
		recorder := httptest.NewRecorder()
		suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
		events := decodeChatNDJSON(t, recorder)
		if events[len(events)-1]["error"] != "chat request failed" {
			t.Fatalf("error=%v", events[len(events)-1]["error"])
		}
	})
}

func TestChatSessionHandlerStopPathPersistsStoppedMarker(t *testing.T) {
	store := newFakeChatSessionStore()
	request := defaultCookieChatRequest(t, `{"message":"hi"}`)
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	provider := &cancellingChatProvider{cancel: cancel}
	suite := newChatTestSuite(t, chatTestHandlerOptions{store: store, provider: provider})
	request = request.WithContext(ctx)
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, request)
	events := decodeChatNDJSON(t, recorder)
	if types := chatEventTypes(events); strings.Join(types, ",") != "step,stopped" {
		t.Fatalf("events=%v", types)
	}
	if events[1]["sessionId"] != store.createID {
		t.Fatalf("stopped=%v", events[1])
	}
	persisted := store.recordedEvents()
	found := false
	for _, event := range persisted {
		if event.role == "assistant" && event.content["stopped"] == true && event.content["text"] == "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stopped marker missing: %+v", persisted)
	}
}

type cancellingChatProvider struct {
	cancel context.CancelFunc
}

func (p *cancellingChatProvider) Stream(ctx context.Context, _ []chatMessage, _ []chatToolSpec, _ func(string)) (chatTurn, error) {
	p.cancel()
	return chatTurn{}, ctx.Err()
}

func TestChatSessionHandlerSteeringIsDrainedAndPersisted(t *testing.T) {
	store := newFakeChatSessionStore()
	store.owned[store.createID] = true
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)}}},
		{message: "done"},
	}}
	suite := newChatTestSuite(t, chatTestHandlerOptions{store: store, provider: provider})
	suite.handler.steering.push(store.createID, "focus on invoices")
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"start","sessionId":"`+store.createID+`"}`))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	messages := provider.callMessages(0)
	found := false
	for _, message := range messages {
		if message.Content == "[steering] focus on invoices" {
			found = true
		}
	}
	if !found {
		t.Fatalf("steering message missing from first call: %+v", messages)
	}
	if len(suite.handler.steering.drain(store.createID)) != 0 {
		t.Fatal("steering queue was not drained")
	}
	events := waitForChatEvents(t, store, "tool_call", "tool_result")
	found = false
	for _, event := range events {
		if event.role == "user" && event.content["text"] == "focus on invoices" && event.content["steering"] == true {
			found = true
		}
	}
	if !found {
		t.Fatalf("steering user event missing: %+v", events)
	}
	doneEvents := decodeChatNDJSON(t, recorder)
	if doneEvents[len(doneEvents)-1]["type"] != "done" {
		t.Fatalf("last event=%v", doneEvents[len(doneEvents)-1])
	}
}

func TestChatSessionHandlerUsageFailureEmitsErrorFrame(t *testing.T) {
	store := newFakeChatSessionStore()
	store.usageErr = errors.New("database down")
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}}}
	suite := newChatTestSuite(t, chatTestHandlerOptions{store: store, provider: provider})
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
	events := decodeChatNDJSON(t, recorder)
	if types := chatEventTypes(events); strings.Join(types, ",") != "step,delta,error" {
		t.Fatalf("events=%v", types)
	}
	if events[2]["error"] != "chat request failed" {
		t.Fatalf("error=%v", events[2]["error"])
	}
	persisted := store.recordedEvents()
	if len(persisted) != 2 || persisted[1].content["text"] != "ok" {
		t.Fatalf("assistant reply must be persisted before usage accounting: %+v", persisted)
	}
}

func TestChatSessionHandlerConfigurationFailures(t *testing.T) {
	t.Run("ai config", func(t *testing.T) {
		suite := newChatTestSuite(t, chatTestHandlerOptions{config: &fakeChatConfigReader{err: errors.New("no settings")}})
		recorder := httptest.NewRecorder()
		suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
		if recorder.Code != http.StatusInternalServerError || !strings.Contains(recorder.Body.String(), "internal error") {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("organization profile", func(t *testing.T) {
		store := newFakeChatSessionStore()
		store.profileErr = errors.New("org missing")
		suite := newChatTestSuite(t, chatTestHandlerOptions{store: store})
		recorder := httptest.NewRecorder()
		suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"hi"}`))
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestChatSessionHandlerTruncatesTitleOnCreate(t *testing.T) {
	store := newFakeChatSessionStore()
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}}}
	suite := newChatTestSuite(t, chatTestHandlerOptions{store: store, provider: provider})
	message := strings.Repeat("m", 200)
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, defaultCookieChatRequest(t, `{"message":"`+message+`"}`))
	created := store.created()
	if len(created) != 1 || utf16Length(created[0].title) != chatSessionTitleUnits {
		t.Fatalf("created=%+v", created)
	}
}

func TestChatSessionHandlerBearerRequestsSkipSameOriginCheck(t *testing.T) {
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}}}
	suite := newChatTestSuite(t, chatTestHandlerOptions{provider: provider})
	recorder := httptest.NewRecorder()
	suite.handler.ServeHTTP(recorder, chatTestRequest(http.MethodPost, `{"message":"hi"}`, chatTestRequestOptions{bearer: true}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if suite.resolver.bearerCalls != 1 {
		t.Fatalf("bearer calls=%d", suite.resolver.bearerCalls)
	}
}

func (p *scriptedChatProvider) toolsForCall(t *testing.T, index int) []chatToolSpec {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if index >= len(p.tools) {
		t.Fatalf("provider call %d never happened", index)
	}
	return p.tools[index]
}

func TestChatHistoryMessagesReconstructsToolCallsAndSkipsOrphans(t *testing.T) {
	events := []chatHistoryEvent{
		{role: "user", content: map[string]any{"text": "Find Acme"}},
		{role: "tool_call", content: map[string]any{"callId": "call-1", "name": "crm_listCustomers", "args": map[string]any{"query": "Acme"}}},
		{role: "tool_result", content: map[string]any{"callId": "call-1", "ok": true, "result": `{"customers":[{"id":"c-1","name":"Acme"}]}`}},
		{role: "assistant", content: map[string]any{"text": "Found Acme."}},
		{role: "user", content: map[string]any{"text": "Now invoice them"}},
		{role: "tool_call", content: map[string]any{"callId": "call-2", "name": "accounting_createInvoice", "args": map[string]any{"customerId": "c-1"}}},
		{role: "assistant", content: map[string]any{"text": "Drafted it."}},
	}
	messages := chatHistoryMessages(events)
	if len(messages) != 6 {
		t.Fatalf("messages=%+v", messages)
	}
	if messages[0].Role != "user" || messages[0].Content != "Find Acme" {
		t.Fatalf("first=%+v", messages[0])
	}
	if messages[1].Role != "assistant" || len(messages[1].ToolCalls) != 1 || messages[1].ToolCalls[0].ID != "call-1" {
		t.Fatalf("tool call=%+v", messages[1])
	}
	if messages[2].Role != "tool" || messages[2].ToolCallID != "call-1" || !strings.Contains(messages[2].Content, "Acme") {
		t.Fatalf("tool result=%+v", messages[2])
	}
	if messages[5].Content != "Drafted it." {
		t.Fatalf("last=%+v", messages[5])
	}
	for _, message := range messages {
		if len(message.ToolCalls) == 1 && message.ToolCalls[0].ID == "call-2" {
			t.Fatal("a tool call without a result must not enter history")
		}
	}
}
