package capability

import (
	"encoding/json"
	"testing"
)

func TestInventoryStockAdjustmentGovernedExecutorApprovalParity(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "inventory.write")
	itemID := seedSalesItem(t, fx, fx.orgID, "SKU-EXEC-ADJUST", "goods")
	foreignItemID := seedSalesItem(t, fx, fx.otherOrgID, "SKU-EXEC-ADJUST", "goods")
	seedInventoryStockAt(t, fx, fx.otherOrgID, foreignItemID, "", 9000)
	seedInventoryStockLocation(t, fx, fx.orgID, "WH-EXEC-ADJUST", "Executor adjustment warehouse")
	fx.addAgentSession()
	fx.addPolicy(inventoryAdjustStockCapabilityID, "read", nil)

	input := json.RawMessage(`{"sku":"SKU-EXEC-ADJUST","quantityDelta":5000,"note":"Verified opening count","lotCode":"LOT-EXEC-ADJUST","locationCode":"WH-EXEC-ADJUST"}`)
	pending, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryAdjustStockCapabilityID, "inventory.write", input, "agent", fx.agentSession, "inventory-adjust-approval"),
		inventoryAdjustStockCapabilityID,
		input,
	)
	if err != nil || pending.OK || !pending.PendingApproval {
		t.Fatalf("agent stock adjustment result=%+v err=%v, want pending approval", pending, err)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, itemID); got != 0 {
		t.Fatalf("pending stock adjustment created %d movements, want zero", got)
	}

	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals
		WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'`,
		fx.orgID, inventoryAdjustStockCapabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	decision, err := decider.Decide(
		fx.ctx,
		waveModuleClaims(fx, inventoryAdjustStockCapabilityID, "inventory.write", input, "human", "", ""),
		ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"},
	)
	if err != nil || !decision.OK || decision.Status != "executed" || decision.Result == nil || !decision.Result.OK {
		t.Fatalf("stock adjustment approval result=%+v err=%v, want one completed execution", decision, err)
	}
	approved := *decision.Result
	var output InventoryAdjustStockOutput
	if err := json.Unmarshal(approved.Data, &output); err != nil {
		t.Fatalf("decode approved adjustment result %s: %v", approved.Data, err)
	}
	if output.OnHandThousandths != 5000 {
		t.Fatalf("approved adjustment output=%+v, want 5000 thousandths on hand", output)
	}

	var quantity int64
	var note, lotCode, locationCode, actorType, actorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT sm.quantity_delta, sm.note, l.lot_code, sl.code, sm.actor_type, sm.actor_id::text
		FROM stock_movements sm
		JOIN lots l ON l.id=sm.lot_id AND l.org_id=sm.org_id
		JOIN stock_locations sl ON sl.id=sm.location_id AND sl.org_id=sm.org_id
		WHERE sm.org_id=$1::uuid AND sm.item_id=$2::uuid AND sm.reason='adjustment'`,
		fx.orgID, itemID).Scan(&quantity, &note, &lotCode, &locationCode, &actorType, &actorID); err != nil {
		t.Fatal(err)
	}
	if quantity != 5000 || note != "Verified opening count" || lotCode != "LOT-EXEC-ADJUST" || locationCode != "WH-EXEC-ADJUST" || actorType != "human" || actorID != fx.userID {
		t.Fatalf("approved stock movement = quantity %d, note %q, lot %q, location %q, actor %s/%s; want approved adjustment details", quantity, note, lotCode, locationCode, actorType, actorID)
	}
	var localBalance, foreignBalance int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements
		WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, itemID).Scan(&localBalance); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements
		WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.otherOrgID, foreignItemID).Scan(&foreignBalance); err != nil {
		t.Fatal(err)
	}
	if localBalance != 5000 || foreignBalance != 9000 {
		t.Fatalf("same-SKU organization balances = local %d, foreign %d; want local 5000, foreign unchanged at 9000", localBalance, foreignBalance)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human' AND actor_id=$3::uuid`, fx.orgID, inventoryAdjustStockCapabilityID, fx.userID); got != 1 {
		t.Fatalf("approved stock adjustment audit events=%d, want one human execution", got)
	}
}
