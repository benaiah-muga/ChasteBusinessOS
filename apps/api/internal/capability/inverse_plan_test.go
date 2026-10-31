package capability

import (
	"encoding/json"
	"testing"
)

func TestPlanInverseMapsKnownOutputs(t *testing.T) {
	customerID := "11111111-1111-4111-8111-111111111111"
	plan, ok := PlanInverse(createCustomerCapabilityID, json.RawMessage(`{"customerId":"`+customerID+`"}`))
	if !ok || plan.CapabilityID != deactivateCustomerCapabilityID {
		t.Fatalf("customer plan=%+v ok=%t", plan, ok)
	}
	var input map[string]string
	if json.Unmarshal(plan.Input, &input) != nil || input["customerId"] != customerID {
		t.Fatalf("customer input=%s", plan.Input)
	}

	paymentID := "22222222-2222-4222-8222-222222222222"
	plan, ok = PlanInverse(recordPaymentCapabilityID, json.RawMessage(`{"paymentId":"`+paymentID+`"}`))
	if !ok || plan.CapabilityID != reversePaymentCapabilityID {
		t.Fatalf("payment plan=%+v ok=%t", plan, ok)
	}
	if err := json.Unmarshal(plan.Input, &input); err != nil || input["paymentId"] != paymentID || input["reason"] == "" {
		t.Fatalf("payment input=%s", plan.Input)
	}
}

func TestPlanInverseUsesDeclaredOutputMappings(t *testing.T) {
	projectID := "33333333-3333-4333-8333-333333333333"
	plan, ok := PlanInverse(createProjectCapabilityID, json.RawMessage(`{"projectId":"`+projectID+`"}`))
	if !ok || plan.CapabilityID != archiveProjectCapabilityID {
		t.Fatalf("project plan=%+v ok=%t", plan, ok)
	}
	if _, ok := PlanInverse(createInvoiceCapabilityID, json.RawMessage(`{"invoiceId":"`+projectID+`"}`)); ok {
		t.Fatal("invoice without a declared inverse must not be revertible")
	}
}

func TestPlanInverseRestoresNotificationReadReceipt(t *testing.T) {
	id := "44444444-4444-4444-8444-444444444444"
	plan, ok := PlanInverse(notificationMarkReadCapabilityID, json.RawMessage(`{"id":"`+id+`","receiptCreated":true,"found":true}`))
	if !ok || plan.CapabilityID != notificationRestoreReadCapabilityID {
		t.Fatalf("notification plan=%+v ok=%t", plan, ok)
	}
	var input map[string]any
	if json.Unmarshal(plan.Input, &input) != nil || input["id"] != id || input["receiptCreated"] != true {
		t.Fatalf("notification inverse input=%s", plan.Input)
	}
}

func TestPlanInverseRestoresDraftOrderSnapshot(t *testing.T) {
	orderID := "55555555-5555-4555-8555-555555555555"
	customerID := "66666666-6666-4666-8666-666666666666"
	output := json.RawMessage(`{"orderId":"` + orderID + `","before":{"customerId":"` + customerID + `","note":"original","lines":[{"description":"Original line","quantity":1000,"unitPriceMinor":2500}]}}`)
	plan, ok := PlanInverse(salesUpdateDraftOrderCapabilityID, output)
	if !ok || plan.CapabilityID != salesRestoreDraftOrderCapabilityID {
		t.Fatalf("draft order plan=%+v ok=%t", plan, ok)
	}
	var input struct {
		OrderID    string                `json:"orderId"`
		CustomerID string                `json:"customerId"`
		Note       *string               `json:"note"`
		Lines      []SalesOrderLineInput `json:"lines"`
	}
	if err := json.Unmarshal(plan.Input, &input); err != nil {
		t.Fatalf("draft order inverse input %s: %v", plan.Input, err)
	}
	if input.OrderID != orderID || input.CustomerID != customerID || len(input.Lines) != 1 || input.Lines[0].Description != "Original line" {
		t.Fatalf("draft order inverse input=%+v", input)
	}
	if input.Note == nil || *input.Note != "original" {
		t.Fatalf("draft order inverse note=%v, want original", input.Note)
	}
}
