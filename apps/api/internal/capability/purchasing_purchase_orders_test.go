package capability

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestParseCreatePurchaseOrderInputMirrorsZodDefaults(t *testing.T) {
	input, err := ParseCreatePurchaseOrderInput(json.RawMessage(`{"vendorId":"vendor","lines":[{"description":"Part","quantity":1000,"unitPriceMinor":2500}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.VendorID != "vendor" || len(input.Lines) != 1 || input.Lines[0].ExpenseAccountCode != "6000" || input.Lines[0].SKU != nil {
		t.Fatalf("parsed minimal input = %+v, want default expense account and no item link", input)
	}

	for _, raw := range []string{
		`{"vendorId":"vendor","lines":[]}`,
		`{"vendorId":"vendor","lines":[{"description":"Part","quantity":0,"unitPriceMinor":1}]}`,
		`{"vendorId":"vendor","lines":[{"description":"Part","quantity":1,"unitPriceMinor":-1}]}`,
		`{"vendorId":"vendor","lines":[{"description":"Part","quantity":1,"unitPriceMinor":1,"expenseAccountCode":"60A0"}]}`,
		`{"vendorId":"vendor","lines":[{"description":"Part","quantity":1,"unitPriceMinor":1,"sku":null}]}`,
		`{"vendorId":"vendor","promisedAt":"tomorrow","lines":[{"description":"Part","quantity":1,"unitPriceMinor":1}]}`,
		`{"vendorId":"vendor","promisedAt":"2030-02-03T04:05:06+02:00","lines":[{"description":"Part","quantity":1,"unitPriceMinor":1}]}`,
	} {
		if _, err := ParseCreatePurchaseOrderInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreatePurchaseOrderInput accepted %s", raw)
		}
	}
}

func TestGoPurchaseOrderCreationMatchesLegacyAndReceiptReplay(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	fx.addAgentSession()
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	itemID := seedSalesItem(t, fx, fx.orgID, "PO-CHAIR", "goods")
	promisedAt := "2030-02-03T04:05:06.123456Z"
	raw := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"memo":"Quarterly stock","promisedAt":%q,"lines":[{"description":"Chair frame","quantity":2500,"unitPriceMinor":4500,"sku":"PO-CHAIR"},{"description":"Freight","quantity":1000,"unitPriceMinor":800,"expenseAccountCode":"6100"}]}`, vendorID, promisedAt))
	claims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", raw, "human", "", "go-po-receipt-once")
	result, err := fx.executor.Execute(fx.ctx, claims, createPurchaseOrderCapabilityID, raw)
	if err != nil || !result.OK || result.PendingApproval {
		t.Fatalf("createPurchaseOrder result=%+v err=%v", result, err)
	}
	var created CreatePurchaseOrderOutput
	if err := json.Unmarshal(result.Data, &created); err != nil || created.PONumber != 1 {
		t.Fatalf("createPurchaseOrder output=%s err=%v, want purchase order 1", result.Data, err)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, createPurchaseOrderCapabilityID, raw)
	var replayed CreatePurchaseOrderOutput
	if decodeErr := json.Unmarshal(replay.Data, &replayed); err == nil {
		err = decodeErr
	}
	if err != nil || !replay.OK || !replay.Replayed || replayed != created {
		t.Fatalf("createPurchaseOrder replay=%+v output=%+v err=%v, want stored original result %+v", replay, replayed, err, created)
	}

	var storedVendorID, status, memo string
	var storedPromisedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT vendor_id::text, status, memo, promised_at
		FROM purchase_orders WHERE org_id=$1::uuid AND number=$2`, fx.orgID, created.PONumber).
		Scan(&storedVendorID, &status, &memo, &storedPromisedAt); err != nil {
		t.Fatal(err)
	}
	wantPromisedAt, _ := time.Parse(time.RFC3339Nano, promisedAt)
	if storedVendorID != vendorID || status != "ordered" || memo != "Quarterly stock" || !storedPromisedAt.Equal(wantPromisedAt.Truncate(time.Millisecond)) {
		t.Fatalf("purchase order vendor=%s status=%s memo=%q promisedAt=%s", storedVendorID, status, memo, storedPromisedAt)
	}
	var lineCount, linkedCount, defaultAccountCount, customAccountCount int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*), count(*) FILTER (WHERE item_id=$2::uuid),
		       count(*) FILTER (WHERE position=1 AND expense_account_code='6000'),
		       count(*) FILTER (WHERE position=2 AND expense_account_code='6100')
		FROM po_lines WHERE po_id=(SELECT id FROM purchase_orders WHERE org_id=$1::uuid AND number=$3)`,
		fx.orgID, itemID, created.PONumber).Scan(&lineCount, &linkedCount, &defaultAccountCount, &customAccountCount); err != nil {
		t.Fatal(err)
	}
	if lineCount != 2 || linkedCount != 1 || defaultAccountCount != 1 || customAccountCount != 1 {
		t.Fatalf("purchase order lines count=%d linked=%d default account=%d custom account=%d", lineCount, linkedCount, defaultAccountCount, customAccountCount)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND vendor_id=$2::uuid`, fx.orgID, vendorID); got != 1 {
		t.Fatalf("same-intent replay stored %d purchase orders, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":go-po-receipt-once"); got != 1 {
		t.Fatalf("purchase order receipts=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, createPurchaseOrderCapabilityID); got != 1 {
		t.Fatalf("purchase order execution audit events=%d, want one", got)
	}

	foreignRaw := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Foreign vendor","quantity":1,"unitPriceMinor":1}]}`, foreignVendorID))
	foreignClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", foreignRaw, "human", "", "go-po-foreign-vendor")
	if _, err := fx.executor.Execute(fx.ctx, foreignClaims, createPurchaseOrderCapabilityID, foreignRaw); err == nil || err.Error() != "vendor not found" {
		t.Fatalf("cross-organization vendor error=%v, want tenant-scoped refusal", err)
	}
}
