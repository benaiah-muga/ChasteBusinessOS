package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const orgTestSecret = "org-route-test-secret-0123456789abcdef"

type stubOrgRepo struct {
	orgs      []OrgSummary
	members   map[string]bool
	soul      string
	listErr   error
	memberErr error
	soulErr   error
	setErr    error
	setCalls  int
}

func (s *stubOrgRepo) ListOrgsForUser(context.Context, string, []string) ([]OrgSummary, error) {
	return s.orgs, s.listErr
}
func (s *stubOrgRepo) IsMember(_ context.Context, _, orgID string) (bool, error) {
	if s.memberErr != nil {
		return false, s.memberErr
	}
	return s.members[orgID], nil
}
func (s *stubOrgRepo) AgentSoul(context.Context, string) (string, error) {
	return s.soul, s.soulErr
}
func (s *stubOrgRepo) SetAgentSoul(_ context.Context, _, soul string) error {
	s.setCalls++
	if s.setErr != nil {
		return s.setErr
	}
	s.soul = soul
	return nil
}

// newOrgTestHandler builds the handler with a session resolver whose decision is
// fixed, so the route's own logic can be exercised without a database.
func newOrgTestHandler(t *testing.T, repo OrgRepository, resolve func() (*session.ResolvedUser, error)) http.Handler {
	t.Helper()
	resolver := SessionResolverFunc(func(context.Context, string, string) (*session.ResolvedUser, error) {
		return resolve()
	})
	return NewOrgHandler(repo, resolver, orgTestSecret, nil)
}

func verifiedActor(orgID string, permissions ...string) *session.ResolvedUser {
	actor := &session.ResolvedUser{
		UserID:        "11111111-2222-4333-8444-555555555555",
		Email:         "ada@example.test",
		EmailVerified: true,
		Permissions:   map[string]bool{},
		AllOrgIDs:     []string{orgID},
	}
	if orgID != "" {
		id := orgID
		actor.OrgID = &id
	}
	for _, permission := range permissions {
		actor.Permissions[permission] = true
	}
	return actor
}

func orgRequest(t *testing.T, handler http.Handler, method, body string, cookies map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/api/org", reader)
	req.Header.Set("Content-Type", "application/json")
	for name, value := range cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %q", recorder.Body.String())
	}
	return out
}

func TestOrgGetListsMembershipsAndActiveOrg(t *testing.T) {
	orgA := "aaaaaaaa-0000-4000-8000-000000000001"
	orgB := "bbbbbbbb-0000-4000-8000-000000000002"
	repo := &stubOrgRepo{orgs: []OrgSummary{
		{ID: orgA, Name: "Org A", BaseCurrency: "USD"},
		{ID: orgB, Name: "Org B", BaseCurrency: "EUR"},
	}}
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor(orgB, "crm.read"), nil
	})

	recorder := orgRequest(t, handler, http.MethodGet, "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	body := decodeBody(t, recorder)
	if body["activeOrgId"] != orgB {
		t.Fatalf("activeOrgId = %v, want %s", body["activeOrgId"], orgB)
	}
	orgs, ok := body["orgs"].([]any)
	if !ok || len(orgs) != 2 {
		t.Fatalf("orgs = %v, want 2 entries", body["orgs"])
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache control = %q, want no-store", got)
	}
}

// An unverified mailbox legitimately holds no membership yet, so it sees an
// empty switcher rather than an error.
func TestOrgGetReturnsAnEmptySwitcherForUnverified(t *testing.T) {
	repo := &stubOrgRepo{orgs: []OrgSummary{{ID: "aaaaaaaa-0000-4000-8000-000000000001", Name: "Org A"}}}
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return &session.ResolvedUser{UserID: "u", EmailVerified: false, Permissions: map[string]bool{}}, nil
	})

	recorder := orgRequest(t, handler, http.MethodGet, "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	body := decodeBody(t, recorder)
	if body["activeOrgId"] != nil {
		t.Fatalf("activeOrgId = %v, want null", body["activeOrgId"])
	}
	orgs, ok := body["orgs"].([]any)
	if !ok || len(orgs) != 0 {
		t.Fatalf("orgs = %v, want an empty array", body["orgs"])
	}
}

// A nil slice must serialize as [] rather than null, or the client sees a shape
// change on the empty case.
func TestOrgGetSerializesNoMembershipsAsAnEmptyArray(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{}, func() (*session.ResolvedUser, error) {
		return &session.ResolvedUser{UserID: "u", EmailVerified: true, Permissions: map[string]bool{}}, nil
	})
	recorder := orgRequest(t, handler, http.MethodGet, "", nil)
	if !strings.Contains(recorder.Body.String(), `"orgs":[]`) {
		t.Fatalf("body = %q, want an empty orgs array", recorder.Body.String())
	}
}

func TestOrgGetRefusesWithoutASession(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{}, func() (*session.ResolvedUser, error) {
		return nil, session.ErrNoSession
	})
	recorder := orgRequest(t, handler, http.MethodGet, "", nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if decodeBody(t, recorder)["error"] != "unauthorized" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

// A repository fault must answer generically rather than leaking a schema detail.
func TestOrgGetHidesRepositoryErrors(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{listErr: context.DeadlineExceeded}, func() (*session.ResolvedUser, error) {
		return verifiedActor("aaaaaaaa-0000-4000-8000-000000000001"), nil
	})
	recorder := orgRequest(t, handler, http.MethodGet, "", nil)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "deadline") {
		t.Fatalf("body leaked the internal cause: %q", recorder.Body.String())
	}
}

func TestOrgPostSwitchesToAMemberOrganization(t *testing.T) {
	orgA := "aaaaaaaa-0000-4000-8000-000000000001"
	orgB := "bbbbbbbb-0000-4000-8000-000000000002"
	repo := &stubOrgRepo{members: map[string]bool{orgB: true}}
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor(orgA), nil
	})

	recorder := orgRequest(t, handler, http.MethodPost, `{"orgId":"`+orgB+`"}`, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}

	cookie := findSetCookie(t, recorder, session.ActiveOrgCookieName)
	if cookie.Value != orgB {
		t.Fatalf("cookie = %q, want %s", cookie.Value, orgB)
	}
	// The legacy app validates these exact attributes before trusting Go's switch.
	if cookie.Path != "/" {
		t.Errorf("cookie path = %q, want /", cookie.Path)
	}
	if !cookie.HttpOnly {
		t.Error("cookie is not HttpOnly")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("cookie SameSite = %v, want Lax", cookie.SameSite)
	}
	if cookie.MaxAge != activeOrgCookieMaxAge {
		t.Errorf("cookie MaxAge = %d, want %d", cookie.MaxAge, activeOrgCookieMaxAge)
	}
}

func TestOrgPostRefusesANonMember(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{members: map[string]bool{}}, func() (*session.ResolvedUser, error) {
		return verifiedActor("aaaaaaaa-0000-4000-8000-000000000001"), nil
	})
	recorder := orgRequest(t, handler, http.MethodPost,
		`{"orgId":"99999999-0000-4000-8000-0000000000ff"}`, nil)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if decodeBody(t, recorder)["error"] != "not a member of that organization" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
	// No cookie may be issued for a refused switch.
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == session.ActiveOrgCookieName {
			t.Fatal("a refused switch still issued a cookie")
		}
	}
}

func TestOrgPostRefusesAnUnverifiedMailbox(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{members: map[string]bool{"aaaaaaaa-0000-4000-8000-000000000001": true}},
		func() (*session.ResolvedUser, error) {
			return &session.ResolvedUser{UserID: "u", EmailVerified: false, Permissions: map[string]bool{}}, nil
		})
	recorder := orgRequest(t, handler, http.MethodPost,
		`{"orgId":"aaaaaaaa-0000-4000-8000-000000000001"}`, nil)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if decodeBody(t, recorder)["error"] != "email verification required" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestOrgPostRejectsMalformedBodies(t *testing.T) {
	valid := "aaaaaaaa-0000-4000-8000-000000000001"
	cases := []struct {
		name string
		body string
	}{
		{"empty", ``},
		{"not json", `nope`},
		{"missing field", `{}`},
		{"empty string", `{"orgId":""}`},
		{"not a uuid", `{"orgId":"not-a-uuid"}`},
		{"partial uuid", `{"orgId":"aaaaaaaa-0000-4000-8000"}`},
		{"uuid wrong length", `{"orgId":"aaaaaaaa-0000-4000-8000-00000000000"}`},
		{"trailing data", `{"orgId":"` + valid + `"}{}`},
		{"trailing json", `{"orgId":"` + valid + `"} {"orgId":"` + valid + `"}`},
		{"null", `null`},
		{"array", `[]`},
		{"wrong type", `{"orgId":123}`},
		{"nested object", `{"orgId":{"a":"` + valid + `"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := &stubOrgRepo{members: map[string]bool{valid: true}}
			handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
				return verifiedActor(valid), nil
			})
			recorder := orgRequest(t, handler, http.MethodPost, tc.body, nil)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 for %q", recorder.Code, tc.body)
			}
			for _, cookie := range recorder.Result().Cookies() {
				if cookie.Name == session.ActiveOrgCookieName {
					t.Fatal("a malformed body still issued a cookie")
				}
			}
		})
	}
}

func TestOrgPostRefusesWithoutASession(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{}, func() (*session.ResolvedUser, error) {
		return nil, session.ErrNoSession
	})
	recorder := orgRequest(t, handler, http.MethodPost,
		`{"orgId":"aaaaaaaa-0000-4000-8000-000000000001"}`, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestOrgPatchRequiresAdmin(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	repo := &stubOrgRepo{}

	// Without the permission the write must not happen.
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor(orgID, "crm.read"), nil
	})
	recorder := orgRequest(t, handler, http.MethodPatch, `{"agentSoul":"be helpful"}`, nil)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if repo.setCalls != 0 {
		t.Fatal("a non-admin triggered a write")
	}

	// With it, the write lands.
	handler = newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor(orgID, "iam.admin"), nil
	})
	recorder = orgRequest(t, handler, http.MethodPatch, `{"agentSoul":"be helpful"}`, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if repo.soul != "be helpful" {
		t.Fatalf("stored soul = %q", repo.soul)
	}
}

// Zod strips unknown keys rather than rejecting them, so a client that sends an
// extra field must succeed here exactly as it does against the legacy route.
func TestOrgPostIgnoresUnknownFields(t *testing.T) {
	valid := "aaaaaaaa-0000-4000-8000-000000000001"
	repo := &stubOrgRepo{members: map[string]bool{valid: true}}
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor(valid), nil
	})
	recorder := orgRequest(t, handler, http.MethodPost, `{"orgId":"`+valid+`","role":"owner"}`, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
}

func TestOrgPatchIgnoresUnknownFields(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	repo := &stubOrgRepo{}
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor(orgID, "iam.admin"), nil
	})
	recorder := orgRequest(t, handler, http.MethodPatch, `{"agentSoul":"x","extra":1}`, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if repo.soul != "x" {
		t.Fatalf("stored soul = %q, want x", repo.soul)
	}
}

// An actor with no organization must not be able to write a persona, because
// there is no tenant to scope it to.
func TestOrgPatchRefusesAnActorWithoutAnOrganization(t *testing.T) {
	repo := &stubOrgRepo{}
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor("", "iam.admin"), nil
	})
	recorder := orgRequest(t, handler, http.MethodPatch, `{"agentSoul":"be helpful"}`, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if repo.setCalls != 0 {
		t.Fatal("an actor without an organization triggered a write")
	}
}

func TestOrgPatchTrimsAndClearsThePersona(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	repo := &stubOrgRepo{}
	handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
		return verifiedActor(orgID, "iam.admin"), nil
	})

	for _, tc := range []struct{ name, in, want string }{
		{"trims surrounding space", "  be helpful  ", "be helpful"},
		{"whitespace clears", "   ", ""},
		{"empty clears", "", ""},
		{"preserves inner spacing", "be  helpful", "be  helpful"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := orgRequest(t, handler, http.MethodPatch,
				`{"agentSoul":`+mustJSONString(t, tc.in)+`}`, nil)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", recorder.Code)
			}
			if repo.soul != tc.want {
				t.Fatalf("stored soul = %q, want %q", repo.soul, tc.want)
			}
		})
	}
}

func TestOrgPatchRejectsMalformedBodies(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	long := strings.Repeat("a", maxSoulLength+1)
	cases := []struct {
		name string
		body string
	}{
		{"empty", ``},
		{"not json", `nope`},
		{"missing field", `{}`},
		{"null field", `{"agentSoul":null}`},
		{"wrong type", `{"agentSoul":42}`},
		{"too long", `{"agentSoul":"` + long + `"}`},
		{"trailing data", `{"agentSoul":"x"}{}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := &stubOrgRepo{}
			handler := newOrgTestHandler(t, repo, func() (*session.ResolvedUser, error) {
				return verifiedActor(orgID, "iam.admin"), nil
			})
			recorder := orgRequest(t, handler, http.MethodPatch, tc.body, nil)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 for %q", recorder.Code, tc.body)
			}
			if repo.setCalls != 0 {
				t.Fatal("a malformed body still triggered a write")
			}
		})
	}
}

func TestOrgPutReturnsThePersona(t *testing.T) {
	orgID := "aaaaaaaa-0000-4000-8000-000000000001"
	handler := newOrgTestHandler(t, &stubOrgRepo{soul: "be brief"}, func() (*session.ResolvedUser, error) {
		return verifiedActor(orgID, "crm.read"), nil
	})
	recorder := orgRequest(t, handler, http.MethodPut, "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if decodeBody(t, recorder)["agentSoul"] != "be brief" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestOrgPutRefusesAnActorWithoutAnOrganization(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{soul: "be brief"}, func() (*session.ResolvedUser, error) {
		return verifiedActor("", "crm.read"), nil
	})
	recorder := orgRequest(t, handler, http.MethodPut, "", nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestOrgRefusesUnsupportedMethods(t *testing.T) {
	handler := newOrgTestHandler(t, &stubOrgRepo{}, func() (*session.ResolvedUser, error) {
		return verifiedActor("aaaaaaaa-0000-4000-8000-000000000001"), nil
	})
	for _, method := range []string{http.MethodDelete, http.MethodHead, http.MethodOptions} {
		recorder := orgRequest(t, handler, method, "", nil)
		if recorder.Code == http.StatusOK {
			t.Fatalf("%s was accepted", method)
		}
	}
}

func findSetCookie(t *testing.T, recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("no %s cookie in %v", name, recorder.Result().Cookies())
	return nil
}

func mustJSONString(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
