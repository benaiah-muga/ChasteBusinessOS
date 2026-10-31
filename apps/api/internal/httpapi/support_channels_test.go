package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
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
	data      supportChannelsData
	readCalls int
}

func (s *supportChannelsTestStore) Read(context.Context, string, string) (supportChannelsData, error) {
	s.readCalls++
	return s.data, nil
}

type supportChannelsTestExecutor struct {
	calls       int
	effectCalls int
	claims      authbridge.CapabilityClaims
	input       json.RawMessage
	result      capability.Result
	replays     map[string]capability.Result
}

func (e *supportChannelsTestExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	e.calls++
	e.claims = claims
	e.input = input
	if capabilityID != "support.updateChannelSettings" {
		return capability.Result{}, nil
	}
	if e.replays == nil {
		e.replays = map[string]capability.Result{}
	}
	if prior, found := e.replays[claims.IntentID]; found {
		prior.Replayed = true
		return prior, nil
	}
	if !hasSupportChannelPermission(claims.Permissions, "iam.admin") {
		return capability.Result{OK: false, Error: "forbidden: missing permission: iam.admin"}, nil
	}
	e.effectCalls++
	result := e.result
	if result.Data == nil && result.Error == "" {
		result = capability.Result{OK: true, Data: json.RawMessage(`{"previous":null,"current":{"autoReplyEnabled":false,"greeting":"Hello there","embedToken":"` + strings.Repeat("a", 64) + `"}}`)}
	}
	e.replays[claims.IntentID] = result
	return result, nil
}

func hasSupportChannelPermission(permissions []string, expected string) bool {
	for _, permission := range permissions {
		if permission == expected || permission == "*" {
			return true
		}
	}
	return false
}

func TestSupportChannelsGetHidesEmbedTokenFromNonAdmin(t *testing.T) {
	token := "private-embed-token"
	store := &supportChannelsTestStore{data: supportChannelsData{
		AutoReplyEnabled: true, Greeting: "Welcome", EmbedToken: &token,
		Member: true, ModuleEnabled: true, CanManage: false,
	}}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(false)}, nil, nil, nil)
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
		handler := newSupportChannelsHandler(&supportChannelsTestStore{}, supportChannelsTestResolver{err: session.ErrNoSession}, nil, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("unverified or no active org", func(t *testing.T) {
		user := channelsTestUser(true)
		user.EmailVerified = false
		store := &supportChannelsTestStore{}
		handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: user}, nil, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusUnauthorized || store.readCalls != 0 {
			t.Fatalf("status=%d read calls=%d", recorder.Code, store.readCalls)
		}
	})
	t.Run("revoked membership", func(t *testing.T) {
		store := &supportChannelsTestStore{data: supportChannelsData{Member: false, ModuleEnabled: true}}
		handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, nil, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("support module disabled", func(t *testing.T) {
		store := &supportChannelsTestStore{data: supportChannelsData{Member: true, ModuleEnabled: false}}
		handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, nil, nil, nil)
		recorder := requestChannels(handler, http.MethodGet, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestSupportChannelsRejectsUnmatchedOrganizationSelector(t *testing.T) {
	store := &supportChannelsTestStore{data: supportChannelsData{Member: true, ModuleEnabled: true, CanManage: true}}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, nil, nil, nil)
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
	executor := &supportChannelsTestExecutor{}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(false)}, executor, nil, nil)
	withoutOrigin := requestChannels(handler, http.MethodPost, `{ "greeting": "Hello" }`, "")
	if withoutOrigin.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("missing origin status=%d calls=%d", withoutOrigin.Code, executor.calls)
	}
	crossOrigin := requestChannels(handler, http.MethodPost, `{ "greeting": "Hello" }`, "https://attacker.example")
	if crossOrigin.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("cross origin status=%d calls=%d", crossOrigin.Code, executor.calls)
	}
	forbidden := requestChannels(handler, http.MethodPost, `{ "greeting": "Hello" }`, "http://example.test")
	if forbidden.Code != http.StatusForbidden || executor.calls != 1 || store.data.Greeting != "" {
		t.Fatalf("non-admin status=%d calls=%d body=%s", forbidden.Code, executor.calls, forbidden.Body.String())
	}
}

func TestSupportChannelsPostValidatesPatchAndTrimsGreeting(t *testing.T) {
	store := &supportChannelsTestStore{data: supportChannelsData{Member: true, ModuleEnabled: true, CanManage: true}}
	executor := &supportChannelsTestExecutor{}
	handler := newSupportChannelsHandler(store, supportChannelsTestResolver{resolved: channelsTestUser(true)}, executor, nil, nil)
	for _, body := range []string{
		`{}`,
		`{"unknown":true}`,
		`{"greeting":null}`,
		`{"autoReplyEnabled":null}`,
		`{"regenerateToken":"true"}`,
		`{"regenerateToken":false}`,
		`{"greeting":""}`,
		`{"greeting":"` + strings.Repeat("x", 301) + `"}`,
		`{"greeting":"Hello"} {}`,
	} {
		recorder := requestChannels(handler, http.MethodPost, body, "http://example.test")
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("body %q status=%d want 400", body, recorder.Code)
		}
	}
	if executor.calls != 0 {
		t.Fatalf("invalid patches reached capability executor %d times", executor.calls)
	}
	valid := requestChannels(handler, http.MethodPost, `{"autoReplyEnabled":false,"greeting":"  Hello there  ","regenerateToken":true}`, "http://example.test")
	if valid.Code != http.StatusOK {
		t.Fatalf("valid patch status=%d body=%s", valid.Code, valid.Body.String())
	}
	if executor.calls != 1 || executor.effectCalls != 1 || executor.claims.CapabilityID != "support.updateChannelSettings" || executor.claims.IntentID == "" {
		t.Fatalf("capability claims=%+v calls=%d", executor.claims, executor.calls)
	}
	var patch supportChannelsPatch
	if err := json.Unmarshal(executor.input, &patch); err != nil {
		t.Fatal(err)
	}
	if patch.Greeting == nil || *patch.Greeting != "Hello there" || patch.AutoReplyEnabled == nil || *patch.AutoReplyEnabled || patch.RegenerateToken == nil || !patch.RegenerateToken.Valid() {
		t.Fatalf("executed patch=%+v", patch)
	}
	replay := requestChannels(handler, http.MethodPost, `{"autoReplyEnabled":false,"greeting":"  Hello there  ","regenerateToken":true}`, "http://example.test")
	if replay.Code != http.StatusOK || replay.Body.String() != valid.Body.String() || executor.calls != 2 || executor.effectCalls != 1 {
		t.Fatalf("same-key replay status=%d body=%s calls=%d effects=%d", replay.Code, replay.Body.String(), executor.calls, executor.effectCalls)
	}
}

func TestSupportChannelsPostRequiresUUIDIdempotencyKey(t *testing.T) {
	executor := &supportChannelsTestExecutor{}
	handler := newSupportChannelsHandler(&supportChannelsTestStore{}, supportChannelsTestResolver{resolved: channelsTestUser(true)}, executor, nil, nil)
	for _, key := range []string{"", "not-a-uuid", "40000000-0000-4000-8000-000000000004\n40000000-0000-4000-8000-000000000005"} {
		request := httptest.NewRequest(http.MethodPost, "http://example.test/api/support/channels", strings.NewReader(`{"greeting":"Hello"}`))
		request.Header.Set("Origin", "http://example.test")
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-cookie"})
		if key != "" {
			for _, value := range strings.Split(key, "\n") {
				request.Header.Add("Idempotency-Key", value)
			}
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("idempotency key %q status=%d executor calls=%d", key, recorder.Code, executor.calls)
		}
	}
}

func channelsTestUser(admin bool) *session.ResolvedUser {
	orgID := "10000000-0000-4000-8000-000000000001"
	permissions := map[string]bool{}
	if admin {
		permissions["iam.admin"] = true
	}
	return &session.ResolvedUser{UserID: "20000000-0000-4000-8000-000000000002", OrgID: &orgID, EmailVerified: true, AuthSessionID: "30000000-0000-4000-8000-000000000003", Permissions: permissions}
}

func requestChannels(handler http.Handler, method, body, origin string) *httptest.ResponseRecorder {
	return requestChannelsWithKey(handler, method, body, origin, "40000000-0000-4000-8000-000000000004")
}

func requestChannelsWithKey(handler http.Handler, method, body, origin, intentID string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://example.test/api/support/channels", strings.NewReader(body))
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if intentID != "" {
		request.Header.Set("Idempotency-Key", intentID)
	}
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-cookie"})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}
