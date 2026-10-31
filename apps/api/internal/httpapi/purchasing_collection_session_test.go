package httpapi

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgconn"
)

const purchasingTestOrgID = "11111111-1111-4111-8111-111111111111"

func purchasingSessionRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: purchasingTestOrgID})
	return r
}

func purchasingWorkspaceJSON() json.RawMessage {
	return json.RawMessage(`{"baseCurrency":"USD","vendors":[],"orders":[],"bills":[],"apAging":{"buckets":{}},"priceHistory":{"rows":[]},"supplierPerformance":{"vendors":[]},"requests":[]}`)
}

func TestPurchasingCollectionGETExecutesWorkspaceCapability(t *testing.T) {
	identity := directTestIdentity()
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: purchasingWorkspaceJSON()}}
	handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))

	if response.Code != http.StatusOK || executor.capID != "purchasing.listWorkspace" {
		t.Fatalf("status=%d capability=%s body=%s", response.Code, executor.capID, response.Body.String())
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.IntentID != "" || executor.claims.ActorType != "human" {
		t.Fatalf("claims=%+v", executor.claims)
	}
	if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), `"baseCurrency":"USD"`) || !strings.Contains(response.Body.String(), `"vendors":[]`) {
		t.Fatalf("headers=%v body=%s", response.Header(), response.Body.String())
	}
}

func TestPurchasingCollectionPOSTDispatchesGovernedActions(t *testing.T) {
	vendorID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	billID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	paymentID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	cases := []struct {
		name         string
		body         string
		capabilityID string
		input        string
		intentID     string
	}{
		{"receiptDetail", `{"action":"receiptDetail","poNumber":7}`, "purchasing.listReceipts", `{"poNumber":7}`, ""},
		{"priceHistory", `{"action":"priceHistory"}`, "purchasing.priceHistory", `{}`, ""},
		{"priceHistorySku", `{"action":"priceHistory","sku":"SKU-1"}`, "purchasing.priceHistory", `{"sku":"SKU-1"}`, ""},
		{"supplierStatement", `{"action":"supplierStatement","vendorId":"` + vendorID + `"}`, "purchasing.supplierStatement", `{"vendorId":"` + vendorID + `"}`, ""},
		{"closePurchaseOrder", `{"action":"closePurchaseOrder","intentId":"po-close-1","poNumber":3}`, "purchasing.closePurchaseOrder", `{"poNumber":3}`, "po-close-1"},
		{"billCreditNote", `{"action":"billCreditNote","intentId":"credit-1","billId":"` + billID + `","amountMinor":500,"reason":"damaged goods"}`, "purchasing.billCreditNote", `{"billId":"` + billID + `","amountMinor":500,"reason":"damaged goods"}`, "credit-1"},
		{"reverseVendorPayment", `{"action":"reverseVendorPayment","intentId":"reverse-1","vendorPaymentId":"` + paymentID + `","reason":"duplicate payment"}`, "purchasing.reverseVendorPayment", `{"vendorPaymentId":"` + paymentID + `","reason":"duplicate payment"}`, "reverse-1"},
		{"createVendorDropsEmptyEmail", `{"action":"createVendor","intentId":"vendor-1","name":"Acme Supply","email":""}`, "purchasing.createVendor", `{"name":"Acme Supply"}`, "vendor-1"},
		{"createVendorKeepsEmail", `{"action":"createVendor","intentId":"vendor-2","name":"Acme Supply","email":"ap@acme.test"}`, "purchasing.createVendor", `{"name":"Acme Supply","email":"ap@acme.test"}`, "vendor-2"},
		{"createBillDropsOptionalZeros", `{"action":"createBill","intentId":"bill-1","vendorId":"` + vendorID + `","vendorRef":null,"memo":"","poNumber":0,"lines":[{"description":"Widgets","quantity":2,"unitPriceMinor":1000}]}`, "purchasing.createBill", `{"vendorId":"` + vendorID + `","lines":[{"description":"Widgets","quantity":2,"unitPriceMinor":1000}]}`, "bill-1"},
		{"payBillDefaultsMethod", `{"action":"payBill","intentId":"pay-1","billNumber":4,"amountMinor":1000,"method":null}`, "purchasing.payBill", `{"billNumber":4,"amountMinor":1000}`, "pay-1"},
		{"createPurchaseRequestDropsZeroEstimate", `{"action":"createPurchaseRequest","intentId":"request-1","title":"Shelving","justification":"Increase storage space","estimatedAmountMinor":0}`, "purchasing.createPurchaseRequest", `{"title":"Shelving","justification":"Increase storage space"}`, "request-1"},
		{"decidePurchaseRequestDropsEmptyReason", `{"action":"decidePurchaseRequest","intentId":"decide-1","requestId":"` + vendorID + `","decision":"approve","reason":""}`, "purchasing.decidePurchaseRequest", `{"requestId":"` + vendorID + `","decision":"approve"}`, "decide-1"},
		{"createRfq", `{"action":"createRfq","intentId":"rfq-1","requestId":"` + vendorID + `","vendorIds":["` + billID + `"]}`, "purchasing.createRfq", `{"requestId":"` + vendorID + `","vendorIds":["` + billID + `"]}`, "rfq-1"},
		{"recordQuoteDropsZeroLeadTime", `{"action":"recordQuote","intentId":"quote-1","rfqId":"` + billID + `","amountMinor":42000,"leadTimeDays":0,"notes":""}`, "purchasing.recordQuote", `{"rfqId":"` + billID + `","amountMinor":42000}`, "quote-1"},
		{"selectWinningQuote", `{"action":"selectWinningQuote","intentId":"select-1","rfqId":"` + billID + `"}`, "purchasing.selectWinningQuote", `{"rfqId":"` + billID + `"}`, "select-1"},
		{"createPurchaseOrder", `{"action":"createPurchaseOrder","intentId":"po-1","vendorId":"` + vendorID + `","memo":"","lines":[{"description":"Widgets","quantity":2,"unitPriceMinor":1000}]}`, "purchasing.createPurchaseOrder", `{"vendorId":"` + vendorID + `","lines":[{"description":"Widgets","quantity":2,"unitPriceMinor":1000}]}`, "po-1"},
		{"receiveGoodsDropsZeroTolerance", `{"action":"receiveGoods","intentId":"receive-1","poNumber":3,"lines":[{"lineNumber":1,"quantity":2}],"overreceiptTolerancePct":0,"authorityReason":"","note":""}`, "purchasing.receiveGoods", `{"poNumber":3,"lines":[{"lineNumber":1,"quantity":2}]}`, "receive-1"},
		{"returnGoodsDropsZeroReceipt", `{"action":"returnGoods","intentId":"return-1","poNumber":3,"receiptNumber":0,"lines":[{"lineNumber":1,"quantity":1,"reason":"damaged"}]}`, "purchasing.returnGoods", `{"poNumber":3,"lines":[{"lineNumber":1,"quantity":1,"reason":"damaged"}]}`, "return-1"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			identity := directTestIdentity()
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"done":true}`)}}
			handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, purchasingSessionRequest(http.MethodPost, "/api/purchasing", test.body))

			if response.Code != http.StatusOK || executor.capID != test.capabilityID {
				t.Fatalf("status=%d capability=%s body=%s", response.Code, executor.capID, response.Body.String())
			}
			if string(executor.input) != test.input && !sameJSON(t, string(executor.input), test.input) {
				t.Fatalf("input=%s want=%s", executor.input, test.input)
			}
			if executor.claims.IntentID != test.intentID {
				t.Fatalf("intent=%q want=%q", executor.claims.IntentID, test.intentID)
			}
			if !strings.Contains(response.Body.String(), `"ok":true`) {
				t.Fatalf("body=%s", response.Body.String())
			}
		})
	}
}

func TestPurchasingCollectionPOSTRejectsMalformedBodies(t *testing.T) {
	bodies := []string{
		``,
		`null`,
		`[]`,
		`{"nope":1}`,
		`{"action":1}`,
		`{"action":"unknownAction"}`,
		`{"action":"closePurchaseOrder","intentId":"intent","poNumber":1,"extra":true}`,
		`{"action":"closePurchaseOrder","poNumber":1}`,
		`{"action":"closePurchaseOrder","intentId":null,"poNumber":1}`,
		`{"action":"closePurchaseOrder","intentId":"intent","poNumber":1}{"action":"closePurchaseOrder"}`,
		`{"action":"createVendor","intentId":"intent"}`,
		`{"action":"createBill","intentId":"intent","vendorId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","lines":[]}`,
		`{"action":"receiptDetail","intentId":42,"poNumber":1}`,
	}
	for _, body := range bodies {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"done":true}`)}}
		handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, purchasingSessionRequest(http.MethodPost, "/api/purchasing", body))

		if response.Code != http.StatusBadRequest {
			t.Fatalf("body=%q status=%d response=%s", body, response.Code, response.Body.String())
		}
		if executor.calls != 0 {
			t.Fatalf("body=%q executed %d capabilities", body, executor.calls)
		}
	}
}

func TestPurchasingCollectionPOSTOverlongIntentIsRejected(t *testing.T) {
	body := `{"action":"closePurchaseOrder","intentId":"` + strings.Repeat("a", 161) + `","poNumber":1}`
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
	handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodPost, "/api/purchasing", body))
	if response.Code != http.StatusBadRequest || executor.calls != 0 {
		t.Fatalf("status=%d calls=%d", response.Code, executor.calls)
	}
}

func TestPurchasingCollectionPOSTPendingApprovalAndRefusals(t *testing.T) {
	pending := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, PendingApproval: true, ApprovalID: "approval-1", ApprovalRationale: "amount 100000 exceeds autonomous threshold 0", Error: "pending human approval"}}
	handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, pending, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodPost, "/api/purchasing", `{"action":"payBill","intentId":"pay-1","billNumber":1,"amountMinor":100000}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), "exceeds autonomous threshold") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	forbidden := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: purchasing.write"}}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, forbidden, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodPost, "/api/purchasing", `{"action":"closePurchaseOrder","intentId":"po-close-1","poNumber":1}`))
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	disabled := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: `module "purchasing" is disabled for this organization`}}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, disabled, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodPost, "/api/purchasing", `{"action":"closePurchaseOrder","intentId":"po-close-1","poNumber":1}`))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	refused := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "purchase order not found"}}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, refused, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodPost, "/api/purchasing", `{"action":"closePurchaseOrder","intentId":"po-close-1","poNumber":1}`))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "purchase order not found") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPurchasingCollectionSessionDenials(t *testing.T) {
	handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{}, &fakeDirectCapabilityExecutor{}, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status=%d", response.Code)
	}

	resolverError := &fakeDirectSessionResolver{err: errors.New("session store down")}
	handler = NewPurchasingCollectionSessionHandler(resolverError, &fakeDirectCapabilityExecutor{}, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("resolver error status=%d", response.Code)
	}

	unverified := directTestIdentity()
	unverified.EmailVerified = false
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: unverified}, &fakeDirectCapabilityExecutor{}, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unverified status=%d", response.Code)
	}

	executor := &fakeDirectCapabilityExecutor{}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
	for name, request := range map[string]*http.Request{
		"cross organization":   purchasingSessionRequestWithOrg(http.MethodGet, "/api/purchasing", "", "99999999-9999-4999-8999-999999999999"),
		"cross origin write":   purchasingSessionRequestWithOrigin(http.MethodPost, "/api/purchasing", `{"action":"closePurchaseOrder","intentId":"intent","poNumber":1}`, "https://evil.example.test"),
		"missing origin write": purchasingSessionRequestWithoutOrigin(http.MethodPost, "/api/purchasing", `{"action":"closePurchaseOrder","intentId":"intent","poNumber":1}`),
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s status=%d body=%s", name, response.Code, response.Body.String())
		}
		if executor.calls != 0 {
			t.Fatalf("%s executed %d capabilities", name, executor.calls)
		}
	}
}

func TestPurchasingCollectionMapsExecutorErrors(t *testing.T) {
	invalidSession := &fakeDirectCapabilityExecutor{err: capability.ErrSessionInvalid}
	handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, invalidSession, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid session status=%d", response.Code)
	}

	notMember := &fakeDirectCapabilityExecutor{err: capability.ErrNotMember}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, notMember, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusForbidden {
		t.Fatalf("not member status=%d", response.Code)
	}

	failing := &fakeDirectCapabilityExecutor{err: &pgconn.PgError{Code: "08006", Message: "connection failure"}}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, failing, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failing status=%d", response.Code)
	}

	missing := &fakeDirectCapabilityExecutor{err: errors.New("bill not found")}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, missing, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), `"ok":false`) {
		t.Fatalf("missing status=%d body=%s", response.Code, response.Body.String())
	}

	refused := &fakeDirectCapabilityExecutor{err: errors.New("order is void")}
	handler = NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, refused, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), `"ok":false`) {
		t.Fatalf("refused status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPurchasingCollectionRejectsWrongMethodAndInvalidSelector(t *testing.T) {
	handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodDelete, "/api/purchasing", ""))
	if response.Code != http.StatusMethodNotAllowed || !strings.Contains(response.Header().Get("Allow"), http.MethodGet) {
		t.Fatalf("status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}

	unavailable := NewPurchasingCollectionSessionHandler(nil, nil, nil)
	response = httptest.NewRecorder()
	unavailable.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status=%d", response.Code)
	}

	badSelector := purchasingSessionRequest(http.MethodGet, "/api/purchasing", "")
	badSelector.Header.Set("X-Organization-ID", "not-a-uuid")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, badSelector)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("bad selector status=%d", response.Code)
	}
}

func TestPurchasingCollectionGETRejectsInvalidOutput(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"baseCurrency":"USD","vendors":null,"orders":[],"bills":[],"requests":[]}`)}}
	handler := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func purchasingSessionRequestWithOrg(method, path, body, orgID string) *http.Request {
	r := purchasingSessionRequest(method, path, body)
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
	r.Header.Set("X-Organization-ID", orgID)
	return r
}

func purchasingSessionRequestWithOrigin(method, path, body, origin string) *http.Request {
	r := purchasingSessionRequest(method, path, body)
	r.Header.Set("Origin", origin)
	return r
}

func purchasingSessionRequestWithoutOrigin(method, path, body string) *http.Request {
	r := purchasingSessionRequest(method, path, body)
	r.Header.Del("Origin")
	return r
}

func TestMountGoPurchasingCollectionRouteKeepsBaseFallthrough(t *testing.T) {
	route := NewPurchasingCollectionSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: purchasingWorkspaceJSON()}}, nil)
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux := MountGoPurchasingCollectionRoute(base, route)

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/purchasing", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("mounted GET status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, purchasingSessionRequest(http.MethodDelete, "/api/purchasing", ""))
	if response.Code != http.StatusNoContent {
		t.Fatalf("base fallthrough status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, purchasingSessionRequest(http.MethodGet, "/api/other", ""))
	if response.Code != http.StatusNoContent {
		t.Fatalf("unrelated path status=%d", response.Code)
	}
}
