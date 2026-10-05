package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func makeNotificationReadRequest(body string) *http.Request {
	request := directCapabilityRequest(http.MethodPost, body)
	request.URL.Path = "/api/notifications"
	return request
}

func TestNotificationReadHandlerUsesVerifiedSessionAndGovernedExecutor(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"id":"44444444-4444-4444-8444-444444444444","receiptCreated":true,"found":true}`)}}
	response := httptest.NewRecorder()
	NewNotificationReadHandler(resolver, executor, nil).ServeHTTP(response, makeNotificationReadRequest(`{"id":"44444444-4444-4444-8444-444444444444"}`))
	if response.Code != http.StatusOK || response.Body.String() != "{\"ok\":true}\n" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.calls != 1 || executor.capID != "notifications.markRead" || string(executor.input) != `{"id":"44444444-4444-4444-8444-444444444444"}` {
		t.Fatalf("executor calls=%d capability=%q input=%s", executor.calls, executor.capID, executor.input)
	}
	if executor.claims.Subject != directTestIdentity().UserID || executor.claims.OrganizationID != *directTestIdentity().OrgID || executor.claims.AuthSessionID != directTestIdentity().AuthSessionID {
		t.Fatalf("claims were not derived from resolved session: %+v", executor.claims)
	}
}

func TestNotificationReadHandlerRejectsUnsupportedRequests(t *testing.T) {
	cases := []struct {
		name   string
		method string
		body   string
		status int
	}{
		{name: "wrong method", method: http.MethodGet, body: `{}`, status: http.StatusMethodNotAllowed},
		{name: "invalid id", method: http.MethodPost, body: `{"id":"x"}`, status: http.StatusBadRequest},
		{name: "unknown field", method: http.MethodPost, body: `{"id":"44444444-4444-4444-8444-444444444444","unexpected":true}`, status: http.StatusBadRequest},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"found":true}`)}}
			response := httptest.NewRecorder()
			NewNotificationReadHandler(resolver, executor, nil).ServeHTTP(response, notificationReadRequestFor(test.method, test.body))
			if response.Code != test.status || executor.calls != 0 {
				t.Fatalf("status=%d executor calls=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestNotificationReadHandlerRequiresVerifiedActiveOrganization(t *testing.T) {
	for _, test := range []struct {
		name     string
		resolved func() *session.ResolvedUser
	}{
		{name: "unverified email", resolved: func() *session.ResolvedUser {
			identity := directTestIdentity()
			identity.EmailVerified = false
			return identity
		}},
		{name: "no active organization", resolved: func() *session.ResolvedUser {
			identity := directTestIdentity()
			identity.OrgID = nil
			return identity
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.resolved()}
			executor := &fakeDirectCapabilityExecutor{}
			response := httptest.NewRecorder()
			NewNotificationReadHandler(resolver, executor, nil).ServeHTTP(response, makeNotificationReadRequest(`{"id":"44444444-4444-4444-8444-444444444444"}`))
			if response.Code != http.StatusUnauthorized || executor.calls != 0 || response.Header().Get("WWW-Authenticate") == "" {
				t.Fatalf("status=%d executor calls=%d headers=%v body=%s", response.Code, executor.calls, response.Header(), response.Body.String())
			}
		})
	}
}

func notificationReadRequestFor(method, body string) *http.Request {
	request := makeNotificationReadRequest(body)
	request.Method = method
	return request
}
