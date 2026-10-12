package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDocumentsEditorWorkspaceBodyValidationAndIgnoredIntent(t *testing.T) {
	for _, test := range []struct {
		name  string
		body  string
		valid bool
	}{
		{name: "heartbeat", body: `{}`, valid: true},
		{name: "content with page settings and client intent", body: `{"content":{"type":"doc"},"pageSettings":{"size":"Letter","orientation":"landscape","margin":"wide"},"rev":1,"intentId":"ignored-client-id"}`, valid: true},
		{name: "null content", body: `{"content":null}`, valid: false},
		{name: "invalid page settings", body: `{"pageSettings":{"size":"A3","orientation":"portrait","margin":"normal"}}`, valid: false},
		{name: "zero revision", body: `{"rev":0}`, valid: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var body documentsEditorWorkspaceBody
			if err := json.Unmarshal([]byte(test.body), &body); err != nil {
				t.Fatal(err)
			}
			if got := validDocumentsEditorWorkspaceBody(body); got != test.valid {
				t.Fatalf("valid=%v want=%v", got, test.valid)
			}
		})
	}
	var body documentsEditorWorkspaceBody
	if err := json.Unmarshal([]byte(`{"intentId":"not-used"}`), &body); err != nil || len(body.IntentID) == 0 {
		t.Fatalf("client intent should be accepted and ignored, body=%+v err=%v", body, err)
	}
}

func TestDocumentsEditorWorkspaceHandlerRequiresAuthenticatedSameOriginSession(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	handler := &documentsEditorWorkspaceHandler{pool: &pgxpool.Pool{}, resolver: resolver, logger: routinesTestLogger()}
	resolver.resolved = nil
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/docs/44444444-4444-4444-8444-444444444444/workspace", `{}`))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", response.Code, response.Body.String())
	}

	resolver.resolved = directTestIdentity()
	request := routinesSessionRequest(http.MethodDelete, "/api/docs/44444444-4444-4444-8444-444444444444/workspace", "")
	request.Header.Set("Origin", "https://evil.example.test")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin delete status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoDocumentsEditorWorkspaceRouteMatchesOnlyWorkspaceMethods(t *testing.T) {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "fallback") })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "go") })
	handler := MountGoDocumentsEditorWorkspaceRoute(fallback, goRoute)
	for _, test := range []struct{ method, path, owner string }{
		{http.MethodPost, "/api/docs/44444444-4444-4444-8444-444444444444/workspace", "go"},
		{http.MethodDelete, "/api/docs/44444444-4444-4444-8444-444444444444/workspace", "go"},
		{http.MethodGet, "/api/docs/44444444-4444-4444-8444-444444444444/workspace", "fallback"},
		{http.MethodPost, "/api/docs/44444444-4444-4444-8444-444444444444/versions", "fallback"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, strings.NewReader("{}")))
		if got := response.Header().Get("X-Route-Owner"); got != test.owner {
			t.Errorf("%s %s owner=%q want=%q", test.method, test.path, got, test.owner)
		}
	}
}
