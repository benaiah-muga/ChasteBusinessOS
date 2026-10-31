package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeRoutinesWebhookEnqueuer struct {
	queued bool
	err    error
	tokens []string
}

func (e *fakeRoutinesWebhookEnqueuer) Enqueue(_ context.Context, token string) (bool, error) {
	e.tokens = append(e.tokens, token)
	return e.queued, e.err
}

func newRoutinesWebhookTestHandler(enqueuer *fakeRoutinesWebhookEnqueuer) *RoutinesWebhookHandler {
	return &RoutinesWebhookHandler{
		enqueuer: enqueuer,
		logger:   routinesTestLogger(),
		allowAttempt: func(context.Context, string) (bool, time.Duration, error) {
			return true, 0, nil
		},
	}
}

func TestRoutinesWebhookHandlerEnqueuesEnabledToken(t *testing.T) {
	const token = "3d87a6ef-e728-418a-8cdf-a9c8a20c0182"
	enqueuer := &fakeRoutinesWebhookEnqueuer{queued: true}
	handler := newRoutinesWebhookTestHandler(enqueuer)
	request := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/"+token, nil)
	request.SetPathValue("token", token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || len(enqueuer.tokens) != 1 || enqueuer.tokens[0] != token {
		t.Fatalf("status=%d body=%s tokens=%v", response.Code, response.Body.String(), enqueuer.tokens)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control=%q", response.Header().Get("Cache-Control"))
	}
}

func TestRoutinesWebhookHandlerDoesNotRevealUnknownOrDisabledTokens(t *testing.T) {
	enqueuer := &fakeRoutinesWebhookEnqueuer{queued: false}
	handler := newRoutinesWebhookTestHandler(enqueuer)
	request := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/3d87a6ef-e728-418a-8cdf-a9c8a20c0182", nil)
	request.SetPathValue("token", "3d87a6ef-e728-418a-8cdf-a9c8a20c0182")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || response.Body.String() != "{\"error\":\"not found\"}\n" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRoutinesWebhookHandlerRejectsInvalidTokenAndUnavailableEnqueue(t *testing.T) {
	enqueuer := &fakeRoutinesWebhookEnqueuer{queued: true}
	handler := newRoutinesWebhookTestHandler(enqueuer)
	invalid := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/not-a-token", nil)
	invalid.SetPathValue("token", "not-a-token")
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusNotFound || len(enqueuer.tokens) != 0 {
		t.Fatalf("invalid token status=%d calls=%v", invalidResponse.Code, enqueuer.tokens)
	}

	enqueuer.err = errors.New("database unavailable")
	valid := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/3d87a6ef-e728-418a-8cdf-a9c8a20c0182", nil)
	valid.SetPathValue("token", "3d87a6ef-e728-418a-8cdf-a9c8a20c0182")
	validResponse := httptest.NewRecorder()
	handler.ServeHTTP(validResponse, valid)
	if validResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("database error status=%d body=%s", validResponse.Code, validResponse.Body.String())
	}
}

func TestRoutinesWebhookHandlerAllowsOnlyPOST(t *testing.T) {
	handler := newRoutinesWebhookTestHandler(&fakeRoutinesWebhookEnqueuer{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/routines/webhook/3d87a6ef-e728-418a-8cdf-a9c8a20c0182", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}
}

func TestRoutinesWebhookHandlerRateLimitsBeforeEnqueue(t *testing.T) {
	const token = "3d87a6ef-e728-418a-8cdf-a9c8a20c0182"
	enqueuer := &fakeRoutinesWebhookEnqueuer{queued: true}
	handler := newRoutinesWebhookTestHandler(enqueuer)
	limiterCalls := 0
	handler.allowAttempt = func(_ context.Context, clientIP string) (bool, time.Duration, error) {
		limiterCalls++
		if clientIP != "192.0.2.1" {
			t.Fatalf("client IP=%q", clientIP)
		}
		return false, 7 * time.Second, nil
	}
	request := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/"+token, nil)
	request.SetPathValue("token", token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "7" {
		t.Fatalf("status=%d retry-after=%q body=%s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
	}
	if limiterCalls != 1 || len(enqueuer.tokens) != 0 {
		t.Fatalf("limiter calls=%d enqueue calls=%v", limiterCalls, enqueuer.tokens)
	}
}

func TestRoutinesWebhookHandlerFailsClosedWhenIngressLimitOrClientIPUnavailable(t *testing.T) {
	const token = "3d87a6ef-e728-418a-8cdf-a9c8a20c0182"
	t.Run("limiter storage failure", func(t *testing.T) {
		enqueuer := &fakeRoutinesWebhookEnqueuer{queued: true}
		handler := newRoutinesWebhookTestHandler(enqueuer)
		handler.allowAttempt = func(context.Context, string) (bool, time.Duration, error) {
			return false, 0, errors.New("private limiter database failure")
		}
		request := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/"+token, nil)
		request.SetPathValue("token", token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable || len(enqueuer.tokens) != 0 || strings.Contains(response.Body.String(), "private limiter") {
			t.Fatalf("status=%d body=%q enqueue calls=%v", response.Code, response.Body.String(), enqueuer.tokens)
		}
	})

	t.Run("missing limiter", func(t *testing.T) {
		enqueuer := &fakeRoutinesWebhookEnqueuer{queued: true}
		handler := newRoutinesWebhookTestHandler(enqueuer)
		handler.allowAttempt = nil
		request := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/"+token, nil)
		request.SetPathValue("token", token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable || len(enqueuer.tokens) != 0 {
			t.Fatalf("status=%d body=%q enqueue calls=%v", response.Code, response.Body.String(), enqueuer.tokens)
		}
	})

	t.Run("missing client IP", func(t *testing.T) {
		enqueuer := &fakeRoutinesWebhookEnqueuer{queued: true}
		handler := newRoutinesWebhookTestHandler(enqueuer)
		limiterCalls := 0
		handler.allowAttempt = func(context.Context, string) (bool, time.Duration, error) {
			limiterCalls++
			return true, 0, nil
		}
		request := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/"+token, nil)
		request.RemoteAddr = "invalid"
		request.SetPathValue("token", token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable || limiterCalls != 0 || len(enqueuer.tokens) != 0 {
			t.Fatalf("status=%d limiter calls=%d enqueue calls=%v", response.Code, limiterCalls, enqueuer.tokens)
		}
	})
}

func TestRoutinesWebhookHandlerUsesForwardedIPOnlyForTrustedProxy(t *testing.T) {
	_, trustedProxyCIDR, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name       string
		remoteAddr string
		trusted    []*net.IPNet
		wantIP     string
	}{
		{name: "trusted proxy", remoteAddr: "10.0.0.2:443", trusted: []*net.IPNet{trustedProxyCIDR}, wantIP: "203.0.113.10"},
		{name: "untrusted peer", remoteAddr: "198.51.100.7:443", trusted: []*net.IPNet{trustedProxyCIDR}, wantIP: "198.51.100.7"},
	} {
		t.Run(test.name, func(t *testing.T) {
			enqueuer := &fakeRoutinesWebhookEnqueuer{queued: true}
			handler := newRoutinesWebhookTestHandler(enqueuer)
			handler.trustedProxyCIDRs = test.trusted
			var gotIP string
			handler.allowAttempt = func(_ context.Context, clientIP string) (bool, time.Duration, error) {
				gotIP = clientIP
				return true, 0, nil
			}
			request := httptest.NewRequest(http.MethodPost, "/api/routines/webhook/3d87a6ef-e728-418a-8cdf-a9c8a20c0182", nil)
			request.RemoteAddr = test.remoteAddr
			request.Header.Set("X-Forwarded-For", "203.0.113.10, 10.0.0.1")
			request.SetPathValue("token", "3d87a6ef-e728-418a-8cdf-a9c8a20c0182")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusAccepted || gotIP != test.wantIP {
				t.Fatalf("status=%d client IP=%q want=%q", response.Code, gotIP, test.wantIP)
			}
		})
	}
}
