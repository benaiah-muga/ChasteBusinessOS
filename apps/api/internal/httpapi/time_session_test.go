package httpapi

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func timeSessionRequest(method, target, body string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Origin", "https://app.example.test")
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *directTestIdentity().OrgID})
	return request
}

func TestTimeSessionHandlerReturnsLegacyReportAndPendingShapesThroughCapabilities(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"rows":[]}`)}}
	handler := NewTimeSessionHandler(resolver, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, timeSessionRequest(http.MethodGet, "/api/time?from=2026-10-01T23%3A00%3A00-02%3A00&to=2026-10-31&employeeId=22222222-2222-4222-8222-222222222222", ""))

	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"rows":[]}` {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.calls != 1 || executor.capID != "hr.timeReport" {
		t.Fatalf("calls=%d capability=%q", executor.calls, executor.capID)
	}
	var reportInput map[string]string
	if json.Unmarshal(executor.input, &reportInput) != nil || reportInput["from"] != "2026-10-02" || reportInput["to"] != "2026-10-31" || reportInput["employeeId"] != identity.UserID {
		t.Fatalf("time report input=%s", executor.input)
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID ||
		executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.CapabilityID != "hr.timeReport" ||
		executor.claims.Audience != "go.capability.execute" {
		t.Fatalf("claims did not come from resolved session: %+v", executor.claims)
	}

	executor = &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"entries":[]}`)}}
	response = httptest.NewRecorder()
	NewTimeSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodGet, "/api/time?pending=1", ""))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"entries":[]}` || executor.capID != "hr.pendingTimeEntries" || string(executor.input) != `{}` {
		t.Fatalf("pending status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
	}
}

func TestTimeSessionHandlerDelegatesWritesToGovernedCapabilities(t *testing.T) {
	identity := directTestIdentity()
	t.Run("log", func(t *testing.T) {
		entryID := "44444444-4444-4444-8444-444444444444"
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"entryId":"` + entryID + `","status":"submitted"}`)}}
		request := timeSessionRequest(http.MethodPost, "/api/time", `{"action":"log","employeeId":"22222222-2222-4222-8222-222222222222","workDate":"2026-10-15T23:30:00-02:00","minutes":60,"note":"Site visit","intentId":"55555555-5555-4555-8555-555555555555","ignored":"legacy extra"}`)
		response := httptest.NewRecorder()
		NewTimeSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"data":{"entryId":"`+entryID+`","status":"submitted"},"ok":true}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var input map[string]any
		if executor.capID != "hr.logTime" || json.Unmarshal(executor.input, &input) != nil || input["workDate"] != "2026-10-16" || input["note"] != "Site visit" {
			t.Fatalf("capability=%q input=%s", executor.capID, executor.input)
		}
		if executor.claims.IntentID != "55555555-5555-4555-8555-555555555555" || executor.claims.InputSHA256 == "" {
			t.Fatalf("write claims did not preserve retry identity and input hash: %+v", executor.claims)
		}
	})

	t.Run("decide", func(t *testing.T) {
		entryID := "44444444-4444-4444-8444-444444444444"
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"entryId":"` + entryID + `","status":"approved"}`)}}
		response := httptest.NewRecorder()
		NewTimeSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodPost, "/api/time", `{"action":"decide","intentId":"decide-time-1","entryId":"`+entryID+`","decision":"approved"}`))
		if response.Code != http.StatusOK || executor.capID != "hr.decideTimeEntry" || strings.TrimSpace(string(executor.input)) != `{"decision":"approved","entryId":"`+entryID+`"}` {
			t.Fatalf("status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
		}
		if executor.claims.IntentID != "decide-time-1" {
			t.Fatalf("decision intent was not preserved: %+v", executor.claims)
		}
	})
}

func TestTimeSessionHandlerRejectsInvalidRequestsBeforeExecution(t *testing.T) {
	tests := []struct {
		name   string
		method string
		target string
		body   string
		status int
		mutate func(*http.Request)
	}{
		{name: "missing report dates", method: http.MethodGet, target: "/api/time", status: http.StatusBadRequest},
		{name: "invalid report dates", method: http.MethodGet, target: "/api/time?from=nope&to=2026-10-31", status: http.StatusBadRequest},
		{name: "invalid calendar date", method: http.MethodGet, target: "/api/time?from=2026-02-30&to=2026-03-31", status: http.StatusBadRequest},
		{name: "invalid employee id", method: http.MethodGet, target: "/api/time?from=2026-10-01&to=2026-10-31&employeeId=bad", status: http.StatusUnprocessableEntity},
		{name: "invalid action", method: http.MethodPost, target: "/api/time", body: `{"action":"delete"}`, status: http.StatusBadRequest},
		{name: "write requires intent", method: http.MethodPost, target: "/api/time", body: `{"action":"decide","entryId":"44444444-4444-4444-8444-444444444444","decision":"approved"}`, status: http.StatusBadRequest},
		{name: "cross origin cookie write", method: http.MethodPost, target: "/api/time", body: `{"action":"decide","entryId":"44444444-4444-4444-8444-444444444444","decision":"approved"}`, status: http.StatusForbidden, mutate: func(request *http.Request) { request.Header.Set("Origin", "https://attacker.example") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"rows":[]}`)}}
			request := timeSessionRequest(test.method, test.target, test.body)
			if test.mutate != nil {
				test.mutate(request)
			}
			response := httptest.NewRecorder()
			NewTimeSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
			if executor.calls != 0 {
				t.Fatalf("invalid request reached capability executor: %+v", executor)
			}
		})
	}

	identity := directTestIdentity()
	identity.EmailVerified = false
	response := httptest.NewRecorder()
	NewTimeSessionHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, timeSessionRequest(http.MethodGet, "/api/time?pending=1", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unverified session status=%d body=%s", response.Code, response.Body.String())
	}

	identity = directTestIdentity()
	identity.ModulesRestricted = true
	identity.EnabledModules = []string{"accounting"}
	executor := &fakeDirectCapabilityExecutor{}
	response = httptest.NewRecorder()
	NewTimeSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodGet, "/api/time?pending=1", ""))
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("disabled module status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
}
