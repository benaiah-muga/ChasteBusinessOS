package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func crmSessionRequest(path string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *directTestIdentity().OrgID})
	return r
}

func TestCRMReadSessionHandlerBuildsGoClaimsForEachReadSelector(t *testing.T) {
	cases := []struct {
		query, capabilityID, input string
	}{
		{"timeline=" + crmReadTestCustomerID, "crm.customerTimeline", `{"customerId":"` + crmReadTestCustomerID + `"}`},
		{"tasks=1&open=1", "crm.listTasks", `{"openOnly":true}`},
		{"tasks=1", "crm.listTasks", `{}`},
		{"deals=1", "crm.listDeals", `{}`},
		{"customers=1", "crm.listCustomerCollection", `{}`},
		{"views=1", "crm.listCustomerViews", `{}`},
	}
	for _, tc := range cases {
		t.Run(tc.capabilityID+"/"+tc.query, func(t *testing.T) {
			identity := directTestIdentity()
			resolver := &fakeDirectSessionResolver{resolved: identity}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"ok":true}`)}}
			response := httptest.NewRecorder()
			NewCRMReadSessionHandler(resolver, executor, nil).ServeHTTP(response, crmSessionRequest("/api/crm?"+tc.query))
			if response.Code != http.StatusOK || executor.capID != tc.capabilityID || string(executor.input) != tc.input {
				t.Fatalf("status=%d capability=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
			}
			if resolver.resolveCalls != 1 || resolver.cookie != "session-cookie" || resolver.activeOrg != *identity.OrgID {
				t.Fatalf("session resolution=%+v", resolver)
			}
			actorID := identity.UserID
			if executor.claims.Audience != authbridge.CapabilityExecuteAudience || executor.claims.Subject != identity.UserID ||
				executor.claims.OrganizationID != *identity.OrgID || executor.claims.ActorID == nil || *executor.claims.ActorID != actorID ||
				executor.claims.ActorType != "human" || executor.claims.AuthSessionID != identity.AuthSessionID ||
				strings.Join(executor.claims.Permissions, ",") != "crm.read,sales.write" {
				t.Fatalf("claims=%+v", executor.claims)
			}
		})
	}
}

func TestCRMReadSessionHandlerResolvesBearerAndFailsClosedOnInvalidAccess(t *testing.T) {
	t.Run("bearer token", func(t *testing.T) {
		identity := directTestIdentity()
		resolver := &fakeDirectSessionResolver{resolved: identity}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"tasks":[]}`)}}
		request := crmSessionRequest("/api/crm?tasks=1")
		request.Header.Set("Authorization", "Bearer native-session-token")
		response := httptest.NewRecorder()
		NewCRMReadSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.resolveCalls != 0 || resolver.bearer != "native-session-token" {
			t.Fatalf("status=%d resolver=%+v body=%s", response.Code, resolver, response.Body.String())
		}
	})
	tests := []struct {
		name     string
		identity *session.ResolvedUser
		path     string
		want     int
	}{
		{name: "unverified", identity: func() *session.ResolvedUser { v := directTestIdentity(); v.EmailVerified = false; return v }(), path: "/api/crm?tasks=1", want: http.StatusUnauthorized},
		{name: "missing auth session", identity: func() *session.ResolvedUser { v := directTestIdentity(); v.AuthSessionID = ""; return v }(), path: "/api/crm?tasks=1", want: http.StatusUnauthorized},
		{name: "missing permission", identity: func() *session.ResolvedUser { v := directTestIdentity(); v.Permissions = map[string]bool{}; return v }(), path: "/api/crm?tasks=1", want: http.StatusForbidden},
		{name: "disabled module", identity: func() *session.ResolvedUser {
			v := directTestIdentity()
			v.ModulesRestricted = true
			v.EnabledModules = []string{"sales"}
			return v
		}(), path: "/api/crm?tasks=1", want: http.StatusForbidden},
		{name: "mismatched org header", identity: directTestIdentity(), path: "/api/crm?tasks=1", want: http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: tc.identity}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
			request := crmSessionRequest(tc.path)
			if tc.name == "mismatched org header" {
				request.Header.Set("X-Organization-ID", "99999999-9999-4999-8999-999999999999")
			}
			response := httptest.NewRecorder()
			NewCRMReadSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
			if response.Code != tc.want || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s want=%d", response.Code, executor.calls, response.Body.String(), tc.want)
			}
		})
	}
}

func TestCRMReadSessionHandlerRejectsAmbiguousSelectorsAndSanitizesFailures(t *testing.T) {
	for _, path := range []string{
		"/api/crm", "/api/crm?tasks=1&deals=1", "/api/crm?tasks=1&tasks=1",
		"/api/crm?timeline=", "/api/crm?tasks=1&open=maybe", "/api/crm?customers=1&unexpected=1",
		"/api/crm?deals=0", "/api/crm?customers=true", "/api/crm?views=", "/api/crm?tasks=yes",
		"/api/crm?tasks=1&open=", "/api/crm?timeline=%20%20",
	} {
		response := httptest.NewRecorder()
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
		NewCRMReadSessionHandler(resolver, executor, nil).ServeHTTP(response, crmSessionRequest(path))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Errorf("%s status=%d calls=%d body=%s", path, response.Code, executor.calls, response.Body.String())
		}
	}
	t.Run("executor failure sanitized", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{err: errors.New("private database detail")}
		response := httptest.NewRecorder()
		NewCRMReadSessionHandler(resolver, executor, nil).ServeHTTP(response, crmSessionRequest("/api/crm?tasks=1"))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database detail") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestMountGoCRMReadRouteMountsOnlyExactGet(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoCRMReadRoute(legacy, routeMarker("go-crm"))
	for _, tc := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/crm", "go-crm"},
		{http.MethodGet, "/api/crm?customers=1", "go-crm"},
		{http.MethodPost, "/api/crm", "legacy"},
		{http.MethodGet, "/api/crm/timeline", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != tc.want {
			t.Errorf("%s %s response=%d %q want %q", tc.method, tc.path, response.Code, response.Body.String(), tc.want)
		}
	}
}
