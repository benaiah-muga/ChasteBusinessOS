package jobs

import "testing"

func TestCommerceWorkerPermissionsAreLeastPrivilege(t *testing.T) {
	want := map[string]string{
		"crm.listCustomerViews":           "crm.read",
		"accounting.decideExpenseClaim":   "expenses.decide",
		"accounting.payExpenseClaim":      "accounting.post",
		"accounting.listExpenseClaims":    "expenses.decide",
		"accounting.listExpensePolicies":  "expenses.decide",
		"accounting.setExpensePolicy":     "expenses.decide",
		"purchasing.createVendor":         "purchasing.write",
		"purchasing.createPurchaseOrder":  "purchasing.write",
		"purchasing.receiveGoods":         "purchasing.write",
		"purchasing.createBill":           "purchasing.write",
		"purchasing.payBill":              "purchasing.post",
		"purchasing.reverseVendorPayment": "purchasing.post",
		"inventory.adjustStock":           "inventory.write",
		"inventory.createTransfer":        "inventory.write",
		"inventory.confirmTransfer":       "inventory.write",
		"inventory.cancelTransfer":        "inventory.write",
		"inventory.reverseTransfer":       "inventory.write",
		"inventory.listTransfers":         "inventory.read",
		"inventory.createCycleCount":      "inventory.write",
		"inventory.recordCycleCounts":     "inventory.write",
		"inventory.postCycleCount":        "inventory.write",
		"inventory.cancelCycleCount":      "inventory.write",
		"pos.openSession":                 "pos.write",
		"pos.completeSale":                "pos.sell",
		"pos.closeSession":                "pos.write",
		"pos.returnSale":                  "pos.sell",
		"pos.shiftSummary":                "pos.read",
	}
	for id, permission := range want {
		if got, ok := GoCapabilityPermissions[id]; !ok || got != permission {
			t.Errorf("worker permission for %s = %q, %t, want %q", id, got, ok, permission)
		}
	}
	if got := len(GoCapabilityPermissions); got < len(want) {
		t.Fatalf("worker allowlist has %d capabilities, expected at least %d", got, len(want))
	}
	for _, id := range []string{"accounting.submitExpenseClaim", "documents.parseDocument", "routines.executeRoutine"} {
		if _, ok := GoCapabilityPermissions[id]; ok {
			t.Errorf("unsupported system capability %s leaked into Go worker allowlist", id)
		}
	}
}
