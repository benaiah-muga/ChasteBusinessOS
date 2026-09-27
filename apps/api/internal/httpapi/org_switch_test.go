package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

const orgSwitchSubject = "3cb98ed4-f31e-4d94-9c8e-e47ce8a216d7"
const orgSwitchTarget = "eef7d82f-8c44-454d-86e2-ed8195852fa9"
const orgSwitchOther = "8d74001f-8c3f-4951-8bf3-86eb941f1e31"

type fakeOrgMembershipChecker struct {
	userID string
	orgID  string
	member bool
	err    error
	calls  int
}

func (c *fakeOrgMembershipChecker) IsMember(_ context.Context, userID, orgID string) (bool, error) {
	c.calls++
	c.userID = userID
	c.orgID = orgID
	return c.member, c.err
}

func orgSwitchAssertion(t *testing.T, claims authbridge.Claims) string {
	t.Helper()
	claims.IssuedAt = time.Now().Unix()
	claims.ExpiresAt = time.Now().Add(30 * time.Second).Unix()
	assertion, err := authbridge.Sign(assertionSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	return assertion
}

func orgSwitchRequest(t *testing.T, body string, claims authbridge.Claims) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/__go/org/switch", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if claims.Audience != "" {
		request.Header.Set(sessionAssertionHeader, orgSwitchAssertion(t, claims))
	}
	return request
}

func validOrgSwitchClaims() authbridge.Claims {
	return authbridge.Claims{
		Audience:       authbridge.OrgSwitchAudience,
		Subject:        orgSwitchSubject,
		OrganizationID: orgSwitchTarget,
	}
}

func TestGoOrgSwitchHandlerSetsExistingCookieForMember(t *testing.T) {
	checker := &fakeOrgMembershipChecker{member: true}
	request := orgSwitchRequest(t, `{"orgId":"`+orgSwitchTarget+`"}`, validOrgSwitchClaims())
	response := httptest.NewRecorder()
	NewGoOrgSwitchHandler(assertionSecret, checker, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if got, want := response.Body.String(), "{\"ok\":true}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if checker.calls != 1 || checker.userID != orgSwitchSubject || checker.orgID != orgSwitchTarget {
		t.Fatalf("membership check was user=%q org=%q calls=%d", checker.userID, checker.orgID, checker.calls)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %#v, want exactly one active-org cookie", cookies)
	}
	cookie := cookies[0]
	if cookie.Name != "chaste_active_org" || cookie.Value != orgSwitchTarget || cookie.Path != "/" ||
		cookie.MaxAge != 60*60*24*90 || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode ||
		cookie.Secure || cookie.Domain != "" || !cookie.Expires.IsZero() {
		t.Fatalf("cookie = %#v, want legacy active-org attributes", cookie)
	}
	if got, want := response.Header().Get("Set-Cookie"), "chaste_active_org="+orgSwitchTarget+"; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax"; got != want {
		t.Fatalf("Set-Cookie = %q, want %q", got, want)
	}
}

func TestGoOrgSwitchHandlerRejectsMissingAndWrongAudienceAssertions(t *testing.T) {
	for _, test := range []struct {
		name   string
		claims authbridge.Claims
	}{
		{name: "missing assertion"},
		{name: "wrong audience", claims: authbridge.Claims{
			Audience:       authbridge.LedgerReadAudience,
			Subject:        orgSwitchSubject,
			OrganizationID: orgSwitchTarget,
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			checker := &fakeOrgMembershipChecker{member: true}
			request := orgSwitchRequest(t, `{"orgId":"`+orgSwitchTarget+`"}`, test.claims)
			response := httptest.NewRecorder()
			NewGoOrgSwitchHandler(assertionSecret, checker, nil).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || checker.calls != 0 || response.Header().Get("Set-Cookie") != "" {
				t.Fatalf("status=%d calls=%d cookie=%q, want unauthorized before membership or cookie", response.Code, checker.calls, response.Header().Get("Set-Cookie"))
			}
		})
	}
}

func TestGoOrgSwitchHandlerRejectsInvalidBodyAndClaimMismatch(t *testing.T) {
	for _, test := range []struct {
		name   string
		body   string
		claims authbridge.Claims
	}{
		{name: "malformed json", body: `{"orgId":`, claims: validOrgSwitchClaims()},
		{name: "missing org id", body: `{}`, claims: validOrgSwitchClaims()},
		{name: "invalid uuid", body: `{"orgId":"not-a-uuid"}`, claims: validOrgSwitchClaims()},
		{name: "target differs from signed claim", body: `{"orgId":"` + orgSwitchOther + `"}`, claims: validOrgSwitchClaims()},
		{name: "unknown field", body: `{"orgId":"` + orgSwitchTarget + `","extra":true}`, claims: validOrgSwitchClaims()},
		{name: "trailing json", body: `{"orgId":"` + orgSwitchTarget + `"}{}`, claims: validOrgSwitchClaims()},
	} {
		t.Run(test.name, func(t *testing.T) {
			checker := &fakeOrgMembershipChecker{member: true}
			request := orgSwitchRequest(t, test.body, test.claims)
			response := httptest.NewRecorder()
			NewGoOrgSwitchHandler(assertionSecret, checker, nil).ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || checker.calls != 0 || response.Header().Get("Set-Cookie") != "" {
				t.Fatalf("status=%d calls=%d cookie=%q, want bad request before membership or cookie", response.Code, checker.calls, response.Header().Get("Set-Cookie"))
			}
		})
	}
}

func TestGoOrgSwitchHandlerRejectsNonmemberWithoutCookie(t *testing.T) {
	checker := &fakeOrgMembershipChecker{member: false}
	request := orgSwitchRequest(t, `{"orgId":"`+orgSwitchTarget+`"}`, validOrgSwitchClaims())
	response := httptest.NewRecorder()
	NewGoOrgSwitchHandler(assertionSecret, checker, nil).ServeHTTP(response, request)

	if response.Code != http.StatusForbidden || checker.calls != 1 || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("status=%d calls=%d cookie=%q, want forbidden and no cookie", response.Code, checker.calls, response.Header().Get("Set-Cookie"))
	}
	if got, want := response.Body.String(), "{\"error\":\"not a member of that organization\"}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestGoOrgSwitchHandlerHidesMembershipDatabaseErrors(t *testing.T) {
	checker := &fakeOrgMembershipChecker{err: errors.New("private database detail")}
	request := orgSwitchRequest(t, `{"orgId":"`+orgSwitchTarget+`"}`, validOrgSwitchClaims())
	response := httptest.NewRecorder()
	NewGoOrgSwitchHandler(assertionSecret, checker, nil).ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database detail") || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("status=%d body=%q cookie=%q, want hidden internal error and no cookie", response.Code, response.Body.String(), response.Header().Get("Set-Cookie"))
	}
}

func TestGoOrgSwitchHandlerRequiresBridgeConfiguration(t *testing.T) {
	for _, test := range []struct {
		name    string
		secret  string
		checker OrgMembershipChecker
	}{
		{name: "missing secret", checker: &fakeOrgMembershipChecker{member: true}},
		{name: "missing checker", secret: assertionSecret},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			NewGoOrgSwitchHandler(test.secret, test.checker, nil).ServeHTTP(response,
				orgSwitchRequest(t, `{"orgId":"`+orgSwitchTarget+`"}`, validOrgSwitchClaims()))
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
			}
		})
	}
}

func TestGoOrgSwitchHandlerRejectsInvalidSignedIDs(t *testing.T) {
	for _, test := range []struct {
		name   string
		claims authbridge.Claims
	}{
		{name: "invalid subject", claims: authbridge.Claims{Audience: authbridge.OrgSwitchAudience, Subject: "not-a-uuid", OrganizationID: orgSwitchTarget}},
		{name: "invalid organization", claims: authbridge.Claims{Audience: authbridge.OrgSwitchAudience, Subject: orgSwitchSubject, OrganizationID: "not-a-uuid"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			checker := &fakeOrgMembershipChecker{member: true}
			request := orgSwitchRequest(t, `{"orgId":"`+orgSwitchTarget+`"}`, test.claims)
			response := httptest.NewRecorder()
			NewGoOrgSwitchHandler(assertionSecret, checker, nil).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || checker.calls != 0 || response.Header().Get("Set-Cookie") != "" {
				t.Fatalf("status=%d calls=%d cookie=%q, want unauthorized before membership or cookie", response.Code, checker.calls, response.Header().Get("Set-Cookie"))
			}
		})
	}
}

func TestRouterRegistersOnlyInternalOrgSwitchPost(t *testing.T) {
	checker := &fakeOrgMembershipChecker{member: true}
	router := NewRouter(fakePinger{}, nil, assertionSecret, nil, nil, checker, nil)

	post := httptest.NewRecorder()
	router.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/__go/org/switch", strings.NewReader(`{"orgId":"`+orgSwitchTarget+`"}`)))
	if post.Code != http.StatusUnauthorized {
		t.Fatalf("internal POST status = %d, want %d without assertion", post.Code, http.StatusUnauthorized)
	}

	get := httptest.NewRecorder()
	router.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/__go/org/switch", nil))
	if get.Code != http.StatusMethodNotAllowed {
		t.Fatalf("internal GET status = %d, want %d", get.Code, http.StatusMethodNotAllowed)
	}

	public := httptest.NewRecorder()
	router.ServeHTTP(public, httptest.NewRequest(http.MethodPost, "/api/org", nil))
	if public.Code != http.StatusNotFound {
		t.Fatalf("public route status = %d, want %d because route ownership is unchanged", public.Code, http.StatusNotFound)
	}
}
