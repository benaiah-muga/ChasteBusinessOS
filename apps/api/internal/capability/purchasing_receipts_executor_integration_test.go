package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPurchasingReceiptHistoryGovernedExecutorPreservesTenantScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingLifecycleFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.read")
	localVendor := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendor := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	localPO := seedLifecyclePO(t, fx, fx.orgID, localVendor, "partial", 1)
	foreignPO := seedLifecyclePO(t, fx, fx.otherOrgID, foreignVendor, "partial", 1)
	localLine := seedLifecyclePOLine(t, fx, localPO, "Steel rod", 1, 10_000, 1_450, nil, nil)
	foreignLine := seedLifecyclePOLine(t, fx, foreignPO, "Foreign equipment", 1, 20_000, 900, nil, nil)
	localReceivedAt := time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC)
	foreignReceivedAt := time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)
	localReceipt := seedLifecycleReceipt(t, fx, fx.orgID, localPO, 1, localReceivedAt, lifecycleString("First delivery"))
	foreignReceipt := seedLifecycleReceipt(t, fx, fx.otherOrgID, foreignPO, 1, foreignReceivedAt, lifecycleString("Foreign delivery"))
	seedLifecycleReceiptLine(t, fx, fx.orgID, localReceipt, localLine, 1, 4_000, 1_000, 500, lifecycleString("damaged cartons"))
	seedLifecycleReceiptLine(t, fx, fx.otherOrgID, foreignReceipt, foreignLine, 1, 15_000, 0, 0, nil)

	input := json.RawMessage(`{"poNumber":1}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, listReceiptsCapabilityID, "crm.read", input, "human", "", "purchasing-receipts-wrong-permission"),
		listReceiptsCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.read") {
		t.Fatalf("listReceipts wrong-permission result=%+v err=%v, want purchasing.read denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, listReceiptsCapabilityID); got != 0 {
		t.Fatalf("denied listReceipts audits=%d, want none", got)
	}

	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, listReceiptsCapabilityID, "purchasing.read", input, "human", "", "purchasing-receipts-local-scope"),
		listReceiptsCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("listReceipts result=%+v err=%v", result, err)
	}
	var output ListReceiptsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode listReceipts output %s: %v", result.Data, err)
	}
	if len(output.Receipts) != 1 {
		t.Fatalf("listReceipts returned %d rows, want only the local receipt: %+v", len(output.Receipts), output.Receipts)
	}
	receipt := output.Receipts[0]
	if receipt.Number != 1 || receipt.ReceivedAt != "2026-09-22T09:00:00.000Z" || receipt.Note == nil || *receipt.Note != "First delivery" || len(receipt.Lines) != 1 {
		t.Fatalf("local receipt=%+v, want its timestamp, note, and one receipt line", receipt)
	}
	line := receipt.Lines[0]
	if line.Position != 1 || line.Description != "Steel rod" || line.AcceptedThousandths != 4_000 || line.RejectedThousandths != 1_000 ||
		line.ReturnedThousandths != 500 || line.RejectionNote == nil || *line.RejectionNote != "damaged cartons" {
		t.Fatalf("local receipt line=%+v, want exact accepted, rejected, returned, and note fields", line)
	}
	wantOrderLines := []LifecycleOrderLine{{
		Position: 1, Description: "Steel rod", OrderedThousandths: 10_000, AcceptedThousandths: 4_000,
		RejectedThousandths: 1_000, ReturnedThousandths: 500, RemainingThousandths: 5_000,
	}}
	if len(output.OrderLines) != len(wantOrderLines) || output.OrderLines[0] != wantOrderLines[0] {
		t.Fatalf("listReceipts order lines=%+v, want %+v", output.OrderLines, wantOrderLines)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, listReceiptsCapabilityID); got != 1 {
		t.Fatalf("listReceipts human execution audits=%d, want one", got)
	}
}
