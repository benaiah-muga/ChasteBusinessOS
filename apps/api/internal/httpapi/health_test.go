package httpapi

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakePinger struct {
	err error
}

func (p fakePinger) Ping(context.Context) error {
	return p.err
}

func TestHealthHandlerPreservesSuccessfulContract(t *testing.T) {
	handler := NewHealthHandler(fakePinger{}, nil).(*HealthHandler)
	handler.now = func() time.Time {
		return time.Date(2026, 9, 27, 10, 11, 12, 345_000_000, time.FixedZone("EAT", 3*60*60))
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if got, want := response.Header().Get("Content-Type"), "application/json"; got != want {
		t.Fatalf("content type = %q, want %q", got, want)
	}
	if got, want := response.Body.String(), "{\"status\":\"ok\",\"db\":\"connected\",\"time\":\"2026-09-27T07:11:12.345Z\"}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestHealthHandlerDoesNotExposeDatabaseError(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := NewHealthHandler(fakePinger{err: errors.New("postgres://private-user:secret@db/internal")}, logger)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if got, want := response.Body.String(), "{\"status\":\"degraded\",\"db\":\"unavailable\"}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if strings.Contains(response.Body.String(), "private-user") || strings.Contains(response.Body.String(), "secret") {
		t.Fatal("response leaked database details")
	}
	if !strings.Contains(logs.String(), "health check failed") {
		t.Fatal("health failure was not logged")
	}
}

func TestRouterRejectsUnsupportedHealthMethod(t *testing.T) {
	response := httptest.NewRecorder()
	NewRouter(fakePinger{}, nil, "", nil, nil, nil, nil).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/health", nil))

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
}
