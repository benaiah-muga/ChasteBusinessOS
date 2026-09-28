package capability

import "testing"

func TestCommerceCapabilitiesHaveConsistentGovernance(t *testing.T) {
	cases := []struct {
		id         string
		permission string
		module     string
		risk       string
		threshold  int64
	}{
		{submitExpenseClaimCapabilityID, "expenses.submit", "accounting", "write", 0},
		{decideExpenseClaimCapabilityID, "expenses.decide", "accounting", "write", 0},
		{payExpenseClaimCapabilityID, "accounting.post", "accounting", "money", 50_000},
		{listExpenseClaimsCapabilityID, "expenses.decide", "accounting", "read", 0},
		{createVendorCapabilityID, "purchasing.write", "purchasing", "write", 0},
		{createPurchaseOrderCapabilityID, "purchasing.write", "purchasing", "write", 0},
		{createBillCapabilityID, "purchasing.write", "purchasing", "write", 0},
		{payBillCapabilityID, "purchasing.post", "purchasing", "money", 50_000},
		{reverseVendorPaymentCapabilityID, "purchasing.post", "purchasing", "money", 0},
		{inventoryAdjustStockCapabilityID, "inventory.write", "inventory", "write", 0},
		{inventoryCreateTransferCapabilityID, "inventory.write", "inventory", "write", 0},
		{inventoryConfirmTransferCapabilityID, "inventory.write", "inventory", "write", 0},
		{inventoryCancelTransferCapabilityID, "inventory.write", "inventory", "write", 0},
		{inventoryReverseTransferCapabilityID, "inventory.write", "inventory", "write", 0},
		{inventoryListTransfersCapabilityID, "inventory.read", "inventory", "read", 0},
		{posOpenSessionCapabilityID, "pos.write", "pos", "write", 0},
		{posCompleteSaleCapabilityID, "pos.sell", "pos", "money", 100_000},
		{posCloseSessionCapabilityID, "pos.write", "pos", "write", 0},
		{posReturnSaleCapabilityID, "pos.sell", "pos", "money", 0},
		{posShiftSummaryCapabilityID, "pos.read", "pos", "read", 0},
	}

	for _, test := range cases {
		t.Run(test.id, func(t *testing.T) {
			if !supportedCapability(test.id) {
				t.Fatal("capability is not supported by the executor")
			}
			spec, ok := capabilitySpecs[test.id]
			if !ok {
				t.Fatal("capability has no executor specification")
			}
			if spec.permission != test.permission || spec.module != test.module || spec.risk != test.risk || spec.moneyThresholdMinor != test.threshold {
				t.Fatalf("executor spec = %+v, want permission=%s module=%s risk=%s threshold=%d", spec, test.permission, test.module, test.risk, test.threshold)
			}
			permission, ok := permissionForCapability(test.id)
			if !ok || permission != test.permission {
				t.Fatalf("approval permission = %q, %t, want %q", permission, ok, test.permission)
			}
		})
	}
}

func TestCommerceMoneyAmountUsesExactOrFailClosedValues(t *testing.T) {
	amount, known := moneyAmount(PayExpenseClaimInput{AmountMinor: 50_001})
	if !known || amount == nil || *amount != 50_001 {
		t.Fatalf("expense payment amount = %v, known=%t", amount, known)
	}
	amount, known = moneyAmount(PayBillInput{AmountMinor: 50_000})
	if !known || amount == nil || *amount != 50_000 {
		t.Fatalf("bill payment amount = %v, known=%t", amount, known)
	}
	for name, input := range map[string]any{
		"vendor reversal": ReverseVendorPaymentInput{},
		"POS return":      PosReturnSaleInput{},
	} {
		amount, known = moneyAmount(input)
		if !known || amount != nil {
			t.Errorf("%s amount = %v, known=%t, want unknown amount requiring approval", name, amount, known)
		}
	}
	amount, known = moneyAmount(PosCompleteSaleInput{Lines: []PosSaleLineInput{{Description: "Item", Quantity: 2_000, UnitPriceMinor: 2_500}}})
	if !known || amount == nil || *amount != 5_000 {
		t.Fatalf("POS sale amount = %v, known=%t, want 5000", amount, known)
	}
}
