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
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/dashboard", nil))
	if response.Code != http.StatusNotFound || response.Body.String() != "legacy" {
		t.Fatalf("unmounted method response = %d %q, want legacy fallback", response.Code, response.Body.String())
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

func TestMountSetupRouteKeepsLegacyFallbackWhenDisabled(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountSetupRoute(legacy, routeMarker("setup"))
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/setup", want: "setup"},
		{method: http.MethodPost, path: "/api/setup", want: "legacy"},
		{method: http.MethodGet, path: "/api/other", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Fatalf("%s %s response = %d %q, want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
	response := httptest.NewRecorder()
	MountSetupRoute(legacy, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/setup", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("disabled setup route response = %d %q, want legacy fallback", response.Code, response.Body.String())
	}
}

func TestMountMyWorkRouteKeepsLegacyFallbackWhenDisabled(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountMyWorkRoute(legacy, routeMarker("my-work"))
	for _, test := range []struct {
		method string
		path   string
		want   string
	}{
		{method: http.MethodGet, path: "/api/my-work", want: "my-work"},
		{method: http.MethodGet, path: "/api/my-work?source=dashboard", want: "my-work"},
		{method: http.MethodPost, path: "/api/my-work", want: "legacy"},
		{method: http.MethodPost, path: "/api/my-work/summarize", want: "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Fatalf("%s %s response = %d %q, want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
	response := httptest.NewRecorder()
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
		{method: http.MethodGet, path: "/api/my-work/summarize", want: "legacy"},
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
	notifications := routeMarker("notifications")
	handler := MountGoSessionReadRoutes(legacy, sessionsList, sessionsDetail, durableRuns, notifications)
	sessionID := "aaaaaaaa-0000-4000-8000-000000000001"
	runID := "bbbbbbbb-0000-4000-8000-000000000002"

	for _, path := range []string{"/api/sessions", "/api/sessions/" + sessionID, "/api/sessions/" + sessionID + "/replay", "/api/durable-runs", "/api/durable-runs/" + runID, "/api/notifications"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Body.String() == "legacy" {
			t.Fatalf("expected Go handler for %s, got legacy fallback", path)
		}
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
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if got := response.Body.String(); got != "legacy" {
			t.Errorf("%s %s response body=%q, want legacy fallback", test.method, test.path, got)
		}
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notifications", nil))
	if got := response.Body.String(); got != "legacy" {
		t.Fatalf("notification write did not reach fallback: got %q", got)
	}

	withReadMutation := MountGoNotificationReadRoute(handler, routeMarker("notification-read"))
	response = httptest.NewRecorder()
	withReadMutation.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notifications", nil))
	if got := response.Body.String(); got != "notification-read" {
		t.Fatalf("notification write did not reach Go handler: got %q", got)
	}
	response = httptest.NewRecorder()
	withReadMutation.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notifications/extra", nil))
	if got := response.Body.String(); got != "legacy" {
		t.Fatalf("notification suffix route did not reach fallback: got %q", got)
	}

	disabled := MountGoSessionReadRoutes(legacy, nil, nil, nil, nil)
	response = httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions", nil))
	if got := response.Body.String(); got != "legacy" {
		t.Fatalf("disabled Go route did not reach fallback: got %q", got)
	}
}
