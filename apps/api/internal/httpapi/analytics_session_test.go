package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type analyticsExecution struct {
	claims authbridge.CapabilityClaims
	id     string
	input  json.RawMessage
}

type analyticsReportExecutor struct {
	results map[string]capability.Result
	errors  map[string]error
	calls   []analyticsExecution
}

func (f *analyticsReportExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, id string, input json.RawMessage) (capability.Result, error) {
	f.calls = append(f.calls, analyticsExecution{claims: claims, id: id, input: append(json.RawMessage(nil), input...)})
	return f.results[id], f.errors[id]
}

func makeAnalyticsReportRequest(body string) *http.Request {
	request := analyticsRequest(http.MethodPost, "/api/analytics")
	request.Body = io.NopCloser(strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func analyticsRequest(method, path string) *http.Request {
	request := httptest.NewRequest(method, path, nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestAnalyticsSessionHandlerListsOnlyPermittedDatasets(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["accounting.read"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	response := httptest.NewRecorder()
	NewAnalyticsSessionHandler(resolver, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, analyticsRequest(http.MethodGet, "/api/analytics"))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "session-cookie" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("resolver calls=%d cookie=%q org=%q", resolver.resolveCalls, resolver.cookie, resolver.activeOrg)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
	for _, fragment := range []string{
		`"id":"analytics.pipelineByStage","label":"Pipeline by stage","description":"Deal counts and values per stage with weighted forecast"`,
		`"id":"analytics.revenueByMonth","label":"Revenue by month","description":"Invoiced totals per month over a lookback window","params":[{"key":"monthsBack","type":"number","default":12}]`,
		`"id":"analytics.salesByCustomer","label":"Top customers","description":"Customers ranked by invoiced value","params":[{"key":"limit","type":"number","default":10}]`,
	} {
		if !strings.Contains(response.Body.String(), fragment) {
			t.Errorf("dataset list missing %s: %s", fragment, response.Body.String())
		}
	}
	if strings.Contains(response.Body.String(), `"permission"`) || strings.Contains(response.Body.String(), `"analytics.stockLevels"`) {
		t.Fatalf("response exposed internal permission or unauthorized dataset: %s", response.Body.String())
	}
}

func TestAnalyticsSessionHandlerRunsKnownDatasetPreviewThroughExecutor(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: []byte(`{"columns":["stage"],"rows":[{"stage":"qualified"}]}`)}}
	response := httptest.NewRecorder()
	NewAnalyticsSessionHandler(resolver, executor, nil).ServeHTTP(response, analyticsRequest(http.MethodGet, "/api/analytics?dataset=analytics.pipelineByStage"))

	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "analytics.pipelineByStage" || string(executor.input) != `{}` {
		t.Fatalf("status=%d executor=%+v body=%s", response.Code, executor, response.Body.String())
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.CapabilityID != executor.capID {
		t.Fatalf("preview claims were not derived from the resolved session: %+v", executor.claims)
	}
	if strings.TrimSpace(response.Body.String()) != `{"columns":["stage"],"rows":[{"stage":"qualified"}]}` {
		t.Fatalf("preview response changed: %s", response.Body.String())
	}
}

func TestAnalyticsSessionHandlerSupportsBearerWithOrganizationHeader(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	request := httptest.NewRequest(http.MethodGet, "/api/analytics?dataset=analytics.invoiceAging", nil)
	request.Header.Set("Authorization", "Bearer opaque-session-token")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: []byte(`{"columns":[],"rows":[]}`)}}
	response := httptest.NewRecorder()
	NewAnalyticsSessionHandler(resolver, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "opaque-session-token" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("status=%d resolver=%+v body=%s", response.Code, resolver, response.Body.String())
	}
}

func TestAnalyticsSessionHandlerGeneratesReportThroughDatasetAndRenderCapabilities(t *testing.T) {
	identity := directTestIdentity()
	executor := &analyticsReportExecutor{results: map[string]capability.Result{
		"analytics.pipelineByStage":                  {OK: true, Data: json.RawMessage(`{"columns":["stage","count"],"rows":[{"stage":"qualified","count":2}]}`)},
		capability.AnalyticsRenderReportCapabilityID: {OK: true, Data: json.RawMessage(`{"region":"east-africa","html":"<html>report</html>","sections":[{"heading":"Pipeline","svg":null,"columns":["stage","count"],"rows":[{"stage":"qualified","count":2}]}]}`)},
	}}
	request := makeAnalyticsReportRequest(`{"title":"Quarterly pipeline","narrative":"Current view","sections":[{"heading":"Pipeline","datasetId":"analytics.pipelineByStage","params":{},"ops":[],"chart":{"type":"bar","x":"stage","y":["count"]}}]}`)
	response := httptest.NewRecorder()
	NewAnalyticsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || len(executor.calls) != 2 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, len(executor.calls), response.Body.String())
	}
	for i, call := range executor.calls {
		if call.claims.Subject != identity.UserID || call.claims.OrganizationID != *identity.OrgID || call.claims.AuthSessionID != identity.AuthSessionID || call.claims.CapabilityID != call.id {
			t.Fatalf("call %d was not scoped to resolved session: %+v", i, call)
		}
	}
	if executor.calls[0].id != "analytics.pipelineByStage" || string(executor.calls[0].input) != `{}` {
		t.Fatalf("dataset call=%+v", executor.calls[0])
	}
	if executor.calls[1].id != capability.AnalyticsRenderReportCapabilityID || !strings.Contains(string(executor.calls[1].input), `"title":"Quarterly pipeline"`) || !strings.Contains(string(executor.calls[1].input), `"ops":[]`) || !strings.Contains(string(executor.calls[1].input), `"chart"`) {
		t.Fatalf("renderer call=%+v", executor.calls[1])
	}
	if response.Body.String() != string(executor.results[capability.AnalyticsRenderReportCapabilityID].Data) {
		t.Fatalf("response contract changed: %s", response.Body.String())
	}
}

func TestAnalyticsSessionHandlerRejectsInvalidReportsBeforeDatasetExecution(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "unknown dataset", body: `{"title":"Report","sections":[{"heading":"Bad","datasetId":"analytics.unknown"}]}`},
		{name: "invalid chart", body: `{"title":"Report","sections":[{"heading":"Pipeline","datasetId":"analytics.pipelineByStage","chart":{"type":"unknown","x":"stage","y":["count"]}}]}`},
		{name: "invalid dataset params", body: `{"title":"Report","sections":[{"heading":"Revenue","datasetId":"analytics.revenueByMonth","params":{"monthsBack":999}}]}`},
		{name: "null narrative", body: `{"title":"Report","narrative":null,"sections":[{"heading":"Pipeline","datasetId":"analytics.pipelineByStage"}]}`},
		{name: "null operations", body: `{"title":"Report","sections":[{"heading":"Pipeline","datasetId":"analytics.pipelineByStage","ops":null}]}`},
		{name: "null chart", body: `{"title":"Report","sections":[{"heading":"Pipeline","datasetId":"analytics.pipelineByStage","chart":null}]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &analyticsReportExecutor{results: map[string]capability.Result{}}
			response := httptest.NewRecorder()
			NewAnalyticsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, makeAnalyticsReportRequest(test.body))
			if response.Code != http.StatusBadRequest || len(executor.calls) != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, len(executor.calls), response.Body.String())
			}
		})
	}
}

func TestAnalyticsSessionHandlerStopsReportWhenDatasetCapabilityDeniesAccess(t *testing.T) {
	executor := &analyticsReportExecutor{results: map[string]capability.Result{
		"analytics.pipelineByStage": {OK: false, Error: "forbidden: missing crm.read"},
	}}
	response := httptest.NewRecorder()
	NewAnalyticsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response,
		makeAnalyticsReportRequest(`{"title":"Report","sections":[{"heading":"Pipeline","datasetId":"analytics.pipelineByStage"}]}`))
	if response.Code != http.StatusForbidden || len(executor.calls) != 1 || !strings.Contains(response.Body.String(), "missing crm.read") {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, len(executor.calls), response.Body.String())
	}
}

func TestAnalyticsSessionHandlerRejectsUnknownDatasetAndOrganizationMismatch(t *testing.T) {
	t.Run("unknown dataset", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewAnalyticsSessionHandler(resolver, executor, nil).ServeHTTP(response, analyticsRequest(http.MethodGet, "/api/analytics?dataset=analytics.unknown"))
		if response.Code != http.StatusNotFound || executor.calls != 0 || !strings.Contains(response.Body.String(), `"error":"unknown dataset"`) {
			t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("unmatched organization header", func(t *testing.T) {
		identity := directTestIdentity()
		resolver := &fakeDirectSessionResolver{resolved: identity}
		executor := &fakeDirectCapabilityExecutor{}
		request := httptest.NewRequest(http.MethodGet, "/api/analytics", nil)
		request.Header.Set("Authorization", "Bearer opaque-session-token")
		request.Header.Set("X-Organization-ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
		response := httptest.NewRecorder()
		NewAnalyticsSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestAnalyticsSessionHandlerRejectsUnverifiedSessionAndMethods(t *testing.T) {
	t.Run("unverified session", func(t *testing.T) {
		identity := directTestIdentity()
		identity.EmailVerified = false
		resolver := &fakeDirectSessionResolver{resolved: identity}
		response := httptest.NewRecorder()
		NewAnalyticsSessionHandler(resolver, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, analyticsRequest(http.MethodGet, "/api/analytics"))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s, want unauthorized", response.Code, response.Body.String())
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewAnalyticsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, analyticsRequest(http.MethodDelete, "/api/analytics"))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d Allow=%q Cache-Control=%q body=%s", response.Code, response.Header().Get("Allow"), response.Header().Get("Cache-Control"), response.Body.String())
		}
	})
}
