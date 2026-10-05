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

type supportChannelsTestResolver struct {
	resolved *session.ResolvedUser
	err      error
}

func (r supportChannelsTestResolver) Resolve(context.Context, string, string) (*session.ResolvedUser, error) {
	return r.resolved, r.err
}

type supportChannelsTestStore struct {
	data       supportChannelsData
	patch      supportChannelsPatch
	token      string
	readCalls  int
	writeCalls int
}

func (s *supportChannelsTestStore) Read(context.Context, string, string) (supportChannelsData, error) {
	s.readCalls++
	return s.data, nil
}

func (s *supportChannelsTestStore) Upsert(_ context.Context, _, _ string, patch supportChannelsPatch, token string) (supportChannelsData, error) {
	s.writeCalls++
	if !s.data.CanManage {
		return s.data, nil
	}
	s.patch = patch
	s.token = token
	if patch.AutoReplyEnabled != nil {
		s.data.AutoReplyEnabled = *patch.AutoReplyEnabled
	}
	if patch.Greeting != nil {
		s.data.Greeting = *patch.Greeting
	}
	if patch.RegenerateToken != nil && *patch.RegenerateToken {
		s.data.EmbedToken = &token
	}
	return s.data, nil
}

func TestSupportChannelsGetHidesEmbedTokenFromNonAdmin(t *testing.T) {
	token := "private-embed-token"
	store := &supportChannelsTestStore{data: supportChannelsData{
		AutoReplyEnabled: true, Greeting: "Welcome", EmbedToken: &token,
		Member: true, ModuleEnabled: true, CanManage: false,
	}}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(false)}, nil, nil)
	recorder := requestChannels(handler, http.MethodGet, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["canManage"] != false || response["embedToken"] != nil || response["greeting"] != "Welcome" {
		t.Fatalf("GET response=%v, token must be hidden from non-admin", response)
	}
	if recorder.Header().Get("Cache-Control") != "no-store" || store.readCalls != 1 {
		t.Fatalf("cache=%q read calls=%d", recorder.Header().Get("Cache-Control"), store.readCalls)
	}
}

func TestSupportChannelsGetRequiresSessionMembershipAndModule(t *testing.T) {
	t.Run("no session", func(t *testing.T) {
		handler := newSupportChannelsHandler(&supportChannelsTestStore{}, supportChannelsTestResolver{err: session.ErrNoSession}, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("unverified or no active org", func(t *testing.T) {
		user := channelsTestUser(true)
		user.EmailVerified = false
		store := &supportChannelsTestStore{}
		handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: user}, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusUnauthorized || store.readCalls != 0 {
			t.Fatalf("status=%d read calls=%d", recorder.Code, store.readCalls)
		}
	})
	t.Run("revoked membership", func(t *testing.T) {
		store := &supportChannelsTestStore{data: supportChannelsData{Member: false, ModuleEnabled: true}}
		handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("support module disabled", func(t *testing.T) {
		store := &supportChannelsTestStore{data: supportChannelsData{Member: true, ModuleEnabled: false}}
		handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestSupportChannelsRejectsUnmatchedOrganizationSelector(t *testing.T) {
	store := &supportChannelsTestStore{data: supportChannelsData{Member: true, ModuleEnabled: true, CanManage: true}}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, nil, nil)
	request := httptest.NewRequest(http.MethodGet, "http://example.test/api/support/channels", nil)
	request.Header.Set("X-Organization-ID", "bbbbbbbb-0000-4000-8000-000000000002")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-cookie"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || store.readCalls != 0 {
		t.Fatalf("status=%d reads=%d body=%s", response.Code, store.readCalls, response.Body.String())
	}
}

func TestSupportChannelsPostRequiresOriginAndAdmin(t *testing.T) {
	store := &supportChannelsTestStore{data: supportChannelsData{Member: true, ModuleEnabled: true, CanManage: false}}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(false)}, nil, nil)
	withoutOrigin := requestChannels(handler, http.MethodPost, `{ "greeting": "Hello" }`, "")
	if withoutOrigin.Code != http.StatusForbidden || store.writeCalls != 0 {
		t.Fatalf("missing origin status=%d writes=%d", withoutOrigin.Code, store.writeCalls)
	}
	crossOrigin := requestChannels(handler, http.MethodPost, `{ "greeting": "Hello" }`, "https://attacker.example")
	if crossOrigin.Code != http.StatusForbidden || store.writeCalls != 0 {
		t.Fatalf("cross origin status=%d writes=%d", crossOrigin.Code, store.writeCalls)
	}
	forbidden := requestChannels(handler, http.MethodPost, `{ "greeting": "Hello" }`, "http://example.test")
	if forbidden.Code != http.StatusForbidden || store.writeCalls != 1 || store.data.Greeting != "" {
		t.Fatalf("non-admin status=%d writes=%d body=%s", forbidden.Code, store.writeCalls, forbidden.Body.String())
	}
}

func TestSupportChannelsPostValidatesPatchAndTrimsGreeting(t *testing.T) {
	store := &supportChannelsTestStore{data: supportChannelsData{Member: true, ModuleEnabled: true, CanManage: true}}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, nil, nil)
	for _, body := range []string{
		`{"unknown":true}`,
		`{"greeting":null}`,
		`{"autoReplyEnabled":null}`,
		`{"regenerateToken":"true"}`,
		`{"greeting":""}`,
		`{"greeting":"` + strings.Repeat("x", 301) + `"}`,
		`{"greeting":"Hello"} {}`,
	} {
		recorder := requestChannels(handler, http.MethodPost, body, "http://example.test")
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("body %q status=%d want 400", body, recorder.Code)
		}
	}
	if store.writeCalls != 0 {
		t.Fatalf("invalid patches reached storage %d times", store.writeCalls)
	}
	valid := requestChannels(handler, http.MethodPost, `{"autoReplyEnabled":false,"greeting":"  Hello there  ","regenerateToken":true}`, "http://example.test")
	if valid.Code != http.StatusOK {
		t.Fatalf("valid patch status=%d body=%s", valid.Code, valid.Body.String())
	}
	if store.writeCalls != 1 || store.patch.Greeting == nil || *store.patch.Greeting != "Hello there" || store.patch.AutoReplyEnabled == nil || *store.patch.AutoReplyEnabled || store.patch.RegenerateToken == nil || !*store.patch.RegenerateToken {
		t.Fatalf("stored patch=%+v calls=%d", store.patch, store.writeCalls)
	}
	if len(store.token) != 64 || strings.Trim(store.token, "0123456789abcdef") != "" {
		t.Fatalf("generated embed token=%q, want 32 bytes of hex entropy", store.token)
	}
}

func channelsTestUser(admin bool) *session.ResolvedUser {
	orgID := "10000000-0000-4000-8000-000000000001"
	permissions := map[string]bool{}
	if admin {
		permissions["iam.admin"] = true
	}
	return &session.ResolvedUser{UserID: "20000000-0000-4000-8000-000000000002", OrgID: &orgID, EmailVerified: true, Permissions: permissions}
}

func requestChannels(handler http.Handler, method, body, origin string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://example.test/api/support/channels", strings.NewReader(body))
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-cookie"})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}
