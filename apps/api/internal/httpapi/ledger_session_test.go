package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func ledgerSessionRequest(path string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "ledger-session"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestLedgerSessionHandlerReadsForResolvedCookieOrganization(t *testing.T) {
	identity := directTestIdentity()
	identity.AllOrgIDs = []string{*identity.OrgID}
	identity.Permissions["accounting.read"] = true
	reader := &fakeLedgerReader{events: []ledger.Event{{
		Seq:          7,
		Kind:         "capability.executed",
		CapabilityID: stringPointer("crm.createCustomer"),
		ActorType:    "agent",
		Payload:      json.RawMessage(`{"customerId":"c-7"}`),
		Hash:         "hash-7",
		OccurredAt:   "2026-10-04T09:10:11.123Z",
	}}}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	response := httptest.NewRecorder()
	NewLedgerSessionHandler(resolver, reader, nil).ServeHTTP(response, ledgerSessionRequest("/api/ledger?limit=100"))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "ledger-session" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("resolver calls=%d cookie=%q organization=%q", resolver.resolveCalls, resolver.cookie, resolver.activeOrg)
	}
	if reader.orgID != *identity.OrgID || reader.limit != 100 || reader.calls != 1 {
		t.Fatalf("reader org=%q limit=%d calls=%d", reader.orgID, reader.limit, reader.calls)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
	var body struct {
		Events []map[string]json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Events) != 1 {
		t.Fatalf("events=%d, want one event", len(body.Events))
	}
	for _, key := range []string{"seq", "kind", "capabilityId", "actorType", "actorId", "sessionId", "payload", "hash", "prevHash", "occurredAt"} {
		if _, ok := body.Events[0][key]; !ok {
			t.Errorf("response omitted legacy event field %q: %s", key, response.Body.String())
		}
	}
	for _, key := range []string{"actorId", "sessionId", "prevHash"} {
		if string(body.Events[0][key]) != "null" {
			t.Errorf("nullable field %q = %s, want null", key, body.Events[0][key])
		}
	}
	if string(body.Events[0]["payload"]) != `{"customerId":"c-7"}` {
		t.Errorf("payload=%s, want original JSON value", body.Events[0]["payload"])
	}
}

func TestLedgerSessionHandlerSupportsBearerAndOrganizationSelection(t *testing.T) {
	identity := directTestIdentity()
	identity.AllOrgIDs = []string{*identity.OrgID}
	identity.Permissions["accounting.read"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &fakeLedgerReader{}
	request := httptest.NewRequest(http.MethodGet, "/api/ledger", nil)
	request.Header.Set("Authorization", "Bearer opaque-session-token")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	NewLedgerSessionHandler(resolver, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "opaque-session-token" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("status=%d resolver=%+v body=%s", response.Code, resolver, response.Body.String())
	}
	if reader.orgID != *identity.OrgID {
		t.Fatalf("reader organization=%q, want selected member organization %q", reader.orgID, *identity.OrgID)
	}
}

func TestLedgerSessionHandlerRejectsInvalidIdentityAndOrganizationMembership(t *testing.T) {
	tests := []struct {
		name     string
		resolved *session.ResolvedUser
		selector string
		want     int
	}{
		{name: "missing organization membership", resolved: &session.ResolvedUser{UserID: directTestIdentity().UserID, EmailVerified: true, AuthSessionID: "session"}, want: http.StatusUnauthorized},
		{name: "unverified email", resolved: func() *session.ResolvedUser { value := directTestIdentity(); value.EmailVerified = false; return value }(), want: http.StatusUnauthorized},
		{name: "selected organization differs from resolved membership", resolved: directTestIdentity(), selector: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", want: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.resolved}
			reader := &fakeLedgerReader{}
			request := httptest.NewRequest(http.MethodGet, "/api/ledger", nil)
			request.Header.Set("Authorization", "Bearer opaque-session-token")
			if test.selector != "" {
				request.Header.Set("X-Organization-ID", test.selector)
			}
			response := httptest.NewRecorder()
			NewLedgerSessionHandler(resolver, reader, nil).ServeHTTP(response, request)
			if response.Code != test.want || reader.calls != 0 {
				t.Fatalf("status=%d reads=%d body=%s, want status %d and no read", response.Code, reader.calls, response.Body.String(), test.want)
			}
		})
	}
}

func TestLedgerSessionHandlerEnforcesPermissionBeforeRead(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["accounting.read"] = false
	reader := &fakeLedgerReader{}
	response := httptest.NewRecorder()
	NewLedgerSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, ledgerSessionRequest("/api/ledger"))

	if response.Code != http.StatusForbidden || reader.calls != 0 || !strings.Contains(response.Body.String(), "forbidden: missing accounting.read") {
		t.Fatalf("status=%d reads=%d body=%s, want permission denial before read", response.Code, reader.calls, response.Body.String())
	}
}

func TestLedgerSessionHandlerValidatesSelectorAndBearer(t *testing.T) {
	tests := []struct {
		name    string
		request *http.Request
		want    int
	}{
		{name: "invalid organization selector", request: func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/ledger", nil)
			r.Header.Set("X-Organization-ID", "not-a-uuid")
			return r
		}(), want: http.StatusBadRequest},
		{name: "duplicate organization selector", request: func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/ledger", nil)
			r.Header.Add("X-Organization-ID", "11111111-1111-4111-8111-111111111111")
			r.Header.Add("X-Organization-ID", "11111111-1111-4111-8111-111111111111")
			return r
		}(), want: http.StatusBadRequest},
		{name: "malformed bearer", request: func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/ledger", nil)
			r.Header.Set("Authorization", "Basic token")
			return r
		}(), want: http.StatusUnauthorized},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reader := &fakeLedgerReader{}
			response := httptest.NewRecorder()
			NewLedgerSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(response, test.request)
			if response.Code != test.want || reader.calls != 0 {
				t.Fatalf("status=%d reads=%d body=%s, want status %d and no read", response.Code, reader.calls, response.Body.String(), test.want)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control=%q, want no-store on error", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestLedgerSessionHandlerBoundsLimitLikeLegacyRoute(t *testing.T) {
	tests := []struct {
		query string
		want  int
	}{
		{query: "", want: 60},
		{query: "?limit=100", want: 100},
		{query: "?limit=999", want: 200},
		{query: "?limit=-8", want: 1},
		{query: "?limit=not-a-number", want: 60},
	}
	for _, test := range tests {
		t.Run(test.query, func(t *testing.T) {
			identity := directTestIdentity()
			identity.Permissions["accounting.read"] = true
			reader := &fakeLedgerReader{}
			request := ledgerSessionRequest("/api/ledger" + test.query)
			response := httptest.NewRecorder()
			NewLedgerSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, request)
			if response.Code != http.StatusOK || reader.limit != test.want {
				t.Fatalf("status=%d limit=%d body=%s, want limit %d", response.Code, reader.limit, response.Body.String(), test.want)
			}
		})
	}
}

func TestLedgerSessionHandlerMapsReaderFailureToInternalError(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["accounting.read"] = true
	reader := &failingLedgerReader{err: errors.New("database connection details")}
	response := httptest.NewRecorder()
	NewLedgerSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, ledgerSessionRequest("/api/ledger"))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database connection details") {
		t.Fatalf("status=%d body=%s, want sanitized internal error", response.Code, response.Body.String())
	}
}

type failingLedgerReader struct{ err error }

func (r *failingLedgerReader) RecentForOrg(_ context.Context, _ string, _ int) ([]ledger.Event, error) {
	return nil, r.err
}
