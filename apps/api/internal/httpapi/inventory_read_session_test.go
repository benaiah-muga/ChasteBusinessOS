package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type inventoryReadTestExecutor struct {
	outputs map[string]json.RawMessage
	results map[string]capability.Result
	ids     []string
	claims  []authbridge.CapabilityClaims
	err     error
}

func (e *inventoryReadTestExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, _ json.RawMessage) (capability.Result, error) {
	e.ids = append(e.ids, capabilityID)
	e.claims = append(e.claims, claims)
	if e.err != nil {
		return capability.Result{}, e.err
	}
	if result, ok := e.results[capabilityID]; ok {
		return result, nil
	}
	return capability.Result{OK: true, Data: e.outputs[capabilityID]}, nil
}

func inventoryReadTestIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"inventory.read": true}
	return identity
}

func inventoryReadRequest(path string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *inventoryReadTestIdentity().OrgID})
	return r
}

func inventoryReadFixtureExecutor() *inventoryReadTestExecutor {
	return &inventoryReadTestExecutor{outputs: map[string]json.RawMessage{
		"inventory.stockReport":         json.RawMessage(`{"items":[{"sku":"MUG-1","name":"Mug","kind":"goods","unitLabel":"unit","salePriceMinor":1250,"imageUrl":null,"tags":["drinkware"],"barcode":"123","onHandThousandths":2000,"valueMinor":900,"avgUnitCostMinor":450,"reservedThousandths":0,"availableThousandths":2000,"reorderPointThousandths":3000,"reorderNeeded":true}],"totalValueMinor":900}`),
		"inventory.listItemMetadata":    json.RawMessage(`{"items":[{"id":"44444444-4444-4444-8444-444444444444","sku":"MUG-1","kind":"goods","unitLabel":"unit","salePriceMinor":1250,"barcode":"123"}]}`),
		"inventory.listLocationRecords": json.RawMessage(`{"locations":[{"id":"55555555-5555-4555-8555-555555555555","orgId":"11111111-1111-4111-8111-111111111111","code":"MAIN","name":"Main","createdAt":"2026-10-05T00:00:00.000Z"}]}`),
		"inventory.listReservations":    json.RawMessage(`{"reservations":[]}`),
		"inventory.listCycleCounts":     json.RawMessage(`{"cycleCounts":[]}`),
		"inventory.listLots":            json.RawMessage(`{"lots":[{"id":"66666666-6666-4666-8666-666666666666","sku":"MUG-1","lotCode":"LOT-1","balanceThousandths":2000,"expiresAt":null}]}`),
		"inventory.listTransfers":       json.RawMessage(`{"transfers":[{"id":"77777777-7777-4777-8777-777777777777","number":1,"status":"draft","note":null,"createdAt":"2026-10-05T00:00:00.000Z","from":"MAIN","to":"BACK","lines":[{"lineId":"88888888-8888-4888-8888-888888888888","sku":"MUG-1","quantityThousandths":1000,"confirmedThousandths":0}]}]}`),
		"inventory.itemHistory":         json.RawMessage(`{"movements":[{"id":"m1","quantityDelta":2000,"reason":"opening","note":null,"refType":null,"unitCostMinor":450,"lotCode":null,"locationCode":null,"actorType":"human","createdAt":"2026-10-05T00:00:00.000Z"}]}`),
	}}
}

func TestInventoryReadSessionHandlerMapsLegacyCatalogShapeThroughCapabilities(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
	executor := inventoryReadFixtureExecutor()
	response := httptest.NewRecorder()
	NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory"))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Items           []map[string]json.RawMessage `json:"items"`
		TotalValueMinor int64                        `json:"totalValueMinor"`
		ReorderAlerts   []map[string]json.RawMessage `json:"reorderAlerts"`
		Locations       []json.RawMessage            `json:"locations"`
		Reservations    []json.RawMessage            `json:"reservations"`
		CycleCounts     []json.RawMessage            `json:"cycleCounts"`
		Lots            []map[string]json.RawMessage `json:"lots"`
		Transfers       []map[string]json.RawMessage `json:"transfers"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || string(body.Items[0]["id"]) != `"44444444-4444-4444-8444-444444444444"` ||
		string(body.Items[0]["totalValueMinor"]) != "900" || body.TotalValueMinor != 900 || len(body.ReorderAlerts) != 1 ||
		string(body.ReorderAlerts[0]["shortfallThousandths"]) != "1000" || len(body.Locations) != 1 ||
		len(body.Reservations) != 0 || len(body.CycleCounts) != 0 || len(body.Lots) != 1 || len(body.Transfers) != 1 {
		t.Fatalf("legacy catalog response shape mismatch: %+v", body)
	}
	if _, hasBalance := body.Lots[0]["balanceThousandths"]; hasBalance {
		t.Fatal("legacy lot response unexpectedly included balanceThousandths")
	}
	if _, hasCreatedAt := body.Transfers[0]["createdAt"]; hasCreatedAt {
		t.Fatal("legacy transfer response unexpectedly included createdAt")
	}
	if len(executor.ids) != 7 {
		t.Fatalf("capability calls=%v, want 7 reads", executor.ids)
	}
	for _, claims := range executor.claims {
		if claims.OrganizationID != *inventoryReadTestIdentity().OrgID || claims.Subject != inventoryReadTestIdentity().UserID || claims.AuthSessionID != inventoryReadTestIdentity().AuthSessionID {
			t.Fatalf("capability ran outside verified session/org: %+v", claims)
		}
	}
}

func TestInventoryReadSessionHandlerMapsSkuHistoryAndValidatesQuery(t *testing.T) {
	t.Run("history", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
		executor := inventoryReadFixtureExecutor()
		response := httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory?sku=MUG-1"))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"movements":[`) || len(executor.ids) != 1 || executor.ids[0] != "inventory.itemHistory" {
			t.Fatalf("status=%d calls=%v body=%s", response.Code, executor.ids, response.Body.String())
		}
	})
	t.Run("native bearer session resolves the requested organization", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
		executor := inventoryReadFixtureExecutor()
		request := inventoryReadRequest("/api/inventory?sku=MUG-1")
		request.Header.Set("Authorization", "Bearer native-session-token")
		response := httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.resolveCalls != 0 || resolver.bearer != "native-session-token" || resolver.activeOrg != *inventoryReadTestIdentity().OrgID {
			t.Fatalf("status=%d bearer calls=%d cookie calls=%d bearer=%q org=%q body=%s", response.Code, resolver.bearerCalls, resolver.resolveCalls, resolver.bearer, resolver.activeOrg, response.Body.String())
		}
	})
	t.Run("repeated sku rejected before execution", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
		executor := inventoryReadFixtureExecutor()
		response := httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory?sku=A&sku=B"))
		if response.Code != http.StatusBadRequest || len(executor.ids) != 0 {
			t.Fatalf("status=%d calls=%v body=%s", response.Code, executor.ids, response.Body.String())
		}
	})
	t.Run("invalid sku rejected before execution", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
		executor := inventoryReadFixtureExecutor()
		response := httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory?sku=%0Ainvalid"))
		if response.Code != http.StatusBadRequest || len(executor.ids) != 0 {
			t.Fatalf("status=%d calls=%v body=%s", response.Code, executor.ids, response.Body.String())
		}
	})
	t.Run("missing sku preserves legacy 404 without hiding permission errors", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
		executor := inventoryReadFixtureExecutor()
		executor.results = map[string]capability.Result{"inventory.itemHistory": {OK: false, Error: "no item with SKU MISSING"}}
		response := httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory?sku=MISSING"))
		if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "no item with SKU MISSING") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}

		executor.results["inventory.itemHistory"] = capability.Result{OK: false, Error: "requires inventory.read permission"}
		response = httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory?sku=PRIVATE"))
		if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "PRIVATE") {
			t.Fatalf("permission error status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestInventoryReadSessionHandlerRequiresSessionOrgPermissionAndModule(t *testing.T) {
	tests := []struct {
		name     string
		identity *session.ResolvedUser
		selector string
		want     int
	}{
		{name: "unverified session", identity: func() *session.ResolvedUser { v := inventoryReadTestIdentity(); v.EmailVerified = false; return v }(), want: http.StatusUnauthorized},
		{name: "missing auth session", identity: func() *session.ResolvedUser { v := inventoryReadTestIdentity(); v.AuthSessionID = ""; return v }(), want: http.StatusUnauthorized},
		{name: "mismatched org header", identity: inventoryReadTestIdentity(), selector: "99999999-9999-4999-8999-999999999999", want: http.StatusForbidden},
		{name: "missing permission", identity: func() *session.ResolvedUser {
			v := inventoryReadTestIdentity()
			v.Permissions = map[string]bool{}
			return v
		}(), want: http.StatusForbidden},
		{name: "disabled module", identity: func() *session.ResolvedUser {
			v := inventoryReadTestIdentity()
			v.ModulesRestricted = true
			v.EnabledModules = []string{"pos"}
			return v
		}(), want: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: test.identity}
			executor := inventoryReadFixtureExecutor()
			request := inventoryReadRequest("/api/inventory")
			if test.selector != "" {
				request.Header.Set("X-Organization-ID", test.selector)
			}
			response := httptest.NewRecorder()
			NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
			if response.Code != test.want || len(executor.ids) != 0 {
				t.Fatalf("status=%d calls=%v body=%s", response.Code, executor.ids, response.Body.String())
			}
		})
	}
	t.Run("executor identity failure", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
		executor := inventoryReadFixtureExecutor()
		executor.err = capability.ErrSessionInvalid
		response := httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory?sku=A"))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("database failure is sanitized", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: inventoryReadTestIdentity()}
		executor := inventoryReadFixtureExecutor()
		executor.err = errors.New("private database detail")
		response := httptest.NewRecorder()
		NewInventoryReadSessionHandler(resolver, executor, nil).ServeHTTP(response, inventoryReadRequest("/api/inventory?sku=A"))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database detail") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestMountGoInventoryReadRouteFallsThroughWritesAndOtherPaths(t *testing.T) {
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("legacy")) })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("go")) })
	handler := MountGoInventoryReadRoute(legacy, goRoute)
	for _, test := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/inventory", "go"},
		{http.MethodGet, "/api/inventory?sku=A", "go"},
		{http.MethodPost, "/api/inventory", "legacy"},
		{http.MethodPatch, "/api/inventory", "legacy"},
		{http.MethodGet, "/api/inventory/history", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Body.String() != test.want {
			t.Errorf("%s %s body=%q, want %q", test.method, test.path, response.Body.String(), test.want)
		}
	}
}
