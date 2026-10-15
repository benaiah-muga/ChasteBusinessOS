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

func TestMountGoExpensesAccountingTaxAndPeriodCloseRoutesOwnExactPaths(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	route := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})
	handler := MountGoExpensesRoute(
		MountGoAccountingTaxRoute(
			MountGoAccountingPeriodCloseRoute(base, route),
			route,
		),
		route,
	)

	for _, request := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/api/expenses", http.StatusAccepted},
		{http.MethodPost, "/api/expenses", http.StatusAccepted},
		{http.MethodGet, "/api/accounting/tax", http.StatusAccepted},
		{http.MethodPost, "/api/accounting/tax", http.StatusAccepted},
		{http.MethodGet, "/api/accounting/close", http.StatusAccepted},
		{http.MethodPost, "/api/accounting/close", http.StatusAccepted},
		{http.MethodGet, "/api/expenses/extra", http.StatusTeapot},
		{http.MethodGet, "/api/accounting/tax/extra", http.StatusTeapot},
		{http.MethodGet, "/api/accounting/close/extra", http.StatusTeapot},
		{http.MethodDelete, "/api/accounting/close", http.StatusTeapot},
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

func TestMountGoAccountingHRMarketingAndPOSWriteRoutesOwnExactMethods(t *testing.T) {
	base := routeMarker("base")
	route := routeMarker("go")
	handler := MountGoPOSWriteRoute(
		MountGoMarketingRoute(
			MountGoHRRoute(
				MountGoAccountingRoute(base, route),
				route,
			),
			route,
		),
		route,
	)
	for _, request := range []struct {
		method string
		path   string
		want   string
	}{
		{http.MethodGet, "/api/accounting", "go"},
		{http.MethodPost, "/api/accounting", "go"},
		{http.MethodGet, "/api/hr", "go"},
		{http.MethodPost, "/api/hr", "go"},
		{http.MethodGet, "/api/marketing", "go"},
		{http.MethodPost, "/api/marketing", "go"},
		{http.MethodPost, "/api/pos", "go"},
		{http.MethodGet, "/api/pos", "base"},
		{http.MethodPost, "/api/pos/extra", "base"},
		{http.MethodGet, "/api/accounting/extra", "base"},
		{http.MethodDelete, "/api/hr", "base"},
		{http.MethodPatch, "/api/marketing", "base"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(request.method, request.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != request.want {
			t.Errorf("%s %s response=%d %q, want %q", request.method, request.path, response.Code, response.Body.String(), request.want)
		}
	}
}
