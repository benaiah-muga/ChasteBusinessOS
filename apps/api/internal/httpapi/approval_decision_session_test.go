package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeApprovalSessionDecider struct {
	userID, orgID, authSessionID string
	permissions                  []string
	input                        capability.ApprovalDecisionInput
	result                       capability.ApprovalDecisionResult
	err                          error
	calls                        int
}

func directApprovalDecisionIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	orgID := approvalDecisionOrg
	identity.OrgID = &orgID
	return identity
}

func (d *fakeApprovalSessionDecider) DecideForSession(_ context.Context, userID, orgID, authSessionID string, permissions []string, input capability.ApprovalDecisionInput) (capability.ApprovalDecisionResult, error) {
	d.calls++
	d.userID, d.orgID, d.authSessionID = userID, orgID, authSessionID
	d.permissions, d.input = permissions, input
	return d.result, d.err
}

func directApprovalDecisionRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/approvals?id="+approvalDecisionID, strings.NewReader(body))
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "verified-session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: approvalDecisionOrg})
	r.Header.Set("Origin", "https://app.example.test")
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestApprovalDecisionSessionHandlerBindsVerifiedSessionAndParsesDecision(t *testing.T) {
	identity := directApprovalDecisionIdentity()
	identity.Permissions = map[string]bool{"accounting.post": true, "iam.admin": false}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	decider := &fakeApprovalSessionDecider{result: capability.ApprovalDecisionResult{OK: true, Status: "rejected", HTTPStatus: http.StatusOK}}
	handler := NewApprovalDecisionSessionHandler(resolver, decider, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, directApprovalDecisionRequest(`{"decision":"reject","comment":"Reviewed evidence"}`))

	if response.Code != http.StatusOK || response.Body.String() != "{\"ok\":true,\"status\":\"rejected\"}\n" {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || resolver.cookie != "verified-session-cookie" || resolver.activeOrg != approvalDecisionOrg {
		t.Fatalf("cache=%q cookie=%q org=%q", response.Header().Get("Cache-Control"), resolver.cookie, resolver.activeOrg)
	}
	if decider.calls != 1 || decider.userID != identity.UserID || decider.orgID != approvalDecisionOrg || decider.authSessionID != identity.AuthSessionID ||
		len(decider.permissions) != 1 || decider.permissions[0] != "accounting.post" || decider.input.ApprovalID != approvalDecisionID ||
		decider.input.Decision != "reject" || decider.input.Comment == nil || *decider.input.Comment != "Reviewed evidence" {
		t.Fatalf("decider calls=%d user=%q org=%q session=%q permissions=%v input=%+v", decider.calls, decider.userID, decider.orgID, decider.authSessionID, decider.permissions, decider.input)
	}
}

func TestApprovalDecisionSessionHandlerPreservesRawJSONInGeneratedResponse(t *testing.T) {
	identity := directApprovalDecisionIdentity()
	decider := &fakeApprovalSessionDecider{result: capability.ApprovalDecisionResult{
		OK:         true,
		Status:     "executed",
		Result:     &capability.Result{OK: true, Data: json.RawMessage(`{"exact":9007199254740993}`)},
		HTTPStatus: http.StatusOK,
	}}
	handler := NewApprovalDecisionSessionHandler(&fakeDirectSessionResolver{resolved: identity}, decider, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, directApprovalDecisionRequest(`{"decision":"approve"}`))

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"exact":9007199254740993`) {
		t.Fatalf("status=%d body=%q, want generated response to preserve raw integer JSON", response.Code, response.Body.String())
	}
}

func TestApprovalDecisionSessionHandlerRequiresVerifiedSameOriginSession(t *testing.T) {
	identity := directApprovalDecisionIdentity()
	identity.EmailVerified = false
	decider := &fakeApprovalSessionDecider{}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	decider.result = capability.ApprovalDecisionResult{OK: true, Status: "rejected", HTTPStatus: http.StatusOK}
	handler := NewApprovalDecisionSessionHandler(resolver, decider, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, directApprovalDecisionRequest(`{"decision":"approve"}`))
	if response.Code != http.StatusUnauthorized || decider.calls != 0 {
		t.Fatalf("unverified identity status=%d calls=%d", response.Code, decider.calls)
	}

	identity.EmailVerified = true
	response = httptest.NewRecorder()
	request := directApprovalDecisionRequest(`{"decision":"approve"}`)
	request.Header.Del("Origin")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || decider.calls != 0 {
		t.Fatalf("cross-site cookie decision status=%d calls=%d", response.Code, decider.calls)
	}

	response = httptest.NewRecorder()
	request = directApprovalDecisionRequest(`{"decision":"approve"}`)
	request.Header.Set("Authorization", "Bearer verified-token")
	request.Header.Del("Origin")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || decider.calls != 1 || resolver.bearer != "verified-token" || resolver.bearerCalls != 1 {
		t.Fatalf("bearer decision status=%d calls=%d", response.Code, decider.calls)
	}
}

func TestApprovalDecisionSessionHandlerRejectsMalformedOrOversizedRequests(t *testing.T) {
	identity := directApprovalDecisionIdentity()
	decider := &fakeApprovalSessionDecider{}
	handler := NewApprovalDecisionSessionHandler(&fakeDirectSessionResolver{resolved: identity}, decider, nil)
	for _, body := range []string{
		`{"decision":"approve","unexpected":true}`,
		`{"decision":"approve","comment":null}`,
		`{"decision":"maybe"}`,
		`{"decision":"reject"} {}`,
		`{"decision":"approve","comment":"` + strings.Repeat("x", 1999) + "😀" + `"}`,
		`{"decision":"approve","comment":"` + strings.Repeat("😀", 1001) + `"}`,
		`{"decision":"approve","comment":"` + strings.Repeat("x", 17000) + `"}`,
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directApprovalDecisionRequest(body))
		if response.Code != http.StatusBadRequest || decider.calls != 0 {
			t.Errorf("body prefix=%q status=%d calls=%d, want invalid request and no dispatch", body[:min(len(body), 48)], response.Code, decider.calls)
		}
	}
	response := httptest.NewRecorder()
	request := directApprovalDecisionRequest(`{"decision":"approve"}`)
	request.URL.RawQuery = "id=" + approvalDecisionID + "&id=" + approvalDecisionID
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || decider.calls != 0 {
		t.Fatalf("duplicate id status=%d calls=%d", response.Code, decider.calls)
	}
}

func TestApprovalDecisionSessionHandlerAcceptsCommentAtTwoThousandUTF16Units(t *testing.T) {
	identity := directApprovalDecisionIdentity()
	decider := &fakeApprovalSessionDecider{result: capability.ApprovalDecisionResult{OK: true, Status: "rejected", HTTPStatus: http.StatusOK}}
	handler := NewApprovalDecisionSessionHandler(&fakeDirectSessionResolver{resolved: identity}, decider, nil)
	comment := strings.Repeat("😀", 1000)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, directApprovalDecisionRequest(`{"decision":"reject","comment":"`+comment+`"}`))
	if response.Code != http.StatusOK || decider.calls != 1 || decider.input.Comment == nil || *decider.input.Comment != comment {
		t.Fatalf("2000 UTF-16 unit comment status=%d calls=%d comment length=%d", response.Code, decider.calls, len(comment))
	}
}

func TestMountGoApprovalsDecisionRouteOnlyHandlesExactPost(t *testing.T) {
	legacy := routeMarker("legacy")
	handler := MountGoApprovalsDecisionRoute(legacy, routeMarker("go-approval-decision"))
	for _, test := range []struct{ method, path, want string }{
		{http.MethodPost, "/api/approvals?id=" + approvalDecisionID, "go-approval-decision"},
		{http.MethodGet, "/api/approvals", "legacy"},
		{http.MethodHead, "/api/approvals", "legacy"},
		{http.MethodPut, "/api/approvals", "legacy"},
		{http.MethodPost, "/api/approvals/extra", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Errorf("%s %s response=%d %q want 200 %q", test.method, test.path, response.Code, response.Body.String(), test.want)
		}
	}
}
