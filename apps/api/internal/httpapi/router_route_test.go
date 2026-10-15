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

func TestMountGoAccountingBudgetsAndTimeRoutesOwnExactPaths(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	budgetRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})
	timeRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	handler := MountGoTimeRoute(MountGoAccountingBudgetsRoute(base, budgetRoute), timeRoute)

	for _, request := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/api/accounting/budgets", http.StatusAccepted},
		{http.MethodPost, "/api/accounting/budgets", http.StatusAccepted},
		{http.MethodGet, "/api/time", http.StatusCreated},
		{http.MethodPost, "/api/time", http.StatusCreated},
		{http.MethodGet, "/api/accounting/budgets/extra", http.StatusTeapot},
		{http.MethodDelete, "/api/time", http.StatusTeapot},
	} {
		t.Run(request.method+" "+request.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(request.method, request.path, nil))
			if response.Code != request.status {
				t.Fatalf("status=%d want=%d", response.Code, request.status)
			}
		})
	}
}
