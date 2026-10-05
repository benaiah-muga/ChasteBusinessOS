package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeDashboardReader struct {
	orgID     string
	now       time.Time
	access    dashboard.ReportReadAccess
	payload   dashboard.Payload
	err       error
	callCount int
}

func (f *fakeDashboardReader) ForOrg(_ context.Context, orgID string, now time.Time, access dashboard.ReportReadAccess) (dashboard.Payload, error) {
	f.callCount++
	f.orgID, f.now, f.access = orgID, now, access
	return f.payload, f.err
}

type fakeDashboardExecutor struct {
	results map[string]capability.Result
	errors  map[string]error
	calls   []string
	claims  []authbridge.CapabilityClaims
}

func (f *fakeDashboardExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	f.calls = append(f.calls, capabilityID)
	f.claims = append(f.claims, claims)
	if string(input) != `{}` {
		return capability.Result{}, errors.New("unexpected dashboard capability input")
	}
	return f.results[capabilityID], f.errors[capabilityID]
}

func dashboardRequest(method string) *http.Request {
	request := httptest.NewRequest(method, "/api/dashboard", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "dashboard-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func dashboardExecutorWithSuccess() *fakeDashboardExecutor {
	return &fakeDashboardExecutor{results: map[string]capability.Result{
		"accounting.incomeStatement": {OK: true, Data: json.RawMessage(`{"revenueMinor":1200}`)},
		"accounting.balanceSheet":    {OK: true, Data: json.RawMessage(`{"balanced":true}`)},
		"accounting.trialBalance":    {OK: true, Data: json.RawMessage(`{"lines":[]}`)},
		"signals.list":               {OK: true, Data: json.RawMessage(`{"signals":[{"id":"cash.low","severity":"orange","module":"accounting","subject":"Cash","detail":"Low cash"}]}`)},
	}}
}

func TestDashboardSessionHandlerReadsCookieSessionAndTenantScopedPayload(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	cashMinor := int64(300)
	reader := &fakeDashboardReader{payload: dashboard.Payload{
		Money:          dashboard.Money{RevenueMinor: 1200, CashMinor: &cashMinor},
		WorkingCapital: dashboard.WorkingCapital{AROutstandingMinor: 80},
		Pipeline:       dashboard.Pipeline{Stages: []dashboard.PipelineStage{}},
		Ops:            dashboard.Operations{LowStock: []dashboard.LowStockItem{}},
		Trend:          []dashboard.TrendMonth{},
		Activity:       []dashboard.Activity{},
	}}
	executor := dashboardExecutorWithSuccess()
	now := time.Date(2026, 10, 4, 12, 30, 0, 0, time.UTC)
	handler := NewDashboardSessionHandler(resolver, reader, executor, nil).(*DashboardSessionHandler)
	handler.now = func() time.Time { return now }
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, dashboardRequest(http.MethodGet))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "dashboard-cookie" || resolver.activeOrg != *identity.OrgID || resolver.bearerCalls != 0 {
		t.Fatalf("cookie session resolution mismatch: %+v", resolver)
	}
	if reader.callCount != 1 || reader.orgID != *identity.OrgID || !reader.now.Equal(now) {
		t.Fatalf("reader did not receive the resolved tenant and injected time: %+v", reader)
	}
	if reader.access != (dashboard.ReportReadAccess{IncomeStatement: true, BalanceSheet: true, TrialBalance: true}) {
		t.Fatalf("report access=%+v", reader.access)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"money", "workingCapital", "pipeline", "ops", "trend", "activity", "signals"} {
		if _, ok := body[key]; !ok {
			t.Errorf("response omitted %q: %s", key, response.Body.String())
		}
	}
	if string(body["signals"]) != `[{"id":"cash.low","severity":"orange","module":"accounting","subject":"Cash","detail":"Low cash"}]` {
		t.Fatalf("signals response mismatch: %s", body["signals"])
	}
	if !reflect.DeepEqual(executor.calls, []string{"accounting.incomeStatement", "accounting.balanceSheet", "accounting.trialBalance", "signals.list"}) {
		t.Fatalf("capability calls=%v", executor.calls)
	}
	for _, claims := range executor.claims {
		if claims.Subject != identity.UserID || claims.OrganizationID != *identity.OrgID || claims.AuthSessionID != identity.AuthSessionID || claims.ActorType != "human" || claims.Audience != authbridge.CapabilityExecuteAudience {
			t.Errorf("capability claims were not derived from the verified session: %+v", claims)
		}
	}
}

func TestDashboardSessionHandlerSupportsBearerAndSelectedOrganization(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &fakeDashboardReader{}
	executor := dashboardExecutorWithSuccess()
	request := httptest.NewRequest(http.MethodGet, "/api/dashboard", nil)
	request.Header.Set("Authorization", "Bearer native-session-token")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	NewDashboardSessionHandler(resolver, reader, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "native-session-token" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("status=%d resolver=%+v body=%s", response.Code, resolver, response.Body.String())
	}
	if reader.orgID != *identity.OrgID {
		t.Fatalf("reader used org %q, expected selected org %q", reader.orgID, *identity.OrgID)
	}
}

func TestDashboardSessionHandlerAppliesReportPermissionFallbacks(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &fakeDashboardReader{}
	executor := dashboardExecutorWithSuccess()
	executor.results["accounting.balanceSheet"] = capability.Result{OK: false, Error: "forbidden"}
	executor.errors = map[string]error{}
	executor.errors["accounting.trialBalance"] = errors.New("report service unavailable")
	response := httptest.NewRecorder()
	NewDashboardSessionHandler(resolver, reader, executor, nil).ServeHTTP(response, dashboardRequest(http.MethodGet))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	want := dashboard.ReportReadAccess{IncomeStatement: true}
	if reader.access != want {
		t.Fatalf("report access=%+v, want %+v", reader.access, want)
	}
	if !strings.Contains(response.Body.String(), `"signals":[`) {
		t.Fatalf("dashboard response missing signals array: %s", response.Body.String())
	}
}

func TestDashboardSessionHandlerRejectsUnverifiedAndMismatchedOrganization(t *testing.T) {
	t.Run("unverified email", func(t *testing.T) {
		identity := directTestIdentity()
		identity.EmailVerified = false
		resolver := &fakeDirectSessionResolver{resolved: identity}
		reader := &fakeDashboardReader{}
		executor := dashboardExecutorWithSuccess()
		response := httptest.NewRecorder()
		NewDashboardSessionHandler(resolver, reader, executor, nil).ServeHTTP(response, dashboardRequest(http.MethodGet))
		if response.Code != http.StatusUnauthorized || reader.callCount != 0 || len(executor.calls) != 0 {
			t.Fatalf("status=%d reader calls=%d executor calls=%d body=%s", response.Code, reader.callCount, len(executor.calls), response.Body.String())
		}
	})

	t.Run("selected organization differs from resolved membership", func(t *testing.T) {
		identity := directTestIdentity()
		resolver := &fakeDirectSessionResolver{resolved: identity}
		reader := &fakeDashboardReader{}
		executor := dashboardExecutorWithSuccess()
		request := httptest.NewRequest(http.MethodGet, "/api/dashboard", nil)
		request.Header.Set("Authorization", "Bearer native-session-token")
		request.Header.Set("X-Organization-ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
		response := httptest.NewRecorder()
		NewDashboardSessionHandler(resolver, reader, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || reader.callCount != 0 || len(executor.calls) != 0 {
			t.Fatalf("status=%d reader calls=%d executor calls=%d body=%s", response.Code, reader.callCount, len(executor.calls), response.Body.String())
		}
	})
}

func TestDashboardSessionHandlerReturnsLegacyAuthAndMethodStatuses(t *testing.T) {
	t.Run("invalid organization selector", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		reader := &fakeDashboardReader{}
		executor := dashboardExecutorWithSuccess()
		request := httptest.NewRequest(http.MethodGet, "/api/dashboard", nil)
		request.Header.Set("X-Organization-ID", "not-a-uuid")
		response := httptest.NewRecorder()
		NewDashboardSessionHandler(resolver, reader, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || reader.callCount != 0 || len(executor.calls) != 0 || resolver.resolveCalls != 0 || resolver.bearerCalls != 0 {
			t.Fatalf("status=%d resolver=%+v reader calls=%d executor calls=%d body=%s", response.Code, resolver, reader.callCount, len(executor.calls), response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid selector response is cacheable: %v", response.Header())
		}
	})

	t.Run("duplicate organization selectors", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		reader := &fakeDashboardReader{}
		executor := dashboardExecutorWithSuccess()
		request := httptest.NewRequest(http.MethodGet, "/api/dashboard", nil)
		request.Header.Add("X-Organization-ID", "11111111-1111-4111-8111-111111111111")
		request.Header.Add("X-Organization-ID", "11111111-1111-4111-8111-111111111111")
		response := httptest.NewRecorder()
		NewDashboardSessionHandler(resolver, reader, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || reader.callCount != 0 || len(executor.calls) != 0 || resolver.resolveCalls != 0 || resolver.bearerCalls != 0 {
			t.Fatalf("status=%d resolver=%+v reader calls=%d executor calls=%d body=%s", response.Code, resolver, reader.callCount, len(executor.calls), response.Body.String())
		}
	})

	t.Run("unauthenticated", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{err: session.ErrNoSession}
		response := httptest.NewRecorder()
		NewDashboardSessionHandler(resolver, &fakeDashboardReader{}, dashboardExecutorWithSuccess(), nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/dashboard", nil))
		if response.Code != http.StatusUnauthorized || response.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewDashboardSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDashboardReader{}, dashboardExecutorWithSuccess(), nil).ServeHTTP(response, dashboardRequest(http.MethodPost))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d Allow=%q Cache-Control=%q body=%s", response.Code, response.Header().Get("Allow"), response.Header().Get("Cache-Control"), response.Body.String())
		}
	})
}

func TestDashboardSessionHandlerFailsClosedOnReaderError(t *testing.T) {
	reader := &fakeDashboardReader{err: errors.New("tenant read failed")}
	response := httptest.NewRecorder()
	NewDashboardSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, dashboardExecutorWithSuccess(), nil).ServeHTTP(response, dashboardRequest(http.MethodGet))
	if response.Code != http.StatusInternalServerError || !reflect.DeepEqual(reader.access, dashboard.ReportReadAccess{IncomeStatement: true, BalanceSheet: true, TrialBalance: true}) {
		t.Fatalf("status=%d access=%+v body=%s", response.Code, reader.access, response.Body.String())
	}
}
