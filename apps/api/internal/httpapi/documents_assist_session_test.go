package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type documentsAssistTestResolver struct{ user *session.ResolvedUser }

func (resolver documentsAssistTestResolver) Resolve(context.Context, string, string) (*session.ResolvedUser, error) {
	return resolver.user, nil
}
func (resolver documentsAssistTestResolver) ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error) {
	return resolver.user, nil
}

type documentsAssistTestStore struct {
	template documentsAssistTemplate
	document documentsAssistDocument
	found    bool
	orgID    string
}

func (store *documentsAssistTestStore) LoadTemplate(_ context.Context, orgID, _ string) (documentsAssistTemplate, bool, error) {
	store.orgID = orgID
	return store.template, store.found, nil
}
func (store *documentsAssistTestStore) LoadProfileFacts(_ context.Context, orgID string) ([]string, error) {
	store.orgID = orgID
	return []string{"Business name: Chaste"}, nil
}
func (store *documentsAssistTestStore) LoadDocument(_ context.Context, orgID, _ string) (documentsAssistDocument, bool, error) {
	store.orgID = orgID
	return store.document, store.found, nil
}

type documentsAssistTestConfig struct {
	loadedOrg string
	value     myWorkSummaryConfig
}

func (config *documentsAssistTestConfig) LoadForOrg(_ context.Context, orgID, _ string) (myWorkSummaryConfig, error) {
	config.loadedOrg = orgID
	return config.value, nil
}
func (*documentsAssistTestConfig) RecordCodingAgentUsage(context.Context, string, string, string, int64, int64) error {
	return nil
}

type documentsAssistTestModel struct {
	system string
	prompt string
	text   string
}

func (model *documentsAssistTestModel) Complete(_ context.Context, _ myWorkSummaryConfig, _, system, prompt string, _ float64, _ int) (string, error) {
	model.system, model.prompt = system, prompt
	return model.text, nil
}
func (*documentsAssistTestModel) CodingAgentBrief(context.Context, supportCodingAgentConnection, string, string) (string, int64, int64, error) {
	return "", 0, 0, nil
}

func TestDocumentsAssistInputValidationAndPlainText(t *testing.T) {
	for _, input := range []documentsAssistInput{
		{Kind: "selection", Action: "translate", Text: "Hello"},
		{Kind: "continue", Before: "Draft"},
		{Kind: "prefill", TemplateID: "44444444-4444-4444-8444-444444444444"},
		{Kind: "chat", DocumentID: "44444444-4444-4444-8444-444444444444", Question: "What is the title?"},
	} {
		if !validDocumentsAssistInput(input) {
			t.Errorf("expected valid assist input: %+v", input)
		}
	}
	for _, input := range []documentsAssistInput{
		{Kind: "selection", Action: "invent", Text: "x"},
		{Kind: "selection", Action: "grammar"},
		{Kind: "continue", Before: strings.Repeat("x", 12_001)},
		{Kind: "prefill", TemplateID: "not-a-uuid"},
		{Kind: "chat", DocumentID: "44444444-4444-4444-8444-444444444444"},
	} {
		if validDocumentsAssistInput(input) {
			t.Errorf("expected invalid assist input: %+v", input)
		}
	}
	content := []byte(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"First line"}]},{"type":"heading","content":[{"type":"text","text":"Second line"}]}]}`)
	if got := documentsAssistPlainText(content); got != "First line\nSecond line" {
		t.Fatalf("plain text=%q", got)
	}
}

func TestDocumentsAssistPrefillFiltersModelValuesAndScopesReads(t *testing.T) {
	orgID := "11111111-1111-4111-8111-111111111111"
	userID := "22222222-2222-4222-8222-222222222222"
	store := &documentsAssistTestStore{template: documentsAssistTemplate{Name: "Letter", Placeholders: []string{"company", "contact"}}, found: true}
	config := &documentsAssistTestConfig{value: myWorkSummaryConfig{provider: "openai", baseURL: "https://api.example.test/v1", apiKey: "test-key", fastModel: "fast-model"}}
	model := &documentsAssistTestModel{text: `{"company":"Chaste","unknown":"leak","contact":7}`}
	handler := newDocumentsAssistSessionHandler(documentsAssistTestResolver{user: &session.ResolvedUser{
		UserID: userID, OrgID: &orgID, EmailVerified: true, AuthSessionID: "session",
	}}, store, config, model, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	r := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/docs/assist", strings.NewReader(`{"kind":"prefill","templateId":"44444444-4444-4444-8444-444444444444"}`))
	r.Header.Set("Origin", "https://app.example.test")
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"company":"Chaste"`) || strings.Contains(response.Body.String(), "unknown") || strings.Contains(response.Body.String(), "contact") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if store.orgID != orgID || config.loadedOrg != orgID {
		t.Fatalf("scoped reads store=%q config=%q want %q", store.orgID, config.loadedOrg, orgID)
	}
	if !strings.Contains(model.prompt, "Business name: Chaste") || !strings.Contains(model.prompt, "Placeholders: company, contact") {
		t.Fatalf("model prompt=%q", model.prompt)
	}
}

func TestDocumentsAssistRejectsUnauthenticatedAndInvalidBody(t *testing.T) {
	orgID := "11111111-1111-4111-8111-111111111111"
	store := &documentsAssistTestStore{}
	config := &documentsAssistTestConfig{}
	model := &documentsAssistTestModel{text: "unexpected"}
	handler := newDocumentsAssistSessionHandler(documentsAssistTestResolver{}, store, config, model, nil, nil)
	for _, tc := range []struct {
		body string
		want int
	}{{body: `{}`, want: http.StatusUnauthorized}, {body: `{"kind":"selection","action":"grammar","text":"ok","extra":true}`, want: http.StatusUnauthorized}} {
		r := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/docs/assist", strings.NewReader(tc.body))
		r.Header.Set("Origin", "https://app.example.test")
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		if response.Code != tc.want {
			t.Fatalf("status=%d body=%s want=%d", response.Code, response.Body.String(), tc.want)
		}
	}
	if model.prompt != "" {
		t.Fatal("unauthenticated request reached the model")
	}
}

func TestDocumentsAssistFailsClosedWhenProviderConfigIsIncomplete(t *testing.T) {
	orgID := "11111111-1111-4111-8111-111111111111"
	userID := "22222222-2222-4222-8222-222222222222"
	model := &documentsAssistTestModel{text: "unexpected"}
	handler := newDocumentsAssistSessionHandler(documentsAssistTestResolver{user: &session.ResolvedUser{
		UserID: userID, OrgID: &orgID, EmailVerified: true, AuthSessionID: "session",
	}}, &documentsAssistTestStore{}, &documentsAssistTestConfig{}, model, nil, nil)
	r := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/docs/assist", strings.NewReader(`{"kind":"selection","action":"grammar","text":"Fix this."}`))
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if response.Code != http.StatusBadGateway || model.prompt != "" {
		t.Fatalf("status=%d body=%s modelPrompt=%q", response.Code, response.Body.String(), model.prompt)
	}
}

func TestMountGoDocumentsAssistRouteMatchesOnlyExactPost(t *testing.T) {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "fallback") })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "go") })
	handler := MountGoDocumentsAssistRoute(fallback, goRoute)
	for _, test := range []struct{ method, path, owner string }{
		{http.MethodPost, "/api/docs/assist", "go"},
		{http.MethodGet, "/api/docs/assist", "fallback"},
		{http.MethodPost, "/api/docs/44444444-4444-4444-8444-444444444444/assist", "fallback"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, strings.NewReader("{}")))
		if got := response.Header().Get("X-Route-Owner"); got != test.owner {
			t.Errorf("%s %s owner=%q want=%q", test.method, test.path, got, test.owner)
		}
	}
}
