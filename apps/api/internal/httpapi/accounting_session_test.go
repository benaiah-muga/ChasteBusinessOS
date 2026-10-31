package httpapi

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func accountingRootRequest(method, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/accounting", strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Origin", "https://app.example.test")
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func accountingRootIdentity(permission ...string) *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = make(map[string]bool, len(permission))
	for _, value := range permission {
		identity.Permissions[value] = true
	}
	return identity
}

func TestAccountingSessionHandlerOverviewUsesResolvedOrgAndCapability(t *testing.T) {
	identity := accountingRootIdentity("accounting.read")
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"entries":[],"aging":{"current":0,"d30":0,"d60":0,"d90plus":0,"totalOutstanding":0},"agingInvoices":[],"baseCurrency":"USD","foreignReceivablesCount":0,"foreignPayablesCount":0,"closedPeriods":[],"bills":[],"filings":[],"customers":[],"invoices":[],"payments":[]}`)}}
	response := httptest.NewRecorder()
	NewAccountingSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, accountingRootRequest(http.MethodGet, ""))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "accounting.overview" {
		t.Fatalf("status=%d calls=%d capability=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.IntentID == "" {
		t.Fatalf("claims did not derive from the resolved session: %+v", executor.claims)
	}
	var body capability.AccountingOverviewOutput
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.BaseCurrency != "USD" || body.Entries == nil {
		t.Fatalf("overview=%+v err=%v", body, err)
	}
}

func TestAccountingSessionHandlerInvoiceWriteUsesGovernedCapability(t *testing.T) {
	identity := accountingRootIdentity("accounting.write")
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"invoiceId":"44444444-4444-4444-8444-444444444444","invoiceNumber":12,"totalMinor":2400,"entryId":"55555555-5555-4555-8555-555555555555","currency":"USD"}`)}}
	body := `{"action":"createInvoice","customerId":"22222222-2222-4222-8222-222222222222","lines":[{"description":"Consulting","quantity":2,"unitPriceMinor":1200}],"currency":"USD","intentId":"create-invoice-attempt-12"}`
	response := httptest.NewRecorder()
	NewAccountingSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, accountingRootRequest(http.MethodPost, body))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "accounting.createInvoice" {
		t.Fatalf("status=%d calls=%d capability=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
	}
	var input map[string]any
	if err := json.Unmarshal(executor.input, &input); err != nil || len(input) != 3 || input["customerId"] != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("capability input=%s err=%v", executor.input, err)
	}
	if executor.claims.IntentID != "create-invoice-attempt-12" || executor.claims.InputSHA256 == "" || executor.claims.OrganizationID != *identity.OrgID {
		t.Fatalf("write claims did not preserve intent and resolved scope: %+v", executor.claims)
	}
}

func TestAccountingSessionHandlerRejectsInvalidWritesBeforeExecution(t *testing.T) {
	tests := []struct {
		name     string
		identity *session.ResolvedUser
		body     string
		status   int
		mutate   func(*http.Request)
	}{
		{name: "missing intent", identity: accountingRootIdentity("accounting.admin"), body: `{"action":"closeYear","year":2026}`, status: http.StatusBadRequest},
		{name: "invalid input", identity: accountingRootIdentity("accounting.write"), body: `{"action":"createInvoice","customerId":"bad","lines":[{"description":"x","quantity":1,"unitPriceMinor":1}],"intentId":"write-attempt-1"}`, status: http.StatusBadRequest},
		{name: "permission denied", identity: accountingRootIdentity("accounting.read"), body: `{"action":"closeYear","year":2026,"intentId":"write-attempt-2"}`, status: http.StatusForbidden},
		{name: "unsupported action", identity: accountingRootIdentity("accounting.write"), body: `{"action":"deleteInvoice","intentId":"write-attempt-3"}`, status: http.StatusBadRequest},
		{name: "cross origin cookie write", identity: accountingRootIdentity("accounting.admin"), body: `{"action":"closeYear","year":2026,"intentId":"write-attempt-4"}`, status: http.StatusForbidden, mutate: func(request *http.Request) { request.Header.Set("Origin", "https://attacker.example") }},
		{name: "unknown field", identity: accountingRootIdentity("accounting.write"), body: `{"action":"createInvoice","customerId":"22222222-2222-4222-8222-222222222222","lines":[{"description":"Consulting","quantity":2,"unitPriceMinor":1200}],"currency":"USD","intentId":"write-attempt-5","ignored":"stripped"}`, status: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{}
			request := accountingRootRequest(http.MethodPost, test.body)
			if test.mutate != nil {
				test.mutate(request)
			}
			response := httptest.NewRecorder()
			NewAccountingSessionHandler(&fakeDirectSessionResolver{resolved: test.identity}, executor, nil).ServeHTTP(response, request)
			if response.Code != test.status || executor.calls != 0 {
				t.Fatalf("status=%d want=%d calls=%d body=%s", response.Code, test.status, executor.calls, response.Body.String())
			}
		})
	}
}

func TestAccountingSessionHandlerRejectsInvalidCapabilityOutput(t *testing.T) {
	identity := accountingRootIdentity("accounting.write")
	outputs := []string{
		`{}`,
		`{"invoiceId":null,"invoiceNumber":12,"totalMinor":2400,"entryId":"55555555-5555-4555-8555-555555555555","currency":"USD"}`,
		`{"invoiceId":"44444444-4444-4444-8444-444444444444","invoiceNumber":"12","totalMinor":2400,"entryId":"55555555-5555-4555-8555-555555555555","currency":"USD"}`,
		`{"invoiceId":"44444444-4444-4444-8444-444444444444","invoiceNumber":12,"totalMinor":2400,"entryId":"55555555-5555-4555-8555-555555555555","currency":"USD","unexpected":true}`,
	}
	for _, output := range outputs {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(output)}}
		body := `{"action":"createInvoice","customerId":"22222222-2222-4222-8222-222222222222","lines":[{"description":"Consulting","quantity":2,"unitPriceMinor":1200}],"intentId":"create-invoice-attempt-13"}`
		response := httptest.NewRecorder()
		NewAccountingSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, accountingRootRequest(http.MethodPost, body))
		if response.Code != http.StatusInternalServerError {
			t.Errorf("accepted invalid capability output %s: status=%d body=%s", output, response.Code, response.Body.String())
		}
	}
}

func TestAccountingSessionHandlerRejectsIncompleteOverviewOutput(t *testing.T) {
	for _, output := range []string{
		`{}`,
		`{"entries":[],"aging":{},"agingInvoices":[],"baseCurrency":"USD","foreignReceivablesCount":0,"foreignPayablesCount":0,"closedPeriods":[],"bills":[],"filings":[],"customers":[],"invoices":[]}`,
		`{"entries":[],"aging":null,"agingInvoices":[],"baseCurrency":"USD","foreignReceivablesCount":0,"foreignPayablesCount":0,"closedPeriods":[],"bills":[],"filings":[],"customers":[],"invoices":[],"payments":[]}`,
	} {
		identity := accountingRootIdentity("accounting.read")
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(output)}}
		response := httptest.NewRecorder()
		NewAccountingSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, accountingRootRequest(http.MethodGet, ""))
		if response.Code != http.StatusInternalServerError {
			t.Errorf("accepted invalid overview output %s: status=%d body=%s", output, response.Code, response.Body.String())
		}
	}
}
