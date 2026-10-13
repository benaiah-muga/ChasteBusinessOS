package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMountGoSupportReplyDraftRouteOwnsOnlyPost(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	route := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})
	handler := MountGoSupportReplyDraftRoute(base, route)

	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/support/draft", nil))
	if post.Code != http.StatusAccepted {
		t.Fatalf("POST status=%d", post.Code)
	}
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/support/draft", nil))
	if get.Code != http.StatusTeapot {
		t.Fatalf("GET status=%d", get.Code)
	}
}
