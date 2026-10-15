package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDecodeMessagingPresenceBody(t *testing.T) {
	for _, test := range []struct {
		name  string
		body  string
		valid bool
	}{
		{name: "typing with intent", body: `{"typing":true,"intentId":"client-intent"}`, valid: true},
		{name: "not typing", body: `{"typing":false,"intentId":"client-intent"}`, valid: true},
		{name: "missing typing", body: `{}`, valid: false},
		{name: "wrong typing type", body: `{"typing":"true"}`, valid: false},
		{name: "unknown property", body: `{"typing":true,"extra":1}`, valid: false},
		{name: "trailing value", body: `{"typing":true}{}`, valid: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", strings.NewReader(test.body))
			var parsed messagingPresenceBody
			err := decodeMessagingPresenceBody(httptest.NewRecorder(), request, &parsed)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%t err=%v", test.valid, err)
			}
		})
	}
}

func TestMessagingPresenceHandlerRequiresVerifiedSessionAndSameOriginWrites(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	resolver.resolved.Permissions["messaging.write"] = true
	handler := &messagingPresenceHandler{pool: &pgxpool.Pool{}, resolver: resolver, logger: routinesTestLogger()}

	resolver.resolved = nil
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", response.Code, response.Body.String())
	}

	resolver.resolved = directTestIdentity()
	resolver.resolved.Permissions["messaging.write"] = true
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", ""))
	if response.Code != http.StatusForbidden {
		t.Fatalf("read without permission status=%d body=%s", response.Code, response.Body.String())
	}

	resolver.resolved = directTestIdentity()
	resolver.resolved.Permissions["messaging.read"] = true
	resolver.resolved.Permissions["messaging.write"] = true
	request := routinesSessionRequest(http.MethodPost, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", `{"typing":true,"intentId":"test-intent"}`)
	request.Header.Set("Origin", "https://evil.example.test")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin post status=%d body=%s", response.Code, response.Body.String())
	}

	resolver.resolved.Permissions["messaging.read"] = false
	resolver.resolved.Permissions["messaging.write"] = false
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", `{"typing":true,"intentId":"test-intent"}`))
	if response.Code != http.StatusForbidden {
		t.Fatalf("write without permission status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMessagingPresenceReadRequiresEnabledModuleBeforeDatabaseAccess(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["messaging.read"] = true
	identity.ModulesRestricted = true
	identity.EnabledModules = []string{"crm"}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	handler := NewMessagingPresenceHandler(&pgxpool.Pool{}, resolver, nil, routinesTestLogger())
	request := routinesSessionRequest(http.MethodGet, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", "")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMessagingPresencePostDispatchesGovernedCapabilityWithCallerIntent(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["messaging.write"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"previousLastSeenAt":null,"previousTypingUntil":null}`)}}
	handler := NewMessagingPresenceHandler(&pgxpool.Pool{}, resolver, executor, routinesTestLogger())
	request := routinesSessionRequest(http.MethodPost, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", `{"typing":true,"intentId":"presence-attempt-7"}`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.capID != messagingPresenceCapabilityID || executor.claims.IntentID != "presence-attempt-7" {
		t.Fatalf("capability=%q intent=%q", executor.capID, executor.claims.IntentID)
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.ActorID == nil || *executor.claims.ActorID != identity.UserID {
		t.Fatalf("claims=%+v", executor.claims)
	}
	var input map[string]any
	if err := json.Unmarshal(executor.input, &input); err != nil {
		t.Fatal(err)
	}
	if input["conversationId"] != "44444444-4444-4444-8444-444444444444" || input["typing"] != true {
		t.Fatalf("input=%s", executor.input)
	}
}

func TestMountGoMessagingPresenceRouteMatchesExactMethodsAndUUIDPaths(t *testing.T) {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "fallback") })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "go") })
	handler := MountGoMessagingPresenceRoute(fallback, goRoute)
	for _, test := range []struct{ method, path, owner string }{
		{http.MethodGet, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", "go"},
		{http.MethodPost, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", "go"},
		{http.MethodDelete, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", "fallback"},
		{http.MethodPut, "/api/conversations/44444444-4444-4444-8444-444444444444/presence", "fallback"},
		{http.MethodGet, "/api/conversations/not-a-uuid/presence", "go"},
		{http.MethodGet, "/api/conversations/44444444-4444-4444-8444-444444444444/messages", "fallback"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if got := response.Header().Get("X-Route-Owner"); got != test.owner {
			t.Errorf("%s %s owner=%q want=%q", test.method, test.path, got, test.owner)
		}
	}
}

func TestMessagingPresenceResponseUsesExpectedJSONShape(t *testing.T) {
	encoded, err := json.Marshal(messagingPresenceResponse{People: []messagingPresencePerson{{UserID: "u1", Name: "Ari", Typing: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"people":[{"userId":"u1","name":"Ari","typing":true}]}` {
		t.Fatalf("unexpected response: %s", encoded)
	}
}
