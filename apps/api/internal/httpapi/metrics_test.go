package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/metrics"
)

const (
	metricsTestUserID = "0b9e1bd3-8432-4059-a0b1-902ff8d520d0"
	metricsTestOrgID  = "a5cb2579-9d6e-41ee-96d6-9af1c89bf250"
)

type fakeMetricsReader struct {
	orgID   string
	calls   int
	payload metrics.Payload
	err     error
}

func (r *fakeMetricsReader) ForOrg(_ context.Context, orgID string) (metrics.Payload, error) {
	r.calls++
	r.orgID = orgID
	return r.payload, r.err
}

func metricsAssertion(t *testing.T, claims authbridge.Claims) string {
	t.Helper()
	now := time.Now().Unix()
	if claims.IssuedAt == 0 {
		claims.IssuedAt = now
	}
	if claims.ExpiresAt == 0 {
		claims.ExpiresAt = now + 30
	}
	assertion, err := authbridge.Sign(assertionSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	return assertion
}

func validMetricsClaims() authbridge.Claims {
	return authbridge.Claims{
		Audience:       MetricsReadAudience,
		Subject:        metricsTestUserID,
		OrganizationID: metricsTestOrgID,
	}
}

func TestGoMetricsHandlerUsesSignedOrganizationAndPreservesPayload(t *testing.T) {
	rate := 38
	reader := &fakeMetricsReader{payload: metrics.Payload{
		Totals: metrics.Totals{
			SessionsTracked:   3,
			InputTokens:       800,
			OutputTokens:      160,
			CachedInputTokens: 300,
			CacheHitRatePct:   &rate,
		},
		Note: "cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet.",
	}}
	request := httptest.NewRequest(http.MethodGet, "/__go/metrics", nil)
	request.Header.Set(sessionAssertionHeader, metricsAssertion(t, validMetricsClaims()))
	response := httptest.NewRecorder()
	NewGoMetricsHandler(assertionSecret, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if reader.orgID != metricsTestOrgID || reader.calls != 1 {
		t.Fatalf("reader called with org=%q calls=%d", reader.orgID, reader.calls)
	}
	var got metrics.Payload
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Totals.SessionsTracked != 3 || got.Totals.InputTokens != 800 || got.Totals.OutputTokens != 160 ||
		got.Totals.CachedInputTokens != 300 || got.Totals.CacheHitRatePct == nil || *got.Totals.CacheHitRatePct != rate || got.Note != reader.payload.Note {
		t.Fatalf("payload = %#v, want %#v", got, reader.payload)
	}
	if gotHeader := response.Header().Get("Cache-Control"); gotHeader != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", gotHeader)
	}
}

func TestGoMetricsHandlerRejectsInvalidAssertionsAndOrganizationClaims(t *testing.T) {
	wrongAudience := validMetricsClaims()
	wrongAudience.Audience = authbridge.PolicyReadAudience
	invalidSubject := validMetricsClaims()
	invalidSubject.Subject = "not-a-uuid"
	invalidOrg := validMetricsClaims()
	invalidOrg.OrganizationID = "not-a-uuid"
	tooLong := validMetricsClaims()
	tooLong.IssuedAt = time.Now().Unix()
	tooLong.ExpiresAt = tooLong.IssuedAt + 31

	for _, test := range []struct {
		name  string
		token string
	}{
		{name: "missing assertion"},
		{name: "malformed assertion", token: "not-signed"},
		{name: "wrong audience", token: metricsAssertion(t, wrongAudience)},
		{name: "malformed subject", token: metricsAssertion(t, invalidSubject)},
		{name: "malformed organization", token: metricsAssertion(t, invalidOrg)},
		{name: "assertion lifetime exceeds 30 seconds", token: metricsAssertion(t, tooLong)},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &fakeMetricsReader{}
			request := httptest.NewRequest(http.MethodGet, "/__go/metrics", nil)
			if test.token != "" {
				request.Header.Set(sessionAssertionHeader, test.token)
			}
			response := httptest.NewRecorder()
			NewGoMetricsHandler(assertionSecret, reader, nil).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || reader.calls != 0 {
				t.Fatalf("status=%d reader calls=%d, want unauthorized and zero reads", response.Code, reader.calls)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
		})
	}
}

func TestGoMetricsHandlerRejectsMismatchedOrganizationBeforeRead(t *testing.T) {
	reader := &fakeMetricsReader{}
	request := httptest.NewRequest(http.MethodGet, "/__go/metrics?org_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", nil)
	request.Header.Set(sessionAssertionHeader, metricsAssertion(t, validMetricsClaims()))
	response := httptest.NewRecorder()
	NewGoMetricsHandler(assertionSecret, reader, nil).ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized || reader.calls != 0 {
		t.Fatalf("status=%d reader calls=%d, want unauthorized and zero reads", response.Code, reader.calls)
	}
}

func TestGoMetricsHandlerFailsClosedWhenUnavailableOrReaderFails(t *testing.T) {
	for _, test := range []struct {
		name   string
		secret string
		reader MetricsReader
		want   int
	}{
		{name: "missing secret", reader: &fakeMetricsReader{}, want: http.StatusServiceUnavailable},
		{name: "missing reader", secret: assertionSecret, want: http.StatusServiceUnavailable},
		{name: "reader error", secret: assertionSecret, reader: &fakeMetricsReader{err: errors.New("database details")}, want: http.StatusInternalServerError},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/__go/metrics", nil)
			request.Header.Set(sessionAssertionHeader, metricsAssertion(t, validMetricsClaims()))
			response := httptest.NewRecorder()
			NewGoMetricsHandler(test.secret, test.reader, nil).ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d", response.Code, test.want)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
			if response.Code == http.StatusInternalServerError && response.Body.String() != "{\"error\":\"internal error\"}\n" {
				t.Fatalf("reader error response exposed details: %s", response.Body.String())
			}
		})
	}
}

func TestGoMetricsRouteIsRegisteredOnlyOnPrivatePath(t *testing.T) {
	reader := &fakeMetricsReader{payload: metrics.Payload{Note: "metrics note"}}
	request := httptest.NewRequest(http.MethodGet, "/__go/metrics", nil)
	request.Header.Set(sessionAssertionHeader, metricsAssertion(t, validMetricsClaims()))
	response := httptest.NewRecorder()
	NewRouterWithMetrics(fakePinger{}, nil, assertionSecret, nil, nil, nil, nil, reader).ServeHTTP(response, request)
	if response.Code != http.StatusOK || reader.calls != 1 {
		t.Fatalf("private route status=%d reader calls=%d, want success and one read", response.Code, reader.calls)
	}

	publicResponse := httptest.NewRecorder()
	NewRouterWithMetrics(fakePinger{}, nil, assertionSecret, nil, nil, nil, nil, reader).ServeHTTP(publicResponse, httptest.NewRequest(http.MethodGet, "/api/metrics", nil))
	if publicResponse.Code != http.StatusNotFound || reader.calls != 1 {
		t.Fatalf("public route status=%d reader calls=%d, want not found without another read", publicResponse.Code, reader.calls)
	}
}
