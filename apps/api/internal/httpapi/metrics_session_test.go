package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/metrics"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeSessionMetricsReader struct {
	orgID   string
	payload metrics.Payload
	err     error
	calls   int
}

func (f *fakeSessionMetricsReader) ForOrg(_ context.Context, orgID string) (metrics.Payload, error) {
	f.calls++
	f.orgID = orgID
	return f.payload, f.err
}

func metricsSessionRequest(method, path string) *http.Request {
	request := httptest.NewRequest(method, path, nil)
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func TestMetricsSessionHandlerReturnsLegacyPayloadForSelectedOrganization(t *testing.T) {
	identity := directTestIdentity()
	// The legacy endpoint has no separate permission gate. Verified membership
	// in the selected organization is supplied by the session resolver.
	identity.Permissions = map[string]bool{}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	rate := 42
	reader := &fakeSessionMetricsReader{payload: metrics.Payload{
		Totals: metrics.Totals{SessionsTracked: 3, InputTokens: 120, OutputTokens: 18, CachedInputTokens: 50, CacheHitRatePct: &rate},
		Note:   "cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet.",
	}}
	response := httptest.NewRecorder()
	NewMetricsSessionHandler(resolver, reader, nil).ServeHTTP(response, metricsSessionRequest(http.MethodGet, "/api/metrics"))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "session-cookie" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("resolver calls=%d cookie=%q org=%q", resolver.resolveCalls, resolver.cookie, resolver.activeOrg)
	}
	if reader.calls != 1 || reader.orgID != *identity.OrgID {
		t.Fatalf("reader calls=%d org=%q, want exactly the selected organization %q", reader.calls, reader.orgID, *identity.OrgID)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
	for _, fragment := range []string{
		`"sessionsTracked":3`, `"inputTokens":120`, `"outputTokens":18`,
		`"cachedInputTokens":50`, `"cacheHitRatePct":42`,
		`"note":"cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet."`,
	} {
		if !strings.Contains(response.Body.String(), fragment) {
			t.Errorf("response missing %s: %s", fragment, response.Body.String())
		}
	}
}

func TestMetricsSessionHandlerFallsBackFromStaleActiveOrganizationCookie(t *testing.T) {
	identity := directTestIdentity()
	identity.AllOrgIDs = []string{*identity.OrgID}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &fakeSessionMetricsReader{}
	request := metricsSessionRequest(http.MethodGet, "/api/metrics")
	request.Header.Set("Cookie", session.SessionCookieName+"=session-cookie; "+session.ActiveOrgCookieName+"=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	response := httptest.NewRecorder()
	NewMetricsSessionHandler(resolver, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || reader.orgID != *identity.OrgID {
		t.Fatalf("stale cookie should fall back to resolved membership: status=%d readerOrg=%q body=%s", response.Code, reader.orgID, response.Body.String())
	}
}

func TestMetricsSessionHandlerSupportsBearerOrganizationSelection(t *testing.T) {
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	reader := &fakeSessionMetricsReader{}
	request := httptest.NewRequest(http.MethodGet, "/api/metrics", nil)
	request.Header.Set("Authorization", "Bearer opaque-session-token")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()
	NewMetricsSessionHandler(resolver, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "opaque-session-token" || resolver.activeOrg != *identity.OrgID {
		t.Fatalf("status=%d resolver=%+v body=%s", response.Code, resolver, response.Body.String())
	}
	if reader.calls != 1 || reader.orgID != *identity.OrgID {
		t.Fatalf("reader calls=%d org=%q", reader.calls, reader.orgID)
	}
}

func TestMetricsSessionHandlerRejectsInvalidSessionOrganizationAndPermissionContext(t *testing.T) {
	tests := []struct {
		name     string
		resolver *fakeDirectSessionResolver
		request  *http.Request
		status   int
	}{
		{
			name:     "session resolution or membership failure",
			resolver: &fakeDirectSessionResolver{err: errors.New("not a member")},
			request:  metricsSessionRequest(http.MethodGet, "/api/metrics"),
			status:   http.StatusUnauthorized,
		},
		{
			name: "unverified email",
			resolver: func() *fakeDirectSessionResolver {
				identity := directTestIdentity()
				identity.EmailVerified = false
				return &fakeDirectSessionResolver{resolved: identity}
			}(),
			request: metricsSessionRequest(http.MethodGet, "/api/metrics"),
			status:  http.StatusUnauthorized,
		},
		{
			name: "no resolved organization",
			resolver: func() *fakeDirectSessionResolver {
				identity := directTestIdentity()
				identity.OrgID = nil
				return &fakeDirectSessionResolver{resolved: identity}
			}(),
			request: metricsSessionRequest(http.MethodGet, "/api/metrics"),
			status:  http.StatusUnauthorized,
		},
		{
			name:     "selected organization mismatch",
			resolver: &fakeDirectSessionResolver{resolved: directTestIdentity()},
			request: func() *http.Request {
				request := httptest.NewRequest(http.MethodGet, "/api/metrics", nil)
				request.Header.Set("Authorization", "Bearer token")
				request.Header.Set("X-Organization-ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
				return request
			}(),
			status: http.StatusForbidden,
		},
		{
			name:     "invalid selected organization",
			resolver: &fakeDirectSessionResolver{resolved: directTestIdentity()},
			request: func() *http.Request {
				request := httptest.NewRequest(http.MethodGet, "/api/metrics", nil)
				request.Header.Set("X-Organization-ID", "not-a-uuid")
				return request
			}(),
			status: http.StatusBadRequest,
		},
		{
			name: "missing metrics read permission remains legacy allowed for organization member",
			resolver: &fakeDirectSessionResolver{resolved: func() *session.ResolvedUser {
				identity := directTestIdentity()
				identity.Permissions = map[string]bool{}
				return identity
			}()},
			request: metricsSessionRequest(http.MethodGet, "/api/metrics"),
			status:  http.StatusOK,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reader := &fakeSessionMetricsReader{}
			response := httptest.NewRecorder()
			NewMetricsSessionHandler(test.resolver, reader, nil).ServeHTTP(response, test.request)
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), test.status)
			}
			if test.status != http.StatusOK && reader.calls != 0 {
				t.Fatalf("reader called %d time(s) for rejected request", reader.calls)
			}
		})
	}
}

func TestMetricsSessionHandlerMapsReaderErrorsAndSetsHeadersOnMethodErrors(t *testing.T) {
	t.Run("reader error", func(t *testing.T) {
		reader := &fakeSessionMetricsReader{err: errors.New("database details")}
		response := httptest.NewRecorder()
		NewMetricsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(response, metricsSessionRequest(http.MethodGet, "/api/metrics"))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "database details") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewMetricsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeSessionMetricsReader{}, nil).ServeHTTP(response, metricsSessionRequest(http.MethodPost, "/api/metrics"))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d Allow=%q Cache-Control=%q body=%s", response.Code, response.Header().Get("Allow"), response.Header().Get("Cache-Control"), response.Body.String())
		}
	})
}
