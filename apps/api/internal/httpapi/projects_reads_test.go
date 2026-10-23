package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const (
	projectsReadTestUserID = "11111111-1111-4111-8111-111111111111"
	projectsReadTestOrgID  = "22222222-2222-4222-8222-222222222222"
	projectsReadTestID     = "33333333-3333-4333-8333-333333333333"
)

type fakeProjectsReadExecutor struct {
	calls  int
	claims authbridge.CapabilityClaims
	capID  string
	input  json.RawMessage
	result capability.Result
	err    error
}

func (f *fakeProjectsReadExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capID string, input json.RawMessage) (capability.Result, error) {
	f.calls++
	f.claims = claims
	f.capID = capID
	f.input = append(json.RawMessage(nil), input...)
	return f.result, f.err
}

func projectsReadAssertion(t *testing.T, claims goProjectsReadAssertionClaims) string {
	t.Helper()
	now := time.Now().Unix()
	if claims.IssuedAt == 0 {
		claims.IssuedAt = now
	}
	if claims.ExpiresAt == 0 {
		claims.ExpiresAt = now + 30
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(assertionSecret))
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func validProjectsReadClaims(t *testing.T, capabilityID, input string) goProjectsReadAssertionClaims {
	t.Helper()
	hash, err := capability.InputHash(json.RawMessage(input))
	if err != nil {
		t.Fatal(err)
	}
	actorID := projectsReadTestUserID
	now := time.Now().Unix()
	return goProjectsReadAssertionClaims{
		Audience:       ProjectsReadAudience,
		Subject:        projectsReadTestUserID,
		OrganizationID: projectsReadTestOrgID,
		CapabilityID:   capabilityID,
		InputSHA256:    hash,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"projects.read"},
		AuthSessionID:  "verified-better-auth-session",
		IssuedAt:       now,
		ExpiresAt:      now + 30,
	}
}

func TestGoProjectsReadHandlerDispatchesListAndBoardWithExactInputs(t *testing.T) {
	for _, test := range []struct {
		name       string
		query      string
		capability string
		input      string
		response   string
	}{
		{
			name:       "collection list",
			capability: capability.ProjectCollectionReadCapabilityID,
			input:      `{}`,
			response:   `{"projects":[{"id":"` + projectsReadTestID + `","name":"Warehouse","status":"active","dueAt":null,"createdAt":"2026-08-10T14:30:01.123Z"}]}`,
		},
		{
			name:       "board",
			query:      "?projectId=" + projectsReadTestID,
			capability: capability.ProjectBoardReadCapabilityID,
			input:      `{"projectId":"` + projectsReadTestID + `"}`,
			response:   `{"columns":[{"status":"todo","tasks":[]},{"status":"doing","tasks":[]},{"status":"done","tasks":[]}]}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeProjectsReadExecutor{
				result: capability.Result{OK: true, Data: json.RawMessage(test.response)},
			}
			request := httptest.NewRequest(http.MethodGet, "/__go/projects"+test.query, nil)
			request.Header.Set(sessionAssertionHeader, projectsReadAssertion(t, validProjectsReadClaims(t, test.capability, test.input)))
			response := httptest.NewRecorder()
			NewGoProjectsReadHandler(assertionSecret, fake, nil).ServeHTTP(response, request)

			if response.Code != http.StatusOK || response.Body.String() != test.response+"\n" {
				t.Fatalf("status=%d body=%q, want 200 and %q", response.Code, response.Body.String(), test.response+"\n")
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control=%q, want no-store", response.Header().Get("Cache-Control"))
			}
			if fake.capID != test.capability || fake.claims.OrganizationID != projectsReadTestOrgID || fake.claims.Audience != authbridge.CapabilityExecuteAudience {
				t.Fatalf("executor cap=%q org=%q aud=%q", fake.capID, fake.claims.OrganizationID, fake.claims.Audience)
			}
			if fake.calls != 1 || string(fake.input) != test.input {
				t.Fatalf("calls=%d input=%s, want one dispatch with %s", fake.calls, fake.input, test.input)
			}
		})
	}
}

func TestGoProjectsReadHandlerRejectsInvalidAssertionsBeforeDispatch(t *testing.T) {
	boardInput := `{"projectId":"` + projectsReadTestID + `"}`
	for _, test := range []struct {
		name   string
		mutate func(*goProjectsReadAssertionClaims)
	}{
		{name: "wrong audience", mutate: func(c *goProjectsReadAssertionClaims) { c.Audience = authbridge.PolicyReadAudience }},
		{name: "malformed subject", mutate: func(c *goProjectsReadAssertionClaims) { c.Subject = "not-a-uuid" }},
		{name: "malformed organization", mutate: func(c *goProjectsReadAssertionClaims) { c.OrganizationID = "not-a-uuid" }},
		{name: "actor does not match subject", mutate: func(c *goProjectsReadAssertionClaims) { value := projectsReadTestOrgID; c.ActorID = &value }},
		{name: "unverified non-human actor", mutate: func(c *goProjectsReadAssertionClaims) { c.ActorType = "agent" }},
		{name: "missing auth session", mutate: func(c *goProjectsReadAssertionClaims) { c.AuthSessionID = " " }},
		{name: "unsorted grants", mutate: func(c *goProjectsReadAssertionClaims) { c.Permissions = []string{"projects.write", "projects.read"} }},
		{name: "duplicate grants", mutate: func(c *goProjectsReadAssertionClaims) { c.Permissions = []string{"projects.read", "projects.read"} }},
		{name: "assertion exceeds thirty seconds", mutate: func(c *goProjectsReadAssertionClaims) { c.ExpiresAt = c.IssuedAt + 31 }},
		{name: "expired assertion", mutate: func(c *goProjectsReadAssertionClaims) { c.ExpiresAt = time.Now().Unix() - 1 }},
		{name: "invalid digest", mutate: func(c *goProjectsReadAssertionClaims) { c.InputSHA256 = "not-a-sha256" }},
		{name: "digest mismatch", mutate: func(c *goProjectsReadAssertionClaims) { c.InputSHA256 = strings.Repeat("0", 64) }},
		{name: "operation mismatch", mutate: func(c *goProjectsReadAssertionClaims) { c.CapabilityID = capability.ProjectCollectionReadCapabilityID }},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeProjectsReadExecutor{}
			claims := validProjectsReadClaims(t, capability.ProjectBoardReadCapabilityID, boardInput)
			test.mutate(&claims)
			request := httptest.NewRequest(http.MethodGet, "/__go/projects?projectId="+projectsReadTestID, nil)
			request.Header.Set(sessionAssertionHeader, projectsReadAssertion(t, claims))
			response := httptest.NewRecorder()
			NewGoProjectsReadHandler(assertionSecret, fake, nil).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || fake.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s, want unauthorized and no dispatch", response.Code, fake.calls, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control=%q, want no-store", response.Header().Get("Cache-Control"))
			}
		})
	}
	for _, token := range []string{"", "malformed"} {
		fake := &fakeProjectsReadExecutor{}
		request := httptest.NewRequest(http.MethodGet, "/__go/projects", nil)
		if token != "" {
			request.Header.Set(sessionAssertionHeader, token)
		}
		response := httptest.NewRecorder()
		NewGoProjectsReadHandler(assertionSecret, fake, nil).ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || fake.calls != 0 {
			t.Fatalf("token %q status=%d calls=%d, want unauthorized without list", token, response.Code, fake.calls)
		}
	}
}

func TestGoProjectsReadHandlerRechecksSessionAndMapsAuthorizationFailures(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
	}{
		{name: "session invalidated", err: capability.ErrSessionInvalid, status: http.StatusUnauthorized},
		{name: "input scope mismatch", err: capability.ErrScopeMismatch, status: http.StatusUnauthorized},
		{name: "organization membership revoked", err: capability.ErrNotMember, status: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeProjectsReadExecutor{err: test.err}
			request := httptest.NewRequest(http.MethodGet, "/__go/projects", nil)
			request.Header.Set(sessionAssertionHeader, projectsReadAssertion(t, validProjectsReadClaims(t, capability.ProjectCollectionReadCapabilityID, `{}`)))
			response := httptest.NewRecorder()
			NewGoProjectsReadHandler(assertionSecret, fake, nil).ServeHTTP(response, request)
			if response.Code != test.status || fake.calls != 1 {
				t.Fatalf("status=%d calls=%d body=%s, want %d after backend recheck", response.Code, fake.calls, response.Body.String(), test.status)
			}
		})
	}

	fake := &fakeProjectsReadExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: projects.read"}}
	request := httptest.NewRequest(http.MethodGet, "/__go/projects", nil)
	request.Header.Set(sessionAssertionHeader, projectsReadAssertion(t, validProjectsReadClaims(t, capability.ProjectCollectionReadCapabilityID, `{}`)))
	response := httptest.NewRecorder()
	NewGoProjectsReadHandler(assertionSecret, fake, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || response.Body.String() != "{\"error\":\"forbidden: missing permission: projects.read\"}\n" {
		t.Fatalf("permission response status=%d body=%q, want a 403 with missing grant", response.Code, response.Body.String())
	}
}

func TestGoProjectsReadHandlerRejectsAmbiguousOrUnsupportedQueries(t *testing.T) {
	for _, rawQuery := range []string{"?projectId=a&projectId=b", "?other=1"} {
		fake := &fakeProjectsReadExecutor{}
		request := httptest.NewRequest(http.MethodGet, "/__go/projects"+rawQuery, nil)
		response := httptest.NewRecorder()
		NewGoProjectsReadHandler(assertionSecret, fake, nil).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || fake.calls != 0 {
			t.Fatalf("query %q status=%d calls=%d, want rejected before dispatch", rawQuery, response.Code, fake.calls)
		}
	}
	capabilityID, input, err := projectsReadRequest(url.Values{"projectId": {""}})
	if err != nil || capabilityID != capability.ProjectCollectionReadCapabilityID || string(input) != `{}` {
		t.Fatalf("empty projectId maps to %q %s err=%v, want legacy collection list", capabilityID, input, err)
	}
}

func TestGoProjectsReadHandlerIsRegisteredOnPrivateRouter(t *testing.T) {
	fake := &fakeProjectsReadExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"projects":[]}`)}}
	request := httptest.NewRequest(http.MethodGet, "/__go/projects", nil)
	request.Header.Set(sessionAssertionHeader, projectsReadAssertion(t, validProjectsReadClaims(t, capability.ProjectCollectionReadCapabilityID, `{}`)))
	response := httptest.NewRecorder()
	NewRouter(nil, nil, assertionSecret, nil, nil, nil, fake).ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s, want private route dispatch", response.Code, fake.calls, response.Body.String())
	}
}

func TestGoProjectsReadHandlerMapsBackendFailureToUnprocessable(t *testing.T) {
	fake := &fakeProjectsReadExecutor{err: errors.New("database unavailable")}
	request := httptest.NewRequest(http.MethodGet, "/__go/projects", nil)
	request.Header.Set(sessionAssertionHeader, projectsReadAssertion(t, validProjectsReadClaims(t, capability.ProjectCollectionReadCapabilityID, `{}`)))
	response := httptest.NewRecorder()
	NewGoProjectsReadHandler(assertionSecret, fake, nil).ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity || response.Body.String() != "{\"error\":\"database unavailable\"}\n" {
		t.Fatalf("status=%d body=%q, want fail-closed unprocessable", response.Code, response.Body.String())
	}
}
