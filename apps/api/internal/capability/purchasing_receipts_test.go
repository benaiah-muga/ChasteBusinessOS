package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestParseReceiveGoodsInputMirrorsLegacyShape(t *testing.T) {
	input, err := ParseReceiveGoodsInput(json.RawMessage(`{"poNumber":3,"lines":[{"lineNumber":1,"quantity":2500},{"lineNumber":1,"quantity":500,"rejected":1000,"rejectionNote":"wet packaging"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.PONumber != 3 || len(input.Lines) != 2 || input.Lines[0].Rejected != 0 || input.Lines[1].Rejected != 1000 {
		t.Fatalf("parsed receipt input = %+v", input)
	}

	for _, raw := range []string{
		`{"poNumber":0,"lines":[{"lineNumber":1,"quantity":1}]}`,
		`{"poNumber":1,"lines":[]}`,
		`{"poNumber":1,"lines":[{"lineNumber":0,"quantity":1}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":-1}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":1,"rejected":-1}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":1,"rejectionNote":null}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":1}],"overreceiptTolerancePct":11}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":1}],"authorityReason":"short"}`,
	} {
		if _, err := ParseReceiveGoodsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseReceiveGoodsInput accepted %s", raw)
		}
	}
}

func TestPurchasingReceiveGoodsMatchesLegacyAndReplays(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	fx.addAgentSession()
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := mustVendorID(t, fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "RECEIPT-PART", "goods")
	poInput := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Stock part","quantity":10000,"unitPriceMinor":1450,"sku":"RECEIPT-PART"},{"description":"Installation","quantity":4000,"unitPriceMinor":900}]}`, vendorID))
	poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poInput, "human", "", "receipt-po-create")
	poResult, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
	if err != nil || !poResult.OK {
		t.Fatalf("create PO result=%+v err=%v", poResult, err)
	}
	var po CreatePurchaseOrderOutput
	if err := json.Unmarshal(poResult.Data, &po); err != nil {
		t.Fatal(err)
	}

	firstRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":4000},{"lineNumber":1,"quantity":1000,"rejected":1000,"rejectionNote":"wet packaging"},{"lineNumber":2,"quantity":2000}]}`, po.PONumber))
	firstClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", firstRaw, "human", "", "receipt-partial")
	firstResult, err := fx.executor.Execute(fx.ctx, firstClaims, receiveGoodsCapabilityID, firstRaw)
	if err != nil || !firstResult.OK {
		t.Fatalf("partial receipt result=%+v err=%v", firstResult, err)
	}
	var first ReceiveGoodsOutput
	if err := json.Unmarshal(firstResult.Data, &first); err != nil || !first.Received || first.FullyReceived || first.ReceiptNumber != 1 {
		t.Fatalf("partial receipt output=%s err=%v", firstResult.Data, err)
	}
	replay, err := fx.executor.Execute(fx.ctx, firstClaims, receiveGoodsCapabilityID, firstRaw)
	var replayed ReceiveGoodsOutput
	if decodeErr := json.Unmarshal(replay.Data, &replayed); err == nil {
		err = decodeErr
	}
	if err != nil || !replay.OK || !replay.Replayed || replayed != first {
		t.Fatalf("receipt replay=%+v output=%+v err=%v", replay, replayed, err)
	}

	secondRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":3000,"rejected":1000,"rejectionNote":"cracked casing"},{"lineNumber":2,"quantity":2000}]}`, po.PONumber))
	secondClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", secondRaw, "human", "", "receipt-final")
	second, err := fx.executor.Execute(fx.ctx, secondClaims, receiveGoodsCapabilityID, secondRaw)
	var final ReceiveGoodsOutput
	if decodeErr := json.Unmarshal(second.Data, &final); err == nil {
		err = decodeErr
	}
	if err != nil || !second.OK || !final.FullyReceived || final.ReceiptNumber != 2 {
		t.Fatalf("final receipt=%+v output=%+v err=%v", second, final, err)
	}
	var poStatus string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM purchase_orders WHERE org_id=$1::uuid AND number=$2`, fx.orgID, po.PONumber).Scan(&poStatus); err != nil || poStatus != "received" {
		t.Fatalf("purchase order status=%q err=%v, want received", poStatus, err)
	}
	var accepted, rejected, receiptLines, serviceAccepted int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT SUM(grl.accepted_thousandths) FILTER (WHERE pl.item_id IS NOT NULL),
		       SUM(grl.rejected_thousandths) FILTER (WHERE pl.item_id IS NOT NULL), count(*),
		       (SELECT service_accepted_thousandths FROM po_lines WHERE po_id=(SELECT id FROM purchase_orders WHERE org_id=$1::uuid AND number=$2) AND position=2)
		FROM goods_receipt_lines grl JOIN po_lines pl ON pl.id=grl.po_line_id WHERE grl.org_id=$1::uuid`, fx.orgID, po.PONumber).Scan(&accepted, &rejected, &receiptLines, &serviceAccepted); err != nil {
		t.Fatal(err)
	}
	if accepted != 8000 || rejected != 2000 || receiptLines != 4 || serviceAccepted != 4000 {
		t.Fatalf("receipt totals item accepted=%d item rejected=%d lines=%d service accepted=%d", accepted, rejected, receiptLines, serviceAccepted)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid AND ref_type='goods_receipt_line' AND reason='purchase' AND unit_cost_minor=1450`, fx.orgID, itemID); got != 2 {
		t.Fatalf("stock movements=%d, want one per accepted receipt line", got)
	}
	if got := fx.count(`SELECT count(*) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid AND quantity=8000`, fx.orgID, itemID); got != 1 {
		t.Fatalf("stock balance projections=%d, want 8000 accepted thousandths", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":receipt-partial"); got != 1 {
		t.Fatalf("receipt action receipts=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, receiveGoodsCapabilityID); got != 2 {
		t.Fatalf("receipt audit events=%d, want one per successful receipt", got)
	}

	zeroRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":0}]}`, po.PONumber))
	zeroClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", zeroRaw, "human", "", "receipt-zero-rejected")
	if _, err := fx.executor.Execute(fx.ctx, zeroClaims, receiveGoodsCapabilityID, zeroRaw); err == nil || !strings.Contains(err.Error(), "must accept or reject") {
		t.Fatalf("zero receipt error=%v, want 0/0 rejection", err)
	}
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO purchase_orders (org_id,vendor_id,number,status,ordered_at) VALUES ($1::uuid,$2::uuid,737,'ordered',now())`, fx.otherOrgID, foreignVendorID); err != nil {
		t.Fatal(err)
	}
	foreignRaw := json.RawMessage(`{"poNumber":737,"lines":[{"lineNumber":1,"quantity":1000}]}`)
	foreignClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", foreignRaw, "human", "", "receipt-foreign-order")
	if _, err := fx.executor.Execute(fx.ctx, foreignClaims, receiveGoodsCapabilityID, foreignRaw); err == nil || err.Error() != "purchase order not found" {
		t.Fatalf("cross-tenant receipt error=%v, want purchase order not found", err)
	}
}

func TestPurchasingReceiveGoodsRequiresPairedOverreceiptAuthority(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	fx.addAgentSession()
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := mustVendorID(t, fx)
	seedSalesItem(t, fx, fx.orgID, "RECEIPT-OVER", "goods")
	poInput := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Stock part","quantity":10000,"unitPriceMinor":200,"sku":"RECEIPT-OVER"}]}`, vendorID))
	poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poInput, "human", "", "overreceipt-po-create")
	created, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
	if err != nil || !created.OK {
		t.Fatalf("create PO result=%+v err=%v", created, err)
	}
	var po CreatePurchaseOrderOutput
	if err := json.Unmarshal(created.Data, &po); err != nil {
		t.Fatal(err)
	}
	baseRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":10000}]}`, po.PONumber))
	baseClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", baseRaw, "human", "", "overreceipt-base")
	if result, err := fx.executor.Execute(fx.ctx, baseClaims, receiveGoodsCapabilityID, baseRaw); err != nil || !result.OK {
		t.Fatalf("base receipt result=%+v err=%v", result, err)
	}
	unauthorizedRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":1000}]}`, po.PONumber))
	unauthorizedClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", unauthorizedRaw, "human", "", "overreceipt-unauthorized")
	if _, err := fx.executor.Execute(fx.ctx, unauthorizedClaims, receiveGoodsCapabilityID, unauthorizedRaw); err == nil || !strings.Contains(err.Error(), "overreceipt needs explicit authority") {
		t.Fatalf("unauthorized overreceipt error=%v, want authority refusal", err)
	}
	overRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":1000}],"overreceiptTolerancePct":10,"authorityReason":"Site manager approved overdelivery"}`, po.PONumber))
	overClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", overRaw, "human", "", "overreceipt-authorized")
	result, err := fx.executor.Execute(fx.ctx, overClaims, receiveGoodsCapabilityID, overRaw)
	var output ReceiveGoodsOutput
	if decodeErr := json.Unmarshal(result.Data, &output); err == nil {
		err = decodeErr
	}
	if err != nil || !result.OK || !output.FullyReceived || output.ReceiptNumber != 2 {
		t.Fatalf("authorized overreceipt=%+v output=%+v err=%v", result, output, err)
	}
	var note string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT note FROM goods_receipts WHERE org_id=$1::uuid AND number=2`, fx.orgID).Scan(&note); err != nil || note != "Overreceipt authorized: Site manager approved overdelivery" {
		t.Fatalf("authorized receipt note=%q err=%v", note, err)
	}
}

func TestPurchasingReceiveGoodsUsesGovernedApprovalPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	fx.addAgentSession()
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := mustVendorID(t, fx)
	poRaw := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Service milestone","quantity":1000,"unitPriceMinor":100}]}`, vendorID))
	poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poRaw, "human", "", "receipt-approval-po")
	created, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poRaw)
	if err != nil || !created.OK {
		t.Fatalf("create PO result=%+v err=%v", created, err)
	}
	var po CreatePurchaseOrderOutput
	if err := json.Unmarshal(created.Data, &po); err != nil {
		t.Fatal(err)
	}
	fx.addPolicy(receiveGoodsCapabilityID, "read", nil)
	receiptRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":1000,"rejected":0}]}`, po.PONumber))
	result := approveModuleWrite(t, fx, receiveGoodsCapabilityID, "purchasing.write", receiptRaw)
	var receipt ReceiveGoodsOutput
	if err := json.Unmarshal(result.Data, &receipt); err != nil || !result.OK || !receipt.Received || !receipt.FullyReceived {
		t.Fatalf("approved receipt result=%+v output=%+v err=%v", result, receipt, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, receiveGoodsCapabilityID); got != 1 {
		t.Fatalf("receipt approval audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, receiveGoodsCapabilityID); got != 1 {
		t.Fatalf("approved receipt execution audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM goods_receipts WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("approved goods receipts=%d, want one", got)
	}
}

func mustVendorID(t *testing.T, fx *executorFixture) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO vendors (org_id,name) VALUES ($1::uuid,'Receipt fixture vendor') RETURNING id::text`, fx.orgID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
