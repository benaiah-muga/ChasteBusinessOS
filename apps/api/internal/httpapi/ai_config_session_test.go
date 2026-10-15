package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

type fakeAIConfigReader struct {
	raw   json.RawMessage
	orgID string
	err   error
}

func (reader *fakeAIConfigReader) ReadAIConfig(_ context.Context, orgID string) (json.RawMessage, error) {
	reader.orgID = orgID
	return reader.raw, reader.err
}

func TestAIConfigSessionHandlerReturnsPublicWorkspaceDTO(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-ai-config-encryption-secret")
	const orgID = "11111111-1111-4111-8111-111111111111"
	const secret = "provider-secret-canary"
	ciphertext, err := encryptAIProviderKey(secret, orgID, "44444444-4444-4444-8444-444444444444")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := json.Marshal(map[string]any{"provider": "custom", "baseUrl": "https://models.example/v1", "models": map[string]string{"primary": "p", "fast": "f", "reasoning": "r", "embeddings": "e"}, "encryptedApiKey": ciphertext, "keyHint": "••••nary", "updatedAt": "2026-10-11T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	reader := &fakeAIConfigReader{raw: stored}
	handler := &AIConfigSessionHandler{resolver: &fakeDirectSessionResolver{resolved: directTestIdentity()}, reader: reader, logger: routinesTestLogger()}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/ai-config", ""))
	if response.Code != http.StatusOK || reader.orgID != orgID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d org=%q headers=%v body=%s", response.Code, reader.orgID, response.Header(), response.Body.String())
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 6 || string(body["provider"]) != `"custom"` || string(body["source"]) != `"workspace"` || string(body["configured"]) != "true" || string(body["keyHint"]) != `"••••nary"` {
		t.Fatalf("public DTO=%s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), secret) || strings.Contains(response.Body.String(), ciphertext) || strings.Contains(response.Body.String(), "encryptedApiKey") {
		t.Fatalf("credential material escaped public DTO: %s", response.Body.String())
	}
}

func TestAIConfigSessionHandlerWritesOnlyThroughGovernedCapability(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-ai-config-encryption-secret")
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	const intentID = "44444444-4444-4444-8444-444444444444"
	const providerKey = "local-provider-key-canary"
	reader := &fakeAIConfigReader{raw: json.RawMessage(`{"provider":"openai","baseUrl":"https://api.openai.com/v1","models":{"primary":"old-p","fast":"old-f","reasoning":"old-r","embeddings":"old-e"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-10-11T00:00:00Z"}`)}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := &AIConfigSessionHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor, reader: reader, logger: routinesTestLogger()}
	body := `{"provider":"custom","baseUrl":"https://models.example/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"apiKey":"` + providerKey + `","intentId":"` + intentID + `","updatedAt":"2026-10-11T00:00:00Z"}`
	request := routinesSessionRequest(http.MethodPost, "/api/ai-config", body)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "settings.configureAiProvider" || executor.claims.IntentID != intentID || executor.claims.OrganizationID != *identity.OrgID {
		t.Fatalf("status=%d calls=%d capability=%q claims=%+v body=%s", response.Code, executor.calls, executor.capID, executor.claims, response.Body.String())
	}
	var input capability.SettingsConfigureAiProviderInput
	if err := json.Unmarshal(executor.input, &input); err != nil || input.Config == nil || input.Config.EncryptedAPIKey == nil || input.Config.KeyHint == nil {
		t.Fatalf("input=%s decodeErr=%v", executor.input, err)
	}
	plain, err := decryptAIProviderKey(*input.Config.EncryptedAPIKey)
	if err != nil || plain != providerKey || *input.Config.KeyHint != "••••nary" {
		t.Fatalf("decrypted credential=%q keyHint=%v err=%v", plain, input.Config.KeyHint, err)
	}
	if strings.Contains(string(executor.input), providerKey) || strings.Contains(response.Body.String(), providerKey) || strings.Contains(response.Body.String(), *input.Config.EncryptedAPIKey) {
		t.Fatalf("plaintext or ciphertext escaped boundary: input=%s response=%s", executor.input, response.Body.String())
	}

	first, err := encryptAIProviderKey(providerKey, *identity.OrgID, intentID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := encryptAIProviderKey(providerKey, *identity.OrgID, intentID)
	if err != nil || first != second {
		t.Fatalf("same intent retry encryption changed: first=%q second=%q err=%v", first, second, err)
	}

	executor.result = capability.Result{PendingApproval: true, ApprovalRationale: "approval required", ApprovalID: "approval-1"}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/ai-config", body))
	var pending map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &pending); err != nil || response.Code != http.StatusAccepted || string(pending["pendingApproval"]) != "true" || string(pending["error"]) != `"approval required"` {
		t.Fatalf("pending status=%d body=%s decodeErr=%v", response.Code, response.Body.String(), err)
	}
}

func TestAIConfigSessionHandlerAcceptsMaximumUTF16ProviderKey(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-ai-config-encryption-secret")
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	const intentID = "44444444-4444-4444-8444-444444444444"
	providerKey := strings.Repeat("😀", 500)
	reader := &fakeAIConfigReader{}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := &AIConfigSessionHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor, reader: reader, logger: routinesTestLogger()}
	body, err := json.Marshal(map[string]any{
		"provider": "custom", "baseUrl": "https://models.example/v1",
		"models": map[string]string{"primary": "p", "fast": "f", "reasoning": "r", "embeddings": "e"},
		"apiKey": providerKey, "intentId": intentID, "updatedAt": "2026-10-11T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/ai-config", string(body)))
	if response.Code != http.StatusOK || executor.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
	parsed, err := capability.ParseSettingsConfigureAiProviderInput(executor.input)
	if err != nil || parsed.Config == nil || parsed.Config.EncryptedAPIKey == nil {
		t.Fatalf("capability input did not parse: input bytes=%d err=%v", len(executor.input), err)
	}
	if got, err := decryptAIProviderKey(*parsed.Config.EncryptedAPIKey); err != nil || got != providerKey {
		t.Fatalf("decrypted key length=%d err=%v, want 500 emoji", len([]rune(got)), err)
	}
	if len(*parsed.Config.EncryptedAPIKey) <= 2000 || len(*parsed.Config.EncryptedAPIKey) > 3000 {
		t.Fatalf("encrypted key length=%d, want between 2001 and 3000", len(*parsed.Config.EncryptedAPIKey))
	}
}

func TestAIConfigSessionHandlerAcceptsMaximumBMPProviderKey(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-ai-config-encryption-secret")
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	const intentID = "44444444-4444-4444-8444-444444444444"
	providerKey := strings.Repeat("漢", 1000)
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := &AIConfigSessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor,
		reader: &fakeAIConfigReader{}, logger: routinesTestLogger(),
	}
	body, err := json.Marshal(map[string]any{
		"provider": "custom", "baseUrl": "https://models.example/v1",
		"models": map[string]string{"primary": "p", "fast": "f", "reasoning": "r", "embeddings": "e"},
		"apiKey": providerKey, "intentId": intentID, "updatedAt": "2026-10-11T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/ai-config", string(body)))
	if response.Code != http.StatusOK || executor.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
	parsed, err := capability.ParseSettingsConfigureAiProviderInput(executor.input)
	if err != nil || parsed.Config == nil || parsed.Config.EncryptedAPIKey == nil {
		t.Fatalf("capability input did not parse: err=%v", err)
	}
	if got, err := decryptAIProviderKey(*parsed.Config.EncryptedAPIKey); err != nil || got != providerKey {
		t.Fatalf("decrypted key length=%d err=%v, want 1000 CJK characters", len([]rune(got)), err)
	}
	const maxEncodedKeyLength = 3 + 16 + 1 + 22 + 1 + 4000
	if got := len(*parsed.Config.EncryptedAPIKey); got != maxEncodedKeyLength {
		t.Fatalf("encrypted key length=%d, want the exact maximum", got)
	}
}

func TestAIConfigSessionHandlerRejectsCrossOriginAndPreservesClearKey(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-ai-config-encryption-secret")
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	reader := &fakeAIConfigReader{raw: json.RawMessage(`{"provider":"openai","baseUrl":"https://api.openai.com/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"encryptedApiKey":"v1:opaque","keyHint":"••••cret","updatedAt":"2026-10-11T00:00:00Z"}`)}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := &AIConfigSessionHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor, reader: reader, logger: routinesTestLogger()}
	validBody := `{"provider":"openai","baseUrl":"https://api.openai.com/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"clearApiKey":true,"intentId":"44444444-4444-4444-8444-444444444444","updatedAt":"2026-10-11T00:00:00Z"}`
	request := routinesSessionRequest(http.MethodPost, "/api/ai-config", validBody)
	request.Header.Set("Origin", "https://attacker.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("cross-origin status=%d executor calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/ai-config", validBody))
	var input capability.SettingsConfigureAiProviderInput
	if err := json.Unmarshal(executor.input, &input); err != nil || response.Code != http.StatusOK || input.Config == nil || input.Config.EncryptedAPIKey != nil || input.Config.KeyHint != nil {
		t.Fatalf("clear key status=%d input=%s body=%s err=%v", response.Code, executor.input, response.Body.String(), err)
	}

	noSession := &AIConfigSessionHandler{resolver: &fakeDirectSessionResolver{}, reader: reader, logger: routinesTestLogger()}
	response = httptest.NewRecorder()
	noSession.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/ai-config", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAIConfigPublicHintUsesDecryptedKeyAndIgnoresStoredHint(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-ai-config-encryption-secret")
	for _, test := range []struct {
		key        string
		stored     json.RawMessage
		wantHint   string
		configured bool
	}{
		{key: "x", stored: json.RawMessage(`"stale hint that is much too long"`), wantHint: "••••x", configured: true},
		{key: "xy", stored: json.RawMessage(`17`), wantHint: "••••xy", configured: true},
		{key: "xyz", stored: json.RawMessage(`"malformed"`), wantHint: "••••xyz", configured: true},
		{key: "long-secret", stored: json.RawMessage(`null`), wantHint: "••••cret", configured: true},
	} {
		ciphertext, err := encryptAIProviderKey(test.key, "11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444")
		if err != nil {
			t.Fatal(err)
		}
		stored, err := json.Marshal(map[string]any{
			"provider": "custom", "baseUrl": "https://models.example/v1",
			"models":          map[string]string{"primary": "p", "fast": "f", "reasoning": "r", "embeddings": "e"},
			"encryptedApiKey": ciphertext, "keyHint": test.stored, "updatedAt": "2026-10-11T00:00:00Z",
		})
		if err != nil {
			t.Fatal(err)
		}
		got := publicAIConfig(stored)
		if got.Configured != test.configured || got.KeyHint == nil || *got.KeyHint != test.wantHint || got.Source != "workspace" {
			t.Errorf("key=%q DTO=%+v want hint=%q configured=%t", test.key, got, test.wantHint, test.configured)
		}
	}

	invalid := json.RawMessage(`{"provider":"custom","baseUrl":"https://models.example/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"encryptedApiKey":"v1:bad:bad:bad","keyHint":"••••valid","updatedAt":"2026-10-11T00:00:00Z"}`)
	got := publicAIConfig(invalid)
	if got.Source != "workspace" || got.Configured || got.KeyHint != nil {
		t.Fatalf("invalid decrypted credential should suppress configured and hint: %+v", got)
	}
}

func TestAIConfigSessionHandlerRequiresUTCUpdatedAtAndIntentUUID(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := &AIConfigSessionHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, executor: executor, reader: &fakeAIConfigReader{}, logger: routinesTestLogger()}
	base := `"provider":"custom","baseUrl":"https://models.example/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"intentId":"44444444-4444-4444-8444-444444444444"`
	for _, body := range []string{
		`{` + base + `,"updatedAt":"2026-10-11T00:00:00+00:00"}`,
		`{` + base + `,"updatedAt":"2026-02-30T00:00:00Z"}`,
		`{` + base + `}`,
		`{"provider":"custom","baseUrl":"https://models.example/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"updatedAt":"2026-10-11T00:00:00Z"}`,
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/ai-config", body))
		if response.Code != http.StatusBadRequest {
			t.Errorf("invalid timestamp or intent status=%d body=%s", response.Code, response.Body.String())
		}
	}
	if executor.calls != 0 {
		t.Fatalf("invalid timestamps or missing intent reached executor %d times", executor.calls)
	}
}

func TestAIConfigSessionHandlerUsesEnvironmentDTOWithoutExposingKey(t *testing.T) {
	t.Setenv("MODEL_PROVIDER", "openai")
	t.Setenv("OPENAI_API_KEY", "environment-key-canary")
	t.Setenv("MODEL_PRIMARY", "env-primary")
	reader := &fakeAIConfigReader{}
	handler := &AIConfigSessionHandler{resolver: &fakeDirectSessionResolver{resolved: directTestIdentity()}, reader: reader, logger: routinesTestLogger()}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/ai-config", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"source":"environment"`) || !strings.Contains(response.Body.String(), `"configured":true`) || !strings.Contains(response.Body.String(), `"keyHint":"••••nary"`) || !strings.Contains(response.Body.String(), `"primary":"env-primary"`) || strings.Contains(response.Body.String(), "environment-key-canary") {
		t.Fatalf("environment DTO status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoAIConfigRouteKeepsItsNamespaceOutOfTheFallback(t *testing.T) {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "fallback") })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Route-Owner", "go")
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	handler := MountGoAIConfigRoute(fallback, goRoute)
	for _, test := range []struct {
		method, path, owner string
		status              int
	}{
		{http.MethodGet, "/api/ai-config", "go", http.StatusOK},
		{http.MethodPost, "/api/ai-config", "go", http.StatusOK},
		{http.MethodHead, "/api/ai-config", "go", http.StatusMethodNotAllowed},
		{http.MethodDelete, "/api/ai-config", "go", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/ai-config/extra", "", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if owner := response.Header().Get("X-Route-Owner"); owner != test.owner {
			t.Errorf("%s %s owner=%q want=%q", test.method, test.path, owner, test.owner)
		}
		if response.Code != test.status {
			t.Errorf("%s %s status=%d want=%d", test.method, test.path, response.Code, test.status)
		}
	}
}

func TestMountGoAIConfigRouteWithoutHandlerDoesNotFallThrough(t *testing.T) {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "fallback") })
	handler := MountGoAIConfigRoute(fallback, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/ai-config", nil))
	if response.Code != http.StatusNotFound || response.Header().Get("X-Route-Owner") == "fallback" {
		t.Fatalf("missing AI config owner reached fallback: status=%d headers=%v", response.Code, response.Header())
	}
}

func TestValidAIConfigBodyUsesJavaScriptStringLengthLimits(t *testing.T) {
	body := aiConfigBody{
		Provider: "custom",
		BaseURL:  "https://example.com/" + strings.Repeat("é", 480),
		Models:   aiConfigModels{Primary: "p", Fast: "f", Reasoning: "r", Embeddings: "e"},
	}
	key := strings.Repeat("😀", 500)
	body.APIKey = &key
	if !validAIConfigBody(body) {
		t.Fatal("500 UTF-16 unit URL and 1000 UTF-16 unit key boundaries should be accepted even when UTF-8 byte lengths are larger")
	}

	tooLongKey := strings.Repeat("😀", 501)
	body.APIKey = &tooLongKey
	if validAIConfigBody(body) {
		t.Fatal("API keys over 1000 UTF-16 units should be rejected")
	}

	body.APIKey = nil
	body.BaseURL += "é"
	if validAIConfigBody(body) {
		t.Fatal("base URLs over 500 UTF-16 units should be rejected")
	}
}
