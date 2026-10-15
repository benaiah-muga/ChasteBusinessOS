package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

func TestAccountingPeriodCloseSessionHandlerDelegatesReadsAndWrites(t *testing.T) {
	identity := directTestIdentity()
	t.Run("workbench", func(t *testing.T) {
		period := capability.ClosePeriodInput{Year: 2026, Month: 8}
		data, err := json.Marshal(validPeriodCloseWorkbench(period))
		if err != nil {
			t.Fatal(err)
		}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: data}}
		response := httptest.NewRecorder()
		NewAccountingPeriodCloseSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodGet, "/api/accounting/close?year=2026&month=8", ""))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "accounting.periodCloseWorkbench" || string(executor.input) != `{"year":2026,"month":8}` {
			t.Fatalf("status=%d calls=%d capability=%q input=%s body=%s", response.Code, executor.calls, executor.capID, executor.input, response.Body.String())
		}
	})
	t.Run("close", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"closed":true}`)}}
		response := httptest.NewRecorder()
		body := `{"action":"close","year":2026,"month":8,"intentId":"close-period-1"}`
		NewAccountingPeriodCloseSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodPost, "/api/accounting/close", body))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "accounting.closePeriod" || string(executor.input) != `{"month":8,"year":2026}` || executor.claims.IntentID != "close-period-1" {
			t.Fatalf("status=%d calls=%d capability=%q input=%s claims=%+v body=%s", response.Code, executor.calls, executor.capID, executor.input, executor.claims, response.Body.String())
		}
	})
	t.Run("checklist", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"updated":true,"previousCompleted":false,"previousNote":null}`)}}
		response := httptest.NewRecorder()
		body := `{"action":"checklist","year":2026,"month":8,"taskKey":"review_tax","completed":true,"note":"Reviewed","intentId":"checklist-1"}`
		NewAccountingPeriodCloseSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodPost, "/api/accounting/close", body))
		if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "accounting.updatePeriodCloseCheck" || executor.claims.IntentID != "checklist-1" {
			t.Fatalf("status=%d calls=%d capability=%q claims=%+v body=%s", response.Code, executor.calls, executor.capID, executor.claims, response.Body.String())
		}
		var input map[string]any
		if json.Unmarshal(executor.input, &input) != nil || input["taskKey"] != "review_tax" || input["completed"] != true || input["note"] != "Reviewed" {
			t.Fatalf("input=%s", executor.input)
		}
	})
}

func TestAccountingPeriodCloseOutputValidationRejectsMalformedAndMismatchedResults(t *testing.T) {
	period := capability.ClosePeriodInput{Year: 2026, Month: 8}
	valid, err := json.Marshal(validPeriodCloseWorkbench(period))
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePeriodCloseOutput("accounting.periodCloseWorkbench", valid, &period); err != nil {
		t.Fatalf("valid workbench rejected: %v", err)
	}
	unsafeCount := validPeriodCloseWorkbench(period)
	unsafeCount.UnmatchedLineCount = javascriptSafeIntegerMaximum + 1
	unsafeCount.Tasks[4].Completed = false
	unsafeCount.Tasks[4].Blocking = true
	unsafeCount.Tasks[4].Status = "blocked"
	unsafeCount.Blockers = []string{"bank_reconciliation"}
	unsafeCount.ReadyToClose = false
	unsafeData, err := json.Marshal(unsafeCount)
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePeriodCloseOutput("accounting.periodCloseWorkbench", unsafeData, &period); err == nil {
		t.Fatal("accepted a count beyond JavaScript's safe integer range")
	}
	for _, data := range []json.RawMessage{
		json.RawMessage(`null`),
		json.RawMessage(`{}`),
		json.RawMessage(`{"year":2025,"month":8,"start":"2026-08-01T00:00:00.000Z","end":"2026-08-31T23:59:59.999Z","tasks":[],"blockers":[],"readyToClose":true,"unmatchedLineCount":0,"currenciesWithExposure":[]}`),
		json.RawMessage(`{"closed":false}`),
	} {
		capabilityID := "accounting.periodCloseWorkbench"
		if string(data) == `{"closed":false}` {
			capabilityID = "accounting.closePeriod"
		}
		if err := validatePeriodCloseOutput(capabilityID, data, &period); err == nil {
			t.Fatalf("accepted malformed output for %s: %s", capabilityID, data)
		}
	}
	for _, test := range []struct {
		capabilityID string
		data         json.RawMessage
	}{
		{"accounting.updatePeriodCloseCheck", json.RawMessage(`{"updated":true}`)},
		{"accounting.closePeriod", json.RawMessage(`{"closed":true,"unexpected":1}`)},
		{"accounting.periodCloseWorkbench", json.RawMessage(`{"year":2026,"month":8,"start":"2026-08-01T00:00:00.000Z","end":"2026-08-31T23:59:59.999Z","tasks":[{"key":"review_journal","label":"Journal","completed":true,"note":null,"blocking":false,"status":"complete"}],"blockers":[],"readyToClose":true,"unmatchedLineCount":0,"currenciesWithExposure":[]}`)},
	} {
		if err := validatePeriodCloseOutput(test.capabilityID, test.data, &period); err == nil {
			t.Fatalf("accepted non-strict output for %s: %s", test.capabilityID, test.data)
		}
	}
	revaluation, err := json.Marshal(capability.RevalueForeignReceivablesOutput{
		RevaluationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		Currencies: []capability.FxRevaluationCurrencyLine{{
			Currency: "EUR", ForeignMinor: 100, HistoricalBaseMinor: 110, CloseBaseMinor: 95,
			AdjustmentMinor: -15, RateNum: 95, RateDen: 100,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePeriodCloseOutput("accounting.revalueForeignReceivables", revaluation, &period); err != nil {
		t.Fatalf("valid revaluation rejected: %v", err)
	}
}

func validPeriodCloseWorkbench(period capability.ClosePeriodInput) capability.PeriodCloseWorkbenchOutput {
	start := time.Date(int(period.Year), time.Month(period.Month), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0).Add(-time.Millisecond)
	keys := []string{"review_journal", "review_receivables", "review_payables", "review_tax", "bank_reconciliation", "fx_revaluation"}
	tasks := make([]capability.PeriodCloseTask, 0, len(keys))
	for _, key := range keys {
		tasks = append(tasks, capability.PeriodCloseTask{Key: key, Label: key, Detail: "", Completed: true, Blocking: false, Status: "complete"})
	}
	return capability.PeriodCloseWorkbenchOutput{
		Year: period.Year, Month: period.Month,
		Start: start.Format("2006-01-02T15:04:05.000Z"), End: end.Format("2006-01-02T15:04:05.000Z"),
		Tasks: tasks, Blockers: []string{}, ReadyToClose: true,
		UnmatchedLineCount: 0, CurrenciesWithExposure: []string{},
	}
}

func TestAccountingPeriodCloseSessionHandlerRejectsInvalidRequests(t *testing.T) {
	for _, test := range []struct {
		name   string
		method string
		target string
		body   string
	}{
		{name: "partial period query", method: http.MethodGet, target: "/api/accounting/close?year=2026"},
		{name: "invalid month", method: http.MethodGet, target: "/api/accounting/close?year=2026&month=13"},
		{name: "missing intent", method: http.MethodPost, target: "/api/accounting/close", body: `{"action":"close","year":2026,"month":8}`},
		{name: "blank intent", method: http.MethodPost, target: "/api/accounting/close", body: `{"action":"close","year":2026,"month":8,"intentId":"  "}`},
		{name: "unexpected field", method: http.MethodPost, target: "/api/accounting/close", body: `{"action":"close","year":2026,"month":8,"intentId":"close-1","untrusted":true}`},
		{name: "invalid checklist task", method: http.MethodPost, target: "/api/accounting/close", body: `{"action":"checklist","year":2026,"month":8,"taskKey":"other","completed":true,"intentId":"check-1"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
			response := httptest.NewRecorder()
			NewAccountingPeriodCloseSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, timeSessionRequest(test.method, test.target, test.body))
			if response.Code != http.StatusBadRequest || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
	}
	request := httptest.NewRequest(http.MethodPost, "/api/accounting/close", strings.NewReader(`{"action":"close","year":2026,"month":8,"intentId":"id"}`))
	request.Header.Set("Origin", "https://attacker.example")
	response := httptest.NewRecorder()
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
	NewAccountingPeriodCloseSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("cross-origin status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
}
