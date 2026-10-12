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

func TestSessionCapabilityHandlerMapsManufacturingDomainRefusalTo422(t *testing.T) {
	request := directCapabilityRequest(http.MethodPost, `{"capabilityId":"manufacturing.produceFromBom","input":{"assemblySku":"MISSING","quantityThousandths":1000},"intentId":"manufacturing-domain-refusal"}`)

	refusal := httptest.NewRecorder()
	NewSessionCapabilityHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{
		err: capability.ManufacturingDomainError("no item with SKU MISSING"),
	}, nil).ServeHTTP(refusal, request)
	if refusal.Code != http.StatusUnprocessableEntity || refusal.Body.String() != "{\"error\":\"no item with SKU MISSING\"}\n" {
		t.Fatalf("typed manufacturing refusal status=%d body=%s, want 422 with actionable error", refusal.Code, refusal.Body.String())
	}

	internal := httptest.NewRecorder()
	NewSessionCapabilityHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{
		err: errors.New("database connection failed"),
	}, nil).ServeHTTP(internal, directCapabilityRequest(http.MethodPost, `{"capabilityId":"manufacturing.produceFromBom","input":{"assemblySku":"MISSING","quantityThousandths":1000},"intentId":"manufacturing-internal-error"}`))
	if internal.Code != http.StatusInternalServerError {
		t.Fatalf("internal manufacturing error status=%d body=%s, want 500", internal.Code, internal.Body.String())
	}
}

func TestSessionCapabilityHandlerDispatchesInventoryBarcodeLookupThroughExecutor(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"inventory.read": true}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"item":{"sku":"MUG-1","name":"Ceramic mug"}}`)}}
	handler := NewSessionCapabilityHandler(resolver, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"inventory.lookupByBarcode","input":{"barcode":"MUG-CODE"}}`))

	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "inventory.lookupByBarcode" {
		t.Fatalf("status=%d calls=%d capability=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
	}
	if string(executor.input) != `{"barcode":"MUG-CODE"}` || executor.claims.OrganizationID != *identity.OrgID || executor.claims.Subject != identity.UserID {
		t.Fatalf("input=%s claims=%+v, want session-scoped barcode lookup", executor.input, executor.claims)
	}
	if strings.TrimSpace(response.Body.String()) != `{"ok":true,"data":{"item":{"sku":"MUG-1","name":"Ceramic mug"}}}` {
		t.Fatalf("body=%s, want the governed item lookup envelope", response.Body.String())
	}
}

func TestSessionCapabilityHandlerLimitsLargeBodiesToMessageUploads(t *testing.T) {
	t.Run("maximum upload envelope accepted", func(t *testing.T) {
		identity := directTestIdentity()
		resolver := &fakeDirectSessionResolver{resolved: identity}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
		body := `{"capabilityId":"` + messagingUploadCapabilityID + `","input":` + string(messageUploadInputAtLimit(t)) + `,"intentId":"upload-intent"}`
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != messagingUploadCapabilityID {
			t.Fatalf("status=%d calls=%d capability=%q body=%q", response.Code, executor.calls, executor.capID, response.Body.String())
		}
	})

	t.Run("upload envelope above hard ceiling rejected", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
		input := `{"contentBase64":"` + strings.Repeat("A", messagingUploadBodyLimit) + `"}`
		body := `{"capabilityId":"` + messagingUploadCapabilityID + `","input":` + input + `,"intentId":"upload-intent"}`
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%q, want upload beyond hard ceiling rejected", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("ordinary capability with upload-shaped data stays below 64 KiB", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
		input := `{"contentBase64":"` + strings.Repeat("A", sessionCapabilityBodyLimit) + `"}`
		body := `{"capabilityId":"crm.createCustomer","input":` + input + `,"intentId":"ordinary-intent"}`
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%q, want oversized ordinary capability rejected", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestSessionCapabilityHandlerAllowsFiveMegabyteDocumentUpload(t *testing.T) {
	fileBase64 := strings.Repeat("A", 4*((5<<20+2)/3))
	input := `{"title":"Upload","fileBase64":"` + fileBase64 + `","mimeType":"application/pdf"}`
	body := `{"capabilityId":"` + documentsCreateCapabilityID + `","input":` + input + `,"intentId":"document-upload-intent"}`
	identity := directTestIdentity()
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"documentId":"44444444-4444-4444-8444-444444444444"}`)}}
	response := httptest.NewRecorder()
	NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != documentsCreateCapabilityID {
		t.Fatalf("status=%d calls=%d capability=%q body=%q", response.Code, executor.calls, executor.capID, response.Body.String())
	}

	oversizedInput := `{"title":"Upload","fileBase64":"` + strings.Repeat("A", documentsUploadBodyLimit) + `","mimeType":"application/pdf"}`
	oversizedBody := `{"capabilityId":"` + documentsCreateCapabilityID + `","input":` + oversizedInput + `,"intentId":"oversized-document-upload-intent"}`
	response = httptest.NewRecorder()
	NewSessionCapabilityHandler(resolver, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, oversizedBody))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%q, want oversized document capability body rejected", response.Code, response.Body.String())
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

	t.Run("accounting domain refusals are definitive client errors", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{err: capability.AccountingDomainError("credit note requires invoice workflow")}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"accounting.reverseEntry","input":{}}`))
		if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "credit note requires invoice workflow") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("creator domain refusals use the Vite refusal envelope", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{err: capability.CreatorDomainError("proposal lacks valid isolated candidate evidence")}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"creator.stageCandidate","input":{}}`))
		var refusal struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &refusal); err != nil {
			t.Fatalf("decode refusal: %v body=%s", err, response.Body.String())
		}
		if response.Code != http.StatusUnprocessableEntity || refusal.OK || refusal.Error != "proposal lacks valid isolated candidate evidence" ||
			strings.TrimSpace(response.Body.String()) != `{"ok":false,"error":"proposal lacks valid isolated candidate evidence"}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("creator review conflicts use the Vite refusal envelope", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{err: capability.CreatorDomainError("conflict: proposal already decided or no longer in review")}
		response := httptest.NewRecorder()
		NewSessionCapabilityHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"capabilityId":"creator.reviewProposal","input":{"proposalId":"11111111-1111-4111-8111-111111111111","decision":"approved"}}`))
		var refusal struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &refusal); err != nil {
			t.Fatalf("decode refusal: %v body=%s", err, response.Body.String())
		}
		if response.Code != http.StatusUnprocessableEntity || refusal.OK || !strings.HasPrefix(refusal.Error, "conflict:") ||
			strings.TrimSpace(response.Body.String()) != `{"ok":false,"error":"conflict: proposal already decided or no longer in review"}` {
			t.Fatalf("status=%d refusal=%+v body=%s", response.Code, refusal, response.Body.String())
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

func TestSessionCapabilityHandlerCanGateManufacturingBomWrites(t *testing.T) {
	for _, test := range []struct {
		capabilityID string
		input        string
	}{
		{capabilityID: "manufacturing.defineBom", input: `{"assemblySku":"DESK-1","components":[{"sku":"LEG-1","quantityThousandths":4000,"scrapPctThousandths":20000}]}`},
		{capabilityID: "manufacturing.deleteBom", input: `{"assemblySku":"DESK-1"}`},
	} {
		t.Run(test.capabilityID, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"capabilityId": test.capabilityID,
				"input":        json.RawMessage(test.input),
				"intentId":     "bom-intent",
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Run("explicitly disabled", func(t *testing.T) {
				resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
				executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
				handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, map[string]struct{}{test.capabilityID: {}})
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, string(body)))
				if response.Code != http.StatusServiceUnavailable || executor.calls != 0 {
					t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
				}
			})
			t.Run("enabled", func(t *testing.T) {
				resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
				executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
				handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, map[string]struct{}{})
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, string(body)))
				if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != test.capabilityID {
					t.Fatalf("status=%d capability=%q executor=%d body=%s", response.Code, executor.capID, executor.calls, response.Body.String())
				}
				if string(executor.input) != test.input {
					t.Fatalf("unexpected input passed to governed executor: %s", executor.input)
				}
			})
		})
	}
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

func TestSessionCapabilityHandlerCanGateAuthoredDocumentEditorRead(t *testing.T) {
	body := `{"capabilityId":"documents.getDoc","input":{"documentId":"6f1b2c3d-0000-4000-8000-000000000001"},"intentId":"documents-editor-read"}`
	t.Run("default off", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"document":{}}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, DocumentsEditorDisabledCapabilities(false))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusServiceUnavailable || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
	t.Run("opted in", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"document":{}}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, DocumentsEditorDisabledCapabilities(true))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "documents.getDoc" {
			t.Fatalf("status=%d capability=%q executor=%d body=%s", response.Code, executor.capID, executor.calls, response.Body.String())
		}
	})
}

func TestSessionCapabilityHandlerCanGateMessagingPeopleRead(t *testing.T) {
	body := `{"capabilityId":"messaging.listPeople","input":{"limit":100},"intentId":"messaging-people-read"}`
	t.Run("default off", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"people":[]}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, MessagingPeopleDisabledCapabilities(false))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusServiceUnavailable || executor.calls != 0 {
			t.Fatalf("status=%d executor=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
	t.Run("opted in", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"people":[]}`)}}
		handler := NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, executor, nil, MessagingPeopleDisabledCapabilities(true))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, directCapabilityRequest(http.MethodPost, body))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "messaging.listPeople" {
			t.Fatalf("status=%d capability=%q executor=%d body=%s", response.Code, executor.capID, executor.calls, response.Body.String())
		}
	})
}
