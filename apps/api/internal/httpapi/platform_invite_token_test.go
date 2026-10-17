package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMountGoInviteTokenRouteAliasesLegacyPath(t *testing.T) {
	seenToken := ""
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenToken = r.PathValue("token")
		w.WriteHeader(http.StatusNoContent)
	})
	mux := MountGoInviteTokenRoute(http.NotFoundHandler(), inner)

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/invite/invite-token-1", nil))
	if response.Code != http.StatusNoContent || seenToken != "invite-token-1" {
		t.Fatalf("GET alias status=%d token=%q, want 204 invite-token-1", response.Code, seenToken)
	}

	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/invite/invite-token-2", nil))
	if response.Code != http.StatusNoContent || seenToken != "invite-token-2" {
		t.Fatalf("POST alias status=%d token=%q, want 204 invite-token-2", response.Code, seenToken)
	}

	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/api/invite/invite-token-1", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("DELETE alias status=%d, want 404 from the base handler", response.Code)
	}

	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	if got := MountGoInviteTokenRoute(base, nil); got == nil {
		t.Fatal("nil invitation route dropped the base handler")
	} else {
		response = httptest.NewRecorder()
		got.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/invite/invite-token-1", nil))
		if response.Code != http.StatusTeapot {
			t.Fatalf("nil invitation route status=%d, want the untouched base handler", response.Code)
		}
	}
}
