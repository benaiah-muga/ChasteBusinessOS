package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const invitationTestToken = "abcdefghijklmnopqrstuvwx12345678"

type invitationStoreStub struct {
	orgID        string
	found        bool
	previewData  invitationPreview
	previewOK    bool
	previewErr   error
	claimResult  invitationClaimResult
	claimErr     error
	claimCalls   int
	claimToken   string
	claimUserID  string
	claimEmail   string
	resolveCalls int
}

func (s *invitationStoreStub) resolveOrg(_ context.Context, token string) (string, bool, error) {
	s.resolveCalls++
	if token != invitationTestToken {
		return "", false, nil
	}
	return s.orgID, s.found, nil
}

func (s *invitationStoreStub) preview(_ context.Context, _, _ string, _ time.Time) (invitationPreview, bool, error) {
	return s.previewData, s.previewOK, s.previewErr
}

func (s *invitationStoreStub) claim(_ context.Context, _, token, userID, email string, _ bool, _ time.Time) (invitationClaimResult, error) {
	s.claimCalls++
	s.claimToken, s.claimUserID, s.claimEmail = token, userID, email
	return s.claimResult, s.claimErr
}

func newInvitationTestHandler(store invitationStore, resolved *session.ResolvedUser, resolveErr error) *GoInvitationHandler {
	return &GoInvitationHandler{
		store: store, resolver: &fakeDirectSessionResolver{resolved: resolved, err: resolveErr},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), limiter: newInvitationAttemptLimiter(nil),
		now: func() time.Time { return time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC) },
	}
}

func invitationRequest(method, token string) *http.Request {
	request := httptest.NewRequest(method, "/api/auth/invitations/"+token, nil)
	request.SetPathValue("token", token)
	request.RemoteAddr = "198.51.100.25:4567"
	request.Host = "vite.example.test"
	request.Header.Set("Origin", "http://vite.example.test")
	return request
}

func invitationResolvedUser() *session.ResolvedUser {
	return &session.ResolvedUser{
		UserID: "22222222-2222-4222-8222-222222222222", Email: "Invitee@Example.test",
		EmailVerified: true, AuthSessionID: "33333333-3333-4333-8333-333333333333",
	}
}

func TestGoInvitationHandlerPreviewUsesRootResponseContract(t *testing.T) {
	store := &invitationStoreStub{
		orgID: "11111111-1111-4111-8111-111111111111", found: true, previewOK: true,
		previewData: invitationPreview{
			Email: "invitee@example.test", OrgName: "Example Ltd", RoleName: "Accountant",
			ExpiresAt: time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
		},
	}
	response := httptest.NewRecorder()
	newInvitationTestHandler(store, nil, nil).ServeHTTP(response, invitationRequest(http.MethodGet, invitationTestToken))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["email"] != "invitee@example.test" || payload["orgName"] != "Example Ltd" || payload["roleName"] != "Accountant" || payload["expiresAt"] == nil {
		t.Fatalf("unexpected preview payload: %#v", payload)
	}
	if payload["data"] != nil || payload["ok"] != nil {
		t.Fatalf("preview must keep the fields at the response root: %#v", payload)
	}
}

func TestGoInvitationHandlerAcceptRequiresVerifiedSessionAndSameOrigin(t *testing.T) {
	t.Run("requires sign in", func(t *testing.T) {
		store := &invitationStoreStub{orgID: "11111111-1111-4111-8111-111111111111", found: true}
		response := httptest.NewRecorder()
		newInvitationTestHandler(store, nil, errors.New("no session")).ServeHTTP(response, invitationRequest(http.MethodPost, invitationTestToken))
		if response.Code != http.StatusUnauthorized || store.claimCalls != 0 || store.resolveCalls != 0 {
			t.Fatalf("status=%d lookup calls=%d claim calls=%d body=%s", response.Code, store.resolveCalls, store.claimCalls, response.Body.String())
		}
	})
	t.Run("rejects unverified mailbox", func(t *testing.T) {
		store := &invitationStoreStub{orgID: "11111111-1111-4111-8111-111111111111", found: true}
		identity := invitationResolvedUser()
		identity.EmailVerified = false
		response := httptest.NewRecorder()
		newInvitationTestHandler(store, identity, nil).ServeHTTP(response, invitationRequest(http.MethodPost, invitationTestToken))
		if response.Code != http.StatusForbidden || store.claimCalls != 0 {
			t.Fatalf("status=%d claim calls=%d body=%s", response.Code, store.claimCalls, response.Body.String())
		}
	})
	t.Run("checks cookie origin", func(t *testing.T) {
		store := &invitationStoreStub{orgID: "11111111-1111-4111-8111-111111111111", found: true}
		request := invitationRequest(http.MethodPost, invitationTestToken)
		request.Header.Del("Origin")
		response := httptest.NewRecorder()
		newInvitationTestHandler(store, invitationResolvedUser(), nil).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || store.claimCalls != 0 {
			t.Fatalf("status=%d claim calls=%d body=%s", response.Code, store.claimCalls, response.Body.String())
		}
	})
}

func TestGoInvitationHandlerUnauthenticatedPostDoesNotRevealTokenExistence(t *testing.T) {
	unknownToken := "abcdefghijklmnopqrstuvwx87654321"
	for _, token := range []string{invitationTestToken, unknownToken} {
		t.Run(token, func(t *testing.T) {
			store := &invitationStoreStub{orgID: "11111111-1111-4111-8111-111111111111", found: token == invitationTestToken}
			response := httptest.NewRecorder()
			newInvitationTestHandler(store, nil, errors.New("no session")).ServeHTTP(response, invitationRequest(http.MethodPost, token))
			if response.Code != http.StatusUnauthorized || store.resolveCalls != 0 {
				t.Fatalf("status=%d lookup calls=%d body=%s", response.Code, store.resolveCalls, response.Body.String())
			}
		})
	}
}

func TestGoInvitationHandlerPassesVerifiedIdentityAndReturnsOK(t *testing.T) {
	store := &invitationStoreStub{orgID: "11111111-1111-4111-8111-111111111111", found: true}
	response := httptest.NewRecorder()
	newInvitationTestHandler(store, invitationResolvedUser(), nil).ServeHTTP(response, invitationRequest(http.MethodPost, invitationTestToken))
	if response.Code != http.StatusOK || store.claimCalls != 1 || store.claimEmail != "Invitee@Example.test" || store.claimToken != invitationTestToken {
		t.Fatalf("status=%d store=%#v body=%s", response.Code, store, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("unexpected success envelope: %s", response.Body.String())
	}
}

func TestGoInvitationHandlerPreservesClaimErrorStatuses(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		want   int
	}{
		{name: "email mismatch", status: http.StatusForbidden, want: http.StatusForbidden},
		{name: "already accepted", status: http.StatusNotFound, want: http.StatusNotFound},
		{name: "expired", status: http.StatusGone, want: http.StatusGone},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &invitationStoreStub{
				orgID: "11111111-1111-4111-8111-111111111111", found: true,
				claimResult: invitationClaimResult{status: test.status, message: "invitation status"},
			}
			response := httptest.NewRecorder()
			newInvitationTestHandler(store, invitationResolvedUser(), nil).ServeHTTP(response, invitationRequest(http.MethodPost, invitationTestToken))
			if response.Code != test.want || !strings.Contains(response.Body.String(), `"error":"invitation status"`) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestGoInvitationRoutesAreMountedInsideAuthNamespace(t *testing.T) {
	store := &invitationStoreStub{
		orgID: "11111111-1111-4111-8111-111111111111", found: true, previewOK: true,
		previewData: invitationPreview{Email: "invitee@example.test", OrgName: "Example Ltd", RoleName: "Member"},
	}
	route := MountGoInvitationRoutes(http.NotFoundHandler(), newInvitationTestHandler(store, nil, nil))
	request := httptest.NewRequest(http.MethodGet, "/invitations/"+invitationTestToken, nil)
	request.RemoteAddr = "198.51.100.25:4567"
	response := httptest.NewRecorder()
	route.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestInvitationRateLimitBoundsTokenAttempts(t *testing.T) {
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	limiter := newInvitationAttemptLimiter(func() time.Time { return now })
	for attempt := 0; attempt < invitationAttemptLimit; attempt++ {
		if allowed, _ := limiter.allow("198.51.100.25"); !allowed {
			t.Fatalf("attempt %d unexpectedly blocked", attempt+1)
		}
	}
	if allowed, retry := limiter.allow("198.51.100.25"); allowed || retry <= 0 {
		t.Fatalf("excess attempt allowed=%v retry=%s", allowed, retry)
	}
	now = now.Add(invitationAttemptWindow)
	if allowed, _ := limiter.allow("198.51.100.25"); !allowed {
		t.Fatal("attempt after the rate window was blocked")
	}
}
