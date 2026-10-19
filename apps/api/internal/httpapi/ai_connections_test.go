package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type aiConnectionsTestStore struct {
	connections []aiConnectionRecord

	listFn             func(context.Context, string, string) ([]aiConnectionRecord, error)
	upsertOpenCodeFn   func(context.Context, string, string, string, string, *string, *bool) (aiConnectionRecord, error)
	markAttentionFn    func(context.Context, string, string) error
	upsertCodexFn      func(context.Context, string, string, *bool) (aiConnectionRecord, error)
	chooseDefaultFn    func(context.Context, string, string, *string) error
	lookupFn           func(context.Context, string, string, string) (aiConnectionRecord, bool, error)
	markDisconnectedFn func(context.Context, string, string) error

	lastEndpoint    string
	lastEncrypted   string
	lastModel       *string
	lastMakeDefault *bool
	attentionID     string
	chooseDefaultID *string
	disconnectedID  string
}

func (s *aiConnectionsTestStore) List(ctx context.Context, orgID, userID string) ([]aiConnectionRecord, error) {
	if s.listFn != nil {
		return s.listFn(ctx, orgID, userID)
	}
	return s.connections, nil
}

func (s *aiConnectionsTestStore) UpsertOpenCode(ctx context.Context, orgID, userID, endpoint, encrypted string, modelID *string, makeDefault *bool) (aiConnectionRecord, error) {
	s.lastEndpoint, s.lastEncrypted, s.lastModel, s.lastMakeDefault = endpoint, encrypted, modelID, makeDefault
	if s.upsertOpenCodeFn != nil {
		return s.upsertOpenCodeFn(ctx, orgID, userID, endpoint, encrypted, modelID, makeDefault)
	}
	return aiConnectionRecord{ID: platformTestProposalID, Provider: aiConnectionProviderOpenCode, Endpoint: &endpoint, Status: aiConnectionStatusConnected, ConnectedAt: time.Now().UTC()}, nil
}

func (s *aiConnectionsTestStore) MarkAttention(ctx context.Context, orgID, connectionID string) error {
	s.attentionID = connectionID
	if s.markAttentionFn != nil {
		return s.markAttentionFn(ctx, orgID, connectionID)
	}
	return nil
}

func (s *aiConnectionsTestStore) UpsertCodex(ctx context.Context, orgID, userID string, makeDefault *bool) (aiConnectionRecord, error) {
	s.lastMakeDefault = makeDefault
	if s.upsertCodexFn != nil {
		return s.upsertCodexFn(ctx, orgID, userID, makeDefault)
	}
	return aiConnectionRecord{ID: platformTestListingID, Provider: aiConnectionProviderCodex, Status: aiConnectionStatusConnected, ConnectedAt: time.Now().UTC()}, nil
}

func (s *aiConnectionsTestStore) ChooseDefault(ctx context.Context, orgID, userID string, connectionID *string) error {
	s.chooseDefaultID = connectionID
	if s.chooseDefaultFn != nil {
		return s.chooseDefaultFn(ctx, orgID, userID, connectionID)
	}
	return nil
}

func (s *aiConnectionsTestStore) Lookup(ctx context.Context, orgID, userID, provider string) (aiConnectionRecord, bool, error) {
	if s.lookupFn != nil {
		return s.lookupFn(ctx, orgID, userID, provider)
	}
	return aiConnectionRecord{}, false, nil
}

func (s *aiConnectionsTestStore) MarkDisconnected(ctx context.Context, orgID, connectionID string) error {
	s.disconnectedID = connectionID
	if s.markDisconnectedFn != nil {
		return s.markDisconnectedFn(ctx, orgID, connectionID)
	}
	return nil
}

type aiTestOpenCodeClient struct {
	connectFn     func(context.Context, string, string, string) (string, error)
	configureFn   func(context.Context, string, string, string, string, string, string) error
	configureMCP  bool
	configureArgs []string
}

func (c *aiTestOpenCodeClient) Connect(ctx context.Context, endpoint, username, password string) (string, error) {
	if c.connectFn != nil {
		return c.connectFn(ctx, endpoint, username, password)
	}
	return endpoint, nil
}

func (c *aiTestOpenCodeClient) ConfigureMCP(ctx context.Context, endpoint, username, password, connectionID, orgID, userID string) error {
	c.configureMCP = true
	c.configureArgs = []string{endpoint, username, password, connectionID, orgID, userID}
	if c.configureFn != nil {
		return c.configureFn(ctx, endpoint, username, password, connectionID, orgID, userID)
	}
	return nil
}

type aiTestCodexRuntime struct {
	available bool
	version   *string
	startFn   func(context.Context, string, string) (aiCodexLoginState, error)
	pollFn    func(context.Context, string, string) (bool, aiCodexLoginState, error)
	stopped   bool
	stopOrg   string
}

func (c *aiTestCodexRuntime) Probe() (bool, *string) { return c.available, c.version }

func (c *aiTestCodexRuntime) Start(ctx context.Context, orgID, userID string) (aiCodexLoginState, error) {
	if c.startFn != nil {
		return c.startFn(ctx, orgID, userID)
	}
	return aiCodexLoginState{}, nil
}

func (c *aiTestCodexRuntime) Poll(ctx context.Context, orgID, userID string) (bool, aiCodexLoginState, error) {
	if c.pollFn != nil {
		return c.pollFn(ctx, orgID, userID)
	}
	return false, aiCodexLoginState{}, nil
}

func (c *aiTestCodexRuntime) Stop(_ context.Context, orgID, _ string) {
	c.stopped = true
	c.stopOrg = orgID
}

func TestAIConnectionsHandlerGet(t *testing.T) {
	store := &aiConnectionsTestStore{connections: []aiConnectionRecord{{
		ID: platformTestProposalID, Provider: aiConnectionProviderOpenCode,
		Endpoint: platformTestString("https://opencode.example.test"), Status: aiConnectionStatusConnected,
		IsDefault: true, ConnectedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}}}
	codex := &aiTestCodexRuntime{available: true, version: platformTestString("codex-cli 0.9.0")}
	handler := newAIConnectionsHandler(store, &aiTestOpenCodeClient{}, codex, platformTestResolver{user: platformTestUser()}, nil, platformTestLogger())

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/ai-connections", ""))
	body := platformTestDecode(t, response)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "private, no-store, max-age=0" {
		t.Fatalf("Cache-Control=%q, want private, no-store, max-age=0", response.Header().Get("Cache-Control"))
	}
	connections, _ := body["connections"].([]any)
	if len(connections) != 1 {
		t.Fatalf("connections=%v, want one", body["connections"])
	}
	first, _ := connections[0].(map[string]any)
	if first["id"] != platformTestProposalID || first["provider"] != "opencode" || first["isDefault"] != true {
		t.Fatalf("connection=%v, want the stored OpenCode record", first)
	}
	if first["connectedAt"] != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("connectedAt=%v, want millisecond UTC formatting", first["connectedAt"])
	}
	runtime, _ := body["codexRuntime"].(map[string]any)
	if runtime["available"] != true || runtime["version"] != "codex-cli 0.9.0" {
		t.Fatalf("codexRuntime=%v, want available with version", runtime)
	}

	unauthenticated := newAIConnectionsHandler(store, &aiTestOpenCodeClient{}, codex, platformTestResolver{}, nil, platformTestLogger())
	response = httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, platformTestRequest(http.MethodGet, "/api/ai-connections", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s, want 401", response.Code, response.Body.String())
	}
}

func TestAIConnectionsHandlerConnectOpenCode(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")
	logger := platformTestLogger()
	user := platformTestUser()

	invalid := newAIConnectionsHandler(&aiConnectionsTestStore{}, &aiTestOpenCodeClient{}, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)

	response := httptest.NewRecorder()
	invalid.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", "{"))
	if response.Code != http.StatusBadRequest || platformTestDecode(t, response)["error"] != aiConnectionsInvalidBodyError {
		t.Fatalf("malformed status=%d body=%s, want 400 invalid request", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	invalid.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"teleport"}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown action status=%d body=%s, want 400", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	invalid.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections",
		`{"action":"connect_opencode","endpoint":"https://opencode.example.test"}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("missing password status=%d body=%s, want 400", response.Code, response.Body.String())
	}

	refusingClient := &aiTestOpenCodeClient{connectFn: func(context.Context, string, string, string) (string, error) {
		return "", errors.New("OpenCode rejected the server password.")
	}}
	refusing := newAIConnectionsHandler(&aiConnectionsTestStore{}, refusingClient, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)
	response = httptest.NewRecorder()
	refusing.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections",
		`{"action":"connect_opencode","endpoint":"https://opencode.example.test","password":"secret-pass"}`))
	if response.Code != http.StatusUnprocessableEntity || platformTestDecode(t, response)["error"] != "OpenCode rejected the server password." {
		t.Fatalf("refused status=%d body=%s, want 422 rejection message", response.Code, response.Body.String())
	}

	attentionStore := &aiConnectionsTestStore{}
	failingConfigure := &aiTestOpenCodeClient{configureFn: func(context.Context, string, string, string, string, string, string) error {
		return errors.New("OpenCode could not connect to Chaste tools.")
	}}
	attention := newAIConnectionsHandler(attentionStore, failingConfigure, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)
	response = httptest.NewRecorder()
	attention.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections",
		`{"action":"connect_opencode","endpoint":"https://opencode.example.test","password":"secret-pass"}`))
	if response.Code != http.StatusUnprocessableEntity || platformTestDecode(t, response)["error"] != "OpenCode could not connect to Chaste tools." {
		t.Fatalf("configure failure status=%d body=%s, want 422 bridge message", response.Code, response.Body.String())
	}
	if attentionStore.attentionID != platformTestProposalID {
		t.Fatalf("attention connection=%q, want the failed connection id", attentionStore.attentionID)
	}

	successStore := &aiConnectionsTestStore{}
	successClient := &aiTestOpenCodeClient{}
	success := newAIConnectionsHandler(successStore, successClient, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)
	response = httptest.NewRecorder()
	success.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections",
		`{"action":"connect_opencode","endpoint":"https://opencode.example.test","username":"dana","password":"secret-pass","modelId":"fast-model","makeDefault":true}`))
	body := platformTestDecode(t, response)
	if response.Code != http.StatusOK || body["ok"] != true {
		t.Fatalf("connect status=%d body=%s, want ok:true", response.Code, response.Body.String())
	}
	if successStore.lastEndpoint != "https://opencode.example.test" || successStore.lastModel == nil || *successStore.lastModel != "fast-model" {
		t.Fatalf("stored endpoint=%q model=%v, want normalized endpoint and model", successStore.lastEndpoint, successStore.lastModel)
	}
	if successStore.lastMakeDefault == nil || *successStore.lastMakeDefault != true {
		t.Fatalf("stored makeDefault=%v, want true", successStore.lastMakeDefault)
	}
	plain, err := decryptSupportProviderKey(successStore.lastEncrypted)
	if err != nil {
		t.Fatalf("decrypt stored credential: %v", err)
	}
	var credential aiOpenCodeCredential
	if err := json.Unmarshal([]byte(plain), &credential); err != nil {
		t.Fatal(err)
	}
	if credential.Username != "dana" || credential.Password != "secret-pass" {
		t.Fatalf("credential=%+v, want the submitted OpenCode account", credential)
	}
	if !successClient.configureMCP || successClient.configureArgs[0] != "https://opencode.example.test" || successClient.configureArgs[3] != platformTestProposalID {
		t.Fatalf("configure args=%v, want the stored connection bridged into OpenCode", successClient.configureArgs)
	}

	crossOrigin := newAIConnectionsHandler(&aiConnectionsTestStore{}, &aiTestOpenCodeClient{}, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)
	request := platformTestRequest(http.MethodPost, "/api/ai-connections",
		`{"action":"connect_opencode","endpoint":"https://opencode.example.test","password":"secret-pass"}`)
	request.Header.Del("Origin")
	response = httptest.NewRecorder()
	crossOrigin.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || platformTestDecode(t, response)["error"] != "origin check failed" {
		t.Fatalf("cross-origin status=%d body=%s, want 403 origin check failed", response.Code, response.Body.String())
	}
}

func TestAIConnectionsHandlerCodexLoginAndDisconnect(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")
	logger := platformTestLogger()
	user := platformTestUser()

	codex := &aiTestCodexRuntime{
		available: true,
		startFn: func(context.Context, string, string) (aiCodexLoginState, error) {
			return aiCodexLoginState{VerificationURL: platformTestString("https://auth.openai.com/device"), UserCode: platformTestString("ABCD-1234")}, nil
		},
		pollFn: func(context.Context, string, string) (bool, aiCodexLoginState, error) {
			return true, aiCodexLoginState{}, nil
		},
	}
	store := &aiConnectionsTestStore{}
	handler := newAIConnectionsHandler(store, &aiTestOpenCodeClient{}, codex, platformTestResolver{user: user}, nil, logger)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"start_codex_login"}`))
	body := platformTestDecode(t, response)
	login, _ := body["login"].(map[string]any)
	if response.Code != http.StatusOK || login["verificationUrl"] != "https://auth.openai.com/device" || login["userCode"] != "ABCD-1234" || login["waitingForPrompt"] != false {
		t.Fatalf("start login status=%d body=%s, want device code response", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"poll_codex_login","makeDefault":true}`))
	body = platformTestDecode(t, response)
	login, _ = body["login"].(map[string]any)
	if response.Code != http.StatusOK || login["connected"] != true || login["message"] != "Codex plan connected." {
		t.Fatalf("poll login status=%d body=%s, want connected plan", response.Code, response.Body.String())
	}
	connection, _ := login["connection"].(map[string]any)
	if connection == nil || connection["provider"] != "codex" {
		t.Fatalf("poll connection=%v, want the stored Codex connection", login["connection"])
	}

	disconnectStore := &aiConnectionsTestStore{lookupFn: func(context.Context, string, string, string) (aiConnectionRecord, bool, error) {
		return aiConnectionRecord{ID: platformTestListingID, Provider: aiConnectionProviderCodex}, true, nil
	}}
	disconnectCodex := &aiTestCodexRuntime{}
	disconnect := newAIConnectionsHandler(disconnectStore, &aiTestOpenCodeClient{}, disconnectCodex, platformTestResolver{user: user}, nil, logger)
	response = httptest.NewRecorder()
	disconnect.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"disconnect","provider":"codex"}`))
	if response.Code != http.StatusOK || platformTestDecode(t, response)["ok"] != true {
		t.Fatalf("disconnect status=%d body=%s, want ok:true", response.Code, response.Body.String())
	}
	if !disconnectCodex.stopped || disconnectCodex.stopOrg != platformTestOrgID {
		t.Fatalf("codex stopped=%v org=%q, want the runtime stopped for the organization", disconnectCodex.stopped, disconnectCodex.stopOrg)
	}
	if disconnectStore.disconnectedID != platformTestListingID {
		t.Fatalf("disconnected connection=%q, want the looked-up row", disconnectStore.disconnectedID)
	}

	missingStore := &aiConnectionsTestStore{lookupFn: func(context.Context, string, string, string) (aiConnectionRecord, bool, error) {
		return aiConnectionRecord{}, false, nil
	}}
	missingCodex := &aiTestCodexRuntime{}
	missing := newAIConnectionsHandler(missingStore, &aiTestOpenCodeClient{}, missingCodex, platformTestResolver{user: user}, nil, logger)
	response = httptest.NewRecorder()
	missing.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"disconnect","provider":"codex"}`))
	if response.Code != http.StatusOK || missingCodex.stopped || missingStore.disconnectedID != "" {
		t.Fatalf("missing disconnect status=%d stopped=%v, want a no-op response", response.Code, missingCodex.stopped)
	}

	response = httptest.NewRecorder()
	missing.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"disconnect","provider":"gemini"}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown provider status=%d body=%s, want 400", response.Code, response.Body.String())
	}
}

func TestAIConnectionsHandlerSetDefault(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")
	logger := platformTestLogger()
	user := platformTestUser()

	invalidBody := newAIConnectionsHandler(&aiConnectionsTestStore{}, &aiTestOpenCodeClient{}, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)
	response := httptest.NewRecorder()
	invalidBody.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"set_default","connectionId":"not-a-uuid"}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status=%d body=%s, want 400", response.Code, response.Body.String())
	}

	missingStore := &aiConnectionsTestStore{chooseDefaultFn: func(context.Context, string, string, *string) error {
		return errAIChooseDefault
	}}
	missing := newAIConnectionsHandler(missingStore, &aiTestOpenCodeClient{}, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)
	response = httptest.NewRecorder()
	missing.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"set_default","connectionId":"`+platformTestListingID+`"}`))
	if response.Code != http.StatusUnprocessableEntity || platformTestDecode(t, response)["error"] != errAIChooseDefault.Error() {
		t.Fatalf("missing default status=%d body=%s, want 422 choose message", response.Code, response.Body.String())
	}

	clearStore := &aiConnectionsTestStore{connections: []aiConnectionRecord{{ID: platformTestProposalID, Provider: aiConnectionProviderOpenCode, Status: aiConnectionStatusConnected, IsDefault: true, ConnectedAt: time.Now().UTC()}}}
	clear := newAIConnectionsHandler(clearStore, &aiTestOpenCodeClient{}, &aiTestCodexRuntime{}, platformTestResolver{user: user}, nil, logger)
	response = httptest.NewRecorder()
	clear.ServeHTTP(response, platformTestRequest(http.MethodPost, "/api/ai-connections", `{"action":"set_default","connectionId":null}`))
	if response.Code != http.StatusOK || platformTestDecode(t, response)["ok"] != true || clearStore.chooseDefaultID != nil {
		t.Fatalf("clear default status=%d id=%v, want cleared selection", response.Code, clearStore.chooseDefaultID)
	}
}

func TestAIConnectionsTokenAndSecretRoundTrip(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "unit-test-ai-key")
	first, err := encryptCodingAgentSecret("provider-credential")
	if err != nil {
		t.Fatal(err)
	}
	second, err := encryptCodingAgentSecret("provider-credential")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("encryption reused a nonce across envelopes")
	}
	plain, err := decryptSupportProviderKey(first)
	if err != nil || plain != "provider-credential" {
		t.Fatalf("decrypted=%q err=%v, want the original credential", plain, err)
	}
	if !strings.HasPrefix(first, "v1:") {
		t.Fatalf("envelope=%q, want the v1 provider-key format", first)
	}

	now := time.Now()
	token, err := signAIToolAccessToken(aiToolAccessClaims{
		OrgID: platformTestOrgID, UserID: platformTestUserID, ConnectionID: platformTestProposalID,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	verified, ok := verifyAIToolAccessToken(token, now)
	if !ok || verified.Audience != "chaste-mcp" || verified.AllowedTools == nil {
		t.Fatalf("verified=%+v ok=%v, want a valid MCP token", verified, ok)
	}
	if verified.ExpiresAt-verified.IssuedAt != 2*aiConnectionTokenDaySeconds {
		t.Fatalf("token lifetime=%d, want two days", verified.ExpiresAt-verified.IssuedAt)
	}
	if _, ok := verifyAIToolAccessToken(token, now.Add(3*24*time.Hour)); ok {
		t.Fatal("expired token verified")
	}
	tampered := []byte(token)
	if tampered[0] == 'a' {
		tampered[0] = 'b'
	} else {
		tampered[0] = 'a'
	}
	if _, ok := verifyAIToolAccessToken(string(tampered), now); ok {
		t.Fatal("tampered token verified")
	}
	anonymous, err := signAIToolAccessToken(aiToolAccessClaims{OrgID: platformTestOrgID, UserID: platformTestUserID}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := verifyAIToolAccessToken(anonymous, now); ok {
		t.Fatal("token without a connection verified")
	}
}

func TestAIPublicAppURLPrefersGoPublicAppURL(t *testing.T) {
	for _, key := range []string{"GO_PUBLIC_APP_URL", "CHASTE_PUBLIC_URL", "NEXT_PUBLIC_APP_URL", "PUBLIC_URL"} {
		t.Setenv(key, "")
	}
	if got := aiPublicAppURL(); got != "http://localhost:3000" {
		t.Fatalf("aiPublicAppURL() with no environment = %q, want localhost fallback", got)
	}
	t.Setenv("PUBLIC_URL", "https://legacy.example.test")
	if got := aiPublicAppURL(); got != "https://legacy.example.test" {
		t.Fatalf("aiPublicAppURL() = %q, want PUBLIC_URL fallback", got)
	}
	t.Setenv("GO_PUBLIC_APP_URL", "https://app.example.test")
	if got := aiPublicAppURL(); got != "https://app.example.test" {
		t.Fatalf("aiPublicAppURL() = %q, want GO_PUBLIC_APP_URL to win", got)
	}
}
