package httpapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func encryptSummaryTestSecret(t *testing.T, plain, secret string) string {
	t.Helper()
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, nonce, []byte(plain), nil)
	cut := len(sealed) - gcm.Overhead()
	encode := base64.RawURLEncoding.EncodeToString
	return "v1:" + encode(nonce) + ":" + encode(sealed[cut:]) + ":" + encode(sealed[:cut])
}

type fakeMyWorkSummaryConfigReader struct {
	config            myWorkSummaryConfig
	err               error
	orgID             string
	userID            string
	calls             int
	usageCalls        int
	usageOrgID        string
	usageUserID       string
	usageConnectionID string
	usageInput        int64
	usageOutput       int64
	usageErr          error
}

func (f *fakeMyWorkSummaryConfigReader) LoadForOrg(_ context.Context, orgID, userID string) (myWorkSummaryConfig, error) {
	f.calls++
	f.orgID, f.userID = orgID, userID
	return f.config, f.err
}

func (f *fakeMyWorkSummaryConfigReader) RecordCodingAgentUsage(_ context.Context, orgID, userID, connectionID string, inputTokens, outputTokens int64) error {
	f.usageCalls++
	f.usageOrgID, f.usageUserID, f.usageConnectionID = orgID, userID, connectionID
	f.usageInput, f.usageOutput = inputTokens, outputTokens
	return f.usageErr
}

type fakeMyWorkSummaryModel struct {
	briefs           []string
	errs             []error
	models           []string
	prompts          []string
	calls            int
	codingCalls      int
	codingConnection *supportCodingAgentConnection
	codingSystem     string
	codingPrompt     string
	codingBrief      string
	codingErr        error
}

func (f *fakeMyWorkSummaryModel) CodingAgentBrief(_ context.Context, connection supportCodingAgentConnection, system, prompt string) (string, int64, int64, error) {
	f.codingCalls++
	f.codingConnection = &connection
	f.codingSystem, f.codingPrompt = system, prompt
	return f.codingBrief, 12, 4, f.codingErr
}

func (f *fakeMyWorkSummaryModel) Brief(_ context.Context, _ myWorkSummaryConfig, model, prompt string) (string, error) {
	index := f.calls
	f.calls++
	f.models = append(f.models, model)
	f.prompts = append(f.prompts, prompt)
	if index < len(f.errs) && f.errs[index] != nil {
		return "", f.errs[index]
	}
	if index < len(f.briefs) {
		return f.briefs[index], nil
	}
	return "", nil
}

func myWorkSummaryRequest(method, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/my-work/summarize", strings.NewReader(body))
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "work-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	request.Header.Set("Content-Type", "application/json")
	return request
}

const validMyWorkSummaryBody = `{"cards":[{"kind":"approval","title":"Approval needed","detail":"Review order 42"}]}`

func myWorkSummaryBoundaryCards(lastDetailUnits int) []myWorkBriefCard {
	cards := make([]myWorkBriefCard, 8)
	for i := range cards {
		detailUnits := 3988
		if i == len(cards)-1 {
			detailUnits = lastDetailUnits
		}
		cards[i] = myWorkBriefCard{Kind: "x", Title: "x", Detail: strings.Repeat("x", detailUnits)}
	}
	return cards
}

func TestMyWorkSummaryHandlerUsesWorkspaceModelAndFastToPrimaryFallback(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{config: myWorkSummaryConfig{
		provider: "openrouter", baseURL: "https://models.example/v1", apiKey: "server-secret",
		fastModel: "openrouter/fast-model", primaryModel: "openrouter/primary-model",
	}}
	model := &fakeMyWorkSummaryModel{briefs: []string{"", "  Two approvals need review.  "}}
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody))
	if response.Code != http.StatusOK || config.orgID != *identity.OrgID || config.userID != identity.UserID {
		t.Fatalf("status=%d config scope=%s/%s body=%s", response.Code, config.orgID, config.userID, response.Body.String())
	}
	if model.calls != 2 || strings.Join(model.models, ",") != "openrouter/fast-model,openrouter/primary-model" || model.prompts[0] != "Pending work:\n- [approval] Approval needed: Review order 42" {
		t.Fatalf("model calls=%d models=%v prompts=%v", model.calls, model.models, model.prompts)
	}
	var body struct {
		Brief string `json:"brief"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Brief != "Two approvals need review." || body.Model != "primary-model" {
		t.Fatalf("response=%+v", body)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q", response.Header().Get("Cache-Control"))
	}
}

func TestMyWorkSummaryHandlerFallsBackForUnavailableFastModel(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{config: myWorkSummaryConfig{apiKey: "server-secret", fastModel: "fast", primaryModel: "primary"}}
	model := &fakeMyWorkSummaryModel{errs: []error{myWorkSummaryProviderError{status: http.StatusNotFound, message: "model_not_found"}}, briefs: []string{"", "Primary summary."}}
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody))
	if response.Code != http.StatusOK || model.calls != 2 || strings.Join(model.models, ",") != "fast,primary" {
		t.Fatalf("status=%d models=%v body=%s", response.Code, model.models, response.Body.String())
	}
}

func TestMyWorkSummaryHandlerValidatesCardsBeforeLoadingCredential(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{}
	model := &fakeMyWorkSummaryModel{}
	tooMany := `{"cards":[` + strings.TrimSuffix(strings.Repeat(`{"kind":"x","title":"y","detail":""},`, 31), ",") + `]}`
	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{name: "missing", body: `{}`, want: "cards are required"},
		{name: "empty", body: `{"cards":[]}`, want: "cards are required"},
		{name: "too many", body: tooMany, want: "too many cards"},
		{name: "empty title", body: `{"cards":[{"kind":"approval","title":"","detail":"x"}]}`, want: "invalid card"},
		{name: "non-string detail", body: `{"cards":[{"kind":"approval","title":"x","detail":null}]}`, want: "invalid card"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, test.body))
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), test.want) || config.calls != 0 || model.calls != 0 {
				t.Fatalf("status=%d config calls=%d model calls=%d body=%s", response.Code, config.calls, model.calls, response.Body.String())
			}
		})
	}
}

func TestMyWorkSummaryHandlerBoundsCardTextBeforeLoadingCredential(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{}
	model := &fakeMyWorkSummaryModel{}
	body, err := json.Marshal(map[string]any{"cards": []any{map[string]string{
		"kind": "approval", "title": "Review", "detail": strings.Repeat("x", myWorkBriefMaxCardFieldUnits+1),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, string(body)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "card text is too long") || config.calls != 0 || model.calls != 0 {
		t.Fatalf("status=%d config calls=%d model calls=%d body=%s", response.Code, config.calls, model.calls, response.Body.String())
	}

	cards := make([]map[string]string, 9)
	for i := range cards {
		cards[i] = map[string]string{"kind": "signal", "title": "Review", "detail": strings.Repeat("x", 4000)}
	}
	body, err = json.Marshal(map[string]any{"cards": cards})
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, string(body)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"error":"card text is too long"`) || config.calls != 0 || model.calls != 0 {
		t.Fatalf("aggregate prompt status=%d config calls=%d model calls=%d body=%s", response.Code, config.calls, model.calls, response.Body.String())
	}
}

func TestMyWorkSummaryHandlerRejectsOversizedRequestBodyWith413(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{}
	model := &fakeMyWorkSummaryModel{}
	body := strings.Repeat("x", myWorkBriefMaxBodyBytes+1)
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, body))
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), `"error":"request body too large"`) || config.calls != 0 || model.calls != 0 {
		t.Fatalf("status=%d config calls=%d model calls=%d body=%s", response.Code, config.calls, model.calls, response.Body.String())
	}
}

func TestMyWorkSummaryHandlerCountsComposedPromptFramingAtLimit(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{config: myWorkSummaryConfig{apiKey: "server-secret", fastModel: "fast", primaryModel: "primary"}}
	model := &fakeMyWorkSummaryModel{briefs: []string{"A bounded summary."}}
	cards := myWorkSummaryBoundaryCards(3991)
	lines := make([]string, len(cards))
	for i, card := range cards {
		lines[i] = "- [" + card.Kind + "] " + card.Title + ": " + card.Detail
	}
	if got := utf16Length(myWorkBriefPrompt(lines)); got != myWorkBriefMaxPromptUnits {
		t.Fatalf("composed prompt units=%d, want %d", got, myWorkBriefMaxPromptUnits)
	}
	body, err := json.Marshal(map[string]any{"cards": cards})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, string(body)))
	if response.Code != http.StatusOK || config.calls != 1 || model.calls != 1 || len(model.prompts) != 1 || utf16Length(model.prompts[0]) != myWorkBriefMaxPromptUnits {
		t.Fatalf("at limit status=%d config calls=%d model calls=%d body=%s", response.Code, config.calls, model.calls, response.Body.String())
	}

	overLimitConfig := &fakeMyWorkSummaryConfigReader{}
	overLimitCards := myWorkSummaryBoundaryCards(3992)
	overLimit, err := json.Marshal(map[string]any{"cards": overLimitCards})
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	overLimitModel := &fakeMyWorkSummaryModel{}
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, overLimitConfig, overLimitModel, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, string(overLimit)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"error":"card text is too long"`) || overLimitConfig.calls != 0 || overLimitModel.calls != 0 {
		t.Fatalf("over limit status=%d config calls=%d model calls=%d body=%s", response.Code, overLimitConfig.calls, overLimitModel.calls, response.Body.String())
	}
}

func TestMyWorkSummaryHandlerRejectsInvalidUTF8RequestBody(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{}
	model := &fakeMyWorkSummaryModel{}
	body := append([]byte(`{"cards":[{"kind":"signal","title":"Review","detail":"`), 0xff)
	body = append(body, []byte(`"}]}`)...)
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, string(body)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"error":"cards are required"`) || config.calls != 0 || model.calls != 0 {
		t.Fatalf("status=%d config calls=%d model calls=%d body=%s", response.Code, config.calls, model.calls, response.Body.String())
	}
}

func TestMyWorkSummaryHandlerFailsClosedForCredentialAndCodingAgentCases(t *testing.T) {
	identity := directTestIdentity()
	t.Run("no workspace credential", func(t *testing.T) {
		config := &fakeMyWorkSummaryConfigReader{}
		model := &fakeMyWorkSummaryModel{}
		response := httptest.NewRecorder()
		NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody))
		if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "no workspace model credential") || model.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, model.calls, response.Body.String())
		}
	})
	t.Run("user coding agent selected", func(t *testing.T) {
		config := &fakeMyWorkSummaryConfigReader{config: myWorkSummaryConfig{apiKey: "workspace-key", codingAgent: &supportCodingAgentConnection{provider: "opencode", modelID: "openai/gpt-5", connectionID: "33333333-3333-4333-8333-333333333333"}}}
		model := &fakeMyWorkSummaryModel{codingBrief: "A coding plan summary."}
		response := httptest.NewRecorder()
		NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody))
		if response.Code != http.StatusOK || model.calls != 0 || model.codingCalls != 1 || config.usageCalls != 1 || !strings.Contains(response.Body.String(), `"model":"opencode:openai/gpt-5"`) {
			t.Fatalf("status=%d workspace calls=%d coding calls=%d usage calls=%d body=%s", response.Code, model.calls, model.codingCalls, config.usageCalls, response.Body.String())
		}
		if model.codingConnection == nil || model.codingConnection.provider != "opencode" || model.codingSystem != myWorkBriefSystemPrompt || model.codingPrompt != "Pending work:\n- [approval] Approval needed: Review order 42" {
			t.Fatalf("coding agent input=%+v system=%q prompt=%q", model.codingConnection, model.codingSystem, model.codingPrompt)
		}
		if config.usageOrgID != *identity.OrgID || config.usageUserID != identity.UserID || config.usageConnectionID != "33333333-3333-4333-8333-333333333333" || config.usageInput != 12 || config.usageOutput != 4 {
			t.Fatalf("usage scope=%s/%s/%s tokens=%d/%d", config.usageOrgID, config.usageUserID, config.usageConnectionID, config.usageInput, config.usageOutput)
		}
	})
	t.Run("coding agent failure does not use workspace key", func(t *testing.T) {
		config := &fakeMyWorkSummaryConfigReader{config: myWorkSummaryConfig{apiKey: "workspace-key", codingAgent: &supportCodingAgentConnection{provider: "opencode"}}}
		model := &fakeMyWorkSummaryModel{codingErr: errors.New("OpenCode could not complete the support reply")}
		response := httptest.NewRecorder()
		NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody))
		if response.Code != http.StatusBadGateway || model.calls != 0 || model.codingCalls != 1 || config.usageCalls != 0 || strings.Contains(response.Body.String(), "workspace-key") {
			t.Fatalf("status=%d workspace calls=%d coding calls=%d usage calls=%d body=%s", response.Code, model.calls, model.codingCalls, config.usageCalls, response.Body.String())
		}
	})
}

func TestMyWorkSummaryHandlerRequiresVerifiedSessionAndOrganizationMatch(t *testing.T) {
	identity := directTestIdentity()
	identity.EmailVerified = false
	config := &fakeMyWorkSummaryConfigReader{}
	model := &fakeMyWorkSummaryModel{}
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody))
	if response.Code != http.StatusUnauthorized || config.calls != 0 {
		t.Fatalf("unverified status=%d config calls=%d body=%s", response.Code, config.calls, response.Body.String())
	}

	identity = directTestIdentity()
	request := myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody)
	request.Header.Set("X-Organization-Id", "22222222-2222-4222-8222-222222222222")
	response = httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || config.calls != 0 {
		t.Fatalf("cross-org status=%d config calls=%d body=%s", response.Code, config.calls, response.Body.String())
	}
}

func TestOpenAIWorkSummaryModelUsesServerCredentialAndLegacyRequestShape(t *testing.T) {
	var requestSeen bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestSeen = true
		if r.URL.Path != "/v1/chat/completions" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer server-secret" || r.Header.Get("X-Title") != "ChasteBusinessOS" {
			t.Errorf("request=%s %s authorization=%q title=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("X-Title"))
		}
		var body struct {
			Model       string  `json:"model"`
			Temperature float64 `json:"temperature"`
			MaxTokens   int     `json:"max_tokens"`
			Messages    []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if body.Model != "fast-model" || body.Temperature != 0.2 || body.MaxTokens != 220 || len(body.Messages) != 2 || body.Messages[0].Content != myWorkBriefSystemPrompt || body.Messages[1].Content != "Pending work:\n- [approval] Review: PO 42" {
			t.Errorf("request body=%+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"A brief."}}]}`))
	}))
	defer server.Close()
	t.Setenv("GO_AUTH_MODE", "development")
	model := &openAIWorkSummaryModel{}
	brief, err := model.Brief(context.Background(), myWorkSummaryConfig{baseURL: server.URL + "/v1", apiKey: "server-secret"}, "openrouter/fast-model", "Pending work:\n- [approval] Review: PO 42")
	if err != nil || brief != "A brief." || !requestSeen {
		t.Fatalf("brief=%q requestSeen=%t err=%v", brief, requestSeen, err)
	}
}

func TestOpenCodeWorkSummaryUsesOnlyTheAuthenticatedConnectionCredentialAndDisablesTools(t *testing.T) {
	const encryptionSecret = "test-auth-and-ai-encryption-secret"
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", encryptionSecret)
	t.Setenv("NODE_ENV", "development")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "user-owned" || password != "opencode-password" {
			t.Errorf("basic auth=%q/%q ok=%t", username, password, ok)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/session":
			_, _ = w.Write([]byte(`{"id":"summary-session"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/session/summary-session/message":
			var body struct {
				System string `json:"system"`
				Model  struct {
					ProviderID string `json:"providerID"`
					ModelID    string `json:"modelID"`
				} `json:"model"`
				Tools map[string]bool `json:"tools"`
				Parts []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"parts"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode OpenCode message: %v", err)
			}
			if body.System != myWorkBriefSystemPrompt || body.Model.ProviderID != "openai" || body.Model.ModelID != "gpt-5" || body.Tools["*"] || body.Tools["*"] != false || len(body.Tools) != 1 || len(body.Parts) != 1 || body.Parts[0].Text != "User: Pending work:\n- [approval] Review: PO 42" {
				t.Errorf("OpenCode message body=%+v", body)
			}
			_, _ = w.Write([]byte(`{"info":{"role":"assistant","tokens":{"input":41,"output":9}},"parts":[{"type":"text","text":"Two approvals need review."}]}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/session/summary-session":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected OpenCode request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	connection := supportCodingAgentConnection{
		provider: "opencode", endpoint: server.URL, modelID: "openai/gpt-5",
		credential: encryptSummaryTestSecret(t, `{"username":"user-owned","password":"opencode-password"}`, encryptionSecret),
	}
	model := &openAIWorkSummaryModel{}
	brief, inputTokens, outputTokens, err := model.CodingAgentBrief(context.Background(), connection, myWorkBriefSystemPrompt, "Pending work:\n- [approval] Review: PO 42")
	if err != nil || brief != "Two approvals need review." || inputTokens != 41 || outputTokens != 9 {
		t.Fatalf("brief=%q usage=%d/%d err=%v", brief, inputTokens, outputTokens, err)
	}
}

func TestOpenCodeWorkSummaryRejectsInvalidModelBeforeCreatingSession(t *testing.T) {
	const encryptionSecret = "test-auth-and-ai-encryption-secret"
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", encryptionSecret)
	t.Setenv("NODE_ENV", "development")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		t.Errorf("unexpected OpenCode request for invalid model: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer server.Close()
	connection := supportCodingAgentConnection{
		provider: "opencode", endpoint: server.URL, modelID: "invalid-model-id",
		credential: encryptSummaryTestSecret(t, `{"username":"user-owned","password":"opencode-password"}`, encryptionSecret),
	}
	_, _, _, err := (&openAIWorkSummaryModel{}).CodingAgentBrief(context.Background(), connection, myWorkBriefSystemPrompt, "Pending work")
	if err == nil || requests != 0 {
		t.Fatalf("err=%v requests=%d, want invalid model rejected before any request", err, requests)
	}
}

func TestResolveCodingPlanOpenCodeEndpointBlocksPrivateRemoteTargets(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	t.Setenv("GO_AUTH_MODE", "production")
	for _, value := range []string{"http://127.0.0.1:4096", "https://127.0.0.1:4096", "http://example.com"} {
		if _, _, err := resolveCodingPlanOpenCodeEndpoint(value); err == nil {
			t.Errorf("endpoint %q should be refused", value)
		}
	}
}

func TestWorkSummaryProviderEndpointPinsPublicAddressAndRequiresExplicitDevelopmentForLocalHTTP(t *testing.T) {
	t.Setenv("NODE_ENV", "")
	t.Setenv("GO_AUTH_MODE", "")
	if _, _, err := resolveWorkSummaryEndpoint("http://127.0.0.1:8081/v1"); err == nil {
		t.Fatal("local HTTP provider was accepted without explicit development mode")
	}
	t.Setenv("GO_AUTH_MODE", "development")
	endpoint, address, err := resolveWorkSummaryEndpoint("http://127.0.0.1:8081/v1")
	if err != nil || endpoint.Host != "127.0.0.1:8081" || address != "127.0.0.1" {
		t.Fatalf("endpoint=%v address=%q err=%v", endpoint, address, err)
	}
	t.Setenv("GO_AUTH_MODE", "production")
	if _, _, err := resolveWorkSummaryEndpoint("https://127.0.0.1:8081/v1"); err == nil {
		t.Fatal("private provider endpoint was accepted in production")
	}
	t.Setenv("NODE_ENV", "development")
	if _, _, err := resolveWorkSummaryEndpoint("http://127.0.0.1:8081/v1"); err == nil {
		t.Fatal("NODE_ENV development overrode explicit Go production mode")
	}
}

func TestOpenAIWorkSummaryModelDoesNotFollowProviderRedirects(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	redirectCalls := 0
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectCalls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer redirect.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirect.URL+"/capture", http.StatusTemporaryRedirect)
	}))
	defer provider.Close()
	model := &openAIWorkSummaryModel{}
	_, err := model.Brief(context.Background(), myWorkSummaryConfig{baseURL: provider.URL + "/v1", apiKey: "server-secret"}, "fast", "pending")
	if err == nil || redirectCalls != 0 {
		t.Fatalf("model error=%v redirect calls=%d, expected no redirect request", err, redirectCalls)
	}
}

func TestCodexWorkSummaryUsesScopedHomeRestrictedArgumentsAndUsage(t *testing.T) {
	orgID, userID := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	root := t.TempDir()
	owner := sha256.Sum256([]byte(orgID + ":" + userID))
	codexHome := filepath.Join(root, hex.EncodeToString(owner[:]))
	if err := os.Mkdir(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(t.TempDir(), "codex-capture.txt")
	binary := filepath.Join(t.TempDir(), "codex")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n%%s\\n' \"$CODEX_HOME\" \"$*\" > %q\ncat >/dev/null\nprintf '%%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Pending approvals need review.\"}}'\nprintf '%%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":13,\"output_tokens\":5}}'\n", capture)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHASTE_CODEX_CONNECTION_HOME", root)
	t.Setenv("CODEX_BIN", binary)
	model := &openAIWorkSummaryModel{}
	connection := supportCodingAgentConnection{provider: "codex", orgID: orgID, userID: userID, modelID: "gpt-5", connectionID: "33333333-3333-4333-8333-333333333333"}
	brief, inputTokens, outputTokens, err := model.CodingAgentBrief(context.Background(), connection, myWorkBriefSystemPrompt, "Pending work:\n- [approval] Review: PO 42")
	if err != nil || brief != "Pending approvals need review." || inputTokens != 13 || outputTokens != 5 {
		t.Fatalf("brief=%q usage=%d/%d err=%v", brief, inputTokens, outputTokens, err)
	}
	captured, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	values := strings.SplitN(strings.TrimSpace(string(captured)), "\n", 2)
	if len(values) != 2 || values[0] != codexHome {
		t.Fatalf("captured Codex environment=%q want home %q", captured, codexHome)
	}
	for _, required := range []string{"--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox read-only", "features.shell_tool=false", "features.web_search_request=false", "--model gpt-5"} {
		if !strings.Contains(values[1], required) {
			t.Errorf("Codex arguments %q do not include %q", values[1], required)
		}
	}
	if strings.Contains(values[1], "mcp_servers") || strings.Contains(values[1], "CHASTE_MCP_TOKEN") {
		t.Errorf("tool access unexpectedly enabled in Codex arguments: %s", values[1])
	}
}

func TestCodexWorkSummaryHomeRejectsPathEscape(t *testing.T) {
	root := t.TempDir()
	escape := t.TempDir()
	orgID, userID := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	owner := sha256.Sum256([]byte(orgID + ":" + userID))
	if err := os.Symlink(escape, filepath.Join(root, hex.EncodeToString(owner[:]))); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHASTE_CODEX_CONNECTION_HOME", root)
	if _, err := codexWorkSummaryHome(orgID, userID); err == nil {
		t.Fatal("Codex connection home symlink escaped its configured root")
	}
}

func TestMyWorkSummaryHandlerDoesNotExposeProviderErrorText(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeMyWorkSummaryConfigReader{config: myWorkSummaryConfig{apiKey: "server-secret", fastModel: "fast", primaryModel: "primary"}}
	model := &fakeMyWorkSummaryModel{errs: []error{errors.New("provider echoed server-secret")}}
	response := httptest.NewRecorder()
	NewMyWorkSummarySessionHandler(&fakeDirectSessionResolver{resolved: identity}, config, model, nil).ServeHTTP(response, myWorkSummaryRequest(http.MethodPost, validMyWorkSummaryBody))
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "server-secret") || !strings.Contains(response.Body.String(), "model request failed") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
