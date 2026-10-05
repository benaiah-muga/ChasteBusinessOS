package session

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// stubResolver lets the middleware be exercised without a database by taking
// the decision function as a seam. The real Resolver.Resolve behavior is
// covered by the integration suite; this file is about the HTTP contract.
// WithStubResolver builds middleware around a fixed decision for tests, so the
// HTTP contract can be exercised without a database. The real resolution path is
// covered by the integration suite.
func WithStubResolver(resolve func(ctx context.Context, cookie, activeOrg string) (*ResolvedUser, error)) *Middleware {
	return &Middleware{resolver: &Resolver{now: time.Now, stub: resolve}}
}

func requestWithCookies(sessionCookie, activeOrg string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	if sessionCookie != "" {
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sessionCookie})
	}
	if activeOrg != "" {
		req.AddCookie(&http.Cookie{Name: ActiveOrgCookieName, Value: activeOrg})
	}
	return req
}

func TestMiddlewarePassesTheResolvedActorThrough(t *testing.T) {
	middleware := WithStubResolver(func(context.Context, string, string) (*ResolvedUser, error) {
		return &ResolvedUser{
			UserID:      "user-1",
			OrgID:       ptr("org-1"),
			Permissions: map[string]bool{"crm.read": true},
		}, nil
	})

	var seen *ResolvedUser
	handler := middleware.Handler(func(r *http.Request, resolved *ResolvedUser) error {
		seen = resolved
		if FromContext(r.Context()) == nil {
			t.Error("resolved actor was not attached to the request context")
		}
		return nil
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, requestWithCookies("cookie", ""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if seen == nil || seen.UserID != "user-1" {
		t.Fatalf("handler saw %+v", seen)
	}
}

func TestMiddlewarePassesOpaqueBearerSessionToResolver(t *testing.T) {
	var gotToken string
	middleware := WithStubResolver(func(_ context.Context, token, activeOrg string) (*ResolvedUser, error) {
		gotToken = token
		if activeOrg != "org-from-cookie" {
			t.Errorf("active org = %q, want cookie value", activeOrg)
		}
		return &ResolvedUser{UserID: "user-1", OrgID: ptr("org-1"), Permissions: map[string]bool{"crm.read": true}}, nil
	})
	handler := middleware.Handler(func(_ *http.Request, resolved *ResolvedUser) error {
		if resolved.UserID != "user-1" {
			t.Fatalf("resolved user = %q", resolved.UserID)
		}
		return nil
	})
	request := requestWithCookies("ignored-cookie", "org-from-cookie")
	request.Header.Set("Authorization", "Bearer opaque-session-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if gotToken != "opaque-session-token" {
		t.Fatalf("resolver token = %q", gotToken)
	}
}

func TestMiddlewareRejectsMalformedAuthorizationWithoutCookieFallback(t *testing.T) {
	called := false
	middleware := WithStubResolver(func(context.Context, string, string) (*ResolvedUser, error) {
		called = true
		return &ResolvedUser{UserID: "user-1"}, nil
	})
	handler := middleware.Handler(func(*http.Request, *ResolvedUser) error { t.Fatal("invalid auth reached handler"); return nil })
	request := requestWithCookies("valid-cookie", "")
	request.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if called || recorder.Code != http.StatusUnauthorized {
		t.Fatalf("malformed authorization fell back: resolver called=%t status=%d", called, recorder.Code)
	}
}

// Every unauthenticated cause must collapse to one indistinguishable 401, so a
// prober cannot learn whether a cookie was forged, expired, or revoked.
func TestMiddlewareCollapsesEveryUnauthenticatedCause(t *testing.T) {
	// A misconfigured secret is a server fault, not an anonymous visitor, and
	// has its own test. These are the causes that must be indistinguishable.
	causes := []error{
		ErrNoSession,
		context.DeadlineExceeded,
		ErrUnauthenticated,
	}
	bodies := map[string]bool{}
	for _, cause := range causes {
		middleware := WithStubResolver(func(context.Context, string, string) (*ResolvedUser, error) {
			return nil, cause
		})
		called := false
		handler := middleware.Handler(func(*http.Request, *ResolvedUser) error {
			called = true
			return nil
		})
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, requestWithCookies("cookie", ""))
		if called {
			t.Fatalf("cause %v reached the wrapped handler", cause)
		}
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("cause %v status = %d, want 401", cause, recorder.Code)
		}
		bodies[recorder.Body.String()] = true
	}
	if len(bodies) != 1 {
		t.Fatalf("expected one indistinguishable response, got %d: %v", len(bodies), bodies)
	}
}

func TestMiddlewareReportsABrokenSecretAsUnavailable(t *testing.T) {
	middleware := WithStubResolver(func(context.Context, string, string) (*ResolvedUser, error) {
		return nil, ErrSecretTooShort
	})
	handler := middleware.Handler(func(*http.Request, *ResolvedUser) error { return nil })
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, requestWithCookies("cookie", ""))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 for a misconfigured secret", recorder.Code)
	}
}

func TestMiddlewareMapsHandlerErrorsToStatusCodes(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
	}{
		{"forbidden", ErrForbidden, http.StatusForbidden},
		{"unauthenticated", ErrUnauthenticated, http.StatusUnauthorized},
		{"unknown", context.Canceled, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			middleware := WithStubResolver(func(context.Context, string, string) (*ResolvedUser, error) {
				return &ResolvedUser{UserID: "u"}, nil
			})
			handler := middleware.Handler(func(*http.Request, *ResolvedUser) error { return tc.err })
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, requestWithCookies("cookie", ""))
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.status)
			}
			if got := recorder.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("content type = %q, want application/json", got)
			}
			if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("cache control = %q, want no-store", got)
			}
		})
	}
}

// A session that resolves without an organization must never satisfy a
// permission guard, even if its permission map was somehow populated.
func TestRequirePermissionRefusesAnActorWithoutAnOrganization(t *testing.T) {
	guard := RequirePermission("crm.read")
	if err := guard(&ResolvedUser{Permissions: map[string]bool{"crm.read": true}}); err != ErrForbidden {
		t.Fatalf("actor without an org passed the guard: %v", err)
	}
	if err := guard(nil); err != ErrForbidden {
		t.Fatalf("nil actor passed the guard: %v", err)
	}
	if err := guard(&ResolvedUser{OrgID: ptr("org"), Permissions: map[string]bool{"crm.read": true}}); err != nil {
		t.Fatalf("authorized actor was refused: %v", err)
	}
	if err := guard(&ResolvedUser{OrgID: ptr("org"), Permissions: map[string]bool{"crm.write": true}}); err != ErrForbidden {
		t.Fatalf("actor with the wrong permission passed the guard: %v", err)
	}
}

func TestRequireActiveOrgRefusesAnUnresolvedActor(t *testing.T) {
	if err := RequireActiveOrg(nil); err != ErrForbidden {
		t.Fatalf("nil actor: %v", err)
	}
	if err := RequireActiveOrg(&ResolvedUser{}); err != ErrForbidden {
		t.Fatalf("actor without an org: %v", err)
	}
	if err := RequireActiveOrg(&ResolvedUser{OrgID: ptr("org")}); err != nil {
		t.Fatalf("actor with an org was refused: %v", err)
	}
}

func TestFromContextReturnsNilWhenUnresolved(t *testing.T) {
	if got := FromContext(context.Background()); got != nil {
		t.Fatalf("FromContext on a bare context = %+v, want nil", got)
	}
	ctx := WithResolvedUser(context.Background(), &ResolvedUser{UserID: "u"})
	if got := FromContext(ctx); got == nil || got.UserID != "u" {
		t.Fatalf("FromContext did not round-trip the actor")
	}
}

func ptr(value string) *string { return &value }
