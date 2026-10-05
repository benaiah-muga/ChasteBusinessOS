package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func scimTokenIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	return identity
}

func scimTokenRequest(method, path, body string) *http.Request {
	r := directCapabilityRequest(method, body)
	r.URL.Path = "/api/scim/tokens"
	if path != "" {
		r.URL.RawQuery = path
	}
	r.Header.Set("Idempotency-Key", "44444444-4444-4444-8444-444444444444")
	return r
}

func TestSCIMTokenSessionHandlerRequiresVerifiedAdminSession(t *testing.T) {
	for _, tc := range []struct {
		name     string
		method   string
		identity *session.ResolvedUser
		status   int
	}{
		{name: "unverified", method: http.MethodGet, identity: func() *session.ResolvedUser { v := scimTokenIdentity(); v.EmailVerified = false; return v }(), status: http.StatusUnauthorized},
		{name: "missing session", method: http.MethodGet, identity: func() *session.ResolvedUser { v := scimTokenIdentity(); v.AuthSessionID = ""; return v }(), status: http.StatusUnauthorized},
		{name: "missing admin write", method: http.MethodPost, identity: directTestIdentity(), status: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: tc.identity}
			handler := NewSCIMTokenSessionHandler(nil, resolver, &fakeDirectCapabilityExecutor{}, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, scimTokenRequest(tc.method, "", `{}`))
			if response.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, tc.status, response.Body.String())
			}
		})
	}
}

func TestSCIMTokenSessionHandlerValidatesCreateBodyBeforeDatabaseAccess(t *testing.T) {
	for _, body := range []string{
		`{`,
		`{"expiresInDays":0}`,
		`{"expiresInDays":366}`,
		`{"expiresInDays":1.5}`,
		`{"label":"` + strings.Repeat("x", scimTokenLabelLimit+1) + `"}`,
		`{"unknown":true}`,
	} {
		t.Run(body[:min(len(body), 24)], func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: scimTokenIdentity()}
			handler := NewSCIMTokenSessionHandler(nil, resolver, &fakeDirectCapabilityExecutor{}, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, scimTokenRequest(http.MethodPost, "", body))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d want=400 body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestSCIMTokenHashMatchesRawTokenHashFormat(t *testing.T) {
	raw := "scim_example"
	want := "2bdd3e2f01c326f45c682fee61ce4440f72da2b0b2848fe00627b86cfb68f78d"
	if got := hashSCIMManagementToken(raw); got != want {
		t.Fatalf("token hash=%q, want %q", got, want)
	}
}

func TestSCIMManagedTokenTimestampsMatchLegacyMillisecondPrecision(t *testing.T) {
	created := time.Date(2026, time.January, 2, 3, 4, 5, 123456789, time.UTC)
	expires := created.Add(time.Hour)
	lastUsed := created.Add(time.Minute)
	row := scimManagedToken{CreatedAt: created, ExpiresAt: &expires, LastUsedAt: &lastUsed}

	truncateSCIMTokenTimestamps(&row)
	want := created.Truncate(time.Millisecond)
	if !row.CreatedAt.Equal(want) || !row.ExpiresAt.Equal(expires.Truncate(time.Millisecond)) || !row.LastUsedAt.Equal(lastUsed.Truncate(time.Millisecond)) {
		t.Fatalf("timestamp precision mismatch: created=%s expires=%s lastUsed=%s", row.CreatedAt, row.ExpiresAt, row.LastUsedAt)
	}
}

func TestSCIMTokenSessionHandlerRequiresIdempotencyKeyForWrites(t *testing.T) {
	for _, tc := range []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodPost, body: `{}`},
		{method: http.MethodDelete, path: "id=11111111-1111-4111-8111-111111111111"},
	} {
		executor := &fakeDirectCapabilityExecutor{}
		handler := NewSCIMTokenSessionHandler(nil, &fakeDirectSessionResolver{resolved: scimTokenIdentity()}, executor, nil, nil)
		req := scimTokenRequest(tc.method, tc.path, tc.body)
		req.Header.Del("Idempotency-Key")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("method=%s status=%d calls=%d body=%s", tc.method, response.Code, executor.calls, response.Body.String())
		}
	}
}

func TestSCIMTokenCreateReplayNeverReturnsRawToken(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{
		OK: true, Replayed: true,
		Data: json.RawMessage(`{"tokenId":"11111111-1111-4111-8111-111111111111","label":"fixture"}`),
	}}
	handler := NewSCIMTokenSessionHandler(nil, &fakeDirectSessionResolver{resolved: scimTokenIdentity()}, executor, nil, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, scimTokenRequest(http.MethodPost, "", `{}`))
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	_, exposedToken := body["token"]
	if response.Code != http.StatusConflict || executor.calls != 1 || exposedToken || strings.Contains(response.Body.String(), "scim_") {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
	if executor.claims.IntentID != "scim:tokens:44444444-4444-4444-8444-444444444444" {
		t.Fatalf("intent id=%q does not include the stable client key", executor.claims.IntentID)
	}
}

func TestSCIMTokenRevokePreservesPendingApprovalResponse(t *testing.T) {
	const approvalID = "55555555-5555-4555-8555-555555555555"
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{
		PendingApproval: true, ApprovalID: approvalID,
		ApprovalRationale: "Token revocation requires human approval.", Error: "pending human approval",
	}}
	handler := NewSCIMTokenSessionHandler(nil, &fakeDirectSessionResolver{resolved: scimTokenIdentity()}, executor, nil, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, scimTokenRequest(http.MethodDelete, "id=11111111-1111-4111-8111-111111111111", ""))
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		OK              bool   `json:"ok"`
		PendingApproval bool   `json:"pendingApproval"`
		Reason          string `json:"reason"`
		ApprovalID      string `json:"approvalId"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.OK || !body.PendingApproval || body.ApprovalID != approvalID || body.Reason != executor.result.ApprovalRationale {
		t.Fatalf("pending response=%+v", body)
	}
}
