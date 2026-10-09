package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeDirectSessionResolver struct {
	resolved     *session.ResolvedUser
	err          error
	cookie       string
	activeOrg    string
	bearer       string
	resolveCalls int
	bearerCalls  int
}

func (f *fakeDirectSessionResolver) Resolve(_ context.Context, cookie, activeOrg string) (*session.ResolvedUser, error) {
	f.resolveCalls++
	f.cookie, f.activeOrg = cookie, activeOrg
	return f.resolved, f.err
}

func (f *fakeDirectSessionResolver) ResolveBearerToken(_ context.Context, token, activeOrg string) (*session.ResolvedUser, error) {
	f.bearerCalls++
	f.bearer, f.activeOrg = token, activeOrg
	return f.resolved, f.err
}

type fakeDirectCapabilityExecutor struct {
	calls  int
	claims authbridge.CapabilityClaims
	capID  string
	input  json.RawMessage
	result capability.Result
	err    error
}

func (f *fakeDirectCapabilityExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	f.calls++
	f.claims, f.capID, f.input = claims, capabilityID, input
	return f.result, f.err
}

func directTestIdentity() *session.ResolvedUser {
	orgID := "11111111-1111-4111-8111-111111111111"
	return &session.ResolvedUser{
		UserID:        "22222222-2222-4222-8222-222222222222",
		OrgID:         &orgID,
		Permissions:   map[string]bool{"sales.write": true, "crm.read": true, "sales.read": false},
		EmailVerified: true,
		AuthSessionID: "33333333-3333-4333-8333-333333333333",
	}
}

func directCapabilityRequest(method, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/capabilities/execute", strings.NewReader(body))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return r
}

func TestSessionCapabilityHandlerBuildsClaimsFromResolvedSession(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"created":true}`)}}
	handler := NewSessionCapabilityHandler(resolver, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"sales.createOrder","input":{"customerId":"x"},"intentId":"intent-123"}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if resolver.resolveCalls != 1 || resolver.cookie != "session-cookie" || resolver.activeOrg != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("session resolution calls=%d cookie=%q activeOrg=%q", resolver.resolveCalls, resolver.cookie, resolver.activeOrg)
	}
	if executor.calls != 1 || executor.capID != "sales.createOrder" || executor.claims.Subject != directTestIdentity().UserID || executor.claims.OrganizationID != *directTestIdentity().OrgID {
		t.Fatalf("executor calls=%d capability=%q claims=%+v", executor.calls, executor.capID, executor.claims)
	}
	if executor.claims.ActorType != "human" || executor.claims.ActorID == nil || *executor.claims.ActorID != executor.claims.Subject || executor.claims.AuthSessionID != directTestIdentity().AuthSessionID || executor.claims.IntentID != "intent-123" {
		t.Fatalf("unexpected actor claims: %+v", executor.claims)
	}
	if strings.Join(executor.claims.Permissions, ",") != "crm.read,sales.write" {
		t.Fatalf("permissions=%v, want sorted verified permissions", executor.claims.Permissions)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache policy=%q", response.Header().Get("Cache-Control"))
	}
}

func TestSessionCapabilityHandlerRateLimitsInventoryImportsPerOrganization(t *testing.T) {
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	limiter := newInventoryImportRateLimiter(func() time.Time { return now })
	identity := directTestIdentity()
	identity.Permissions["inventory.write"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
	handler := NewSessionCapabilityHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).(*SessionCapabilityHandler)
	handler.inventoryImportLimit = limiter

	unauthorizedExecutor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
	unauthorizedHandler := NewSessionCapabilityHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, unauthorizedExecutor, nil).(*SessionCapabilityHandler)
	unauthorizedHandler.inventoryImportLimit = limiter
	for _, capabilityID := range []string{"inventory.importItems", "inventory.undoItemImport"} {
		input := `{"rows":[{"rowNumber":1,"sku":"RATE-1","name":"Rate test","salePriceMinor":100}]}`
		if capabilityID == "inventory.undoItemImport" {
			input = `{"itemIds":["10000000-0000-4000-8000-000000000001"]}`
		}
		response := httptest.NewRecorder()
		unauthorizedHandler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"`+capabilityID+`","input":`+input+`,"intentId":"import-intent-123456789"}`))
		if response.Code != http.StatusForbidden || strings.TrimSpace(response.Body.String()) != `{"error":"forbidden"}` || unauthorizedExecutor.calls != 0 {
			t.Fatalf("unauthorized %s status=%d body=%s executor calls=%d, want forbidden without dispatch", capabilityID, response.Code, response.Body.String(), unauthorizedExecutor.calls)
		}
	}
	for _, malformed := range []struct {
		capabilityID string
		input        string
	}{
		{capabilityID: "inventory.importItems", input: `{"rows":[]}`},
		{capabilityID: "inventory.undoItemImport", input: `{"itemIds":[]}`},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"`+malformed.capabilityID+`","input":`+malformed.input+`,"intentId":"import-intent-123456789"}`))
		if response.Code != http.StatusUnprocessableEntity || executor.calls != 0 {
			t.Fatalf("malformed %s status=%d body=%s executor calls=%d, want parser rejection before quota dispatch", malformed.capabilityID, response.Code, response.Body.String(), executor.calls)
		}
	}
	disabledExecutor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
	disabledHandler := NewSessionCapabilityHandlerWithDisabledCapabilities(
		&fakeDirectSessionResolver{resolved: identity}, disabledExecutor, nil,
		map[string]struct{}{"inventory.importItems": {}},
	).(*SessionCapabilityHandler)
	disabledHandler.inventoryImportLimit = limiter
	disabled := httptest.NewRecorder()
	disabledHandler.ServeHTTP(disabled, directCapabilityRequest(http.MethodPost, `{"capabilityId":"inventory.importItems","input":{"rows":[{"rowNumber":1,"sku":"RATE-1","name":"Rate test","salePriceMinor":100}]},"intentId":"import-intent-123456789"}`))
	if disabled.Code != http.StatusServiceUnavailable || disabledExecutor.calls != 0 {
		t.Fatalf("disabled import status=%d body=%s executor calls=%d, want disabled before quota dispatch", disabled.Code, disabled.Body.String(), disabledExecutor.calls)
	}

	for i := 0; i < inventoryImportRateLimit; i++ {
		capabilityID := "inventory.importItems"
		input := `{"rows":[{"rowNumber":1,"sku":"RATE-1","name":"Rate test","salePriceMinor":100}]}`
		if i%2 == 1 {
			capabilityID = "inventory.undoItemImport"
			input = `{"itemIds":["10000000-0000-4000-8000-000000000001"]}`
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"`+capabilityID+`","input":`+input+`,"intentId":"import-intent-123456789"}`))
		if response.Code != http.StatusOK {
			t.Fatalf("request %d status=%d body=%s, want allowed", i+1, response.Code, response.Body.String())
		}
	}

	limited := httptest.NewRecorder()
	handler.ServeHTTP(limited, directCapabilityRequest(http.MethodPost, `{"capabilityId":"inventory.importItems","input":{"rows":[{"rowNumber":1,"sku":"RATE-1","name":"Rate test","salePriceMinor":100}]},"intentId":"import-intent-123456789"}`))
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") != "3600" || executor.calls != inventoryImportRateLimit {
		t.Fatalf("status=%d Retry-After=%q executor calls=%d body=%s, want 429, 3600 seconds, and no extra dispatch", limited.Code, limited.Header().Get("Retry-After"), executor.calls, limited.Body.String())
	}

	unrelated := httptest.NewRecorder()
	handler.ServeHTTP(unrelated, directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{},"intentId":"import-intent-123456789"}`))
	if unrelated.Code != http.StatusOK {
		t.Fatalf("unrelated capability status=%d body=%s, want unaffected by import budget", unrelated.Code, unrelated.Body.String())
	}

	otherOrg := "44444444-4444-4444-8444-444444444444"
	otherIdentity := *identity
	otherIdentity.OrgID = &otherOrg
	otherIdentity.Permissions = map[string]bool{"*": true}
	otherHandler := NewSessionCapabilityHandler(&fakeDirectSessionResolver{resolved: &otherIdentity}, executor, nil).(*SessionCapabilityHandler)
	otherHandler.inventoryImportLimit = limiter
	otherResponse := httptest.NewRecorder()
	otherRequest := directCapabilityRequest(http.MethodPost, `{"capabilityId":"inventory.importItems","input":{"rows":[{"rowNumber":1,"sku":"RATE-1","name":"Rate test","salePriceMinor":100}]},"intentId":"import-intent-123456789"}`)
	otherRequest.Header.Set("Cookie", session.SessionCookieName+"=session-cookie; "+session.ActiveOrgCookieName+"="+otherOrg)
	otherHandler.ServeHTTP(otherResponse, otherRequest)
	if otherResponse.Code != http.StatusOK {
		t.Fatalf("different organization status=%d body=%s, want independent budget", otherResponse.Code, otherResponse.Body.String())
	}

	now = now.Add(inventoryImportRateWindow)
	reset := httptest.NewRecorder()
	handler.ServeHTTP(reset, directCapabilityRequest(http.MethodPost, `{"capabilityId":"inventory.undoItemImport","input":{"itemIds":["10000000-0000-4000-8000-000000000001"]},"intentId":"import-intent-123456789"}`))
	if reset.Code != http.StatusOK {
		t.Fatalf("request after window reset status=%d body=%s, want allowed", reset.Code, reset.Body.String())
	}
}

func TestSessionCapabilityHandlerRoutesInventoryRestoreItemImport(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["inventory.write"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"itemIds":["10000000-0000-4000-8000-000000000001"],"restored":1}`)}}
	handler := NewSessionCapabilityHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil)
	request := directCapabilityRequest(http.MethodPost, `{"capabilityId":"inventory.restoreItemImport","input":{"itemIds":["10000000-0000-4000-8000-000000000001"]},"intentId":"restore-intent-123456789"}`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "inventory.restoreItemImport" {
		t.Fatalf("restore status=%d body=%s executor calls=%d capability=%q, want one governed restore dispatch", response.Code, response.Body.String(), executor.calls, executor.capID)
	}

	malformed := httptest.NewRecorder()
	handler.ServeHTTP(malformed, directCapabilityRequest(http.MethodPost, `{"capabilityId":"inventory.restoreItemImport","input":{"itemIds":["bad-id"]},"intentId":"restore-intent-123456789"}`))
	if malformed.Code != http.StatusUnprocessableEntity || executor.calls != 1 {
		t.Fatalf("malformed restore status=%d body=%s executor calls=%d, want parser rejection before dispatch", malformed.Code, malformed.Body.String(), executor.calls)
	}
}

func TestSessionCapabilityHandlerSupportsBearerClientsWithoutTrustingClaims(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
	handler := NewSessionCapabilityHandler(resolver, executor, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/capabilities/execute", strings.NewReader(`{"capabilityId":"crm.listCustomers","input":{}}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer opaque-session-token")
	r.Header.Set("X-Organization-ID", *directTestIdentity().OrgID)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)

	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "opaque-session-token" || resolver.activeOrg != *directTestIdentity().OrgID || executor.calls != 1 {
		t.Fatalf("status=%d resolver=%+v executor=%d body=%s", response.Code, resolver, executor.calls, response.Body.String())
	}
	if executor.claims.OrganizationID != *directTestIdentity().OrgID {
		t.Fatalf("caller organization header changed resolved org to %q", executor.claims.OrganizationID)
	}
}

func TestSessionCapabilityHandlerRejectsInvalidAuthOriginAndCallerClaims(t *testing.T) {
	t.Run("missing identity", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{err: session.ErrNoSession}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`))
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("unverified or unscoped identity", func(t *testing.T) {
		identity := directTestIdentity()
		identity.EmailVerified = false
		resolver := &fakeDirectSessionResolver{resolved: identity}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`))
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("cross origin cookie request", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		r := directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`)
		r.Header.Set("Origin", "https://attacker.example")
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, r)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("scheme downgrade cookie request", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		r := directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`)
		r.Header.Set("Origin", "http://app.example.test")
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, r)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("invalid organization selector", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		r := directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`)
		r.Header.Set("X-Organization-ID", "not-a-uuid")
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, r)
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("unmatched organization selector", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		r := directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`)
		r.Header.Set("X-Organization-ID", "22222222-2222-4222-8222-222222222222")
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, r)
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("trusted proxy forwarded scheme", func(t *testing.T) {
		_, proxyCIDR, err := net.ParseCIDR("10.0.0.0/8")
		if err != nil {
			t.Fatal(err)
		}
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
		r := directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`)
		r.TLS = nil
		r.RemoteAddr = "10.1.2.3:9000"
		r.Header.Set("X-Forwarded-Proto", "https")
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil, []*net.IPNet{proxyCIDR}).ServeHTTP(response, r)
		if response.Code != http.StatusOK || executor.calls != 1 {
			t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("caller supplied claims are rejected", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{},"permissions":["iam.admin"]}`))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("malformed bearer header", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		r := directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`)
		r.Header.Set("Authorization", "Basic secret")
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, r)
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("malformed json", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":`))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d", response.Code, executor.calls)
		}
	})

	t.Run("executor errors map to safe statuses", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{err: capability.ErrNotMember}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`))
		if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "not member") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("executor unavailable", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, nil, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{}`))
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d", response.Code)
		}
	})

	t.Run("invalid method", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodGet, ""))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPost {
			t.Fatalf("status=%d allow=%q", response.Code, response.Header().Get("Allow"))
		}
	})

	t.Run("resolver unavailable", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(nil, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{}`))
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d", response.Code)
		}
	})

	t.Run("write response without data stays explicit", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{err: errors.New("backend detail")}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"crm.listCustomers","input":{}}`))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "backend detail") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestSessionCapabilityHandlerReturnsApprovalPendingEnvelope(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalID: "approval-1", ApprovalRationale: "Needs review"}}
	response := httptest.NewRecorder()
	NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"sales.createOrder","input":{},"intentId":"intent-123"}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), `"approvalId":"approval-1"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSessionCapabilityHandlerCanGateManufacturingDefineBom(t *testing.T) {
	body := `{"capabilityId":"manufacturing.defineBom","input":{"assemblySku":"DESK-1","components":[{"sku":"LEG-1","quantityThousandths":4000,"scrapPctThousandths":20000}]},"intentId":"bom-intent"}`
	t.Run("default off", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"componentCount":1}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, map[string]struct{}{"manufacturing.defineBom": {}})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusServiceUnavailable || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
	t.Run("opted in", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"componentCount":1}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, map[string]struct{}{})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "manufacturing.defineBom" {
			t.Fatalf("status=%d capability=%q executor=%d body=%s", response.Code, executor.capID, executor.calls, response.Body.String())
		}
		if string(executor.input) != `{"assemblySku":"DESK-1","components":[{"sku":"LEG-1","quantityThousandths":4000,"scrapPctThousandths":20000}]}` {
			t.Fatalf("unexpected input passed to governed executor: %s", executor.input)
		}
	})
}

func TestSessionCapabilityHandlerCanGateIngestedDocumentsRead(t *testing.T) {
	body := `{"capabilityId":"documents.listIngestedDocuments","input":{},"intentId":"documents-list-read"}`
	t.Run("default off", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"documents":[],"vendors":[]}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, DocumentsIngestedDisabledCapabilities(false))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusServiceUnavailable || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
	t.Run("opted in", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"documents":[],"vendors":[]}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, DocumentsIngestedDisabledCapabilities(true))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "documents.listIngestedDocuments" {
			t.Fatalf("status=%d capability=%q executor=%d body=%s", response.Code, executor.capID, executor.calls, response.Body.String())
		}
	})
}

func TestSessionCapabilityHandlerCanGateAuthoredDocumentVersionReads(t *testing.T) {
	cases := []struct {
		capabilityID string
		input        string
		output       string
	}{
		{"documents.listDocVersions", `{"documentId":"6f1b2c3d-0000-4000-8000-000000000001"}`, `{"versions":[]}`},
		{"documents.getDocVersion", `{"documentId":"6f1b2c3d-0000-4000-8000-000000000001","version":1}`, `{"version":1,"content":{},"html":"<p>Version</p>","note":null,"createdAt":"2026-09-29T08:00:00.000Z"}`},
	}
	for _, tc := range cases {
		t.Run(tc.capabilityID+" default off", func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(tc.output)}}
			handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, DocumentsVersionDisabledCapabilities(false))
			body := `{"capabilityId":"` + tc.capabilityID + `","input":` + tc.input + `,"intentId":"document-version-read"}`
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
			if response.Code != http.StatusServiceUnavailable || executor.calls != 0 {
				t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
		t.Run(tc.capabilityID+" opted in", func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(tc.output)}}
			handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, DocumentsVersionDisabledCapabilities(true))
			body := `{"capabilityId":"` + tc.capabilityID + `","input":` + tc.input + `,"intentId":"document-version-read"}`
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
			if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != tc.capabilityID {
				t.Fatalf("status=%d capability=%q executor=%d body=%s", response.Code, executor.capID, executor.calls, response.Body.String())
			}
		})
	}
}
