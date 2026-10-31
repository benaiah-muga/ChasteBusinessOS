package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type expensesCall struct {
	claims authbridge.CapabilityClaims
	capID  string
	input  json.RawMessage
}

type expensesExecutorStub struct {
	results []capability.Result
	errs    []error
	calls   []expensesCall
}

func (stub *expensesExecutorStub) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	stub.calls = append(stub.calls, expensesCall{claims: claims, capID: capabilityID, input: append(json.RawMessage(nil), input...)})
	index := len(stub.calls) - 1
	if index < len(stub.errs) && stub.errs[index] != nil {
		return capability.Result{}, stub.errs[index]
	}
	if index < len(stub.results) {
		return stub.results[index], nil
	}
	return capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil
}

func expensesRequest(method, path, body string) *http.Request {
	request := directCapabilityRequest(method, body)
	target, err := url.Parse(path)
	if err != nil {
		panic(err)
	}
	request.URL.Path, request.URL.RawQuery = target.Path, target.RawQuery
	return request
}

func TestExpensesSessionHandlerGETListsClaimsAndPoliciesThroughCapabilities(t *testing.T) {
	identity := directTestIdentity()
	executor := &expensesExecutorStub{results: []capability.Result{
		{OK: true, Data: json.RawMessage(`{"claims":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","claimantUserId":"22222222-2222-4222-8222-222222222222","amountMinor":12500,"currency":"UGX","status":"submitted","memo":"Taxi to client"}]}`)},
		{OK: true, Data: json.RawMessage(`{"policies":[{"category":"travel","limitMinor":10000}]}`)},
	}}
	response := httptest.NewRecorder()
	NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, expensesRequest(http.MethodGet, "/api/expenses", ""))

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"claims":[`) || !strings.Contains(response.Body.String(), `"policies":[`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(executor.calls) != 2 || executor.calls[0].capID != "accounting.listExpenseClaims" || executor.calls[1].capID != "accounting.listExpensePolicies" || string(executor.calls[0].input) != `{}` || string(executor.calls[1].input) != `{}` {
		t.Fatalf("unexpected calls: %+v", executor.calls)
	}
	if executor.calls[0].claims.OrganizationID != *identity.OrgID || executor.calls[0].claims.Subject != identity.UserID || executor.calls[0].claims.AuthSessionID != identity.AuthSessionID {
		t.Fatalf("claims were not built from resolved session: %+v", executor.calls[0].claims)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("privacy headers missing: %v", response.Header())
	}
}

func TestExpensesSessionHandlerGETUsesOnlySupportedStatusFilters(t *testing.T) {
	for _, test := range []struct{ path, want string }{
		{"/api/expenses?status=approved", `{"status":"approved"}`},
		{"/api/expenses?status=unsupported", `{}`},
	} {
		executor := &expensesExecutorStub{results: []capability.Result{{OK: true, Data: json.RawMessage(`{"claims":[]}`)}, {OK: true, Data: json.RawMessage(`{"policies":[]}`)}}}
		response := httptest.NewRecorder()
		NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, expensesRequest(http.MethodGet, test.path, ""))
		if response.Code != http.StatusOK || string(executor.calls[0].input) != test.want {
			t.Fatalf("path=%s status=%d input=%s body=%s", test.path, response.Code, executor.calls[0].input, response.Body.String())
		}
	}
}

func TestExpensesSessionHandlerPOSTMapsGovernedActionsAndRequiresStableIntent(t *testing.T) {
	for _, test := range []struct {
		name, body, capabilityID, expectedIntent string
		data                                     string
	}{
		{"submit", `{"action":"submit","intentId":"expense-submit-1","amountMinor":12500,"memo":"Taxi to client"}`, "accounting.submitExpenseClaim", "expense-submit-1", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"submitted","category":"travel","overPolicyLimit":false,"policyLimitMinor":10000}`},
		{"decide", `{"action":"decide","intentId":"expense-decide-1","claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","decision":"approved"}`, "accounting.decideExpenseClaim", "expense-decide-1", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"approved"}`},
		{"pay", `{"action":"pay","intentId":"expense-pay-1","claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","amountMinor":12500}`, "accounting.payExpenseClaim", "expense-pay-1", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","entryId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","paidMinor":12500}`},
		{"set policy", `{"action":"setPolicy","intentId":"expense-policy-1","category":"travel","limitMinor":10000}`, "accounting.setExpensePolicy", "expense-policy-1", `{"set":true,"category":"travel","limitMinor":10000}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			identity := directTestIdentity()
			result := capability.Result{OK: true, Data: json.RawMessage(test.data)}
			executor := &expensesExecutorStub{results: []capability.Result{result}}
			response := httptest.NewRecorder()
			NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, expensesRequest(http.MethodPost, "/api/expenses", test.body))
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ok":true`) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(executor.calls) != 1 || executor.calls[0].capID != test.capabilityID || executor.calls[0].claims.IntentID != test.expectedIntent || executor.calls[0].claims.OrganizationID != *identity.OrgID {
				t.Fatalf("unexpected governed call: %+v", executor.calls)
			}
		})
	}

	for _, body := range []string{
		`{"action":"submit","amountMinor":1000,"memo":"Taxi"}`,
		`{"action":"submit","intentId":" ","amountMinor":1000,"memo":"Taxi"}`,
		`{"action":"submit","intentId":"id","amountMinor":1000,"memo":"Taxi","unexpected":true}`,
	} {
		executor := &expensesExecutorStub{}
		response := httptest.NewRecorder()
		NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, expensesRequest(http.MethodPost, "/api/expenses", body))
		if response.Code != http.StatusBadRequest || len(executor.calls) != 0 {
			t.Fatalf("body=%s status=%d calls=%d response=%s", body, response.Code, len(executor.calls), response.Body.String())
		}
	}
}

func TestExpensesSessionHandlerMapsPendingApprovalAndRejectsWrongMethod(t *testing.T) {
	executor := &expensesExecutorStub{results: []capability.Result{{OK: false, PendingApproval: true, ApprovalRationale: "manager approval required"}}}
	response := httptest.NewRecorder()
	NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, expensesRequest(http.MethodPost, "/api/expenses", `{"action":"pay","intentId":"pay-1","claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","amountMinor":10}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), "manager approval required") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &expensesExecutorStub{}, nil).ServeHTTP(response, expensesRequest(http.MethodDelete, "/api/expenses", ""))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("status=%d Allow=%q", response.Code, response.Header().Get("Allow"))
	}
}

func TestExpensesSessionHandlerMapsMissingPermissionToForbidden(t *testing.T) {
	executor := &expensesExecutorStub{results: []capability.Result{{OK: false, Error: "forbidden: missing permission: accounting.post"}}}
	response := httptest.NewRecorder()
	NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, expensesRequest(http.MethodPost, "/api/expenses", `{"action":"submit","intentId":"expense-submit-permission-test","amountMinor":1000,"memo":"Taxi"}`))
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "forbidden: missing permission: accounting.post") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestExpenseActionOutputsRequireExactCompleteContracts(t *testing.T) {
	valid := map[string]string{
		"submit":    `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"submitted","category":"travel","overPolicyLimit":false,"policyLimitMinor":10000}`,
		"decide":    `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"approved"}`,
		"pay":       `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","entryId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","paidMinor":10}`,
		"setPolicy": `{"set":true,"category":"travel","limitMinor":10000}`,
	}
	for action, raw := range valid {
		if !validExpenseOutput(action, json.RawMessage(raw)) {
			t.Errorf("%s rejected valid output %s", action, raw)
		}
	}
	if !validExpenseOutput("submit", json.RawMessage(strings.Replace(valid["submit"], `"policyLimitMinor":10000`, `"policyLimitMinor":null`, 1))) {
		t.Error("submit rejected the defined null policy limit")
	}
	invalid := []struct{ action, raw string }{
		{"submit", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"submitted","category":"travel","policyLimitMinor":10000}`},
		{"submit", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"submitted","category":"travel","overPolicyLimit":false}`},
		{"submit", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"submitted","category":"travel","overPolicyLimit":null,"policyLimitMinor":10000}`},
		{"submit", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"submitted","category":"travel","overPolicyLimit":false,"policyLimitMinor":10000,"extra":true}`},
		{"decide", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"approved","extra":true}`},
		{"pay", `{"claimId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","entryId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","paidMinor":10,"extra":true}`},
		{"setPolicy", `{"set":true,"category":"travel","limitMinor":null}`},
	}
	for _, test := range invalid {
		if validExpenseOutput(test.action, json.RawMessage(test.raw)) {
			t.Errorf("%s accepted invalid/incomplete output %s", test.action, test.raw)
		}
	}
}

func TestExpensesPaymentOutputRequiresUUIDEntryID(t *testing.T) {
	validClaimID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if !validExpenseOutput("pay", json.RawMessage(`{"claimId":"`+validClaimID+`","entryId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","paidMinor":10}`)) {
		t.Fatal("valid payment output was rejected")
	}
	if validExpenseOutput("pay", json.RawMessage(`{"claimId":"`+validClaimID+`","entryId":"not-a-uuid","paidMinor":10}`)) {
		t.Fatal("accepted payment output with an invalid journal entry ID")
	}
}

func TestExpensesSessionHandlerRejectsUnverifiedAndCrossOrganizationSessions(t *testing.T) {
	unverified := directTestIdentity()
	unverified.EmailVerified = false
	for _, test := range []struct {
		name     string
		identity *session.ResolvedUser
		selector string
		status   int
	}{
		{"unverified", unverified, "", http.StatusUnauthorized},
		{"cross organization", directTestIdentity(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", http.StatusForbidden},
	} {
		executor := &expensesExecutorStub{}
		request := expensesRequest(http.MethodGet, "/api/expenses", "")
		if test.selector != "" {
			request.Header.Set("X-Organization-ID", test.selector)
		}
		response := httptest.NewRecorder()
		NewExpensesSessionHandler(&fakeDirectSessionResolver{resolved: test.identity}, executor, nil).ServeHTTP(response, request)
		if response.Code != test.status || len(executor.calls) != 0 {
			t.Fatalf("case=%s status=%d calls=%d body=%s", test.name, response.Code, len(executor.calls), response.Body.String())
		}
	}
}
