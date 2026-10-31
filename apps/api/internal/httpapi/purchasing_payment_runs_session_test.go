package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const purchasingTestRunID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

func purchasingPaymentRunsRequest(method, body string) *http.Request {
	return purchasingSessionRequest(method, "/api/purchasing/payment-runs", body)
}

func TestPurchasingPaymentRunsGETExecutesListCapability(t *testing.T) {
	identity := directTestIdentity()
	runs := `{"runs":[{"id":"` + purchasingTestRunID + `","reference":"PR-000001","currency":"USD","totalMinor":5000,"status":"draft","createdAt":"2026-01-02T00:00:00.000Z","instructedAt":null,"confirmedAt":null,"entryId":null,"lines":[]}]}`
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(runs)}}
	handler := NewPurchasingPaymentRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodGet, ""))

	if response.Code != http.StatusOK || executor.capID != "purchasing.listPaymentRuns" {
		t.Fatalf("status=%d capability=%s body=%s", response.Code, executor.capID, response.Body.String())
	}
	if executor.claims.IntentID != "" || executor.claims.OrganizationID != *identity.OrgID {
		t.Fatalf("claims=%+v", executor.claims)
	}
	if !strings.Contains(response.Body.String(), `"ok":true`) || !strings.Contains(response.Body.String(), `"reference":"PR-000001"`) {
		t.Fatalf("body=%s", response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("headers=%v", response.Header())
	}
}

func TestPurchasingPaymentRunsGETRequiresRunsArray(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"runs":null}`)}}
	handler := NewPurchasingPaymentRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodGet, ""))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPurchasingPaymentRunsPOSTDispatchesGovernedActions(t *testing.T) {
	billID := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	cases := []struct {
		name         string
		body         string
		capabilityID string
		input        string
	}{
		{"create", `{"action":"create","intentId":"run-create-1","memo":"January batch","lines":[{"billId":"` + billID + `","amountMinor":5000}]}`, "purchasing.createPaymentRun", `{"memo":"January batch","lines":[{"billId":"` + billID + `","amountMinor":5000}]}`},
		{"createDropsEmptyMemo", `{"action":"create","intentId":"run-create-2","memo":"","lines":[{"billId":"` + billID + `","amountMinor":5000}]}`, "purchasing.createPaymentRun", `{"lines":[{"billId":"` + billID + `","amountMinor":5000}]}`},
		{"instruct", `{"action":"instruct","intentId":"run-instruct-1","paymentRunId":"` + purchasingTestRunID + `"}`, "purchasing.instructPaymentRun", `{"paymentRunId":"` + purchasingTestRunID + `"}`},
		{"cancel", `{"action":"cancel","intentId":"run-cancel-1","paymentRunId":"` + purchasingTestRunID + `"}`, "purchasing.cancelPaymentRunDraft", `{"paymentRunId":"` + purchasingTestRunID + `"}`},
		{"restore", `{"action":"restore","intentId":"run-restore-1","paymentRunId":"` + purchasingTestRunID + `"}`, "purchasing.restorePaymentRunDraft", `{"paymentRunId":"` + purchasingTestRunID + `"}`},
		{"reverse", `{"action":"reverse","intentId":"run-reverse-1","paymentRunId":"` + purchasingTestRunID + `","reason":"bank rejected the batch"}`, "purchasing.reversePaymentRun", `{"paymentRunId":"` + purchasingTestRunID + `","reason":"bank rejected the batch"}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"paymentRunId":"` + purchasingTestRunID + `"}`)}}
			handler := NewPurchasingPaymentRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodPost, test.body))

			if response.Code != http.StatusOK || executor.capID != test.capabilityID {
				t.Fatalf("status=%d capability=%s body=%s", response.Code, executor.capID, response.Body.String())
			}
			if string(executor.input) != test.input && !sameJSON(t, string(executor.input), test.input) {
				t.Fatalf("input=%s want=%s", executor.input, test.input)
			}
			if !strings.Contains(response.Body.String(), `"ok":true`) {
				t.Fatalf("body=%s", response.Body.String())
			}
		})
	}
}

func TestPurchasingPaymentRunsPOSTRejectsMalformedBodies(t *testing.T) {
	bodies := []string{
		``,
		`{"action":"unknown"}`,
		`{"action":"instruct"}`,
		`{"action":"instruct","intentId":"intent","paymentRunId":"not-a-uuid"}`,
		`{"action":"instruct","intentId":"intent","paymentRunId":"` + purchasingTestRunID + `","extra":1}`,
		`{"action":"reverse","intentId":"intent","paymentRunId":"` + purchasingTestRunID + `","reason":"no"}`,
		`{"action":"create","intentId":"intent","lines":[]}`,
	}
	for _, body := range bodies {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true}}
		handler := NewPurchasingPaymentRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodPost, body))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("body=%q status=%d calls=%d response=%s", body, response.Code, executor.calls, response.Body.String())
		}
	}
}

func TestPurchasingPaymentRunsPOSTPendingApproval(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, PendingApproval: true, ApprovalRationale: "risk class \"money\" requires human approval by organization policy", Error: "pending human approval"}}
	handler := NewPurchasingPaymentRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodPost, `{"action":"instruct","intentId":"run-instruct-1","paymentRunId":"`+purchasingTestRunID+`"}`))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPurchasingPaymentRunsGETForbidden(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: purchasing.read"}}
	handler := NewPurchasingPaymentRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodGet, ""))
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoPurchasingPaymentRunsRouteKeepsBaseFallthrough(t *testing.T) {
	route := NewPurchasingPaymentRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"runs":[]}`)}}, nil)
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux := MountGoPurchasingPaymentRunsRoute(base, route)

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodGet, ""))
	if response.Code != http.StatusOK {
		t.Fatalf("mounted GET status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, purchasingPaymentRunsRequest(http.MethodDelete, ""))
	if response.Code != http.StatusNoContent {
		t.Fatalf("base fallthrough status=%d", response.Code)
	}
}
