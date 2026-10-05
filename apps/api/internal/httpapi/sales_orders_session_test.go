package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func salesOrdersRequest(path string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *directTestIdentity().OrgID})
	return request
}

func TestSalesOrdersSessionHandlerReturnsLegacyOrdersShapeThroughCapability(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"orders":[]}`)}}
	response := httptest.NewRecorder()
	NewSalesOrdersSessionHandler(resolver, executor, nil).ServeHTTP(response, salesOrdersRequest("/api/sales?status=draft&source=page"))

	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"orders":[]}` {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.calls != 1 || executor.capID != salesListOrdersCapabilityID || string(executor.input) != `{"status":"draft"}` {
		t.Fatalf("calls=%d capability=%q input=%s", executor.calls, executor.capID, executor.input)
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID ||
		executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.CapabilityID != salesListOrdersCapabilityID {
		t.Fatalf("capability claims did not come from the resolved session: %+v", executor.claims)
	}
}

func TestSalesOrdersSessionHandlerPreservesLegacyStatusSelection(t *testing.T) {
	for _, test := range []struct {
		name string
		path string
		want string
	}{
		{name: "missing status", path: "/api/sales", want: `{}`},
		{name: "unsupported status ignored", path: "/api/sales?status=unknown", want: `{}`},
		{name: "first repeated status", path: "/api/sales?status=cancelled&status=draft", want: `{"status":"cancelled"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"orders":[]}`)}}
			response := httptest.NewRecorder()
			NewSalesOrdersSessionHandler(resolver, executor, nil).ServeHTTP(response, salesOrdersRequest(test.path))
			if response.Code != http.StatusOK || string(executor.input) != test.want {
				t.Fatalf("status=%d input=%s body=%s, want input %s", response.Code, executor.input, response.Body.String(), test.want)
			}
		})
	}
}

func TestSalesOrdersSessionHandlerEnforcesVerifiedOrgSessionAndMapsCapabilityErrors(t *testing.T) {
	tests := []struct {
		name     string
		identity *session.ResolvedUser
		selector string
		result   capability.Result
		want     int
	}{
		{name: "unverified session", identity: func() *session.ResolvedUser { u := directTestIdentity(); u.EmailVerified = false; return u }(), want: http.StatusUnauthorized},
		{name: "mismatched org", identity: directTestIdentity(), selector: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", want: http.StatusForbidden},
		{name: "missing read grant reported by capability kernel", identity: directTestIdentity(), result: capability.Result{OK: false, Error: "forbidden: missing permission: sales.read"}, want: http.StatusUnprocessableEntity},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.identity}
			executor := &fakeDirectCapabilityExecutor{result: test.result}
			request := salesOrdersRequest("/api/sales")
			if test.selector != "" {
				request.Header.Set("X-Organization-ID", test.selector)
			}
			response := httptest.NewRecorder()
			NewSalesOrdersSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
			if test.want != http.StatusOK && test.identity != nil && test.selector != "" && executor.calls != 0 {
				t.Fatalf("mismatched org reached capability executor: %+v", executor)
			}
		})
	}
}

func TestSalesOrdersSessionHandlerSupportsBearerClientsAndRejectsInvalidOutput(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"orders":[]}`)}}
	request := salesOrdersRequest("/api/sales")
	request.Header.Set("Authorization", "Bearer native-session-token")
	response := httptest.NewRecorder()
	NewSalesOrdersSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.resolveCalls != 0 || resolver.bearer != "native-session-token" {
		t.Fatalf("status=%d bearerCalls=%d cookieCalls=%d token=%q body=%s", response.Code, resolver.bearerCalls, resolver.resolveCalls, resolver.bearer, response.Body.String())
	}

	badExecutor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"orders":null}`)}}
	response = httptest.NewRecorder()
	NewSalesOrdersSessionHandler(&fakeDirectSessionResolver{resolved: identity}, badExecutor, nil).ServeHTTP(response, salesOrdersRequest("/api/sales"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("invalid capability output status=%d body=%s", response.Code, response.Body.String())
	}
}
