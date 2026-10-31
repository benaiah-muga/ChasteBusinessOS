package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func TestSessionCapabilityHandlerRequiresResolvedMessagingIdentity(t *testing.T) {
	const body = `{"capabilityId":"messaging.listConversations","input":{"limit":100},"intentId":"messaging-auth-proof-1"}`

	t.Run("missing session", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{err: session.ErrNoSession}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d executor calls=%d body=%s, want unauthorized without dispatch", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("caller cannot select a foreign organization", func(t *testing.T) {
		identity := directTestIdentity()
		identity.Permissions["messaging.read"] = true
		resolver := &fakeDirectSessionResolver{resolved: identity}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"conversations":[],"me":"22222222-2222-4222-8222-222222222222"}`)}}
		request := directCapabilityRequest(http.MethodPost, body)
		request.Header.Set("X-Organization-ID", "44444444-4444-4444-8444-444444444444")
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d executor calls=%d body=%s, want unauthorized without dispatch", response.Code, executor.calls, response.Body.String())
		}
	})
}
