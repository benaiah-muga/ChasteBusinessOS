package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func signalsRequest(method, path string) *http.Request {
	request := httptest.NewRequest(method, path, nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signals-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestSignalsSessionHandlerExecutesGovernedListAndReturnsLegacyEnvelope(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["signals.read"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"signals":[{"id":"cash.low","severity":"orange"}]}`)}}
	response := httptest.NewRecorder()
	NewSignalsSessionHandler(resolver, executor, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals?severity=orange&severity=red&module=sales&ignored=value"))

	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"signals":[{"id":"cash.low","severity":"orange"}]}` {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "signals-cookie" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("resolver=%+v", resolver)
	}
	if executor.calls != 1 || executor.capID != "signals.list" || string(executor.input) != `{"module":"sales","severity":"orange"}` {
		t.Fatalf("executor=%+v input=%s", executor, executor.input)
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.ActorType != "human" {
		t.Fatalf("claims were not resolved from the session: %+v", executor.claims)
	}
	if len(executor.claims.Permissions) != 3 || executor.claims.Permissions[2] != "signals.read" {
		t.Fatalf("permissions were not passed to governed executor: %+v", executor.claims.Permissions)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
}

func TestSignalsSessionHandlerSupportsBearerAndEmptyQuery(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"signals":[]}`)}}
	request := httptest.NewRequest(http.MethodGet, "/api/signals", nil)
	request.Header.Set("Authorization", "Bearer access-token")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	NewSignalsSessionHandler(resolver, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"signals":[]}` || string(executor.input) != `{}` {
		t.Fatalf("status=%d input=%s body=%s", response.Code, executor.input, response.Body.String())
	}
	if resolver.bearerCalls != 1 || resolver.bearer != "access-token" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("bearer resolver=%+v", resolver)
	}
}

func TestSignalsSessionHandlerRequiresVerifiedOrgSession(t *testing.T) {
	tests := []struct {
		name     string
		resolved *session.ResolvedUser
		err      error
		status   int
	}{
		{name: "missing session", err: session.ErrNoSession, status: http.StatusUnauthorized},
		{name: "unverified email", resolved: func() *session.ResolvedUser { u := directTestIdentity(); u.EmailVerified = false; return u }(), status: http.StatusUnauthorized},
		{name: "authenticated user without organization matches legacy unauthorized response", resolved: func() *session.ResolvedUser { u := directTestIdentity(); u.OrgID = nil; return u }(), status: http.StatusUnauthorized},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: test.resolved, err: test.err}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals"))
			if response.Code != test.status || response.Header().Get("WWW-Authenticate") == "" {
				t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
			}
		})
	}
}

func TestSignalsSessionHandlerPreservesLegacyFailureSemantics(t *testing.T) {
	t.Run("capability validation and permission failures", func(t *testing.T) {
		for _, message := range []string{"severity must be red, orange or green", "forbidden: missing permission: signals.read"} {
			t.Run(message, func(t *testing.T) {
				executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: message}}
				response := httptest.NewRecorder()
				NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals?severity=blue"))
				if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), message) {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
			})
		}
	})
	t.Run("executor error", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{err: errors.New("database detail")}, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals"))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database detail") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("wrong method", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, signalsRequest(http.MethodPost, "/api/signals"))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("status=%d Allow=%q", response.Code, response.Header().Get("Allow"))
		}
	})
}

func TestMountSignalsRouteIsOptIn(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	response := httptest.NewRecorder()
	MountSignalsRoute(base, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/signals", nil))
	if response.Code != http.StatusTeapot {
		t.Fatalf("nil Go route status=%d, want legacy handler status %d", response.Code, http.StatusTeapot)
	}
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	response = httptest.NewRecorder()
	MountSignalsRoute(base, goRoute).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/signals", nil))
	if response.Code != http.StatusAccepted {
		t.Fatalf("mounted Go route status=%d", response.Code)
	}
}

var _ CapabilityExecutor = (*fakeDirectCapabilityExecutor)(nil)
var _ signalsSessionResolver = (*fakeDirectSessionResolver)(nil)
