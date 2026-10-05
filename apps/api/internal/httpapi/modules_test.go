package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func modulesRequest(method string) *http.Request {
	request := httptest.NewRequest(method, "/api/modules", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestModulesHandlerReturnsCatalogAndDefaultModules(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	response := httptest.NewRecorder()
	NewModulesHandler(resolver).ServeHTTP(response, modulesRequest(http.MethodGet))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "session-cookie" || resolver.activeOrg != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("resolver calls=%d cookie=%q org=%q", resolver.resolveCalls, resolver.cookie, resolver.activeOrg)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", got)
	}
	body := response.Body.String()
	for _, fragment := range []string{
		`"catalog":[`,
		`"id":"accounting","label":"Accounting","description":"Ledger, invoicing, bills, payments, reports","href":"/accounting"`,
		`"id":"skills","label":"Skills","description":"Advisory playbooks the workmate can consult","href":null`,
		`"id":"iam","label":"Identity & access","description":"Roles, permissions, module switchboard","href":"/team","protected":true`,
		`"enabledModules":["accounting","analytics","marketing","projects","pos","inventory","manufacturing","purchasing","crm","sales","documents","hr","messaging","support","skills","creator","iam","routines","signals"]`,
		`"usingDefaults":true`,
	} {
		if !strings.Contains(body, fragment) {
			t.Errorf("response missing %s: %s", fragment, body)
		}
	}
}

func TestModulesHandlerUsesRestrictedModulesAndPreservesProtectedModules(t *testing.T) {
	identity := directTestIdentity()
	identity.ModulesRestricted = true
	identity.EnabledModules = []string{"crm", "crm", "support"}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	response := httptest.NewRecorder()
	NewModulesHandler(resolver).ServeHTTP(response, modulesRequest(http.MethodGet))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"enabledModules":["iam","routines","signals","crm","support"]`) {
		t.Fatalf("enabled modules did not preserve protected modules and deduplicate saved modules: %s", body)
	}
	if !strings.Contains(body, `"usingDefaults":false`) {
		t.Fatalf("saved modules reported as defaults: %s", body)
	}
}

func TestModulesHandlerPreservesUnknownSavedModuleIDsLikeLegacy(t *testing.T) {
	identity := directTestIdentity()
	identity.ModulesRestricted = true
	identity.EnabledModules = []string{"projects", "future-module", "projects"}
	response := httptest.NewRecorder()
	NewModulesHandler(&fakeDirectSessionResolver{resolved: identity}).ServeHTTP(response, modulesRequest(http.MethodGet))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"enabledModules":["iam","routines","signals","projects","future-module"]`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestModulesHandlerSupportsBearerAndOrganizationHeader(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	request := httptest.NewRequest(http.MethodGet, "/api/modules", nil)
	request.Header.Set("Authorization", "Bearer opaque-session-token")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	NewModulesHandler(resolver).ServeHTTP(response, request)

	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "opaque-session-token" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("status=%d resolver=%+v body=%s", response.Code, resolver, response.Body.String())
	}
}

func TestModulesHandlerRejectsUnverifiedAndUnmatchedOrganization(t *testing.T) {
	t.Run("unverified session", func(t *testing.T) {
		identity := directTestIdentity()
		identity.EmailVerified = false
		resolver := &fakeDirectSessionResolver{resolved: identity}
		response := httptest.NewRecorder()
		NewModulesHandler(resolver).ServeHTTP(response, modulesRequest(http.MethodGet))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s, want unauthorized", response.Code, response.Body.String())
		}
	})

	t.Run("unmatched header selector", func(t *testing.T) {
		identity := directTestIdentity()
		resolver := &fakeDirectSessionResolver{resolved: identity}
		request := httptest.NewRequest(http.MethodGet, "/api/modules", nil)
		request.Header.Set("Authorization", "Bearer opaque-session-token")
		request.Header.Set("X-Organization-ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
		response := httptest.NewRecorder()
		NewModulesHandler(resolver).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s, want forbidden", response.Code, response.Body.String())
		}
	})

	t.Run("invalid header selector", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		request := httptest.NewRequest(http.MethodGet, "/api/modules", nil)
		request.Header.Set("Authorization", "Bearer opaque-session-token")
		request.Header.Set("X-Organization-ID", "not-a-uuid")
		response := httptest.NewRecorder()
		NewModulesHandler(resolver).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || resolver.bearerCalls != 0 {
			t.Fatalf("status=%d resolver calls=%d body=%s", response.Code, resolver.bearerCalls, response.Body.String())
		}
	})
}

func TestModulesHandlerOnlyAllowsGETAndAlwaysDisablesCaching(t *testing.T) {
	response := httptest.NewRecorder()
	NewModulesHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}).ServeHTTP(response, modulesRequest(http.MethodPost))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("status=%d Allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", response.Header().Get("Cache-Control"))
	}
}
