package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	financeSalesTestCustomerID = "44444444-4444-4444-8444-444444444444"
	financeSalesTestQuoteID    = "55555555-5555-4555-8555-555555555555"
	financeSalesTestInvoiceID  = "66666666-6666-4666-8666-666666666666"
	financeSalesTestOrderID    = "77777777-7777-4777-8777-777777777777"
	financeSalesTestItemID     = "88888888-8888-4888-8888-888888888888"
	financeSalesTestCountID    = "99999999-9999-4999-8999-999999999999"
	financeSalesTestIntentID   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
)

type financeSalesScriptedExecutor struct {
	calls   []string
	inputs  map[string]json.RawMessage
	results map[string]capability.Result
}

func (f *financeSalesScriptedExecutor) Execute(_ context.Context, _ authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	f.calls = append(f.calls, capabilityID)
	if f.inputs == nil {
		f.inputs = map[string]json.RawMessage{}
	}
	f.inputs[capabilityID] = input
	return f.results[capabilityID], nil
}

func financeSalesTestIdentity(permissions ...string) *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = make(map[string]bool, len(permissions))
	for _, permission := range permissions {
		identity.Permissions[permission] = true
	}
	return identity
}

func financeSalesTestRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://app.example.test")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *directTestIdentity().OrgID})
	return request
}

func financeSalesTestDecode(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	return body
}

func financeSalesTestData(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	body := financeSalesTestDecode(t, response)
	data, _ := body["data"].(map[string]any)
	return data
}

func TestQuoteCollectionGetListsWithLegacyStatusFilter(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.read")}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"quotes":[]}`)}}
	response := httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/quotes?status=accepted", ""))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"quotes":[]}` {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.calls != 1 || executor.capID != "accounting.listQuotes" || string(executor.input) != `{"status":"accepted"}` {
		t.Fatalf("calls=%d capability=%q input=%s", executor.calls, executor.capID, executor.input)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q", response.Header().Get("Cache-Control"))
	}

	unknown := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"quotes":[]}`)}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, unknown, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/quotes?status=bogus", ""))
	if string(unknown.input) != `{}` {
		t.Fatalf("unsupported status input=%s, want empty input", unknown.input)
	}
}

func TestQuoteCollectionGetEnforcesAuthorization(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"quotes":[]}`)}}
	unauthorized := httptest.NewRecorder()
	NewQuotesSessionHandler(&fakeDirectSessionResolver{resolved: financeSalesTestIdentity()}, executor, nil).
		ServeHTTP(unauthorized, financeSalesTestRequest(http.MethodGet, "/api/quotes", ""))
	if unauthorized.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("missing permission status=%d calls=%d", unauthorized.Code, executor.calls)
	}

	restricted := financeSalesTestIdentity("accounting.read")
	restricted.ModulesRestricted = true
	restricted.EnabledModules = []string{"crm"}
	disabled := httptest.NewRecorder()
	NewQuotesSessionHandler(&fakeDirectSessionResolver{resolved: restricted}, executor, nil).
		ServeHTTP(disabled, financeSalesTestRequest(http.MethodGet, "/api/quotes", ""))
	if disabled.Code != http.StatusForbidden || !strings.Contains(disabled.Body.String(), "accounting module is disabled") {
		t.Fatalf("disabled module status=%d body=%s", disabled.Code, disabled.Body.String())
	}

	unverified := financeSalesTestIdentity("accounting.read")
	unverified.EmailVerified = false
	denied := httptest.NewRecorder()
	NewQuotesSessionHandler(&fakeDirectSessionResolver{resolved: unverified}, executor, nil).
		ServeHTTP(denied, financeSalesTestRequest(http.MethodGet, "/api/quotes", ""))
	if denied.Code != http.StatusUnauthorized || executor.calls != 0 {
		t.Fatalf("unverified status=%d calls=%d", denied.Code, executor.calls)
	}
}

func TestQuoteCollectionPostDispatchesLegacyActions(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.write")}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"quoteId":"` + financeSalesTestQuoteID + `","quoteNumber":4,"totalMinor":2000}`)}}
	response := httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
		`{"action":"create","intentId":"`+financeSalesTestIntentID+`","customerId":"`+financeSalesTestCustomerID+`","memo":"Pilot","expiresAt":"2026-11-01T00:00:00.000Z","lines":[{"description":"Consulting","quantity":2,"unitPriceMinor":1000}]}`))
	if response.Code != http.StatusOK || executor.capID != "accounting.createQuote" {
		t.Fatalf("create status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
	}
	var createInput map[string]any
	if err := json.Unmarshal(executor.input, &createInput); err != nil {
		t.Fatal(err)
	}
	lines, _ := createInput["lines"].([]any)
	if createInput["customerId"] != financeSalesTestCustomerID || createInput["memo"] != "Pilot" || len(lines) != 1 {
		t.Fatalf("create input=%s", executor.input)
	}
	data := financeSalesTestData(t, response)
	if data["quoteId"] != financeSalesTestQuoteID || data["quoteNumber"].(float64) != 4 {
		t.Fatalf("create data=%v", data)
	}
	if executor.claims.IntentID != financeSalesTestIntentID || executor.claims.CapabilityID != "accounting.createQuote" {
		t.Fatalf("claims=%+v", executor.claims)
	}

	accept := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"invoiceId":"` + financeSalesTestInvoiceID + `","invoiceNumber":9,"totalMinor":2000}`)}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, accept, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
		`{"action":"accept","quoteId":"`+financeSalesTestQuoteID+`"}`))
	if response.Code != http.StatusOK || accept.capID != "accounting.acceptQuote" || string(accept.input) != `{"quoteId":"`+financeSalesTestQuoteID+`"}` {
		t.Fatalf("accept status=%d capability=%q input=%s", response.Code, accept.capID, accept.input)
	}

	decline := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"status":"declined"}`)}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, decline, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
		`{"action":"decline","quoteId":"`+financeSalesTestQuoteID+`"}`))
	if response.Code != http.StatusOK || decline.capID != "accounting.declineQuote" {
		t.Fatalf("decline status=%d capability=%q", response.Code, decline.capID)
	}

	expire := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"expiredCount":2}`)}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, expire, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes", `{"action":"expire"}`))
	if response.Code != http.StatusOK || expire.capID != "accounting.expireQuote" || string(expire.input) != `{}` {
		t.Fatalf("expire status=%d capability=%q input=%s", response.Code, expire.capID, expire.input)
	}
	if expire.claims.IntentID == "" {
		t.Fatal("expire without intentId must still resolve a governed intent")
	}

	nullIntent := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"status":"declined"}`)}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, nullIntent, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
		`{"action":"decline","intentId":null,"quoteId":"`+financeSalesTestQuoteID+`"}`))
	if response.Code != http.StatusOK || nullIntent.claims.IntentID == "" {
		t.Fatalf("null intentId status=%d intent=%q body=%s", response.Code, nullIntent.claims.IntentID, response.Body.String())
	}
}

func TestQuoteCollectionPostRejectsMalformedBodies(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.write")}
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "unknown action", body: `{"action":"send"}`},
		{name: "unknown field", body: `{"action":"expire","admin":true}`},
		{name: "missing customer", body: `{"action":"create","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`},
		{name: "empty lines", body: `{"action":"create","customerId":"` + financeSalesTestCustomerID + `","lines":[]}`},
		{name: "date only expiry", body: `{"action":"create","customerId":"` + financeSalesTestCustomerID + `","expiresAt":"2026-11-01","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`},
		{name: "non-uuid quote", body: `{"action":"accept","quoteId":"nope"}`},
		{name: "trailing json", body: `{"action":"expire"}{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
			response := httptest.NewRecorder()
			NewQuotesSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes", test.body))
			if response.Code != http.StatusBadRequest || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestQuoteCollectionPostMapsRefusals(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.write")}
	pending := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalRationale: "needs review"}}
	response := httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, pending, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
		`{"action":"expire"}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) {
		t.Fatalf("pending status=%d body=%s", response.Code, response.Body.String())
	}

	forbidden := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: accounting.write"}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, forbidden, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes", `{"action":"expire"}`))
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d body=%s", response.Code, response.Body.String())
	}

	refused := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "quote is sent; only draft quotes..."}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, refused, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes", `{"action":"expire"}`))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), `"ok":false`) {
		t.Fatalf("refused status=%d body=%s", response.Code, response.Body.String())
	}

	invalid := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"quoteId":"nope","quoteNumber":0,"totalMinor":-1}`)}}
	response = httptest.NewRecorder()
	NewQuotesSessionHandler(resolver, invalid, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
		`{"action":"create","customerId":"`+financeSalesTestCustomerID+`","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("invalid output status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRecurringCollectionGetListsTemplates(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.read")}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"templates":[]}`)}}
	response := httptest.NewRecorder()
	NewRecurringSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/recurring", ""))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"templates":[]}` {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.capID != "accounting.listRecurringTemplates" || string(executor.input) != `{}` {
		t.Fatalf("capability=%q input=%s", executor.capID, executor.input)
	}
}

func TestRecurringCollectionPostDispatchesLegacyActions(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.write")}
	create := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"templateId":"` + financeSalesTestQuoteID + `","nextRunAt":"2026-11-01T00:00:00.000Z"}`)}}
	response := httptest.NewRecorder()
	NewRecurringSessionHandler(resolver, create, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/recurring",
		`{"action":"create","customerId":"`+financeSalesTestCustomerID+`","frequency":"monthly","memo":"Retainer","lines":[{"description":"Retainer","quantity":1,"unitPriceMinor":50000}]}`))
	if response.Code != http.StatusOK || create.capID != "accounting.createRecurringTemplate" {
		t.Fatalf("create status=%d capability=%q body=%s", response.Code, create.capID, response.Body.String())
	}

	pause := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"active":false}`)}}
	response = httptest.NewRecorder()
	NewRecurringSessionHandler(resolver, pause, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/recurring",
		`{"action":"pause","templateId":"`+financeSalesTestQuoteID+`"}`))
	if response.Code != http.StatusOK || pause.capID != "accounting.pauseRecurringTemplate" {
		t.Fatalf("pause status=%d capability=%q", response.Code, pause.capID)
	}

	resume := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"active":true}`)}}
	response = httptest.NewRecorder()
	NewRecurringSessionHandler(resolver, resume, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/recurring",
		`{"action":"resume","templateId":"`+financeSalesTestQuoteID+`"}`))
	if response.Code != http.StatusOK || resume.capID != "accounting.resumeRecurringTemplate" {
		t.Fatalf("resume status=%d capability=%q", response.Code, resume.capID)
	}

	mismatched := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"active":true}`)}}
	response = httptest.NewRecorder()
	NewRecurringSessionHandler(resolver, mismatched, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/recurring",
		`{"action":"pause","templateId":"`+financeSalesTestQuoteID+`"}`))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("pause with active output status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestReportsRouteAggregatesCapabilities(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.read")}
	executor := &financeSalesScriptedExecutor{results: map[string]capability.Result{
		"accounting.reportCurrencyMetadata": {OK: true, Data: json.RawMessage(`{"baseCurrency":"USD","unsupportedCurrencies":[]}`)},
		"accounting.incomeStatement":        {OK: true, Data: json.RawMessage(`{"revenueMinor":100,"expenseMinor":40,"netIncomeMinor":60,"lines":[]}`)},
		"accounting.balanceSheet":           {OK: true, Data: json.RawMessage(`{"assetsMinor":1,"liabilitiesMinor":0,"equityMinor":1,"retainedResultMinor":0,"balanced":true}`)},
		"accounting.cashFlow":               {OK: true, Data: json.RawMessage(`{"openingMinor":0,"closingMinor":0,"netMinor":0,"cashBalanceMinor":0,"ties":true,"unsupportedCurrencies":[],"operating":{"inflowMinor":0,"outflowMinor":0,"netMinor":0,"entries":0},"investing":{"inflowMinor":0,"outflowMinor":0,"netMinor":0,"entries":0},"financing":{"inflowMinor":0,"outflowMinor":0,"netMinor":0,"entries":0}}`)},
		"accounting.unrealizedFxExposure":   {OK: true, Data: json.RawMessage(`{"exposures":[]}`)},
	}}
	response := httptest.NewRecorder()
	NewReportsSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/reports", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := financeSalesTestDecode(t, response)
	if body["baseCurrency"] != "USD" || body["cashFlow"] == nil || body["fxExposure"] == nil {
		t.Fatalf("body=%v", body)
	}
	pnl, _ := body["pnl"].(map[string]any)
	if pnl["netIncomeMinor"].(float64) != 60 {
		t.Fatalf("pnl=%v", pnl)
	}
	wantOrder := []string{"accounting.reportCurrencyMetadata", "accounting.incomeStatement", "accounting.balanceSheet", "accounting.cashFlow", "accounting.unrealizedFxExposure"}
	if strings.Join(executor.calls, ",") != strings.Join(wantOrder, ",") {
		t.Fatalf("capability order=%v", executor.calls)
	}
}

func TestReportsRouteDegradesOptionalReportsAndFailsRequiredOnes(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.read")}
	degraded := &financeSalesScriptedExecutor{results: map[string]capability.Result{
		"accounting.reportCurrencyMetadata": {OK: true, Data: json.RawMessage(`{"baseCurrency":"EUR","unsupportedCurrencies":["GBP"]}`)},
		"accounting.incomeStatement":        {OK: true, Data: json.RawMessage(`{"revenueMinor":0,"expenseMinor":0,"netIncomeMinor":0,"lines":[]}`)},
		"accounting.balanceSheet":           {OK: true, Data: json.RawMessage(`{"assetsMinor":0,"liabilitiesMinor":0,"equityMinor":0,"retainedResultMinor":0,"balanced":true}`)},
		"accounting.cashFlow":               {OK: false, Error: "cash flow unavailable"},
		"accounting.unrealizedFxExposure":   {OK: true, Data: json.RawMessage(`{"exposures":"bogus"}`)},
	}}
	response := httptest.NewRecorder()
	NewReportsSessionHandler(resolver, degraded, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/reports", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := financeSalesTestDecode(t, response)
	if body["cashFlow"] != nil || body["fxExposure"] != nil || body["baseCurrency"] != "EUR" {
		t.Fatalf("body=%v", body)
	}

	brokenMetadata := &financeSalesScriptedExecutor{results: map[string]capability.Result{
		"accounting.reportCurrencyMetadata": {OK: true, Data: json.RawMessage(`{"baseCurrency":"usd","unsupportedCurrencies":[]}`)},
	}}
	response = httptest.NewRecorder()
	NewReportsSessionHandler(resolver, brokenMetadata, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/reports", ""))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("invalid metadata status=%d body=%s", response.Code, response.Body.String())
	}

	brokenPnl := &financeSalesScriptedExecutor{results: map[string]capability.Result{
		"accounting.reportCurrencyMetadata": {OK: true, Data: json.RawMessage(`{"baseCurrency":"USD","unsupportedCurrencies":[]}`)},
		"accounting.incomeStatement":        {OK: false, Error: "income statement unavailable"},
	}}
	response = httptest.NewRecorder()
	NewReportsSessionHandler(resolver, brokenPnl, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/reports", ""))
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), "income statement unavailable") {
		t.Fatalf("failed pnl status=%d body=%s", response.Code, response.Body.String())
	}

	denied := httptest.NewRecorder()
	NewReportsSessionHandler(&fakeDirectSessionResolver{resolved: financeSalesTestIdentity("crm.read")}, brokenMetadata, nil).
		ServeHTTP(denied, financeSalesTestRequest(http.MethodGet, "/api/reports", ""))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("denied status=%d body=%s", denied.Code, denied.Body.String())
	}
}

func TestSalesCollectionPostDispatchesLegacyActions(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("sales.write")}
	create := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"orderId":"` + financeSalesTestOrderID + `","orderNumber":3}`)}}
	response := httptest.NewRecorder()
	NewSalesOrdersWriteSessionHandler(resolver, create, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/sales",
		`{"action":"create","customerId":"`+financeSalesTestCustomerID+`","note":"Rush","lines":[{"description":"Consulting","quantity":2,"unitPriceMinor":1000}]}`))
	if response.Code != http.StatusOK || create.capID != "sales.createOrder" {
		t.Fatalf("create status=%d capability=%q body=%s", response.Code, create.capID, response.Body.String())
	}
	if data := financeSalesTestData(t, response); data["orderId"] != financeSalesTestOrderID {
		t.Fatalf("create data=%v", data)
	}

	confirm := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"confirmed":true,"backordered":true,"reservedThousandths":500}`)}}
	response = httptest.NewRecorder()
	NewSalesOrdersWriteSessionHandler(resolver, confirm, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/sales",
		`{"action":"confirm","orderId":"`+financeSalesTestOrderID+`","allowBackorder":true}`))
	if response.Code != http.StatusOK || confirm.capID != "sales.confirmOrder" || string(confirm.input) != `{"allowBackorder":true,"orderId":"`+financeSalesTestOrderID+`"}` {
		t.Fatalf("confirm status=%d capability=%q input=%s", response.Code, confirm.capID, confirm.input)
	}

	deliver := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"invoiceId":"` + financeSalesTestInvoiceID + `","invoiceNumber":5,"invoiceTotalMinor":2000,"orderStatus":"delivered"}`)}}
	response = httptest.NewRecorder()
	NewSalesOrdersWriteSessionHandler(resolver, deliver, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/sales",
		`{"action":"deliver","orderId":"`+financeSalesTestOrderID+`"}`))
	if response.Code != http.StatusOK || deliver.capID != "sales.deliverOrder" {
		t.Fatalf("deliver status=%d capability=%q body=%s", response.Code, deliver.capID, response.Body.String())
	}

	cancel := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"status":"cancelled","releasedThousandths":500}`)}}
	response = httptest.NewRecorder()
	NewSalesOrdersWriteSessionHandler(resolver, cancel, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/sales",
		`{"action":"cancel","orderId":"`+financeSalesTestOrderID+`"}`))
	if response.Code != http.StatusOK || cancel.capID != "sales.cancelOrder" {
		t.Fatalf("cancel status=%d capability=%q", response.Code, cancel.capID)
	}
}

func TestSalesCollectionPostRequiresSameOriginCookieRequests(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("sales.write")}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"orderId":"` + financeSalesTestOrderID + `","orderNumber":3}`)}}
	request := financeSalesTestRequest(http.MethodPost, "/api/sales",
		`{"action":"create","customerId":"`+financeSalesTestCustomerID+`","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`)
	request.Header.Del("Origin")
	request.TLS = nil
	response := httptest.NewRecorder()
	NewSalesOrdersWriteSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("cross-origin cookie POST status=%d calls=%d", response.Code, executor.calls)
	}

	request = financeSalesTestRequest(http.MethodPost, "/api/sales",
		`{"action":"create","customerId":"`+financeSalesTestCustomerID+`","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`)
	request.Header.Set("Authorization", "Bearer native-token")
	response = httptest.NewRecorder()
	NewSalesOrdersWriteSessionHandler(resolver, executor, nil).ServeHTTP(response, request)
	if response.Code != http.StatusOK || resolver.bearerCalls != 1 {
		t.Fatalf("bearer POST status=%d bearerCalls=%d", response.Code, resolver.bearerCalls)
	}
}

func TestInventoryCollectionPostDispatchesLegacyActions(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("inventory.write", "inventory.read")}

	create := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"itemId":"` + financeSalesTestItemID + `"}`)}}
	response := httptest.NewRecorder()
	NewInventoryWriteSessionHandler(resolver, create, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"createItem","sku":"SKU-1","name":"Widget"}`))
	if response.Code != http.StatusOK || create.capID != "inventory.createItem" {
		t.Fatalf("createItem status=%d capability=%q body=%s", response.Code, create.capID, response.Body.String())
	}
	var createInput map[string]any
	if err := json.Unmarshal(create.input, &createInput); err != nil {
		t.Fatal(err)
	}
	if createInput["kind"] != "goods" || createInput["unitLabel"] != "unit" || createInput["salePriceMinor"].(float64) != 0 ||
		createInput["reorderPointThousandths"].(float64) != 0 || len(createInput["tags"].([]any)) != 0 {
		t.Fatalf("createItem defaults input=%s", create.input)
	}

	update := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"sku":"SKU-1","prior":{"sku":"SKU-1","barcode":null}}`)}}
	response = httptest.NewRecorder()
	NewInventoryWriteSessionHandler(resolver, update, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"updateItem","sku":"SKU-1","name":"Widget 2","barcode":null}`))
	if response.Code != http.StatusOK || update.capID != "inventory.updateItem" {
		t.Fatalf("updateItem status=%d capability=%q body=%s", response.Code, update.capID, response.Body.String())
	}
	var patch map[string]any
	if err := json.Unmarshal(update.input, &patch); err != nil {
		t.Fatal(err)
	}
	if value, exists := patch["barcode"]; !exists || value != nil {
		t.Fatalf("updateItem must keep explicit null barcode, input=%s", update.input)
	}
	if _, exists := patch["unitLabel"]; exists {
		t.Fatalf("updateItem must drop absent fields, input=%s", update.input)
	}

	archive := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"sku":"SKU-1","archived":true}`)}}
	response = httptest.NewRecorder()
	NewInventoryWriteSessionHandler(resolver, archive, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"archiveItem","sku":"SKU-1"}`))
	if response.Code != http.StatusOK || string(archive.input) != `{"archive":true,"sku":"SKU-1"}` {
		t.Fatalf("archiveItem status=%d input=%s", response.Code, archive.input)
	}

	history := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"movements":[]}`)}}
	response = httptest.NewRecorder()
	NewInventoryWriteSessionHandler(resolver, history, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"stockHistory","sku":"SKU-1"}`))
	if response.Code != http.StatusOK || history.capID != "inventory.itemHistory" || string(history.input) != `{"limit":50,"sku":"SKU-1"}` {
		t.Fatalf("stockHistory status=%d capability=%q input=%s", response.Code, history.capID, history.input)
	}

	record := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"recorded":1}`)}}
	response = httptest.NewRecorder()
	NewInventoryWriteSessionHandler(resolver, record, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"recordCycleCounts","countId":"`+financeSalesTestCountID+`","entries":[{"sku":"SKU-1","countedThousandths":5}]}`))
	if response.Code != http.StatusOK || record.capID != "inventory.recordCycleCounts" {
		t.Fatalf("recordCycleCounts status=%d capability=%q body=%s", response.Code, record.capID, response.Body.String())
	}
	var recordInput map[string]any
	if err := json.Unmarshal(record.input, &recordInput); err != nil {
		t.Fatal(err)
	}
	counts, _ := recordInput["counts"].([]any)
	if len(counts) != 1 {
		t.Fatalf("recordCycleCounts must map entries onto counts, input=%s", record.input)
	}
	if _, exists := recordInput["entries"]; exists {
		t.Fatalf("recordCycleCounts must not forward entries, input=%s", record.input)
	}
}

func TestInventoryCollectionPostGuardsActionsAndPermissions(t *testing.T) {
	readOnly := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("inventory.read")}
	lookup := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"item":null}`)}}
	response := httptest.NewRecorder()
	NewInventoryWriteSessionHandler(readOnly, lookup, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"lookupByBarcode","barcode":"123456"}`))
	if response.Code != http.StatusOK || lookup.capID != "inventory.lookupByBarcode" {
		t.Fatalf("read-only lookup status=%d capability=%q body=%s", response.Code, lookup.capID, response.Body.String())
	}

	writeOnly := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("inventory.write")}
	denied := httptest.NewRecorder()
	NewInventoryWriteSessionHandler(writeOnly, lookup, nil).ServeHTTP(denied, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"lookupByBarcode","barcode":"123456"}`))
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "missing inventory.read") {
		t.Fatalf("write-only lookup status=%d body=%s", denied.Code, denied.Body.String())
	}

	adjust := httptest.NewRecorder()
	NewInventoryWriteSessionHandler(readOnly, lookup, nil).ServeHTTP(adjust, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"adjustStock","sku":"SKU-1","quantityDelta":5,"note":"count fix"}`))
	if adjust.Code != http.StatusForbidden || !strings.Contains(adjust.Body.String(), "missing inventory.write") {
		t.Fatalf("read-only adjust status=%d body=%s", adjust.Code, adjust.Body.String())
	}

	unknown := httptest.NewRecorder()
	NewInventoryWriteSessionHandler(writeOnly, lookup, nil).ServeHTTP(unknown, financeSalesTestRequest(http.MethodPost, "/api/inventory",
		`{"action":"meltInventory"}`))
	if unknown.Code != http.StatusBadRequest || !strings.Contains(unknown.Body.String(), "invalid action") {
		t.Fatalf("unknown action status=%d body=%s", unknown.Code, unknown.Body.String())
	}

	restricted := financeSalesTestIdentity("inventory.write")
	restricted.ModulesRestricted = true
	restricted.EnabledModules = []string{"crm"}
	disabled := httptest.NewRecorder()
	NewInventoryWriteSessionHandler(&fakeDirectSessionResolver{resolved: restricted}, lookup, nil).
		ServeHTTP(disabled, financeSalesTestRequest(http.MethodPost, "/api/inventory", `{"action":"createLocation","code":"MAIN","name":"Main"}`))
	if disabled.Code != http.StatusForbidden || !strings.Contains(disabled.Body.String(), "inventory module is disabled") {
		t.Fatalf("disabled module status=%d body=%s", disabled.Code, disabled.Body.String())
	}
}

func TestFinanceSalesMountsKeepUnmigratedMethodsWithBase(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	quotes := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"quotes":[]}`)}}
	mounted := MountGoQuotesRoute(base, NewQuotesSessionHandler(&fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.read")}, quotes, nil))
	response := httptest.NewRecorder()
	mounted.ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/quotes", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("quotes GET status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	mounted.ServeHTTP(response, financeSalesTestRequest(http.MethodDelete, "/api/quotes", ""))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("quotes DELETE status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	mounted.ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/other", ""))
	if response.Code != http.StatusTeapot {
		t.Fatalf("base passthrough status=%d", response.Code)
	}

	salesWrite := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(
		`{"orderId":"` + financeSalesTestOrderID + `","orderNumber":3}`)}}
	salesMounted := MountGoSalesWriteRoute(base, NewSalesOrdersWriteSessionHandler(
		&fakeDirectSessionResolver{resolved: financeSalesTestIdentity("sales.write")}, salesWrite, nil))
	response = httptest.NewRecorder()
	salesMounted.ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/sales", ""))
	if response.Code != http.StatusTeapot {
		t.Fatalf("sales GET must fall through to base, status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	salesMounted.ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/sales",
		`{"action":"create","customerId":"`+financeSalesTestCustomerID+`","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}]}`))
	if response.Code != http.StatusOK {
		t.Fatalf("sales POST status=%d body=%s", response.Code, response.Body.String())
	}

	if MountGoReportsRoute(base, nil) == nil {
		t.Fatalf("nil route mount must return the base handler")
	}
	response = httptest.NewRecorder()
	MountGoReportsRoute(base, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/reports", ""))
	if response.Code != http.StatusTeapot {
		t.Fatalf("reports mount with nil route status=%d", response.Code)
	}
	if MountGoRecurringRoute(nil, nil) != nil {
		t.Fatalf("nil base with nil route must stay nil")
	}
}

func TestFinanceCollectionsClassifyExecutorErrors(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: financeSalesTestIdentity("accounting.read", "accounting.write", "sales.write")}

	t.Run("missing domain object is 404", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{err: errors.New("quote not found")}
		response := httptest.NewRecorder()
		NewQuotesSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodGet, "/api/quotes", ""))
		if response.Code != http.StatusNotFound || strings.TrimSpace(response.Body.String()) != `{"error":"quote not found"}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("domain refusal keeps the legacy 422", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{err: errors.New("quote is already accepted")}
		response := httptest.NewRecorder()
		NewQuotesSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
			`{"action":"accept","quoteId":"`+financeSalesTestQuoteID+`"}`))
		if response.Code != http.StatusUnprocessableEntity || strings.TrimSpace(response.Body.String()) != `{"error":"quote is already accepted"}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("forbidden execution is 403", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{err: errors.New("forbidden: missing permission: accounting.write")}
		response := httptest.NewRecorder()
		NewQuotesSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/quotes",
			`{"action":"accept","quoteId":"`+financeSalesTestQuoteID+`"}`))
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("infrastructure failure stays 500", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{err: &pgconn.PgError{Code: "08006", Message: "connection failure"}}
		response := httptest.NewRecorder()
		NewSalesOrdersWriteSessionHandler(resolver, executor, nil).ServeHTTP(response, financeSalesTestRequest(http.MethodPost, "/api/sales",
			`{"action":"confirm","orderId":"`+financeSalesTestOrderID+`"}`))
		if response.Code != http.StatusInternalServerError || strings.TrimSpace(response.Body.String()) != `{"error":"internal error"}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}
