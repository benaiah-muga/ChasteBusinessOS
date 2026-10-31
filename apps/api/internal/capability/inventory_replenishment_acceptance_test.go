package capability

import (
	"encoding/json"
	"testing"
	"time"
)

// TestInventoryReplenishmentAcceptance proves the first complete operating
// loop: plan from live records, prepare an approval-gated commitment, approve
// it, receive the goods, verify the order, and show that the next plan no
// longer needs to reorder the item.
func TestInventoryReplenishmentAcceptance(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	for _, permission := range []string{"inventory.read", "purchasing.read", "purchasing.write"} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO role_permissions (role_id, permission_key, org_id)
			VALUES ($1::uuid, $2, $3::uuid)`, fx.roleID, permission, fx.orgID); err != nil {
			t.Fatal(err)
		}
	}
	itemID := seedReplenishmentItem(t, fx, fx.orgID, "ACCEPT-1", "Acceptance cement", 10_000)
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Acceptance supplier')
		RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	seedReplenishmentMovement(t, fx, fx.orgID, itemID, 20_000, "purchase", int64Pointer(500), now.AddDate(0, 0, -40))
	for day := 0; day < 30; day++ {
		seedReplenishmentMovement(t, fx, fx.orgID, itemID, -500, "sale", nil, now.AddDate(0, 0, -day))
	}

	planInput := json.RawMessage(`{"sku":"ACCEPT-1","lookbackDays":30,"reviewDays":7,"leadTimeDays":14}`)
	planClaims := fx.claims(planInput, "agent", fx.agentSession, executorUUID(t))
	planClaims.CapabilityID = inventoryReplenishmentPlanCapabilityID
	planClaims.Permissions = []string{"inventory.read"}
	planned, err := fx.executor.Execute(fx.ctx, planClaims, inventoryReplenishmentPlanCapabilityID, planInput)
	if err != nil {
		t.Fatal(err)
	}
	if !planned.OK {
		t.Fatalf("planner refused: %s", planned.Error)
	}
	var plan InventoryReplenishmentPlanOutput
	if err := json.Unmarshal(planned.Data, &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 1 || plan.Items[0].SuggestedOrderQtyThousandths <= 0 {
		t.Fatalf("plan=%+v, want one item with a positive suggestion", plan)
	}
	suggested := plan.Items[0].SuggestedOrderQtyThousandths
	unitPrice := plan.Items[0].EstimatedUnitCostMinor

	poInput := json.RawMessage(`{"vendorId":"` + vendorID + `","memo":"Acceptance replenishment","lines":[{"description":"Acceptance cement","quantity":` +
		jsonInt(suggested) + `,"unitPriceMinor":` + jsonInt(unitPrice) + `,"sku":"ACCEPT-1"}]}`)
	poClaims := fx.claims(poInput, "agent", fx.agentSession, executorUUID(t))
	poClaims.CapabilityID = createPurchaseOrderCapabilityID
	poClaims.Permissions = []string{"purchasing.write"}
	pending, err := fx.executor.Execute(fx.ctx, poClaims, createPurchaseOrderCapabilityID, poInput)
	if err != nil {
		t.Fatal(err)
	}
	if !pending.PendingApproval || pending.ApprovalID == "" {
		t.Fatalf("proposal result=%+v, want a pending approval", pending)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("proposal wrote %d orders before approval, want zero", got)
	}

	var approvalPayload json.RawMessage
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT payload FROM approvals WHERE id=$1::uuid AND org_id=$2::uuid`, pending.ApprovalID, fx.orgID).Scan(&approvalPayload); err != nil {
		t.Fatal(err)
	}
	approvalDigest, err := InputHash(approvalPayload)
	if err != nil {
		t.Fatal(err)
	}
	approvalClaims := fx.humanClaims(poInput, "acceptance-approve")
	approvalClaims.CapabilityID = createPurchaseOrderCapabilityID
	approvalClaims.InputSHA256 = approvalDigest
	approvalClaims.Permissions = []string{"purchasing.write"}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	decision, err := decider.Decide(fx.ctx, approvalClaims, ApprovalDecisionInput{ApprovalID: pending.ApprovalID, Decision: "approve"})
	if err != nil {
		t.Fatal(err)
	}
	if !decision.OK || decision.Status != "executed" || decision.Result == nil || !decision.Result.OK {
		t.Fatalf("decision=%+v, want an executed approval with a result", decision)
	}
	var created CreatePurchaseOrderOutput
	if err := json.Unmarshal(decision.Result.Data, &created); err != nil {
		t.Fatal(err)
	}
	if created.PONumber <= 0 {
		t.Fatalf("created order=%+v, want a purchase order number", created)
	}

	orderInput := json.RawMessage(`{"poNumber":` + jsonInt(created.PONumber) + `}`)
	orderClaims := fx.humanClaims(orderInput, "acceptance-order-"+executorUUID(t))
	orderClaims.CapabilityID = purchasingGetPurchaseOrderCapabilityID
	orderClaims.Permissions = []string{"purchasing.read"}
	ordered, err := fx.executor.Execute(fx.ctx, orderClaims, purchasingGetPurchaseOrderCapabilityID, orderInput)
	if err != nil {
		t.Fatal(err)
	}
	if !ordered.OK {
		t.Fatalf("purchase order read refused: %s", ordered.Error)
	}
	var order PurchasingPurchaseOrderOutput
	if err := json.Unmarshal(ordered.Data, &order); err != nil {
		t.Fatal(err)
	}
	if order.Status != "ordered" || order.FullyReceived || len(order.Lines) != 1 || order.Lines[0].RemainingThousandths != suggested {
		t.Fatalf("order=%+v, want one open line of %d thousandths", order, suggested)
	}
	wantTotal, err := inventoryJsRoundProductDiv(suggested, unitPrice, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if order.TotalMinor != wantTotal {
		t.Fatalf("order total=%d, want %d from %d thousandths at %d minor", order.TotalMinor, wantTotal, suggested, unitPrice)
	}

	receiptInput := json.RawMessage(`{"poNumber":` + jsonInt(created.PONumber) + `,"lines":[{"lineNumber":1,"quantity":` + jsonInt(suggested) + `}]}`)
	receiptClaims := fx.humanClaims(receiptInput, "acceptance-receipt-"+executorUUID(t))
	receiptClaims.CapabilityID = receiveGoodsCapabilityID
	receiptClaims.Permissions = []string{"purchasing.write"}
	received, err := fx.executor.Execute(fx.ctx, receiptClaims, receiveGoodsCapabilityID, receiptInput)
	if err != nil {
		t.Fatal(err)
	}
	if !received.OK {
		t.Fatalf("receive goods refused: %s", received.Error)
	}

	verifiedClaims := fx.humanClaims(orderInput, "acceptance-order-verified-"+executorUUID(t))
	verifiedClaims.CapabilityID = purchasingGetPurchaseOrderCapabilityID
	verifiedClaims.Permissions = []string{"purchasing.read"}
	verified, err := fx.executor.Execute(fx.ctx, verifiedClaims, purchasingGetPurchaseOrderCapabilityID, orderInput)
	if err != nil {
		t.Fatal(err)
	}
	if !verified.OK {
		t.Fatalf("verified purchase order read refused: %s", verified.Error)
	}
	var fulfilled PurchasingPurchaseOrderOutput
	if err := json.Unmarshal(verified.Data, &fulfilled); err != nil {
		t.Fatal(err)
	}
	if !fulfilled.FullyReceived || len(fulfilled.Receipts) != 1 || fulfilled.Lines[0].RemainingThousandths != 0 {
		t.Fatalf("fulfilled order=%+v, want one receipt and no remainder", fulfilled)
	}

	replanClaims := fx.claims(planInput, "agent", fx.agentSession, executorUUID(t))
	replanClaims.CapabilityID = inventoryReplenishmentPlanCapabilityID
	replanClaims.Permissions = []string{"inventory.read"}
	replanned, err := fx.executor.Execute(fx.ctx, replanClaims, inventoryReplenishmentPlanCapabilityID, planInput)
	if err != nil {
		t.Fatal(err)
	}
	if !replanned.OK {
		t.Fatalf("second plan refused: %s", replanned.Error)
	}
	var next InventoryReplenishmentPlanOutput
	if err := json.Unmarshal(replanned.Data, &next); err != nil {
		t.Fatal(err)
	}
	if next.Summary.ActionRequired != 0 || len(next.Items) != 1 {
		t.Fatalf("next plan=%+v, want the single evaluated item with no remaining reorder", next)
	}
	for _, item := range next.Items {
		if item.SuggestedOrderQtyThousandths != 0 || item.Status != "sufficient" {
			t.Fatalf("next plan item=%+v, want a sufficient item after receipt", item)
		}
	}
}

func jsonInt(value int64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
