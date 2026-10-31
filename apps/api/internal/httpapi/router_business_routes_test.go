package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func routeMarker(value string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(value))
	})
}

func TestMountGoBusinessRoutesMountsDashboardLedgerAndMetrics(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("legacy"))
	})
	handler := MountGoBusinessRoutes(
		legacy,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		routeMarker("dashboard"), routeMarker("ledger"), routeMarker("metrics"),
	)

	for _, test := range []struct {
		path string
		want string
	}{
		{path: "/api/dashboard", want: "dashboard"},
		{path: "/api/ledger", want: "ledger"},
		{path: "/api/metrics", want: "metrics"},
	} {
		t.Run(test.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
			if response.Code != http.StatusOK || response.Body.String() != test.want {
				t.Fatalf("response = %d %q, want 200 %q", response.Code, response.Body.String(), test.want)
			}
		})
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/ledger", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("POST exact ledger response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/ledger/extra", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("GET ledger suffix response = %d %q, want base fallback", response.Code, response.Body.String())
	}
	disabled := MountGoBusinessRoutes(legacy,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
	response = httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/ledger", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("disabled ledger route response = %d %q, want base fallback", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/dashboard", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("unmounted method response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}

	for _, test := range []struct {
		method string
		path   string
	}{
		{method: http.MethodHead, path: "/api/metrics"},
		{method: http.MethodPost, path: "/api/metrics"},
		{method: http.MethodGet, path: "/api/metrics/extra"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
			t.Errorf("%s %s response = %d %q, want legacy fallback", test.method, test.path, response.Code, response.Body.String())
		}
	}
}

func TestMountGoBusinessRoutesMountsAnalyticsGetOnlyWhenHandlerProvided(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("legacy"))
	})
	analytics := MountGoBusinessRoutes(legacy, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, routeMarker("analytics"), nil, nil, nil)
	response := httptest.NewRecorder()
	analytics.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/analytics", nil))
	if response.Code != http.StatusOK || response.Body.String() != "analytics" {
		t.Fatalf("mounted analytics GET response = %d %q", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	analytics.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/analytics", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("unmounted analytics POST response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	analytics.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/api/analytics", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("unmounted analytics method response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}

	disabled := MountGoBusinessRoutes(legacy, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	response = httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/analytics", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("disabled analytics GET response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
}

func TestMountGoBusinessRoutesMountsAnalyticsReportPostSeparately(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("legacy"))
	})
	handler := MountGoBusinessRoutes(
		legacy,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		routeMarker("analytics read"), nil, nil, nil,
		routeMarker("analytics report"),
	)
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/analytics", want: "analytics read"},
		{method: http.MethodGet, path: "/api/analytics?dataset=analytics.pipelineByStage", want: "analytics read"},
		{method: http.MethodPost, path: "/api/analytics", want: "analytics report"},
		{method: http.MethodPost, path: "/api/analytics?format=html", want: "analytics report"},
		{method: http.MethodDelete, path: "/api/analytics", want: "legacy"},
		{method: http.MethodPost, path: "/api/analytics/extra", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		wantStatus := http.StatusOK
		if test.want == "legacy" {
			wantStatus = http.StatusNotFound
		}
		if response.Code != wantStatus || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q, want %d %q", test.method, test.path, response.Code, response.Body.String(), wantStatus, test.want)
		}
	}

	reportOnly := MountGoBusinessRoutes(
		legacy,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil,
		nil, nil, nil,
		routeMarker("analytics report"),
	)
	response := httptest.NewRecorder()
	reportOnly.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/analytics", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("GET with report-only route response=%d %q, want legacy fallback", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	reportOnly.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/analytics", nil))
	if response.Code != http.StatusOK || response.Body.String() != "analytics report" {
		t.Fatalf("POST with report-only route response=%d %q, want Go report route", response.Code, response.Body.String())
	}
}

func TestMountGoSalesOrdersRouteMatchesOnlyCollectionGet(t *testing.T) {
	base := routeMarker("legacy")
	handler := MountGoSalesOrdersRoute(base, routeMarker("go-orders"))
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/sales", want: "go-orders"},
		{method: http.MethodGet, path: "/api/sales?status=draft", want: "go-orders"},
		{method: http.MethodHead, path: "/api/sales", want: "legacy"},
		{method: http.MethodPost, path: "/api/sales", want: "legacy"},
		{method: http.MethodGet, path: "/api/sales/extra", want: "legacy"},
		{method: http.MethodGet, path: "/api/sales/", want: "legacy"},
	} {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
			if response.Code != http.StatusOK || response.Body.String() != test.want {
				t.Fatalf("response=%d %q want 200 %q", response.Code, response.Body.String(), test.want)
			}
		})
	}
}

func TestMountGoBusinessRoutesMatchesOnlySalesInvoiceGet(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoBusinessRoutes(legacy, nil, routeMarker("go-invoice"), nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/sales/order-id", want: "go-invoice"},
		{method: http.MethodGet, path: "/api/sales/order-id?print=1", want: "go-invoice"},
		{method: http.MethodPost, path: "/api/sales/order-id", want: "legacy"},
		{method: http.MethodGet, path: "/api/sales/order-id/", want: "legacy"},
		{method: http.MethodGet, path: "/api/sales/order-id/extra", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q, want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
}

func TestMountGoBusinessRoutesDispatchesTeamMethodsExactly(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("legacy")) })
	handler := MountGoBusinessRoutes(
		legacy,
		nil, nil, nil, nil, nil, nil, nil,
		routeMarker("team read"), routeMarker("team write"),
		nil, nil, nil, nil, nil,
	)

	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/team", want: "team read"},
		{method: http.MethodPost, path: "/api/team", want: "team write"},
		{method: http.MethodHead, path: "/api/team", want: "legacy"},
		{method: http.MethodPatch, path: "/api/team", want: "legacy"},
		{method: http.MethodGet, path: "/api/team/extra", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Body.String() != test.want {
			t.Errorf("%s %s body=%q, want %q", test.method, test.path, response.Body.String(), test.want)
		}
	}
}

func TestMountGoBusinessRoutesDispatchesModulesAndProjectsExactly(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("legacy")) })
	handler := MountGoBusinessRoutes(
		legacy,
		nil, nil, nil, nil,
		routeMarker("modules read"), routeMarker("modules write"), routeMarker("projects"),
		nil, nil, nil, nil, nil, nil, nil,
	)

	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/modules", want: "modules read"},
		{method: http.MethodPost, path: "/api/modules", want: "modules write"},
		{method: http.MethodHead, path: "/api/modules", want: "legacy"},
		{method: http.MethodGet, path: "/api/modules/extra", want: "legacy"},
		{method: http.MethodGet, path: "/api/projects", want: "projects"},
		{method: http.MethodPost, path: "/api/projects", want: "projects"},
		{method: http.MethodHead, path: "/api/projects", want: "legacy"},
		{method: http.MethodDelete, path: "/api/projects", want: "legacy"},
		{method: http.MethodGet, path: "/api/projects/extra", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Body.String() != test.want {
			t.Errorf("%s %s body=%q, want %q", test.method, test.path, response.Body.String(), test.want)
		}
	}
}

func TestMountGoBusinessRoutesKeepsTeamMethodsAndPathsOptIn(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("legacy"))
	})
	team := MountGoBusinessRoutes(
		legacy,
		nil, nil, nil, nil, nil, nil, nil,
		routeMarker("team-read"), routeMarker("team-write"),
		nil, nil, nil, nil, nil,
	)
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/team", want: "team-read"},
		{method: http.MethodPost, path: "/api/team", want: "team-write"},
		{method: http.MethodPatch, path: "/api/team", want: "legacy"},
		{method: http.MethodGet, path: "/api/team/invitations", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		team.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		wantStatus := http.StatusOK
		if test.want == "legacy" {
			wantStatus = http.StatusNotFound
		}
		if response.Code != wantStatus || response.Body.String() != test.want {
			t.Fatalf("%s %s response = %d %q, want %d %q", test.method, test.path, response.Code, response.Body.String(), wantStatus, test.want)
		}
	}

	disabled := MountGoBusinessRoutes(legacy, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	response := httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/team", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("disabled team route response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
}

func TestMountSetupRouteOwnsExactPathAndRejectsOtherMethods(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountSetupRoute(legacy, NewSetupSessionHandler(nil, nil, nil))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/setup", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("POST exact setup response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/setup/extra", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("GET setup suffix response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
}

func TestMountSetupRouteKeepsLegacyFallbackWhenDisabled(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountSetupRoute(legacy, nil)
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/setup", want: "legacy"},
		{method: http.MethodPost, path: "/api/setup", want: "legacy"},
		{method: http.MethodGet, path: "/api/other", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Fatalf("%s %s response = %d %q, want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
}

func TestMountMyWorkRouteOwnsExactPathAndRejectsOtherMethods(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountMyWorkRoute(legacy, routeMarker("my-work"))
	for _, path := range []string{"/api/my-work", "/api/my-work?source=dashboard"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || response.Body.String() != "my-work" {
			t.Fatalf("GET %s response = %d %q, want 200 my-work", path, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/my-work", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("POST exact my-work response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/my-work/extra", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("GET my-work suffix response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/my-work/summarize", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("POST my-work summarize response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	MountMyWorkRoute(legacy, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/my-work", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("disabled my-work route response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
}

func TestMountMyWorkSummaryRouteMountsOnlyThePostEndpoint(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountMyWorkSummaryRoute(legacy, routeMarker("summary"))
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodPost, path: "/api/my-work/summarize", want: "summary"},
		{method: http.MethodPost, path: "/api/my-work/summarize/extra", want: "legacy"},
		{method: http.MethodPost, path: "/api/my-work", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Fatalf("%s %s response = %d %q, want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/my-work/summarize", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPost ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("GET exact summary response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	response = httptest.NewRecorder()
	MountMyWorkSummaryRoute(legacy, nil).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/my-work/summarize", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("disabled summary route response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
}

func TestMountGoSCIMRoutesKeepsReadsAndWritesIndependent(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("base"))
	})
	read := routeMarker("read")
	write := routeMarker("write")
	handler := MountGoSCIMRoutes(base, read, write)

	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/scim/v2/Users", want: "read"},
		{method: http.MethodGet, path: "/api/scim/v2/Users/user-1", want: "read"},
		{method: http.MethodPost, path: "/api/scim/v2/Users", want: "write"},
		{method: http.MethodDelete, path: "/api/scim/v2/Users/user-1", want: "write"},
		{method: http.MethodHead, path: "/api/scim/v2/Users", want: "base"},
		{method: http.MethodHead, path: "/api/scim/v2/Users/user-1", want: "base"},
		{method: http.MethodPatch, path: "/api/scim/v2/Users/user-1", want: "base"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Body.String() != test.want {
			t.Errorf("%s %s body=%q, want %q", test.method, test.path, response.Body.String(), test.want)
		}
	}

	readOnly := MountGoSCIMRoutes(base, read, nil)
	response := httptest.NewRecorder()
	readOnly.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", nil))
	if response.Code != http.StatusAccepted || response.Body.String() != "base" {
		t.Fatalf("write request with only read route returned %d %q, want base handler", response.Code, response.Body.String())
	}
}

func TestMountGoSCIMTokenManagementRouteIsOptInAndExactPath(t *testing.T) {
	base := routeMarker("base")
	management := routeMarker("management")

	response := httptest.NewRecorder()
	MountGoSCIMTokenManagementRoute(base, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/scim/tokens", nil))
	if response.Body.String() != "base" {
		t.Fatalf("nil route body=%q, want base", response.Body.String())
	}

	handler := MountGoSCIMTokenManagementRoute(base, management)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/scim/tokens", nil))
	if response.Body.String() != "management" {
		t.Fatalf("mounted route body=%q, want management", response.Body.String())
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/scim/tokens/extra", nil))
	if response.Body.String() != "base" {
		t.Fatalf("suffix route body=%q, want base", response.Body.String())
	}
}

func TestMountGoSessionReadRoutesUseExactMethodsAndUUIDPaths(t *testing.T) {
	legacy := routeMarker("legacy")
	sessionsList := routeMarker("sessions-list")
	sessionsDetail := routeMarker("sessions-detail")
	durableRuns := routeMarker("durable-runs")
	handler := MountGoSessionReadRoutes(legacy, sessionsList, sessionsDetail, durableRuns)
	sessionID := "aaaaaaaa-0000-4000-8000-000000000001"
	runID := "bbbbbbbb-0000-4000-8000-000000000002"

	for _, path := range []string{"/api/sessions", "/api/sessions/" + sessionID, "/api/sessions/" + sessionID + "/replay", "/api/durable-runs", "/api/durable-runs/" + runID} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Body.String() == "legacy" {
			t.Fatalf("expected Go handler for %s, got legacy fallback", path)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/durable-runs", nil))
	if got := response.Body.String(); got != "durable-runs" {
		t.Fatalf("POST /api/durable-runs response body=%q, want Go durable-runs handler", got)
	}

	for _, test := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/sessions"},
		{method: http.MethodHead, path: "/api/sessions"},
		{method: http.MethodGet, path: "/api/sessions/not-a-uuid"},
		{method: http.MethodGet, path: "/api/sessions/" + sessionID + "/events"},
		{method: http.MethodHead, path: "/api/sessions/" + sessionID},
		{method: http.MethodGet, path: "/api/durable-runs/not-a-uuid"},
		{method: http.MethodHead, path: "/api/durable-runs/" + runID},
		{method: http.MethodPost, path: "/api/durable-runs/" + runID},
		{method: http.MethodPost, path: "/api/durable-runs/extra"},
		{method: http.MethodPut, path: "/api/durable-runs"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if got := response.Body.String(); got != "legacy" {
			t.Errorf("%s %s response body=%q, want legacy fallback", test.method, test.path, got)
		}
	}

	disabled := MountGoSessionReadRoutes(legacy, nil, nil, nil)
	response = httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions", nil))
	if got := response.Body.String(); got != "legacy" {
		t.Fatalf("disabled Go route did not reach fallback: got %q", got)
	}
}

func TestMountGoNotificationsRouteOwnsExactPathAndReturnsConfiguredMethodAllow(t *testing.T) {
	legacy := routeMarker("legacy")
	get := routeMarker("notifications-get")
	post := routeMarker("notifications-post")
	full := MountGoNotificationsRoute(legacy, get, post)

	for _, test := range []struct {
		method string
		want   string
	}{
		{method: http.MethodGet, want: "notifications-get"},
		{method: http.MethodPost, want: "notifications-post"},
	} {
		response := httptest.NewRecorder()
		full.ServeHTTP(response, httptest.NewRequest(test.method, "/api/notifications", nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s exact route status=%d body=%q, want %q", test.method, response.Code, response.Body.String(), test.want)
		}
	}

	response := httptest.NewRecorder()
	full.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/notifications", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("full mount unsupported method status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}

	response = httptest.NewRecorder()
	full.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/notifications/extra", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("suffix path status=%d body=%q, want legacy fallback", response.Code, response.Body.String())
	}

	getOnly := MountGoNotificationsRoute(legacy, get, nil)
	response = httptest.NewRecorder()
	getOnly.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notifications", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("disabled POST did not reach fallback: status=%d body=%q", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	getOnly.ServeHTTP(response, httptest.NewRequest(http.MethodPatch, "/api/notifications", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
		t.Fatalf("GET-only mount unsupported method status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}

	postOnly := MountGoNotificationsRoute(legacy, nil, post)
	response = httptest.NewRecorder()
	postOnly.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/notifications", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("disabled GET did not reach fallback: status=%d body=%q", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	postOnly.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/notifications", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "POST" {
		t.Fatalf("POST-only mount unsupported method status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}

	disabled := MountGoNotificationsRoute(legacy, nil, nil)
	response = httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/notifications", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("fully disabled route did not preserve fallback: status=%d body=%q", response.Code, response.Body.String())
	}
}
