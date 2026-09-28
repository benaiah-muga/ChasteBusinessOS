package capability

import (
	"encoding/json"
	"testing"
)

func TestGoPurchasingVendorUsesGovernedApprovalAndReceiptPath(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	grantWavePermission(t, fx, "purchasing.write")
	fx.addPolicy(createVendorCapabilityID, "read", nil)

	input := json.RawMessage(`{"name":"Governed commerce vendor"}`)
	result := approveModuleWrite(t, fx, createVendorCapabilityID, "purchasing.write", input)
	var output CreateVendorOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || !result.OK || !isUUID(output.VendorID) {
		t.Fatalf("approved createVendor result=%+v output=%+v err=%v", result, output, err)
	}
	if got := fx.count(`SELECT count(*) FROM vendors WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, output.VendorID); got != 1 {
		t.Fatalf("vendors=%d, want one governed vendor", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, createVendorCapabilityID); got != 1 {
		t.Fatalf("approval request audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, createVendorCapabilityID); got != 1 {
		t.Fatalf("human execution audit events=%d, want one", got)
	}

	claims := waveModuleClaims(fx, createVendorCapabilityID, "purchasing.write", input, "human", "", "commerce-vendor-receipt")
	direct, err := fx.executor.Execute(fx.ctx, claims, createVendorCapabilityID, input)
	if err != nil || !direct.OK {
		t.Fatalf("direct createVendor result=%+v err=%v", direct, err)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, createVendorCapabilityID, input)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createVendor replay=%+v err=%v, want governed receipt replay", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":commerce-vendor-receipt"); got != 1 {
		t.Fatalf("action receipts=%d, want one", got)
	}
}
