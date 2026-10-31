package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestParseReturnGoodsInputMatchesLegacyContract(t *testing.T) {
	input, err := ParseReturnGoodsInput(json.RawMessage(`{"poNumber":12,"receiptNumber":4,"lines":[{"lineNumber":1,"quantity":250,"reason":"damaged"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.PONumber != 12 || input.ReceiptNumber == nil || *input.ReceiptNumber != 4 || len(input.Lines) != 1 || input.Lines[0].Reason != "damaged" {
		t.Fatalf("parsed return input = %+v", input)
	}
	if _, err := ParseReturnGoodsInput(json.RawMessage(`{"poNumber":2147483647,"receiptNumber":2147483647,"lines":[{"lineNumber":2147483647,"quantity":2147483647,"reason":"valid"}]}`)); err != nil {
		t.Fatalf("parser rejected MaxInt32 boundary: %v", err)
	}
	for _, raw := range []string{
		`{"poNumber":0,"lines":[{"lineNumber":1,"quantity":1,"reason":"valid"}]}`,
		`{"poNumber":1,"receiptNumber":0,"lines":[{"lineNumber":1,"quantity":1,"reason":"valid"}]}`,
		`{"poNumber":1,"lines":[]}`,
		`{"poNumber":1,"lines":[{"lineNumber":0,"quantity":1,"reason":"valid"}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":0,"reason":"valid"}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":1,"reason":"no"}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":1,"reason":null}]}`,
		`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":2147483647,"reason":"valid"},{"lineNumber":1,"quantity":1,"reason":"valid"}]}`,
	} {
		if _, err := ParseReturnGoodsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseReturnGoodsInput accepted %s", raw)
		}
	}
}

func TestPurchasingReturnGoodsAllocatesByReceiptNumberAndHonorsReceiptScope(t *testing.T) {
	t.Run("oldest receipt first", func(t *testing.T) {
		fx := newExecutorFixture(t)
		cleanupPurchasingBillsFixture(t, fx)
		grantWavePermission(t, fx, "purchasing.write")
		vendorID := mustVendorID(t, fx)
		itemID := seedSalesItem(t, fx, fx.orgID, "RETURN-ORDERED-RECEIPTS", "goods")
		poInput := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Stock part","quantity":10000,"unitPriceMinor":100,"sku":"RETURN-ORDERED-RECEIPTS"}]}`, vendorID))
		poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poInput, "human", "", "return-order-po")
		created, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
		if err != nil || !created.OK {
			t.Fatalf("create PO result=%+v err=%v", created, err)
		}
		var po CreatePurchaseOrderOutput
		if err := json.Unmarshal(created.Data, &po); err != nil {
			t.Fatal(err)
		}
		for index, qty := range []int{4000, 6000} {
			raw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":%d}]}`, po.PONumber, qty))
			claims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", raw, "human", "", fmt.Sprintf("return-order-receipt-%d", index))
			if result, err := fx.executor.Execute(fx.ctx, claims, receiveGoodsCapabilityID, raw); err != nil || !result.OK {
				t.Fatalf("receipt %d result=%+v err=%v", index+1, result, err)
			}
		}
		returnRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":5000,"reason":"excess stock"}]}`, po.PONumber))
		claims := waveModuleClaims(fx, returnGoodsCapabilityID, "purchasing.write", returnRaw, "human", "", "return-ordered-allocation")
		if result, err := fx.executor.Execute(fx.ctx, claims, returnGoodsCapabilityID, returnRaw); err != nil || !result.OK {
			t.Fatalf("return result=%+v err=%v", result, err)
		}
		var returnedOnFirst, returnedOnSecond int64
		if err := fx.owner.QueryRow(fx.ctx, `SELECT returned_thousandths FROM goods_receipt_lines WHERE org_id=$1::uuid AND receipt_id=(SELECT id FROM goods_receipts WHERE org_id=$1::uuid AND po_id=(SELECT id FROM purchase_orders WHERE org_id=$1::uuid AND number=$2) AND number=1)`, fx.orgID, po.PONumber).Scan(&returnedOnFirst); err != nil {
			t.Fatal(err)
		}
		if err := fx.owner.QueryRow(fx.ctx, `SELECT returned_thousandths FROM goods_receipt_lines WHERE org_id=$1::uuid AND receipt_id=(SELECT id FROM goods_receipts WHERE org_id=$1::uuid AND po_id=(SELECT id FROM purchase_orders WHERE org_id=$1::uuid AND number=$2) AND number=2)`, fx.orgID, po.PONumber).Scan(&returnedOnSecond); err != nil {
			t.Fatal(err)
		}
		if returnedOnFirst != 4000 || returnedOnSecond != 1000 {
			t.Fatalf("receipt return allocation = [%d, %d], want [4000, 1000]", returnedOnFirst, returnedOnSecond)
		}
		if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid AND quantity_delta=-5000 AND reason='purchase'`, fx.orgID, itemID); got != 1 {
			t.Fatalf("vendor return movements=%d, want one", got)
		}
	})

	t.Run("explicit receipt cannot fall through to PO history", func(t *testing.T) {
		fx := newExecutorFixture(t)
		cleanupPurchasingBillsFixture(t, fx)
		grantWavePermission(t, fx, "purchasing.write")
		vendorID := mustVendorID(t, fx)
		seedSalesItem(t, fx, fx.orgID, "RETURN-RECEIPT-SCOPE-A", "goods")
		seedSalesItem(t, fx, fx.orgID, "RETURN-RECEIPT-SCOPE-B", "goods")
		poInput := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"First","quantity":1000,"unitPriceMinor":100,"sku":"RETURN-RECEIPT-SCOPE-A"},{"description":"Second","quantity":1000,"unitPriceMinor":100,"sku":"RETURN-RECEIPT-SCOPE-B"}]}`, vendorID))
		poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poInput, "human", "", "return-scope-po")
		created, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
		if err != nil || !created.OK {
			t.Fatalf("create PO result=%+v err=%v", created, err)
		}
		var po CreatePurchaseOrderOutput
		if err := json.Unmarshal(created.Data, &po); err != nil {
			t.Fatal(err)
		}
		receiptRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":1000}]}`, po.PONumber))
		receiptClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", receiptRaw, "human", "", "return-scope-receipt")
		if result, err := fx.executor.Execute(fx.ctx, receiptClaims, receiveGoodsCapabilityID, receiptRaw); err != nil || !result.OK {
			t.Fatalf("receipt result=%+v err=%v", result, err)
		}
		receiptTwoRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":2,"quantity":1000}]}`, po.PONumber))
		receiptTwoClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", receiptTwoRaw, "human", "", "return-scope-receipt-two")
		if result, err := fx.executor.Execute(fx.ctx, receiptTwoClaims, receiveGoodsCapabilityID, receiptTwoRaw); err != nil || !result.OK {
			t.Fatalf("second receipt result=%+v err=%v", result, err)
		}
		returnRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"receiptNumber":1,"lines":[{"lineNumber":2,"quantity":1000,"reason":"wrong receipt"}]}`, po.PONumber))
		returnClaims := waveModuleClaims(fx, returnGoodsCapabilityID, "purchasing.write", returnRaw, "human", "", "return-scope-attempt")
		if _, err := fx.executor.Execute(fx.ctx, returnClaims, returnGoodsCapabilityID, returnRaw); err == nil || !strings.Contains(err.Error(), "has no received quantity available") {
			t.Fatalf("scoped return error=%v", err)
		}
		if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND reason='purchase' AND quantity_delta<0`, fx.orgID); got != 0 {
			t.Fatalf("failed scoped return changed %d stock movements", got)
		}
	})
}

func TestPurchasingReturnGoodsAllocatesReceiptStockAndReplays(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := mustVendorID(t, fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "RETURN-PART", "goods")
	poInput := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Stock part","quantity":10000,"unitPriceMinor":1450,"sku":"RETURN-PART"}]}`, vendorID))
	poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poInput, "human", "", "return-po-create")
	created, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
	if err != nil || !created.OK {
		t.Fatalf("create PO result=%+v err=%v", created, err)
	}
	var po CreatePurchaseOrderOutput
	if err := json.Unmarshal(created.Data, &po); err != nil {
		t.Fatal(err)
	}
	receiptRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":10000}]}`, po.PONumber))
	receiptClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", receiptRaw, "human", "", "return-receipt")
	receipt, err := fx.executor.Execute(fx.ctx, receiptClaims, receiveGoodsCapabilityID, receiptRaw)
	if err != nil || !receipt.OK {
		t.Fatalf("receive PO result=%+v err=%v", receipt, err)
	}

	returnRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"receiptNumber":1,"lines":[{"lineNumber":1,"quantity":1000,"reason":"damaged carton"},{"lineNumber":1,"quantity":1000,"reason":"wrong finish"}]}`, po.PONumber))
	claims := waveModuleClaims(fx, returnGoodsCapabilityID, "purchasing.write", returnRaw, "human", "", "return-goods-once")
	result, err := fx.executor.Execute(fx.ctx, claims, returnGoodsCapabilityID, returnRaw)
	var output ReturnGoodsOutput
	if decodeErr := json.Unmarshal(result.Data, &output); err == nil {
		err = decodeErr
	}
	if err != nil || !result.OK || !output.Returned || output.Lines != 2 {
		t.Fatalf("return result=%+v output=%+v err=%v", result, output, err)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, returnGoodsCapabilityID, returnRaw)
	var replayOutput ReturnGoodsOutput
	if decodeErr := json.Unmarshal(replay.Data, &replayOutput); err == nil {
		err = decodeErr
	}
	if err != nil || !replay.OK || !replay.Replayed || replayOutput != output {
		t.Fatalf("return replay=%+v output=%+v err=%v", replay, replayOutput, err)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid AND quantity_delta=-2000 AND reason='purchase' AND ref_type='goods_receipt_line' AND unit_cost_minor=1450`, fx.orgID, itemID); got != 1 {
		t.Fatalf("vendor return movements=%d, want one aggregated movement", got)
	}
	if got := fx.count(`SELECT count(*) FROM goods_receipt_lines WHERE org_id=$1::uuid AND returned_thousandths=2000`, fx.orgID); got != 1 {
		t.Fatalf("returned receipt lines=%d, want one line with 2000 returned", got)
	}
	if got := fx.count(`SELECT count(*) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid AND quantity=8000`, fx.orgID, itemID); got != 1 {
		t.Fatalf("stock balance=%d rows at 8000, want one", got)
	}
	var status string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM purchase_orders WHERE org_id=$1::uuid AND number=$2`, fx.orgID, po.PONumber).Scan(&status); err != nil || status != "partial" {
		t.Fatalf("purchase order status=%q err=%v, want partial", status, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, returnGoodsCapabilityID); got != 1 {
		t.Fatalf("return audit events=%d, want one", got)
	}

	tooMuch := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":9000,"reason":"exceeds received"}]}`, po.PONumber))
	tooMuchClaims := waveModuleClaims(fx, returnGoodsCapabilityID, "purchasing.write", tooMuch, "human", "", "return-goods-too-much")
	if _, err := fx.executor.Execute(fx.ctx, tooMuchClaims, returnGoodsCapabilityID, tooMuch); err == nil || !strings.Contains(err.Error(), "only 8000 thousandths were received") {
		t.Fatalf("excess return error=%v, want remaining accepted quantity refusal", err)
	}
}

func TestPurchasingReturnGoodsRejectsForeignReceiptAndConsumedStock(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := mustVendorID(t, fx)
	itemID := seedSalesItem(t, fx, fx.orgID, "RETURN-CONSUMED", "goods")
	poInput := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Stock part","quantity":3000,"unitPriceMinor":1450,"sku":"RETURN-CONSUMED"}]}`, vendorID))
	poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poInput, "human", "", "return-guard-po")
	created, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
	if err != nil || !created.OK {
		t.Fatalf("create PO result=%+v err=%v", created, err)
	}
	var po CreatePurchaseOrderOutput
	if err := json.Unmarshal(created.Data, &po); err != nil {
		t.Fatal(err)
	}
	receiptRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":3000}]}`, po.PONumber))
	receiptClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", receiptRaw, "human", "", "return-guard-receipt")
	if result, err := fx.executor.Execute(fx.ctx, receiptClaims, receiveGoodsCapabilityID, receiptRaw); err != nil || !result.OK {
		t.Fatalf("receive PO result=%+v err=%v", result, err)
	}

	wrongReceipt := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"receiptNumber":99,"lines":[{"lineNumber":1,"quantity":1000,"reason":"wrong receipt"}]}`, po.PONumber))
	wrongClaims := waveModuleClaims(fx, returnGoodsCapabilityID, "purchasing.write", wrongReceipt, "human", "", "return-wrong-receipt")
	if _, err := fx.executor.Execute(fx.ctx, wrongClaims, returnGoodsCapabilityID, wrongReceipt); err == nil || !strings.Contains(err.Error(), "does not belong to order") {
		t.Fatalf("wrong receipt error=%v", err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO stock_movements (org_id,item_id,quantity_delta,reason,actor_type) VALUES ($1::uuid,$2::uuid,-2500,'sale','human')`, fx.orgID, itemID); err != nil {
		t.Fatal(err)
	}
	consumed := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":1000,"reason":"supplier return"}]}`, po.PONumber))
	consumedClaims := waveModuleClaims(fx, returnGoodsCapabilityID, "purchasing.write", consumed, "human", "", "return-consumed-stock")
	if _, err := fx.executor.Execute(fx.ctx, consumedClaims, returnGoodsCapabilityID, consumed); err == nil || !strings.Contains(err.Error(), "only 500 thousandths") {
		t.Fatalf("consumed stock return error=%v", err)
	}
	if got := fx.count(`SELECT count(*) FROM goods_receipt_lines WHERE org_id=$1::uuid AND returned_thousandths<>0`, fx.orgID); got != 0 {
		t.Fatalf("failed return changed %d receipt lines", got)
	}
}

func TestPurchasingReturnGoodsUsesGovernedApprovalPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	fx.addAgentSession()
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := mustVendorID(t, fx)
	seedSalesItem(t, fx, fx.orgID, "RETURN-APPROVAL", "goods")
	poInput := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Stock part","quantity":2000,"unitPriceMinor":900,"sku":"RETURN-APPROVAL"}]}`, vendorID))
	poClaims := waveModuleClaims(fx, createPurchaseOrderCapabilityID, "purchasing.write", poInput, "human", "", "return-approval-po")
	created, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
	if err != nil || !created.OK {
		t.Fatalf("create PO result=%+v err=%v", created, err)
	}
	var po CreatePurchaseOrderOutput
	if err := json.Unmarshal(created.Data, &po); err != nil {
		t.Fatal(err)
	}
	receiptRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":2000}]}`, po.PONumber))
	receiptClaims := waveModuleClaims(fx, receiveGoodsCapabilityID, "purchasing.write", receiptRaw, "human", "", "return-approval-receipt")
	if result, err := fx.executor.Execute(fx.ctx, receiptClaims, receiveGoodsCapabilityID, receiptRaw); err != nil || !result.OK {
		t.Fatalf("receive PO result=%+v err=%v", result, err)
	}
	fx.addPolicy(returnGoodsCapabilityID, "read", nil)
	returnRaw := json.RawMessage(fmt.Sprintf(`{"poNumber":%d,"lines":[{"lineNumber":1,"quantity":1000,"reason":"quality concern"}]}`, po.PONumber))
	result := approveModuleWrite(t, fx, returnGoodsCapabilityID, "purchasing.write", returnRaw)
	var output ReturnGoodsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || !result.OK || !output.Returned {
		t.Fatalf("approved return result=%+v output=%+v err=%v", result, output, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, returnGoodsCapabilityID); got != 1 {
		t.Fatalf("return approval audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, returnGoodsCapabilityID); got != 1 {
		t.Fatalf("approved return execution events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND reason='purchase' AND quantity_delta=-1000`, fx.orgID); got != 1 {
		t.Fatalf("approved return stock movements=%d, want one", got)
	}
}
