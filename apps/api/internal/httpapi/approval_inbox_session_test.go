package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func TestApprovalInboxSessionHandlerBindsVerifiedSessionAndOrganization(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"accounting.post": true, "iam.admin": false, "*": false}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &fakeApprovalInboxReader{response: ApprovalInboxResponse{
		Approvals: []ApprovalInboxRow{},
		History:   []ApprovalInboxRow{},
	}}
	handler := NewApprovalInboxSessionHandler(resolver, reader, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/approvals?state=pending", nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session-cookie"})
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "{\"approvals\":[],\"history\":[]}\n" {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || resolver.cookie != "verified-session-cookie" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("cache-control=%q cookie=%q org=%q", response.Header().Get("Cache-Control"), resolver.cookie, resolver.activeOrg)
	}
	if reader.calls != 1 || reader.capabilities != nil || reader.claims.Subject != identity.UserID ||
		reader.claims.OrganizationID != *identity.OrgID || reader.claims.AuthSessionID != identity.AuthSessionID ||
		reader.claims.ActorType != "human" || reader.claims.ActorID == nil || *reader.claims.ActorID != identity.UserID ||
		len(reader.claims.Permissions) != 1 || reader.claims.Permissions[0] != "accounting.post" {
		t.Fatalf("reader calls=%d claims=%+v capabilities=%v", reader.calls, reader.claims, reader.capabilities)
	}
}

func TestApprovalInboxSessionHandlerRejectsUnverifiedIdentityAndNonGet(t *testing.T) {
	identity := directTestIdentity()
	identity.EmailVerified = false
	reader := &fakeApprovalInboxReader{}
	handler := NewApprovalInboxSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/approvals", nil))
	if response.Code != http.StatusUnauthorized || reader.calls != 0 {
		t.Fatalf("unverified identity status=%d reader calls=%d", response.Code, reader.calls)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/approvals", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet || reader.calls != 0 {
		t.Fatalf("POST status=%d allow=%q reader calls=%d", response.Code, response.Header().Get("Allow"), reader.calls)
	}
}

func TestMountGoApprovalsReadRouteOnlyHandlesExactGet(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoApprovalsReadRoute(legacy, routeMarker("go-approvals"))
	for _, test := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/approvals", "go-approvals"},
		{http.MethodGet, "/api/approvals?state=pending", "go-approvals"},
		{http.MethodHead, "/api/approvals", "legacy"},
		{http.MethodPost, "/api/approvals", "legacy"},
		{http.MethodGet, "/api/approvals/extra", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
}
