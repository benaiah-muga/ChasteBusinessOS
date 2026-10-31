package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeNotificationsSessionReader struct {
	rows   []notificationSessionRow
	unread int
	err    error
	orgID  string
	userID string
	limit  int
	calls  int
}

func (reader *fakeNotificationsSessionReader) ForUser(_ context.Context, orgID, userID string, limit int) ([]notificationSessionRow, int, error) {
	reader.calls++
	reader.orgID, reader.userID, reader.limit = orgID, userID, limit
	return reader.rows, reader.unread, reader.err
}

func TestNotificationsSessionHandlerReturnsLegacyFeedAndUsesBoundedLimit(t *testing.T) {
	identity := directTestIdentity()
	readAt := time.Date(2026, 10, 4, 8, 9, 10, 123456789, time.FixedZone("EAT", 3*60*60))
	createdAt := time.Date(2026, 10, 4, 9, 10, 11, 987654321, time.FixedZone("EAT", 3*60*60))
	reader := &fakeNotificationsSessionReader{
		rows:   []notificationSessionRow{{ID: "44444444-4444-4444-8444-444444444444", Kind: "system", Title: "Ready", Href: nil, ReadAt: &readAt, CreatedAt: createdAt}},
		unread: 7,
	}
	handler := newNotificationsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/notifications?limit=12.9", nil)
	request.AddCookie(&http.Cookie{Name: "better-auth.session_token", Value: "notifications-cookie"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || reader.calls != 1 || reader.orgID != *identity.OrgID || reader.userID != identity.UserID || reader.limit != 12 {
		t.Fatalf("status=%d reader=%+v body=%s", response.Code, reader, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"unreadCount":7`) ||
		!strings.Contains(response.Body.String(), `"createdAt":"2026-10-04T06:10:11.987Z"`) ||
		!strings.Contains(response.Body.String(), `"readAt":"2026-10-04T05:09:10.123Z"`) ||
		!strings.Contains(response.Body.String(), `"href":null`) {
		t.Fatalf("response did not preserve legacy fields and millisecond UTC timestamps: %s", response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
}

func TestNotificationsSessionHandlerBoundsLimitLikeLegacyRoute(t *testing.T) {
	tests := []struct {
		query string
		want  int
	}{
		{query: "", want: 30},
		{query: "?limit=", want: 1},
		{query: "?limit=0", want: 1},
		{query: "?limit=100.9", want: 100},
		{query: "?limit=500", want: 100},
		{query: "?limit=nope", want: 30},
	}
	for _, test := range tests {
		t.Run(test.query, func(t *testing.T) {
			reader := &fakeNotificationsSessionReader{}
			handler := newNotificationsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/notifications"+test.query, nil))
			if response.Code != http.StatusOK || reader.limit != test.want {
				t.Fatalf("status=%d limit=%d, want %d; body=%s", response.Code, reader.limit, test.want, response.Body.String())
			}
		})
	}
}

func TestNotificationsSessionHandlerRequiresIdentityAndGET(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeNotificationsSessionReader{}
	resolver := &fakeDirectSessionResolver{resolved: identity, err: errors.New("no session")}
	handler := newNotificationsSessionHandler(resolver, reader, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/notifications", nil))
	if response.Code != http.StatusUnauthorized || reader.calls != 0 || response.Header().Get("WWW-Authenticate") == "" {
		t.Fatalf("unauthenticated status=%d reader calls=%d headers=%v", response.Code, reader.calls, response.Header())
	}

	resolver.err = nil
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notifications", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet || reader.calls != 0 {
		t.Fatalf("wrong method status=%d allow=%q reader calls=%d", response.Code, response.Header().Get("Allow"), reader.calls)
	}
}

func TestNotificationsSessionHandlerRejectsRequestedOrgOutsideResolvedIdentity(t *testing.T) {
	reader := &fakeNotificationsSessionReader{}
	handler := newNotificationsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/notifications", nil)
	request.Header.Set("X-Organization-ID", "55555555-5555-4555-8555-555555555555")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || reader.calls != 0 {
		t.Fatalf("status=%d reader calls=%d body=%s", response.Code, reader.calls, response.Body.String())
	}
}

func TestNotificationLimitMatchesLegacyEmptyValueAndDefaultsInvalidNumbers(t *testing.T) {
	if got := notificationLimit("", true); got != 1 {
		t.Fatalf("empty limit=%d, want 1", got)
	}
	if got := notificationLimit("NaN", true); got != 30 {
		t.Fatalf("NaN limit=%d, want 30", got)
	}
}
