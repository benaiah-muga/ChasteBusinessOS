package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type budgetAccountsStub struct {
	orgID   string
	rows    []accountingBudgetAccount
	err     error
	readNum int
}

func (stub *budgetAccountsStub) ListBudgetAccounts(_ context.Context, orgID string) ([]accountingBudgetAccount, error) {
	stub.readNum++
	stub.orgID = orgID
	return stub.rows, stub.err
}

type budgetCapabilityCall struct {
	claims authbridge.CapabilityClaims
	capID  string
	input  json.RawMessage
}

type budgetExecutorStub struct {
	results []capability.Result
	errs    []error
	calls   []budgetCapabilityCall
}

func (stub *budgetExecutorStub) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	stub.calls = append(stub.calls, budgetCapabilityCall{claims: claims, capID: capabilityID, input: append(json.RawMessage(nil), input...)})
	index := len(stub.calls) - 1
	if index < len(stub.errs) && stub.errs[index] != nil {
		return capability.Result{}, stub.errs[index]
	}
	if index < len(stub.results) {
		return stub.results[index], nil
	}
	return capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil
}

func accountingBudgetsRequest(method, target, body string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.TLS = &tls.ConnectionState{}
	request.Host = "app.example.test"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://app.example.test")
	request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: "11111111-1111-4111-8111-111111111111"})
	return request
}

func accountingBudgetsIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"accounting.read": true, "accounting.write": true}
	return identity
}

func TestAccountingBudgetsSessionHandlerGETPreservesLegacyContractAndScopes(t *testing.T) {
	identity := accountingBudgetsIdentity()
	executor := &budgetExecutorStub{results: []capability.Result{
		{OK: true, Data: json.RawMessage(`{"scenarios":[{"id":"budget-1"}]}`)},
		{OK: true, Data: json.RawMessage(`{"scenarioId":"budget-1","months":[]}`)},
	}}
	accounts := &budgetAccountsStub{rows: []accountingBudgetAccount{{Code: "4000", Name: "Sales", Type: "income"}}}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	handler := newAccountingBudgetsSessionHandler(resolver, executor, accounts, nil, nil)
	request := accountingBudgetsRequest(http.MethodGet, "/api/accounting/budgets?fiscalYear=2026&scenarioId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		OK         bool                      `json:"ok"`
		Scenarios  json.RawMessage           `json:"scenarios"`
		Comparison json.RawMessage           `json:"comparison"`
		Accounts   []accountingBudgetAccount `json:"accounts"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || !body.OK || string(body.Scenarios) != `{"scenarios":[{"id":"budget-1"}]}` || string(body.Comparison) != `{"scenarioId":"budget-1","months":[]}` || len(body.Accounts) != 1 || body.Accounts[0].Code != "4000" {
		t.Fatalf("unexpected response body=%s parsed=%+v err=%v", response.Body.String(), body, err)
	}
	if len(executor.calls) != 2 || executor.calls[0].capID != "accounting.listBudgetScenarios" || string(executor.calls[0].input) != `{"fiscalYear":2026}` || executor.calls[1].capID != "accounting.budgetActualVsPlan" || string(executor.calls[1].input) != `{"scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}` {
		t.Fatalf("unexpected capability calls: %+v", executor.calls)
	}
	if executor.calls[0].claims.OrganizationID != *identity.OrgID || executor.calls[0].claims.Subject != identity.UserID || executor.calls[0].claims.ActorID == nil || *executor.calls[0].claims.ActorID != identity.UserID || executor.calls[0].claims.CapabilityID != executor.calls[0].capID {
		t.Fatalf("claims not derived from resolved session: %+v", executor.calls[0].claims)
	}
	if accounts.orgID != *identity.OrgID || accounts.readNum != 1 || resolver.cookie != "session-cookie" {
		t.Fatalf("account lookup org=%q count=%d resolver cookie=%q", accounts.orgID, accounts.readNum, resolver.cookie)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache control=%q", response.Header().Get("Cache-Control"))
	}
}

func TestAccountingBudgetsSessionHandlerPOSTMapsSaveAndUndoCapabilities(t *testing.T) {
	for _, test := range []struct {
		name      string
		body      string
		capID     string
		wantInput string
		intentID  string
	}{
		{
			name:      "save",
			body:      `{"action":"save","intentId":"save-1","scenarioKey":"base-case","name":"Base case","fiscalYear":2026,"currency":"UGX","assumptions":{"collectionDelayDays":15,"spendUpliftBasisPoints":0,"expectedMonthlyInflowMinor":1000,"expectedMonthlyOutflowMinor":500,"minimumCashBufferMinor":100},"lines":[{"month":1,"accountCode":"4000","plannedMinor":1000}]}`,
			capID:     "accounting.saveBudgetScenario",
			wantInput: `{"assumptions":{"collectionDelayDays":15,"spendUpliftBasisPoints":0,"expectedMonthlyInflowMinor":1000,"expectedMonthlyOutflowMinor":500,"minimumCashBufferMinor":100},"currency":"UGX","fiscalYear":2026,"lines":[{"month":1,"accountCode":"4000","plannedMinor":1000}],"name":"Base case","scenarioKey":"base-case"}`,
			intentID:  "save-1",
		},
		{
			name:      "undo",
			body:      `{"action":"undo","intentId":"undo-1","scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","previousScenarioId":null}`,
			capID:     "accounting.undoBudgetScenarioVersion",
			wantInput: `{"previousScenarioId":null,"scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`,
			intentID:  "undo-1",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			identity := accountingBudgetsIdentity()
			executor := &budgetExecutorStub{results: []capability.Result{{OK: true, Data: json.RawMessage(`{"scenarioId":"budget-2","version":2,"previousScenarioId":"budget-1"}`)}}}
			handler := newAccountingBudgetsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, &budgetAccountsStub{}, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, accountingBudgetsRequest(http.MethodPost, "/api/accounting/budgets", test.body))
			if response.Code != http.StatusOK || response.Body.String() != `{"ok":true,"data":{"scenarioId":"budget-2","version":2,"previousScenarioId":"budget-1"}}`+"\n" {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(executor.calls) != 1 || executor.calls[0].capID != test.capID || string(executor.calls[0].input) != test.wantInput || executor.calls[0].claims.IntentID != test.intentID || executor.calls[0].claims.CapabilityID != test.capID {
				t.Fatalf("unexpected capability call: %+v", executor.calls)
			}
		})
	}
}

func TestAccountingBudgetsSessionHandlerValidatesAuthPermissionAndInput(t *testing.T) {
	for _, test := range []struct {
		name     string
		method   string
		target   string
		body     string
		identity *session.ResolvedUser
		want     int
	}{
		{name: "invalid year query", method: http.MethodGet, target: "/api/accounting/budgets?fiscalYear=2101", want: http.StatusBadRequest},
		{name: "invalid scenario query", method: http.MethodGet, target: "/api/accounting/budgets?scenarioId=not-a-uuid", want: http.StatusBadRequest},
		{name: "missing read permission", method: http.MethodGet, target: "/api/accounting/budgets", identity: func() *session.ResolvedUser {
			u := accountingBudgetsIdentity()
			u.Permissions = map[string]bool{}
			return u
		}(), want: http.StatusForbidden},
		{name: "missing write permission", method: http.MethodPost, target: "/api/accounting/budgets", body: `{"action":"undo","scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`, identity: func() *session.ResolvedUser {
			u := accountingBudgetsIdentity()
			u.Permissions = map[string]bool{"accounting.read": true}
			return u
		}(), want: http.StatusForbidden},
		{name: "missing idempotency intent", method: http.MethodPost, target: "/api/accounting/budgets", body: `{"action":"undo","scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`, want: http.StatusBadRequest},
		{name: "undo requires scenario id", method: http.MethodPost, target: "/api/accounting/budgets", body: `{"action":"undo","intentId":"undo-missing-scenario"}`, want: http.StatusBadRequest},
		{name: "undo rejects invalid scenario id", method: http.MethodPost, target: "/api/accounting/budgets", body: `{"action":"undo","intentId":"undo-invalid-scenario","scenarioId":"not-a-uuid"}`, want: http.StatusBadRequest},
		{name: "missing origin", method: http.MethodPost, target: "/api/accounting/budgets", body: `{"action":"undo","scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`, want: http.StatusForbidden},
		{name: "invalid body", method: http.MethodPost, target: "/api/accounting/budgets", body: `{"action":"delete"}`, want: http.StatusBadRequest},
		{name: "invalid intent id", method: http.MethodPost, target: "/api/accounting/budgets", body: `{"action":"undo","intentId":"bad\nintent","scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`, want: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			identity := test.identity
			if identity == nil {
				identity = accountingBudgetsIdentity()
			}
			resolver := &fakeDirectSessionResolver{resolved: identity}
			executor := &budgetExecutorStub{}
			handler := newAccountingBudgetsSessionHandler(resolver, executor, &budgetAccountsStub{}, nil, nil)
			request := accountingBudgetsRequest(test.method, test.target, test.body)
			if test.name == "missing origin" {
				request.Header.Del("Origin")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
			if test.want != http.StatusOK && len(executor.calls) != 0 {
				t.Fatalf("rejected request reached capability executor: %+v", executor.calls)
			}
		})
	}
}

func TestAccountingBudgetsSessionHandlerMapsCapabilityFailures(t *testing.T) {
	for _, test := range []struct {
		name   string
		result capability.Result
		err    error
		want   int
	}{
		{name: "invalid capability input", result: capability.Result{OK: false, Error: "invalid budget scenario"}, want: http.StatusUnprocessableEntity},
		{name: "approval pending", result: capability.Result{PendingApproval: true, ApprovalRationale: "review needed"}, want: http.StatusAccepted},
		{name: "expired session", err: capability.ErrSessionInvalid, want: http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &budgetExecutorStub{results: []capability.Result{test.result}, errs: []error{test.err}}
			handler := newAccountingBudgetsSessionHandler(&fakeDirectSessionResolver{resolved: accountingBudgetsIdentity()}, executor, &budgetAccountsStub{}, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, accountingBudgetsRequest(http.MethodPost, "/api/accounting/budgets", `{"action":"undo","intentId":"undo-failure-1","scenarioId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`))
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
		})
	}
}
