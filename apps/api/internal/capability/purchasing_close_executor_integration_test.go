package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGoPurchasingCloseUsesGovernedApprovalAndTenantScopedEffects(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingLifecycleFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.write")

	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	poID := seedLifecyclePO(t, fx, fx.orgID, vendorID, "open", 1)
	seedLifecyclePOLine(t, fx, poID, "Assembly service", 1, 5_000, 900, nil, lifecycleInt64(2_000))
	foreignPOID := seedLifecyclePO(t, fx, fx.otherOrgID, foreignVendorID, "open", 1)
	seedLifecyclePOLine(t, fx, foreignPOID, "Foreign service", 1, 7_000, 900, nil, lifecycleInt64(1_000))
	input := json.RawMessage(`{"poNumber":1}`)

	denied, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, closePurchaseOrderCapabilityID, "crm.write", input, "human", "", "close-denied"),
		closePurchaseOrderCapabilityID, input)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.write") {
		t.Fatalf("close permission result=%+v err=%v, want purchasing.write refusal", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND id=$2::uuid AND status='open'`, fx.orgID, poID); got != 1 {
		t.Fatalf("permission-denied close changed purchase order state, open rows=%d", got)
	}

	fx.addAgentSession()
	fx.addPolicy(closePurchaseOrderCapabilityID, "read", nil)
	pending, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, closePurchaseOrderCapabilityID, "purchasing.write", input, "agent", fx.agentSession, "close-po-approval"),
		closePurchaseOrderCapabilityID, input)
	if err != nil || pending.OK || !pending.PendingApproval {
		t.Fatalf("agent close result=%+v err=%v, want pending approval", pending, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, closePurchaseOrderCapabilityID); got != 1 {
		t.Fatalf("close approval request audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND id=$2::uuid AND status='open'`, fx.orgID, poID); got != 1 {
		t.Fatalf("pending close changed purchase order state, open rows=%d", got)
	}

	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'
		ORDER BY created_at DESC LIMIT 1`, fx.orgID, closePurchaseOrderCapabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	approved, err := decider.Decide(fx.ctx,
		waveModuleClaims(fx, closePurchaseOrderCapabilityID, "purchasing.write", input, "human", "", ""),
		ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || !approved.OK || approved.Status != "executed" || approved.Result == nil || !approved.Result.OK {
		t.Fatalf("approved close result=%+v err=%v, want executed approval", approved, err)
	}
	var output ClosePurchaseOrderOutput
	if err := json.Unmarshal(approved.Result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if !output.Closed || !output.Backordered || output.ShortThousandths != 3_000 {
		t.Fatalf("approved close output=%+v, want 3000 short thousandths", output)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND id=$2::uuid AND status='closed' AND backordered`, fx.orgID, poID); got != 1 {
		t.Fatalf("approved close did not persist backordered state, rows=%d", got)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND id=$2::uuid AND status='open' AND NOT backordered`, fx.otherOrgID, foreignPOID); got != 1 {
		t.Fatalf("close changed the same-number foreign purchase order, unchanged rows=%d", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, closePurchaseOrderCapabilityID); got != 1 {
		t.Fatalf("approved close audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.otherOrgID, closePurchaseOrderCapabilityID); got != 0 {
		t.Fatalf("close wrote %d foreign-tenant audit events", got)
	}
}
