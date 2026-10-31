package httpapi

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func posShiftSummaryRequest(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/pos/shift-summary", strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://app.example.test")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *directTestIdentity().OrgID})
	return request
}

func TestPosShiftSummarySessionHandlerExecutesOnlyShiftSummaryWithResolvedClaims(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"register":"main","status":"open","salesCount":2,"takingsMinor":300,"tenderTotals":[],"refundTotals":[],"expectedCashMinor":250,"countedCashMinor":null,"varianceMinor":null}`)}}
	response := httptest.NewRecorder()
	NewPosShiftSummarySessionHandler(resolver, executor, nil).ServeHTTP(response, posShiftSummaryRequest(`{"capabilityId":"pos.shiftSummary","input":{"sessionId":"44444444-4444-4444-8444-444444444444"},"intentId":"summary-1"}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		OK   bool                             `json:"ok"`
		Data capability.PosShiftSummaryOutput `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || !body.OK || body.Data.Register != "main" || body.Data.TenderTotals == nil || body.Data.RefundTotals == nil {
		t.Fatalf("response does not match shift summary schema: %+v err=%v body=%s", body, err, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "session-cookie" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("resolver calls=%d cookie=%q org=%q", resolver.resolveCalls, resolver.cookie, resolver.activeOrg)
	}
	if executor.calls != 1 || executor.capID != posShiftSummaryCapabilityID || string(executor.input) != `{"sessionId":"44444444-4444-4444-8444-444444444444"}` {
		t.Fatalf("executor calls=%d capability=%q input=%s", executor.calls, executor.capID, executor.input)
	}
	if executor.claims.Audience != authbridge.CapabilityExecuteAudience || executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID ||
		executor.claims.ActorID == nil || *executor.claims.ActorID != identity.UserID || executor.claims.ActorType != "human" ||
		executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.CapabilityID != posShiftSummaryCapabilityID || executor.claims.IntentID != "summary-1" {
		t.Fatalf("claims do not match resolved session: %+v", executor.claims)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache policy=%q", response.Header().Get("Cache-Control"))
	}
}

func TestPosShiftSummarySessionHandlerValidatesAuthOriginAndCapabilityInput(t *testing.T) {
	for _, test := range []struct {
		name     string
		identity *session.ResolvedUser
		body     string
		origin   string
		selector string
		want     int
	}{
		{name: "unverified session", identity: func() *session.ResolvedUser { u := directTestIdentity(); u.EmailVerified = false; return u }(), body: `{"capabilityId":"pos.shiftSummary","input":{"sessionId":"44444444-4444-4444-8444-444444444444"}}`, want: http.StatusUnauthorized},
		{name: "missing origin for cookie request", identity: directTestIdentity(), body: `{"capabilityId":"pos.shiftSummary","input":{"sessionId":"44444444-4444-4444-8444-444444444444"}}`, origin: "", want: http.StatusForbidden},
		{name: "foreign origin", identity: directTestIdentity(), body: `{"capabilityId":"pos.shiftSummary","input":{"sessionId":"44444444-4444-4444-8444-444444444444"}}`, origin: "https://evil.example", want: http.StatusForbidden},
		{name: "invalid session id", identity: directTestIdentity(), body: `{"capabilityId":"pos.shiftSummary","input":{"sessionId":"not-a-uuid"}}`, want: http.StatusBadRequest},
		{name: "unsupported capability", identity: directTestIdentity(), body: `{"capabilityId":"sales.createOrder","input":{"sessionId":"44444444-4444-4444-8444-444444444444"}}`, want: http.StatusBadRequest},
		{name: "unsupported request field", identity: directTestIdentity(), body: `{"capabilityId":"pos.shiftSummary","input":{"sessionId":"44444444-4444-4444-8444-444444444444"},"extra":true}`, want: http.StatusBadRequest},
		{name: "mismatched organization", identity: directTestIdentity(), body: `{"capabilityId":"pos.shiftSummary","input":{"sessionId":"44444444-4444-4444-8444-444444444444"}}`, selector: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", want: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.identity}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"register":"main","status":"open","tenderTotals":[],"refundTotals":[]}`)}}
			request := posShiftSummaryRequest(test.body)
			if test.origin != "" || test.name == "missing origin for cookie request" {
				request.Header.Set("Origin", test.origin)
			}
			if test.selector != "" {
				request.Header.Set("X-Organization-ID", test.selector)
			}
			response := httptest.NewRecorder()
			NewPosShiftSummarySessionHandler(resolver, executor, nil).ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
			if test.want != http.StatusOK && executor.calls != 0 {
				t.Fatalf("rejected request reached executor: %+v", executor)
			}
		})
	}
}

func TestPosShiftSummarySessionHandlerSupportsBearerClientsAndMapsCapabilityErrors(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: pos.read"}}
	request := posShiftSummaryRequest(`{"capabilityId":"pos.shiftSummary","input":{"sessionId":"44444444-4444-4444-8444-444444444444"},"intentId":"summary-2"}`)
	request.Header.Set("Authorization", "Bearer native-session-token")
	request.Header.Del("Origin")
	response := httptest.NewRecorder()
	NewPosShiftSummarySessionHandler(resolver, executor, nil).ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity || resolver.bearerCalls != 1 || resolver.resolveCalls != 0 || resolver.bearer != "native-session-token" {
		t.Fatalf("status=%d bearerCalls=%d cookieCalls=%d token=%q body=%s", response.Code, resolver.bearerCalls, resolver.resolveCalls, resolver.bearer, response.Body.String())
	}
}

func TestMountGoPOSShiftSummaryRouteMountsOnlyExactPost(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoPOSShiftSummaryRoute(legacy, routeMarker("go-summary"))
	for _, test := range []struct{ method, path, want string }{
		{http.MethodPost, "/api/pos/shift-summary", "go-summary"},
		{http.MethodGet, "/api/pos/shift-summary", "legacy"},
		{http.MethodPost, "/api/pos/shift-summary/extra", "legacy"},
		{http.MethodGet, "/api/pos", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q want %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
	response := httptest.NewRecorder()
	MountGoPOSShiftSummaryRoute(legacy, nil).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/pos/shift-summary", nil))
	if response.Code != http.StatusOK || response.Body.String() != "legacy" {
		t.Fatalf("disabled route response=%d %q, want legacy fallback", response.Code, response.Body.String())
	}
}
