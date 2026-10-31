package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeSessionsListReader struct {
	rows   []sessionsListRow
	orgID  string
	userID string
	admin  bool
	err    error
	calls  int
}

func (f *fakeSessionsListReader) ForUser(_ context.Context, orgID, userID string, admin bool) ([]sessionsListRow, error) {
	f.calls++
	f.orgID, f.userID, f.admin = orgID, userID, admin
	return f.rows, f.err
}

func sessionsListRequest(method string) *http.Request {
	r := httptest.NewRequest(method, "/api/sessions", nil)
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return r
}

func TestSessionsListHandlerListsOwnSessionsWithLegacyShape(t *testing.T) {
	identity := directTestIdentity()
	createdAt := time.Date(2026, time.October, 4, 12, 30, 0, 123456789, time.FixedZone("EAT", 3*60*60))
	title := "Quarterly close"
	modelRef := "model-a"
	reader := &fakeSessionsListReader{rows: []sessionsListRow{{
		ID: "44444444-4444-4444-8444-444444444444", UserID: &identity.UserID,
		Title: &title, Mode: "assist", Status: "open", ModelRef: &modelRef, CreatedAt: createdAt,
	}}}
	response := httptest.NewRecorder()
	newSessionsListHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, sessionsListRequest(http.MethodGet))
	if response.Code != http.StatusOK || reader.calls != 1 || reader.orgID != *identity.OrgID || reader.userID != identity.UserID || reader.admin {
		t.Fatalf("status=%d reader=%+v body=%s", response.Code, reader, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("missing private cache headers: %v", response.Header())
	}
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Sessions) != 1 {
		t.Fatalf("sessions = %v", body.Sessions)
	}
	got := body.Sessions[0]
	if got["id"] != "44444444-4444-4444-8444-444444444444" || got["userId"] != identity.UserID || got["title"] != title ||
		got["mode"] != "assist" || got["status"] != "open" || got["modelRef"] != modelRef || got["createdAt"] != "2026-10-04T09:30:00.123Z" {
		t.Fatalf("unexpected session response shape: %v", got)
	}
}

func TestSessionsListHandlerAllowsIAMAdminToListOrganizationSessions(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	reader := &fakeSessionsListReader{rows: []sessionsListRow{}}
	response := httptest.NewRecorder()
	newSessionsListHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(response, sessionsListRequest(http.MethodGet))
	if response.Code != http.StatusOK || !reader.admin || reader.orgID != *identity.OrgID {
		t.Fatalf("status=%d admin=%v org=%q body=%s", response.Code, reader.admin, reader.orgID, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"sessions":[]`) {
		t.Fatalf("empty sessions must serialize as an array: %s", response.Body.String())
	}
}

func TestSessionsListHandlerRejectsInvalidOrUnauthorizedRequests(t *testing.T) {
	for _, test := range []struct {
		name       string
		request    *http.Request
		identity   *session.ResolvedUser
		resolveErr error
		want       int
	}{
		{name: "unauthenticated", request: sessionsListRequest(http.MethodGet), resolveErr: session.ErrNoSession, want: http.StatusUnauthorized},
		{name: "unverified", request: sessionsListRequest(http.MethodGet), identity: func() *session.ResolvedUser { u := directTestIdentity(); u.EmailVerified = false; return u }(), want: http.StatusUnauthorized},
		{name: "no active organization", request: sessionsListRequest(http.MethodGet), identity: func() *session.ResolvedUser { u := directTestIdentity(); u.OrgID = nil; return u }(), want: http.StatusUnauthorized},
		{name: "invalid selector", request: func() *http.Request {
			r := sessionsListRequest(http.MethodGet)
			r.Header.Set("X-Organization-ID", "invalid")
			return r
		}(), identity: directTestIdentity(), want: http.StatusBadRequest},
		{name: "organization mismatch", request: func() *http.Request {
			r := sessionsListRequest(http.MethodGet)
			r.Header.Set("X-Organization-ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
			return r
		}(), identity: directTestIdentity(), want: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.identity, err: test.resolveErr}
			reader := &fakeSessionsListReader{}
			response := httptest.NewRecorder()
			newSessionsListHandler(resolver, reader, nil).ServeHTTP(response, test.request)
			if response.Code != test.want || reader.calls != 0 {
				t.Fatalf("status=%d reader calls=%d body=%s, want=%d and no read", response.Code, reader.calls, response.Body.String(), test.want)
			}
		})
	}
}

func TestSessionsListHandlerSupportsBearerSessionAndAdminWildcard(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["*"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &fakeSessionsListReader{rows: []sessionsListRow{}}
	request := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	request.Header.Set("Authorization", "Bearer opaque-session")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	newSessionsListHandler(resolver, reader, nil).ServeHTTP(response, request)
	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "opaque-session" || !reader.admin {
		t.Fatalf("status=%d resolver=%+v admin=%v body=%s", response.Code, resolver, reader.admin, response.Body.String())
	}
}

func TestSessionsListHandlerReturnsServiceAndDatabaseErrors(t *testing.T) {
	t.Run("missing dependencies", func(t *testing.T) {
		response := httptest.NewRecorder()
		newSessionsListHandler(nil, &fakeSessionsListReader{}, nil).ServeHTTP(response, sessionsListRequest(http.MethodGet))
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("database failure", func(t *testing.T) {
		reader := &fakeSessionsListReader{err: errors.New("database details must not escape")}
		response := httptest.NewRecorder()
		newSessionsListHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(response, sessionsListRequest(http.MethodGet))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database details") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("method not allowed", func(t *testing.T) {
		response := httptest.NewRecorder()
		newSessionsListHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeSessionsListReader{}, nil).ServeHTTP(response, sessionsListRequest(http.MethodPost))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("status=%d Allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
		}
	})
}
