package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGoAccountingListInvoicesRejectsNonUUIDCustomerBeforeDatabase(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "accounting.read")
	input := json.RawMessage(`{"customerId":"not-a-uuid"}`)
	claims := waveModuleClaims(fx, listInvoicesCapabilityID, "accounting.read", input, "human", "", "list-invoices-invalid-customer")
	result, err := fx.executor.Execute(fx.ctx, claims, listInvoicesCapabilityID, input)
	if err != nil {
		t.Fatalf("listInvoices invalid customerId returned executor error %v; want governed refusal", err)
	}
	if result.OK || !strings.Contains(result.Error, "customerId must be a UUID") {
		t.Fatalf("listInvoices invalid customerId result=%+v, want refusal naming customerId", result)
	}

	validInput := json.RawMessage(`{"customerId":"11111111-2222-4333-8444-555555555555"}`)
	validClaims := waveModuleClaims(fx, listInvoicesCapabilityID, "accounting.read", validInput, "human", "", "list-invoices-valid-customer")
	valid, err := fx.executor.Execute(fx.ctx, validClaims, listInvoicesCapabilityID, validInput)
	if err != nil || !valid.OK {
		t.Fatalf("listInvoices valid customerId result=%+v err=%v", valid, err)
	}
}
