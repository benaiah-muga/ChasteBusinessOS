package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeAccountingTaxReader struct {
	snapshot accountingTaxSnapshot
	err      error
	orgID    string
	calls    int
}

func (reader *fakeAccountingTaxReader) ReadAccountingTax(_ context.Context, orgID string) (accountingTaxSnapshot, error) {
	reader.calls++
	reader.orgID = orgID
	return reader.snapshot, reader.err
}

func accountingTaxRequest(method, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/accounting/tax", strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Origin", "https://app.example.test")
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func taxIdentity(perms ...string) *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = make(map[string]bool, len(perms))
	for _, permission := range perms {
		identity.Permissions[permission] = true
	}
	return identity
}

func TestAccountingTaxSessionHandlerReturnsOrgScopedSnapshot(t *testing.T) {
	identity := taxIdentity("accounting.read")
	reader := &fakeAccountingTaxReader{snapshot: accountingTaxSnapshot{
		Profile: &accountingTaxProfile{JurisdictionCode: "UG", FilingFrequency: "monthly", ProviderMode: "manual"},
		Codes:   []accountingTaxCode{{ID: "tax-code-id", Code: "VAT18", Name: "VAT 18%", JurisdictionCode: "UG", Direction: "output", RateBasisPoints: 1800, Active: true}},
		Returns: []accountingTaxReturn{}, Settlements: []accountingTaxSettlement{},
	}}
	response := httptest.NewRecorder()
	newAccountingTaxSessionHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDirectCapabilityExecutor{}, reader, nil, nil).ServeHTTP(response, accountingTaxRequest(http.MethodGet, ""))
	if response.Code != http.StatusOK || reader.calls != 1 || reader.orgID != *identity.OrgID {
		t.Fatalf("status=%d read calls=%d org=%q body=%s", response.Code, reader.calls, reader.orgID, response.Body.String())
	}
	var got accountingTaxSnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil || got.Profile == nil || got.Profile.JurisdictionCode != "UG" || len(got.Codes) != 1 || got.Codes[0].Recoverable || got.Returns == nil || got.Settlements == nil {
		t.Fatalf("snapshot=%+v err=%v", got, err)
	}
}

func TestAccountingTaxSessionHandlerDelegatesWritesWithStableIntent(t *testing.T) {
	identity := taxIdentity("accounting.admin")
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"taxCodeId":"44444444-4444-4444-8444-444444444444"}`)}}
	request := accountingTaxRequest(http.MethodPost, `{"action":"createCode","code":"VAT18","name":"VAT 18%","direction":"output","rateBasisPoints":1800,"priceIncludesTax":false,"recoverable":false,"intentId":"retry-tax-code-42","ignored":"value"}`)
	response := httptest.NewRecorder()
	newAccountingTaxSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, &fakeAccountingTaxReader{}, nil, nil).ServeHTTP(response, request)
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "accounting.createTaxCode" {
		t.Fatalf("status=%d calls=%d cap=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
	}
	var input map[string]any
	if err := json.Unmarshal(executor.input, &input); err != nil || len(input) != 6 || input["code"] != "VAT18" {
		t.Fatalf("capability input=%s err=%v", executor.input, err)
	}
	if executor.claims.IntentID != "retry-tax-code-42" || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID {
		t.Fatalf("claims=%+v", executor.claims)
	}
}

func TestAccountingTaxSessionHandlerValidatesIntentAndPermissionBeforeExecution(t *testing.T) {
	tests := []struct {
		name     string
		identity *session.ResolvedUser
		body     string
		status   int
	}{
		{name: "missing intent", identity: taxIdentity("accounting.admin"), body: `{"action":"archiveCode","taxCodeId":"44444444-4444-4444-8444-444444444444"}`, status: http.StatusBadRequest},
		{name: "invalid capability input", identity: taxIdentity("accounting.admin"), body: `{"action":"archiveCode","taxCodeId":"bad","intentId":"intent-tax-1"}`, status: http.StatusBadRequest},
		{name: "permission denied", identity: taxIdentity("accounting.read"), body: `{"action":"createCode","code":"VAT18","name":"VAT 18%","direction":"output","rateBasisPoints":1800,"priceIncludesTax":false,"recoverable":false,"intentId":"intent-tax-2"}`, status: http.StatusForbidden},
		{name: "unknown action", identity: taxIdentity("accounting.admin"), body: `{"action":"delete","intentId":"intent-tax-3"}`, status: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{}
			response := httptest.NewRecorder()
			newAccountingTaxSessionHandler(&fakeDirectSessionResolver{resolved: test.identity}, executor, &fakeAccountingTaxReader{}, nil, nil).ServeHTTP(response, accountingTaxRequest(http.MethodPost, test.body))
			if response.Code != test.status || executor.calls != 0 {
				t.Fatalf("status=%d want=%d calls=%d body=%s", response.Code, test.status, executor.calls, response.Body.String())
			}
		})
	}
}

func TestAccountingTaxSessionHandlerReportUsesReadPermissionAndCapability(t *testing.T) {
	identity := taxIdentity("accounting.read")
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"taxableSalesMinor":12000}`)}}
	handler := newAccountingTaxSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, &fakeAccountingTaxReader{}, nil, nil)
	var firstIntent string
	for i := 0; i < 2; i++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, accountingTaxRequest(http.MethodPost, `{"action":"report","from":"2026-09-01","to":"2026-09-30"}`))
		if response.Code != http.StatusOK || executor.calls != i+1 || executor.capID != "accounting.salesTaxReport" || strings.TrimSpace(response.Body.String()) != `{"ok":true,"data":{"taxableSalesMinor":12000}}` {
			t.Fatalf("request=%d status=%d calls=%d cap=%q body=%s", i+1, response.Code, executor.calls, executor.capID, response.Body.String())
		}
		if executor.claims.IntentID == "" || (i == 1 && executor.claims.IntentID == firstIntent) {
			t.Fatalf("report intent was empty or reused: previous=%q current=%q", firstIntent, executor.claims.IntentID)
		}
		firstIntent = executor.claims.IntentID
	}
}
