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
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"signals":[{"id":"cash.low","severity":"orange","module":"cash","subject":"Low cash","detail":"Cash is low"}]}`)}}
	response := httptest.NewRecorder()
	NewSignalsSessionHandler(resolver, executor, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals?severity=orange&severity=red&module=sales&ignored=value"))

	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"signals":[{"detail":"Cash is low","id":"cash.low","module":"cash","severity":"orange","subject":"Low cash"}]}` {
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
	identity.Permissions["signals.read"] = true
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

func TestSignalsSessionHandlerRejectsOrganizationOutsideMembership(t *testing.T) {
	for _, auth := range []string{"cookie", "bearer"} {
		t.Run(auth, func(t *testing.T) {
			identity := directTestIdentity()
			identity.Permissions["signals.read"] = true
			request := signalsRequest(http.MethodGet, "/api/signals")
			request.Header.Set("X-Organization-ID", "99999999-9999-4999-8999-999999999999")
			resolver := &fakeDirectSessionResolver{resolved: identity}
			if auth == "bearer" {
				request.Header.Set("Authorization", "Bearer access-token")
			}
			response := httptest.NewRecorder()
			executor := &fakeDirectCapabilityExecutor{}
			NewSignalsSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || strings.TrimSpace(response.Body.String()) != `{"error":"forbidden"}` || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestSignalsSessionHandlerClassifiesResolverFailures(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
	}{
		{name: "invalid session", err: session.ErrNoSession, status: http.StatusUnauthorized},
		{name: "short secret", err: session.ErrSecretTooShort, status: http.StatusServiceUnavailable},
		{name: "resolver infrastructure failure", err: errors.New("database credentials leaked"), status: http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			NewSignalsSessionHandler(&fakeDirectSessionResolver{err: test.err}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals"))
			if response.Code != test.status || strings.Contains(response.Body.String(), "database credentials") {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if test.status == http.StatusUnauthorized && response.Header().Get("WWW-Authenticate") == "" {
				t.Fatalf("unauthorized response is missing bearer challenge: %v", response.Header())
			}
		})
	}
}

func TestSignalsSessionHandlerMapsInvalidFiltersToBadRequest(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["signals.read"] = true
	for _, path := range []string{"/api/signals?severity=blue", "/api/signals?module=x", "/api/signals?module=%ZZ"} {
		t.Run(path, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"signals":[]}`)}}
			response := httptest.NewRecorder()
			NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, signalsRequest(http.MethodGet, path))
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid query parameters") || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestSignalsSessionHandlerRejectsMissingReadPermissionWithoutLeakingDetails(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: signals.read"}}
	response := httptest.NewRecorder()
	NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals"))
	if response.Code != http.StatusForbidden || strings.TrimSpace(response.Body.String()) != `{"error":"forbidden"}` || executor.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
}

func TestSignalsSessionHandlerHidesCapabilityFailure(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["signals.read"] = true
	response := httptest.NewRecorder()
	NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "database detail"}}, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals"))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database detail") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSignalsSessionHandlerRejectsMalformedGeneratedSignalResponse(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["signals.read"] = true
	for _, data := range []string{
		`{"signals":[{"id":"cash.low","severity":"orange","module":"cash","detail":"Cash is low"}]}`,
		`{"signals":[{"id":"cash.low","severity":"orange","module":"cash","subject":"Low cash","detail":"Cash is low","extra":true}]}`,
	} {
		t.Run(data, func(t *testing.T) {
			response := httptest.NewRecorder()
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(data)}}
			NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals"))
			if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "extra") {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestSignalsSessionHandlerHidesExecutorFailure(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["signals.read"] = true
	response := httptest.NewRecorder()
	NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDirectCapabilityExecutor{err: errors.New("database detail")}, nil).ServeHTTP(response, signalsRequest(http.MethodGet, "/api/signals"))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database detail") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSignalsSessionHandlerWrongMethod(t *testing.T) {
	response := httptest.NewRecorder()
	NewSignalsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, signalsRequest(http.MethodPost, "/api/signals"))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("status=%d Allow=%q", response.Code, response.Header().Get("Allow"))
	}
}

func TestMountSignalsRouteIsOptIn(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	response := httptest.NewRecorder()
	MountSignalsRoute(base, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/signals", nil))
	if response.Code != http.StatusTeapot {
		t.Fatalf("nil Go route status=%d, want legacy handler status %d", response.Code, http.StatusTeapot)
	}
	for _, path := range []string{"/api/signals", "/api/signals/export"} {
		response = httptest.NewRecorder()
		MountSignalsRoute(base, nil).ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
		if response.Code != http.StatusTeapot {
			t.Fatalf("disabled route %s status=%d, want base handler status %d", path, response.Code, http.StatusTeapot)
		}
	}
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	mounted := MountSignalsRoute(base, goRoute)
	response = httptest.NewRecorder()
	mounted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/signals", nil))
	if response.Code != http.StatusAccepted {
		t.Fatalf("mounted Go route status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	mounted.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/signals", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("unsupported exact method status=%d headers=%v", response.Code, response.Header())
	}
	response = httptest.NewRecorder()
	mounted.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/signals/export", nil))
	if response.Code != http.StatusTeapot {
		t.Fatalf("suffix fallback status=%d, want base handler", response.Code)
	}
}

var _ CapabilityExecutor = (*fakeDirectCapabilityExecutor)(nil)
var _ signalsSessionResolver = (*fakeDirectSessionResolver)(nil)
