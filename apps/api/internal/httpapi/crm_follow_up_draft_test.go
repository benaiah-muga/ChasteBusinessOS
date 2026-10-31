package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const validCRMFollowUpDraftBody = `{"customerId":"aaaaaaaa-0000-4000-8000-000000000001"}`

type fakeCRMFollowUpDraftReader struct {
	customer   crmFollowUpDraftCustomer
	err        error
	orgID      string
	customerID string
	calls      int
}

func (f *fakeCRMFollowUpDraftReader) Read(_ context.Context, orgID, customerID string) (crmFollowUpDraftCustomer, error) {
	f.calls++
	f.orgID, f.customerID = orgID, customerID
	return f.customer, f.err
}

type fakeCRMFollowUpDraftConfig struct {
	config     myWorkSummaryConfig
	err        error
	orgID      string
	userID     string
	calls      int
	usageCalls int
}

func (f *fakeCRMFollowUpDraftConfig) LoadForOrg(_ context.Context, orgID, userID string) (myWorkSummaryConfig, error) {
	f.calls++
	f.orgID, f.userID = orgID, userID
	return f.config, f.err
}

func (f *fakeCRMFollowUpDraftConfig) RecordCodingAgentUsage(_ context.Context, _, _, _ string, _, _ int64) error {
	f.usageCalls++
	return nil
}

type fakeCRMFollowUpDraftModel struct {
	draft       string
	err         error
	codingDraft string
	codingErr   error
	codingCalls int
	model       string
	system      string
	prompt      string
	temperature float64
	maxTokens   int
	calls       int
}

func (f *fakeCRMFollowUpDraftModel) Complete(_ context.Context, _ myWorkSummaryConfig, model, system, prompt string, temperature float64, maxTokens int) (string, error) {
	f.calls++
	f.model, f.system, f.prompt = model, system, prompt
	f.temperature, f.maxTokens = temperature, maxTokens
	return f.draft, f.err
}

func (f *fakeCRMFollowUpDraftModel) CodingAgentBrief(context.Context, supportCodingAgentConnection, string, string) (string, int64, int64, error) {
	f.codingCalls++
	return f.codingDraft, 12, 4, f.codingErr
}

type fakeCRMFollowUpDraftExecutor struct {
	result       capability.Result
	err          error
	claims       authbridge.CapabilityClaims
	capabilityID string
	input        json.RawMessage
	calls        int
}

func (f *fakeCRMFollowUpDraftExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	f.calls++
	f.claims, f.capabilityID = claims, capabilityID
	f.input = append([]byte(nil), input...)
	return f.result, f.err
}

func crmFollowUpDraftRequest(method, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/crm/follow-up-draft", strings.NewReader(body))
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "work-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	request.Header.Set("Origin", "http://example.com")
	request.Header.Set("Content-Type", "application/json")
	return request
}

func followUpDraftTimeline(t *testing.T, entries []map[string]string) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(map[string]any{"entries": entries})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func newTestCRMFollowUpDraftHandler(identity *session.ResolvedUser, executor CapabilityExecutor, reader crmFollowUpDraftCustomerReader, config crmFollowUpDraftConfigReader, model crmFollowUpDraftModel) *CRMFollowUpDraftSessionHandler {
	if reader == nil {
		reader = &fakeCRMFollowUpDraftReader{}
	}
	handler := NewCRMFollowUpDraftSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil, config, model, nil).(*CRMFollowUpDraftSessionHandler)
	handler.reader = reader
	return handler
}

func TestCRMFollowUpDraftHandlerUsesScopedTimelineAndWorkspaceModel(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeCRMFollowUpDraftReader{customer: crmFollowUpDraftCustomer{Name: "Northwind"}}
	executor := &fakeCRMFollowUpDraftExecutor{result: capability.Result{OK: true, Data: followUpDraftTimeline(t, []map[string]string{
		{"kind": "invoice", "date": "2026-09-20T12:00:00Z", "refId": "aaaaaaaa-0000-4000-8000-000000000002", "summary": "Invoice 7 is awaiting payment"},
		{"kind": "customer", "date": "2026-09-19T12:00:00Z", "refId": "aaaaaaaa-0000-4000-8000-000000000003", "summary": "Ignored non-source kind"},
	})}}
	config := &fakeCRMFollowUpDraftConfig{config: myWorkSummaryConfig{apiKey: "server-secret", fastModel: "fast-model", primaryModel: "primary-model"}}
	model := &fakeCRMFollowUpDraftModel{draft: " Hello Northwind, can we review invoice 7? "}
	response := httptest.NewRecorder()
	newTestCRMFollowUpDraftHandler(identity, executor, reader, config, model).ServeHTTP(response, crmFollowUpDraftRequest(http.MethodPost, validCRMFollowUpDraftBody))
	if response.Code != http.StatusOK || reader.orgID != *identity.OrgID || reader.customerID != "aaaaaaaa-0000-4000-8000-000000000001" {
		t.Fatalf("status=%d reader scope=%s/%s body=%s", response.Code, reader.orgID, reader.customerID, response.Body.String())
	}
	if executor.calls != 1 || executor.capabilityID != "crm.customerTimeline" || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID {
		t.Fatalf("timeline executor calls=%d capability=%s claims=%+v", executor.calls, executor.capabilityID, executor.claims)
	}
	var timelineInput map[string]any
	if err := json.Unmarshal(executor.input, &timelineInput); err != nil || timelineInput["customerId"] != "aaaaaaaa-0000-4000-8000-000000000001" || timelineInput["limit"] != float64(30) {
		t.Fatalf("timeline input=%s err=%v", executor.input, err)
	}
	if config.calls != 1 || config.orgID != *identity.OrgID || config.userID != identity.UserID || model.calls != 1 || model.model != "fast-model" || model.temperature != .4 || model.maxTokens != 320 {
		t.Fatalf("config=%+v model=%+v", config, model)
	}
	if !strings.Contains(model.prompt, "Northwind") || !strings.Contains(model.prompt, "Invoice 7 is awaiting payment") || strings.Contains(model.prompt, "Ignored non-source kind") {
		t.Fatalf("unsafe or incomplete prompt: %s", model.prompt)
	}
	var body struct {
		Draft   string                   `json:"draft"`
		Sources []crmFollowUpDraftSource `json:"sources"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Draft != "Hello Northwind, can we review invoice 7?" || len(body.Sources) != 1 || body.Sources[0].Kind != "invoice" {
		t.Fatalf("response=%+v", body)
	}
}

func TestCRMFollowUpDraftHandlerRejectsCrossOriginAndNonJSONCookieRequests(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeCRMFollowUpDraftReader{customer: crmFollowUpDraftCustomer{Name: "Northwind"}}
	executor := &fakeCRMFollowUpDraftExecutor{result: capability.Result{OK: true, Data: followUpDraftTimeline(t, nil)}}
	config := &fakeCRMFollowUpDraftConfig{config: myWorkSummaryConfig{apiKey: "server-secret", fastModel: "fast-model"}}
	model := &fakeCRMFollowUpDraftModel{draft: "Follow up"}
	handler := newTestCRMFollowUpDraftHandler(identity, executor, reader, config, model)

	crossOrigin := crmFollowUpDraftRequest(http.MethodPost, validCRMFollowUpDraftBody)
	crossOrigin.Header.Set("Origin", "https://attacker.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, crossOrigin)
	if response.Code != http.StatusForbidden || reader.calls != 0 || model.calls != 0 {
		t.Fatalf("cross-origin response=%d reads=%d model calls=%d body=%s", response.Code, reader.calls, model.calls, response.Body.String())
	}

	wrongContentType := crmFollowUpDraftRequest(http.MethodPost, validCRMFollowUpDraftBody)
	wrongContentType.Header.Set("Content-Type", "text/plain")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, wrongContentType)
	if response.Code != http.StatusUnsupportedMediaType || reader.calls != 0 || model.calls != 0 {
		t.Fatalf("non-JSON response=%d reads=%d model calls=%d body=%s", response.Code, reader.calls, model.calls, response.Body.String())
	}
}

func TestCRMFollowUpDraftHandlerRejectsUnsafeOrUnauthorizedRequests(t *testing.T) {
	tests := []struct {
		name       string
		identity   *session.ResolvedUser
		reader     crmFollowUpDraftCustomerReader
		body       string
		wantStatus int
	}{
		{name: "unverified session", identity: func() *session.ResolvedUser { user := directTestIdentity(); user.EmailVerified = false; return user }(), wantStatus: http.StatusUnauthorized},
		{name: "missing permission", identity: func() *session.ResolvedUser {
			user := directTestIdentity()
			user.Permissions = map[string]bool{}
			return user
		}(), wantStatus: http.StatusForbidden},
		{name: "DNC customer", identity: directTestIdentity(), reader: &fakeCRMFollowUpDraftReader{customer: crmFollowUpDraftCustomer{Name: "Northwind", DoNotContact: true}}, body: validCRMFollowUpDraftBody, wantStatus: http.StatusConflict},
		{name: "unknown request field", identity: directTestIdentity(), reader: &fakeCRMFollowUpDraftReader{}, body: `{"customerId":"aaaaaaaa-0000-4000-8000-000000000001","orgId":"22222222-2222-4222-8222-222222222222"}`, wantStatus: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeCRMFollowUpDraftExecutor{}
			config := &fakeCRMFollowUpDraftConfig{}
			model := &fakeCRMFollowUpDraftModel{}
			response := httptest.NewRecorder()
			newTestCRMFollowUpDraftHandler(test.identity, executor, test.reader, config, model).ServeHTTP(response, crmFollowUpDraftRequest(http.MethodPost, test.body))
			if response.Code != test.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			if executor.calls != 0 || config.calls != 0 || model.calls != 0 {
				t.Fatalf("unauthorized request performed work: executor=%d config=%d model=%d", executor.calls, config.calls, model.calls)
			}
		})
	}
}

func TestCRMFollowUpDraftHandlerRequiresUsableSourcesAndProvider(t *testing.T) {
	identity := directTestIdentity()
	for _, test := range []struct {
		name     string
		timeline []map[string]string
		config   myWorkSummaryConfig
		want     int
	}{
		{name: "no eligible source", timeline: []map[string]string{{"kind": "customer", "date": "2026-09-20T12:00:00Z", "refId": "aaaaaaaa-0000-4000-8000-000000000002", "summary": "customer"}}, config: myWorkSummaryConfig{apiKey: "secret"}, want: http.StatusUnprocessableEntity},
		{name: "missing provider key", timeline: []map[string]string{{"kind": "task", "date": "2026-09-20T12:00:00Z", "refId": "aaaaaaaa-0000-4000-8000-000000000002", "summary": "Call customer"}}, want: http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeCRMFollowUpDraftExecutor{result: capability.Result{OK: true, Data: followUpDraftTimeline(t, test.timeline)}}
			config := &fakeCRMFollowUpDraftConfig{config: test.config}
			model := &fakeCRMFollowUpDraftModel{}
			response := httptest.NewRecorder()
			newTestCRMFollowUpDraftHandler(identity, executor, &fakeCRMFollowUpDraftReader{customer: crmFollowUpDraftCustomer{Name: "Northwind"}}, config, model).ServeHTTP(response, crmFollowUpDraftRequest(http.MethodPost, validCRMFollowUpDraftBody))
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
			if model.calls != 0 {
				t.Fatalf("model called %d times", model.calls)
			}
		})
	}
}

func TestCRMFollowUpDraftHandlerUsesConnectedCodingPlanAndRecordsUsage(t *testing.T) {
	identity := directTestIdentity()
	config := &fakeCRMFollowUpDraftConfig{config: myWorkSummaryConfig{codingAgent: &supportCodingAgentConnection{connectionID: "connection-7"}}}
	model := &fakeCRMFollowUpDraftModel{codingDraft: "Hello Northwind, can we review the invoice?"}
	executor := &fakeCRMFollowUpDraftExecutor{result: capability.Result{OK: true, Data: followUpDraftTimeline(t, []map[string]string{{
		"kind": "invoice", "date": "2026-09-20T12:00:00Z", "refId": "aaaaaaaa-0000-4000-8000-000000000002", "summary": "Invoice 7 is awaiting payment",
	}})}}
	response := httptest.NewRecorder()
	newTestCRMFollowUpDraftHandler(identity, executor, &fakeCRMFollowUpDraftReader{customer: crmFollowUpDraftCustomer{Name: "Northwind"}}, config, model).ServeHTTP(response, crmFollowUpDraftRequest(http.MethodPost, validCRMFollowUpDraftBody))
	if response.Code != http.StatusOK || model.codingCalls != 1 || model.calls != 0 || config.usageCalls != 1 {
		t.Fatalf("status=%d coding calls=%d provider calls=%d usage calls=%d body=%s", response.Code, model.codingCalls, model.calls, config.usageCalls, response.Body.String())
	}
}

func TestMountGoCRMFollowUpDraftRouteIsExactAndPostOnly(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	handler := MountGoCRMFollowUpDraftRoute(base, routeMarker("go draft"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/crm/follow-up-draft", nil))
	if response.Code != http.StatusOK || response.Body.String() != "go draft" {
		t.Fatalf("Go route response=%d %q", response.Code, response.Body.String())
	}
	for _, test := range []struct{ method, path string }{
		{http.MethodGet, "/api/crm/follow-up-draft"},
		{http.MethodPost, "/api/crm/follow-up-draft/extra"},
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("%s %s response=%d, want base handler", test.method, test.path, response.Code)
		}
	}
}
