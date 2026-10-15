package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

func TestPosSessionHandlerDispatchesActionsThroughCapabilities(t *testing.T) {
	tests := []struct {
		name, body, capabilityID, output string
		wantIntent                       string
	}{
		{
			name: "open", body: `{"action":"open","intentId":"pos-open-session-intent","openingFloatMinor":12500}`,
			capabilityID: "pos.openSession", wantIntent: "pos-open-session-intent",
			output: `{"sessionId":"44444444-4444-4444-8444-444444444444"}`,
		},
		{
			name: "sale", body: `{"action":"sale","intentId":"pos-complete-sale-intent","sessionId":"44444444-4444-4444-8444-444444444444","lines":[{"description":"Tea","quantity":1000,"unitPriceMinor":200,"sku":"TEA"}],"tenders":[{"method":"cash","amountMinor":200}]}`,
			capabilityID: "pos.completeSale", wantIntent: "pos-complete-sale-intent",
			output: `{"invoiceId":"55555555-5555-4555-8555-555555555555","invoiceNumber":1,"totalMinor":200,"tenderedMinor":200,"changeGivenMinor":0,"tenders":[{"method":"cash","amountMinor":200}]}`,
		},
		{
			name: "close", body: `{"action":"close","intentId":"pos-close-session-intent","sessionId":"44444444-4444-4444-8444-444444444444","countedCashMinor":300}`,
			capabilityID: "pos.closeSession", wantIntent: "pos-close-session-intent",
			output: `{"expectedCashMinor":300,"varianceMinor":0,"flagged":false}`,
		},
		{
			name: "return", body: `{"action":"returnSale","intentId":"pos-return-sale-intent","invoiceId":"55555555-5555-4555-8555-555555555555","reason":"Customer return","refundMethod":"cash","lines":[{"invoiceLineId":"66666666-6666-4666-8666-666666666666","quantity":1000}]}`,
			capabilityID: "pos.returnSale", wantIntent: "pos-return-sale-intent",
			output: `{"refundEntryId":"77777777-7777-4777-8777-777777777777","refundMinor":200,"creditedMinor":200,"restockedLines":1,"refundMethod":"cash"}`,
		},
		{
			name: "summary without write intent", body: `{"action":"shiftSummary","sessionId":"44444444-4444-4444-8444-444444444444"}`,
			capabilityID: "pos.shiftSummary",
			output:       `{"register":"main","status":"open","salesCount":1,"takingsMinor":200,"tenderTotals":[{"method":"cash","amountMinor":200}],"refundTotals":[],"expectedCashMinor":200,"countedCashMinor":null,"varianceMinor":null}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(test.output)}}
			response := httptest.NewRecorder()
			NewPosSessionHandler(resolver, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, test.body))
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if executor.calls != 1 || executor.capID != test.capabilityID || executor.claims.OrganizationID != *directTestIdentity().OrgID || executor.claims.Subject != directTestIdentity().UserID {
				t.Fatalf("executor calls=%d capability=%q claims=%+v", executor.calls, executor.capID, executor.claims)
			}
			if executor.claims.IntentID != test.wantIntent || executor.claims.ActorType != "human" || executor.claims.AuthSessionID != directTestIdentity().AuthSessionID {
				t.Fatalf("claims=%+v, want POS action intent and session-bound human actor", executor.claims)
			}
			if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), `"ok":true`) {
				t.Fatalf("headers=%v body=%s", response.Header(), response.Body.String())
			}
			if err := validatePosInput(executor.capID, executor.input); err != nil {
				t.Fatalf("dispatched invalid capability input %s: %v", executor.input, err)
			}
		})
	}
}

func TestPosSessionHandlerRejectsInvalidRequestsBeforeExecution(t *testing.T) {
	validSale := `"sessionId":"44444444-4444-4444-8444-444444444444","lines":[{"description":"Tea","quantity":0,"unitPriceMinor":200}]`
	tests := []struct {
		name, body string
	}{
		{name: "missing intent", body: `{"action":"open"}`},
		{name: "unknown action", body: `{"action":"delete","intentId":"pos-delete-session-intent"}`},
		{name: "unknown root field", body: `{"action":"open","intentId":"pos-open-session-intent","extra":true}`},
		{name: "unknown sale line field", body: `{"action":"sale","intentId":"pos-complete-sale-intent","sessionId":"44444444-4444-4444-8444-444444444444","lines":[{"description":"Tea","quantity":1000,"unitPriceMinor":200,"unknown":true}]}`},
		{name: "empty sale SKU", body: `{"action":"sale","intentId":"pos-complete-sale-intent","sessionId":"44444444-4444-4444-8444-444444444444","lines":[{"description":"Tea","quantity":1000,"unitPriceMinor":200,"sku":""}]}`},
		{name: "unknown tender field", body: `{"action":"sale","intentId":"pos-complete-sale-intent","sessionId":"44444444-4444-4444-8444-444444444444","lines":[{"description":"Tea","quantity":1000,"unitPriceMinor":200}],"tenders":[{"method":"cash","amountMinor":200,"unknown":true}]}`},
		{name: "missing refund method", body: `{"action":"returnSale","intentId":"pos-return-sale-intent","invoiceId":"55555555-5555-4555-8555-555555555555","reason":"Customer return"}`},
		{name: "bad session UUID", body: `{"action":"sale","intentId":"pos-complete-sale-intent","sessionId":"not-a-uuid","lines":[{"description":"Tea","quantity":1000,"unitPriceMinor":200}]}`},
		{name: "trailing JSON", body: `{"action":"open","intentId":"pos-open-session-intent"}{}`},
		{name: "invalid sale line", body: `{"action":"sale","intentId":"pos-complete-sale-intent",` + validSale + `}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"sessionId":"44444444-4444-4444-8444-444444444444"}`)}}
			response := httptest.NewRecorder()
			NewPosSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, test.body))
			if response.Code != http.StatusBadRequest || executor.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s, want 400 without execution", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestPosSessionHandlerEnforcesSessionOriginOrganizationAndOutputContract(t *testing.T) {
	t.Run("cross organization selector denied", func(t *testing.T) {
		request := directCapabilityRequest(http.MethodPost, `{"action":"open","intentId":"pos-open-session-intent"}`)
		request.Header.Set("X-Organization-Id", "77777777-7777-4777-8777-777777777777")
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewPosSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("unverified identity denied", func(t *testing.T) {
		identity := directTestIdentity()
		identity.EmailVerified = false
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewPosSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"action":"open","intentId":"pos-open-session-intent"}`))
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("cookie request requires same origin", func(t *testing.T) {
		request := directCapabilityRequest(http.MethodPost, `{"action":"open","intentId":"pos-open-session-intent"}`)
		request.Header.Set("Origin", "https://attacker.example")
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewPosSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("malformed capability output fails closed", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"sessionId":"44444444-4444-4444-8444-444444444444","unexpected":true}`)}}
		response := httptest.NewRecorder()
		NewPosSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"action":"open","intentId":"pos-open-session-intent"}`))
		if response.Code != http.StatusInternalServerError || executor.calls != 1 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestPosSessionHandlerPreservesApprovalAndDomainRefusalResponses(t *testing.T) {
	t.Run("approval pending", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalRationale: "Manager approval required"}}
		response := httptest.NewRecorder()
		NewPosSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"action":"open","intentId":"pos-open-session-intent"}`))
		if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("domain refusal", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "register is already open"}}
		response := httptest.NewRecorder()
		NewPosSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"action":"open","intentId":"pos-open-session-intent"}`))
		if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "register is already open") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("missing permission", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: "forbidden: missing permission: pos.write"}}
		response := httptest.NewRecorder()
		NewPosSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, directCapabilityRequest(http.MethodPost, `{"action":"open","intentId":"pos-open-session-intent"}`))
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "forbidden: missing permission: pos.write") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestPosReturnOutputRequiresUUIDRefundEntryID(t *testing.T) {
	valid := `{"refundEntryId":"77777777-7777-4777-8777-777777777777","refundMinor":200,"creditedMinor":200,"restockedLines":1,"refundMethod":"cash"}`
	if !validPosOutput("returnSale", json.RawMessage(valid)) {
		t.Fatal("valid return output was rejected")
	}
	if validPosOutput("returnSale", json.RawMessage(strings.Replace(valid, "77777777-7777-4777-8777-777777777777", "refund-1", 1))) {
		t.Fatal("accepted return output with an invalid refund journal entry ID")
	}
}
