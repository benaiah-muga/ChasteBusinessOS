package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/jackc/pgx/v5/pgxpool"
)

type scimNoopProvisionExecutor struct{}

func (scimNoopProvisionExecutor) ExecuteSCIMProvisionUser(context.Context, string, string, string, json.RawMessage) (capability.Result, error) {
	return capability.Result{}, nil
}

func TestSCIMReadAndWriteShareLimiterAndLegacyRateError(t *testing.T) {
	limiter := NewSCIMRateLimiter()
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	limiter.now = func() time.Time { return now }
	pool := &pgxpool.Pool{}
	readHandler, err := NewSCIMReadHandlerWithLimiter(pool, nil, nil, limiter)
	if err != nil {
		t.Fatal(err)
	}
	writeHandler, err := NewSCIMWriteHandlerWithLimiter(pool, scimNoopProvisionExecutor{}, nil, nil, limiter)
	if err != nil {
		t.Fatal(err)
	}
	read := readHandler.(*scimReadHandler)
	write := writeHandler.(*scimWriteHandler)
	if read.limiter != write.read.limiter {
		t.Fatal("SCIM read and write handlers do not share their rate limiter")
	}
	for i := 0; i < scimReadLimit/2; i++ {
		if !read.allow("192.0.2.70") || !write.read.allow("192.0.2.70") {
			t.Fatalf("shared limiter rejected mixed request %d before the 60-request limit", i)
		}
	}

	for _, test := range []struct {
		name    string
		handler http.Handler
		method  string
	}{
		{name: "read", handler: read, method: http.MethodGet},
		{name: "write", handler: write, method: http.MethodPost},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "/api/scim/v2/Users", nil)
			request.RemoteAddr = "192.0.2.70:43210"
			response := httptest.NewRecorder()
			test.handler.ServeHTTP(response, request)
			var body scimErrorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusUnauthorized || body.Status != "401" || body.Detail != "invalid or missing SCIM token" {
				t.Fatalf("rate-limit response status=%d body=%+v, want legacy SCIM 401", response.Code, body)
			}
		})
	}
}
