package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const (
	teamSSOTestUserID = "11111111-1111-4111-8111-111111111111"
	teamSSOTestOrgID  = "22222222-2222-4222-8222-222222222222"
	teamSSOTestID     = "33333333-3333-4333-8333-333333333333"
)

type teamSSOResolverStub struct {
	resolved                                 *session.ResolvedUser
	err                                      error
	cookie, selector, bearer, bearerSelector string
}

func (stub *teamSSOResolverStub) Resolve(_ context.Context, cookie, selector string) (*session.ResolvedUser, error) {
	stub.cookie, stub.selector = cookie, selector
	return stub.resolved, stub.err
}
func (stub *teamSSOResolverStub) ResolveBearerToken(_ context.Context, bearer, selector string) (*session.ResolvedUser, error) {
	stub.bearer, stub.bearerSelector = bearer, selector
	return stub.resolved, stub.err
}

type teamSSORepositoryStub struct {
	connections []teamSSOConnection
	err         error
	listCalls   int
	orgID       string
}

func (stub *teamSSORepositoryStub) List(_ context.Context, orgID string) ([]teamSSOConnection, error) {
	stub.listCalls++
	stub.orgID = orgID
	return stub.connections, stub.err
}

type teamSSOExecutorStub struct {
	claims authbridge.CapabilityClaims
	id     string
	input  json.RawMessage
	result capability.Result
	err    error
	calls  int
}

func (stub *teamSSOExecutorStub) Execute(_ context.Context, claims authbridge.CapabilityClaims, id string, input json.RawMessage) (capability.Result, error) {
	stub.claims, stub.id, stub.input, stub.calls = claims, id, append(json.RawMessage(nil), input...), stub.calls+1
	if stub.err != nil {
		return capability.Result{}, stub.err
	}
	if stub.result.Data == nil {
		stub.result = capability.Result{OK: true, Data: json.RawMessage(`{"connectionId":"` + teamSSOTestID + `"}`)}
	}
	return stub.result, nil
}

func teamSSOResolved(permissions map[string]bool) *session.ResolvedUser {
	orgID := teamSSOTestOrgID
	return &session.ResolvedUser{UserID: teamSSOTestUserID, Email: "owner@example.test", OrgID: &orgID,
		Permissions: permissions, EmailVerified: true, AllOrgIDs: []string{orgID}, AuthSessionID: "authenticated-session"}
}
func teamSSORequest(method, target string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: teamSSOTestOrgID})
	if method == http.MethodPost || method == http.MethodDelete {
		request.Header.Set("Origin", "http://example.com")
		request.Host = "example.com"
	}
	return request
}
func teamSSOTestHandler(resolved *session.ResolvedUser, repo *teamSSORepositoryStub, executor *teamSSOExecutorStub) (*TeamSSOSessionHandler, *teamSSOResolverStub) {
	resolver := &teamSSOResolverStub{resolved: resolved}
	return &TeamSSOSessionHandler{resolver: resolver, repository: repo, executor: executor,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, resolver
}

func TestTeamSSOListRequiresIAMAdminAndOmitsCertificate(t *testing.T) {
	createdAt := time.Date(2026, time.October, 15, 8, 0, 0, 0, time.UTC)
	repo := &teamSSORepositoryStub{connections: []teamSSOConnection{{ID: teamSSOTestID, Protocol: "saml", Label: "Work IdP", IDPEntityID: "urn:example:idp", SSOURL: "https://idp.example.test/sso", Status: "active", CreatedAt: createdAt}}}
	handler, resolver := teamSSOTestHandler(teamSSOResolved(map[string]bool{"iam.admin": true}), repo, &teamSSOExecutorStub{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, teamSSORequest(http.MethodGet, "/api/team/sso", nil))
	if response.Code != http.StatusOK || repo.listCalls != 1 || repo.orgID != teamSSOTestOrgID {
		t.Fatalf("status=%d repo=%+v body=%s", response.Code, repo, response.Body.String())
	}
	if resolver.cookie != "signed-session-cookie" || resolver.selector != teamSSOTestOrgID {
		t.Fatalf("resolver=%+v", resolver)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("private cache headers missing: %v", response.Header())
	}
	if strings.Contains(response.Body.String(), "CERTIFICATE") || strings.Contains(response.Body.String(), "idpCertificate") {
		t.Fatalf("exposed certificate: %s", response.Body.String())
	}
	var body struct {
		Connections []teamSSOConnection `json:"connections"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.Connections) != 1 || body.Connections[0].ID != teamSSOTestID || !body.Connections[0].CreatedAt.Equal(createdAt) {
		t.Fatalf("connections=%+v err=%v", body, err)
	}
	deniedRepo := &teamSSORepositoryStub{}
	denied, _ := teamSSOTestHandler(teamSSOResolved(map[string]bool{"iam.read": true}), deniedRepo, &teamSSOExecutorStub{})
	deniedResponse := httptest.NewRecorder()
	denied.ServeHTTP(deniedResponse, teamSSORequest(http.MethodGet, "/api/team/sso", nil))
	if deniedResponse.Code != http.StatusForbidden || deniedRepo.listCalls != 0 {
		t.Fatalf("non-admin status=%d calls=%d", deniedResponse.Code, deniedRepo.listCalls)
	}
}

func TestTeamSSOWritesUseGovernedCapabilities(t *testing.T) {
	identity := teamSSOResolved(map[string]bool{"iam.admin": true})
	repo, executor := &teamSSORepositoryStub{}, &teamSSOExecutorStub{}
	handler, resolver := teamSSOTestHandler(identity, repo, executor)
	body := `{"intentId":"sso-create-fixture-01","protocol":"saml","label":" Work IdP ","idpEntityId":" urn:example:idp ","ssoUrl":"https://idp.example.test/sso","idpCertificate":"public cert","domain":"Example.Test"}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, teamSSORequest(http.MethodPost, "/api/team/sso", strings.NewReader(body)))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.id != capability.IAMCreateSSOConnectionCapabilityID {
		t.Fatalf("status=%d executor=%+v body=%s", response.Code, executor, response.Body.String())
	}
	if executor.claims.OrganizationID != teamSSOTestOrgID || executor.claims.ActorID == nil || *executor.claims.ActorID != teamSSOTestUserID || executor.claims.IntentID != "sso-create-fixture-01" || resolver.cookie != "signed-session-cookie" {
		t.Fatalf("claims=%+v resolver=%+v", executor.claims, resolver)
	}
	for _, expected := range []string{`"label":"Work IdP"`, `"idpEntityId":"urn:example:idp"`, `"domain":"example.test"`} {
		if !strings.Contains(string(executor.input), expected) {
			t.Fatalf("input %s missing %s", executor.input, expected)
		}
	}

	executor.calls = 0
	deleteBody := `{"intentId":"sso-disable-fixture-01","connectionId":"` + teamSSOTestID + `"}`
	deleteResponse := httptest.NewRecorder()
	handler.ServeHTTP(deleteResponse, teamSSORequest(http.MethodDelete, "/api/team/sso", strings.NewReader(deleteBody)))
	if deleteResponse.Code != http.StatusOK || executor.calls != 1 || executor.id != capability.IAMDisableSSOConnectionCapabilityID || !strings.Contains(string(executor.input), teamSSOTestID) {
		t.Fatalf("status=%d executor=%+v body=%s", deleteResponse.Code, executor, deleteResponse.Body.String())
	}
}

func TestTeamSSOWritesRejectMissingOrWrongOriginBeforeExecution(t *testing.T) {
	for _, origin := range []string{"", "https://attacker.example"} {
		t.Run("origin="+origin, func(t *testing.T) {
			executor := &teamSSOExecutorStub{}
			handler, _ := teamSSOTestHandler(teamSSOResolved(map[string]bool{"iam.admin": true}), &teamSSORepositoryStub{}, executor)
			req := teamSSORequest(http.MethodPost, "/api/team/sso", strings.NewReader(`{"intentId":"origin-check-01","protocol":"oidc","label":"IdP","idpEntityId":"issuer","ssoUrl":"https://idp.example.test/sso"}`))
			if origin == "" {
				req.Header.Del("Origin")
			} else {
				req.Header.Set("Origin", origin)
			}
			resp := httptest.NewRecorder()
			handler.ServeHTTP(resp, req)
			if resp.Code != http.StatusForbidden || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", resp.Code, executor.calls, resp.Body.String())
			}
		})
	}
}

func TestTeamSSORejectsInvalidAuthAndOrganizationSelectors(t *testing.T) {
	for _, selector := range []string{"invalid", "33333333-3333-4333-8333-333333333333"} {
		repo, executor := &teamSSORepositoryStub{}, &teamSSOExecutorStub{}
		handler, _ := teamSSOTestHandler(teamSSOResolved(map[string]bool{"iam.admin": true}), repo, executor)
		req := teamSSORequest(http.MethodGet, "/api/team/sso", nil)
		req.Header.Set("X-Organization-ID", selector)
		resp := httptest.NewRecorder()
		handler.ServeHTTP(resp, req)
		if resp.Code != http.StatusUnauthorized || repo.listCalls != 0 {
			t.Fatalf("selector=%q status=%d calls=%d", selector, resp.Code, repo.listCalls)
		}
	}
	unverified := teamSSOResolved(map[string]bool{"iam.admin": true})
	unverified.EmailVerified = false
	repo := &teamSSORepositoryStub{}
	handler, _ := teamSSOTestHandler(unverified, repo, &teamSSOExecutorStub{})
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, teamSSORequest(http.MethodGet, "/api/team/sso", nil))
	if resp.Code != http.StatusUnauthorized || repo.listCalls != 0 {
		t.Fatalf("unverified status=%d calls=%d", resp.Code, repo.listCalls)
	}
}

func TestTeamSSOWritesEnforceReadSizeBoundary(t *testing.T) {
	executor := &teamSSOExecutorStub{}
	handler, _ := teamSSOTestHandler(teamSSOResolved(map[string]bool{"iam.admin": true}), &teamSSORepositoryStub{}, executor)
	body := `{"intentId":"sso-size-boundary-01","protocol":"oidc","label":"IdP","idpEntityId":"issuer","ssoUrl":"https://idp.example.test/sso","padding":"` + strings.Repeat("x", teamSSOBodyLimit) + `"}`
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, teamSSORequest(http.MethodPost, "/api/team/sso", strings.NewReader(body)))
	if resp.Code != http.StatusBadRequest || executor.calls != 0 {
		t.Fatalf("oversize status=%d calls=%d body=%s", resp.Code, executor.calls, resp.Body.String())
	}
}

func TestTeamSSORouteDoesNotFallThroughForUnsupportedMethod(t *testing.T) {
	baseCalls := 0
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { baseCalls++; w.WriteHeader(http.StatusTeapot) })
	route := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusMethodNotAllowed) })
	response := httptest.NewRecorder()
	MountGoTeamSSORoute(base, route).ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/team/sso", nil))
	if response.Code != http.StatusMethodNotAllowed || baseCalls != 0 {
		t.Fatalf("status=%d base calls=%d", response.Code, baseCalls)
	}
}

func TestTeamSSORepositoryErrorsDoNotLeakDatabaseDetails(t *testing.T) {
	repo := &teamSSORepositoryStub{err: errors.New("database password must not appear")}
	handler, _ := teamSSOTestHandler(teamSSOResolved(map[string]bool{"iam.admin": true}), repo, &teamSSOExecutorStub{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, teamSSORequest(http.MethodGet, "/api/team/sso", nil))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database password") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
