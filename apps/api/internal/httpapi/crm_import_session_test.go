package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func crmImportTestIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions["crm.write"] = true
	identity.Permissions["inventory.write"] = true
	return identity
}

func crmImportPostRequest(body string) *http.Request {
	return crmCollectionTestRequest(http.MethodPost, "/api/import", body)
}

func crmCustomerImportEcho(result *capability.Result) *crmRoutingExecutor {
	return &crmRoutingExecutor{result: func(_ string, claims authbridge.CapabilityClaims, _ json.RawMessage) (capability.Result, error) {
		if result != nil {
			return *result, nil
		}
		data, _ := json.Marshal(map[string]any{
			"createdIds":           []string{crmTestCustomerID},
			"imported":             1,
			"skippedDuplicateRows": []int64{3},
			"importIntentId":       claims.IntentID,
		})
		return capability.Result{OK: true, Data: data}, nil
	}}
}

func TestCRMImportCustomersPreparesRowsAndUndo(t *testing.T) {
	executor := crmCustomerImportEcho(nil)
	handler := NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, crmImportPostRequest(`{"entity":"customers","rows":[
		{"rowNumber":2,"name":"  Ada  ","email":"ada@example.test","creditLimit":"1,200.50","paymentTermDays":"30"},
		{"name":"Bob","creditLimitMinor":null,"allowDuplicate":true}
	]}`))

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.capID != "crm.importCustomers" || executor.calls != 1 {
		t.Fatalf("capability=%q calls=%d", executor.capID, executor.calls)
	}
	if !crmIsV4UUID(executor.claims.IntentID) {
		t.Fatalf("intent=%q, want generated v4 UUID", executor.claims.IntentID)
	}
	var input struct {
		Rows []struct {
			RowNumber        int64   `json:"rowNumber"`
			Name             string  `json:"name"`
			CreditLimitMinor *int64  `json:"creditLimitMinor"`
			PaymentTermDays  *int64  `json:"paymentTermDays"`
			AllowDuplicate   bool    `json:"allowDuplicate"`
			Email            *string `json:"email"`
		} `json:"rows"`
	}
	if json.Unmarshal(executor.input, &input) != nil || len(input.Rows) != 2 {
		t.Fatalf("input=%s", executor.input)
	}
	first, second := input.Rows[0], input.Rows[1]
	if first.RowNumber != 2 || first.Name != "Ada" || first.CreditLimitMinor == nil || *first.CreditLimitMinor != 120050 ||
		first.PaymentTermDays == nil || *first.PaymentTermDays != 30 || first.Email == nil || *first.Email != "ada@example.test" {
		t.Fatalf("first row=%+v", first)
	}
	if second.RowNumber != 3 || second.Name != "Bob" || second.CreditLimitMinor != nil || second.PaymentTermDays != nil || !second.AllowDuplicate {
		t.Fatalf("second row=%+v", second)
	}
	var body struct {
		Inserted             int64    `json:"inserted"`
		SkippedDuplicates    int      `json:"skippedDuplicates"`
		SkippedDuplicateRows []int64  `json:"skippedDuplicateRows"`
		CreatedIDs           []string `json:"createdIds"`
		ImportIntentID       string   `json:"importIntentId"`
	}
	if json.Unmarshal(response.Body.Bytes(), &body) != nil {
		t.Fatalf("body=%s", response.Body.String())
	}
	if body.Inserted != 1 || body.SkippedDuplicates != 1 || len(body.SkippedDuplicateRows) != 1 || body.CreatedIDs[0] != crmTestCustomerID || body.ImportIntentID != executor.claims.IntentID {
		t.Fatalf("body=%+v", body)
	}

	undoExecutor := &crmRoutingExecutor{result: func(_ string, claims authbridge.CapabilityClaims, input json.RawMessage) (capability.Result, error) {
		var parsed struct {
			ImportIntentID string `json:"importIntentId"`
		}
		_ = json.Unmarshal(input, &parsed)
		data, _ := json.Marshal(map[string]any{
			"customerIds": []string{crmTestCustomerID}, "deactivated": 1,
			"importIntentId": parsed.ImportIntentID, "undoIntentId": claims.IntentID,
		})
		return capability.Result{OK: true, Data: data}, nil
	}}
	undo := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, undoExecutor, nil).
		ServeHTTP(undo, crmImportPostRequest(`{"entity":"customers","action":"undo","importIds":["`+crmTestCustomerID+`"],"importIntentId":"`+crmTestDealID+`"}`))
	if undo.Code != http.StatusOK || undoExecutor.capID != "crm.undoCustomerImport" {
		t.Fatalf("status=%d capability=%q body=%s", undo.Code, undoExecutor.capID, undo.Body.String())
	}
	var undoInput map[string]json.RawMessage
	if json.Unmarshal(undoExecutor.input, &undoInput) != nil || string(undoInput["importIntentId"]) != `"`+crmTestDealID+`"` ||
		string(undoInput["customerIds"]) != `["`+crmTestCustomerID+`"]` || undoInput["importIds"] != nil {
		t.Fatalf("undo input=%s", undoExecutor.input)
	}
	var undoBody struct {
		Undone    int64 `json:"undone"`
		Remaining int64 `json:"remaining"`
	}
	if json.Unmarshal(undo.Body.Bytes(), &undoBody) != nil || undoBody.Undone != 1 || undoBody.Remaining != 0 {
		t.Fatalf("undo body=%s", undo.Body.String())
	}

	missingIntent := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, crmCustomerImportEcho(nil), nil).
		ServeHTTP(missingIntent, crmImportPostRequest(`{"entity":"customers","action":"undo","importIds":["`+crmTestCustomerID+`"]}`))
	if missingIntent.Code != http.StatusBadRequest || !strings.Contains(missingIntent.Body.String(), `"code":"invalid"`) {
		t.Fatalf("status=%d body=%s", missingIntent.Code, missingIntent.Body.String())
	}
}

func TestCRMImportProductsPrepareRowsAndUndo(t *testing.T) {
	executor := &crmRoutingExecutor{result: func(_ string, _ authbridge.CapabilityClaims, _ json.RawMessage) (capability.Result, error) {
		data, _ := json.Marshal(map[string]any{
			"createdIds": []string{crmTestCustomerID}, "imported": 1, "skippedDuplicateRows": []int64{},
		})
		return capability.Result{OK: true, Data: data}, nil
	}}
	handler := NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, crmImportPostRequest(`{"entity":"products","rows":[
		{"name":"Consulting","type":"service","salePrice":"9.99"},
		{"name":"Widget","sku":"SKU-1","salePriceMinor":2500,"tags":["hardware","new"]}
	]}`))
	if response.Code != http.StatusOK || executor.capID != "inventory.importItems" {
		t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
	}
	var input struct {
		Rows []struct {
			RowNumber    int64    `json:"rowNumber"`
			Name         string   `json:"name"`
			SKU          string   `json:"sku"`
			Kind         string   `json:"kind"`
			UnitLabel    string   `json:"unitLabel"`
			SalePrice    int64    `json:"salePriceMinor"`
			ReorderPoint int64    `json:"reorderPointThousandths"`
			Barcode      *string  `json:"barcode"`
			Tags         []string `json:"tags"`
		} `json:"rows"`
	}
	if json.Unmarshal(executor.input, &input) != nil || len(input.Rows) != 2 {
		t.Fatalf("input=%s response=%s", executor.input, response.Body.String())
	}
	first, second := input.Rows[0], input.Rows[1]
	if first.RowNumber != 2 || first.Kind != "service" || first.UnitLabel != "hour" || first.SalePrice != 999 || !strings.HasPrefix(first.SKU, "SVC-IMPORT-") || len(first.SKU) != len("SVC-IMPORT-")+8 {
		t.Fatalf("first row=%+v", first)
	}
	if second.Kind != "goods" || second.UnitLabel != "unit" || second.SalePrice != 2500 || second.SKU != "SKU-1" || strings.Join(second.Tags, ",") != "hardware,new" {
		t.Fatalf("second row=%+v", second)
	}
	if strings.Contains(response.Body.String(), "importIntentId") {
		t.Fatalf("product import must not add importIntentId: %s", response.Body.String())
	}

	undoExecutor := &crmRoutingExecutor{result: func(_ string, _ authbridge.CapabilityClaims, _ json.RawMessage) (capability.Result, error) {
		data, _ := json.Marshal(map[string]any{"itemIds": []string{crmTestCustomerID}, "archived": 1})
		return capability.Result{OK: true, Data: data}, nil
	}}
	undo := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, undoExecutor, nil).
		ServeHTTP(undo, crmImportPostRequest(`{"entity":"products","action":"undo","importIds":["`+crmTestCustomerID+`"]}`))
	if undo.Code != http.StatusOK || undoExecutor.capID != "inventory.undoItemImport" {
		t.Fatalf("status=%d capability=%q body=%s", undo.Code, undoExecutor.capID, undo.Body.String())
	}
	var undoInput map[string]json.RawMessage
	if json.Unmarshal(undoExecutor.input, &undoInput) != nil || string(undoInput["itemIds"]) != `["`+crmTestCustomerID+`"]` {
		t.Fatalf("undo input=%s", undoExecutor.input)
	}
	var undoBody struct {
		Undone    int64 `json:"undone"`
		Remaining int64 `json:"remaining"`
	}
	if json.Unmarshal(undo.Body.Bytes(), &undoBody) != nil || undoBody.Undone != 1 || undoBody.Remaining != 0 {
		t.Fatalf("undo body=%s", undo.Body.String())
	}
}

func TestCRMImportRowsKeepConversionErrorsAndRejectSchemaViolations(t *testing.T) {
	executor := crmCustomerImportEcho(nil)
	response := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, executor, nil).
		ServeHTTP(response, crmImportPostRequest(`{"entity":"customers","rows":[
			{"rowNumber":2,"name":"Ada","creditLimit":"not-a-number"},
			{"rowNumber":3,"name":"Bob","paymentTermDays":-5},
			{"rowNumber":4,"name":"Cy","creditLimitMinor":500}
		]}`))
	if response.Code != http.StatusOK || executor.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
	var input struct {
		Rows []json.RawMessage `json:"rows"`
	}
	if json.Unmarshal(executor.input, &input) != nil || len(input.Rows) != 1 || !strings.Contains(string(input.Rows[0]), `"rowNumber":4`) {
		t.Fatalf("input=%s", executor.input)
	}
	var body struct {
		Errors []crmImportRowIssue `json:"errors"`
	}
	if json.Unmarshal(response.Body.Bytes(), &body) != nil || len(body.Errors) != 2 {
		t.Fatalf("body=%s", response.Body.String())
	}
	if body.Errors[0].Row != 2 || body.Errors[0].Field != "creditLimit" || body.Errors[1].Row != 3 || body.Errors[1].Field != "paymentTermDays" {
		t.Fatalf("errors=%+v", body.Errors)
	}

	fatalExecutor := crmCustomerImportEcho(nil)
	fatal := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, fatalExecutor, nil).
		ServeHTTP(fatal, crmImportPostRequest(`{"entity":"customers","rows":[{"rowNumber":2,"email":"ada@example.test"}]}`))
	if fatal.Code != http.StatusBadRequest || !strings.Contains(fatal.Body.String(), "Some rows are invalid") || fatalExecutor.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", fatal.Code, fatalExecutor.calls, fatal.Body.String())
	}
	var fatalBody struct {
		Detail []crmImportRowIssue `json:"detail"`
		Code   string              `json:"code"`
	}
	if json.Unmarshal(fatal.Body.Bytes(), &fatalBody) != nil || fatalBody.Code != "invalid" || len(fatalBody.Detail) != 1 || fatalBody.Detail[0].Row != 2 || fatalBody.Detail[0].Field != "name" {
		t.Fatalf("body=%s", fatal.Body.String())
	}

	noRows := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, crmCustomerImportEcho(nil), nil).
		ServeHTTP(noRows, crmImportPostRequest(`{"entity":"customers","rows":[]}`))
	if noRows.Code != http.StatusBadRequest || !strings.Contains(noRows.Body.String(), "No rows to import.") {
		t.Fatalf("status=%d body=%s", noRows.Code, noRows.Body.String())
	}
}

func TestCRMImportGuardsEntityPermissionAndBody(t *testing.T) {
	executor := crmCustomerImportEcho(nil)
	handler := NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, executor, nil)

	unknown := httptest.NewRecorder()
	handler.ServeHTTP(unknown, crmImportPostRequest(`{"entity":"invoices","rows":[{"name":"Ada"}]}`))
	if unknown.Code != http.StatusBadRequest || executor.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", unknown.Code, executor.calls, unknown.Body.String())
	}

	identity := directTestIdentity()
	denied := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).
		ServeHTTP(denied, crmImportPostRequest(`{"entity":"customers","rows":[{"name":"Ada"}]}`))
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "forbidden: missing crm.write") {
		t.Fatalf("status=%d body=%s", denied.Code, denied.Body.String())
	}

	strict := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, executor, nil).
		ServeHTTP(strict, crmImportPostRequest(`{"entity":"customers","rows":[{"name":"Ada"}],"unexpected":true}`))
	if strict.Code != http.StatusBadRequest || !strings.Contains(strict.Body.String(), `"code":"invalid"`) {
		t.Fatalf("status=%d body=%s", strict.Code, strict.Body.String())
	}

	method := httptest.NewRecorder()
	methodRequest := crmImportPostRequest(`{}`)
	methodRequest.Method = http.MethodGet
	handler.ServeHTTP(method, methodRequest)
	if method.Code != http.StatusMethodNotAllowed || method.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("status=%d allow=%q", method.Code, method.Header().Get("Allow"))
	}
}

func TestCRMImportRateLimitSharesTheLegacyQuota(t *testing.T) {
	fixed := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	handler := NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, crmCustomerImportEcho(nil), nil).(*CRMImportSessionHandler)
	handler.limit = newInventoryImportRateLimiter(func() time.Time { return fixed })
	for i := 0; i < inventoryImportRateLimit; i++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, crmImportPostRequest(`{"entity":"products","rows":[]}`))
		if response.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d rate limited early: %s", i+1, response.Body.String())
		}
	}
	limited := httptest.NewRecorder()
	handler.ServeHTTP(limited, crmImportPostRequest(`{"entity":"products","rows":[]}`))
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") == "" || !strings.Contains(limited.Body.String(), `"code":"rate_limited"`) {
		t.Fatalf("status=%d retry-after=%q body=%s", limited.Code, limited.Header().Get("Retry-After"), limited.Body.String())
	}
}

func TestCRMImportExecutorFailuresAndPendingApproval(t *testing.T) {
	pending := crmCustomerImportEcho(&capability.Result{PendingApproval: true, Error: "pending human approval", ApprovalRationale: "policy"})
	response := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, pending, nil).
		ServeHTTP(response, crmImportPostRequest(`{"entity":"customers","rows":[{"name":"Ada"}]}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), `"error":"policy"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	refusal := crmCustomerImportEcho(&capability.Result{OK: false, Error: "invalid input: rows are not allowed"})
	refused := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, refusal, nil).
		ServeHTTP(refused, crmImportPostRequest(`{"entity":"customers","rows":[{"name":"Ada"}]}`))
	if refused.Code != http.StatusUnprocessableEntity || !strings.Contains(refused.Body.String(), `"code":"invalid"`) {
		t.Fatalf("status=%d body=%s", refused.Code, refused.Body.String())
	}

	domain := &fakeDirectCapabilityExecutor{err: errors.New("customer not found in this organization")}
	missing := httptest.NewRecorder()
	NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, domain, nil).
		ServeHTTP(missing, crmImportPostRequest(`{"entity":"customers","rows":[{"name":"Ada"}]}`))
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), `"code":"refused"`) {
		t.Fatalf("status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func TestCRMImportRequiresSameOriginForCookieSessions(t *testing.T) {
	executor := crmCustomerImportEcho(nil)
	handler := NewCRMImportSessionHandler(&fakeDirectSessionResolver{resolved: crmImportTestIdentity()}, executor, nil)

	noOrigin := crmImportPostRequest(`{"entity":"customers","rows":[{"name":"Ada"}]}`)
	noOrigin.Header.Del("Origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, noOrigin)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	crossOrigin := crmImportPostRequest(`{"entity":"customers","rows":[{"name":"Ada"}]}`)
	crossOrigin.Header.Set("Origin", "https://evil.example.test")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, crossOrigin)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
