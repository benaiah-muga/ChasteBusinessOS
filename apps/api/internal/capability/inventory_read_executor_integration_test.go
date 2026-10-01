package capability

import (
	"encoding/json"
	"testing"
	"time"
)

func TestInventoryStockReportGovernedExecutorPreservesValuationAndTenantScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	grantWavePermission(t, fx, "inventory.read")

	localItemID := seedInventoryValuationItem(t, fx, fx.orgID, "SKU-EXEC-VALUATION", "goods", 2500, 0, nil)
	foreignItemID := seedInventoryValuationItem(t, fx, fx.otherOrgID, "SKU-EXEC-VALUATION", "goods", 2500, 0, nil)
	base := time.Date(2026, 9, 12, 9, 0, 0, 0, time.UTC)
	seedInventoryValuationMovement(t, fx, fx.orgID, localItemID, 10000, "purchase", inventoryValuationIntPointer(1200), nil, nil, "system", base)
	seedInventoryValuationMovement(t, fx, fx.orgID, localItemID, -2500, "sale", nil, nil, nil, "human", base.Add(time.Minute))
	seedInventoryValuationMovement(t, fx, fx.orgID, localItemID, -1000, "transfer", nil, nil, nil, "system", base.Add(2*time.Minute))
	seedInventoryValuationMovement(t, fx, fx.orgID, localItemID, 1000, "transfer", nil, nil, nil, "system", base.Add(3*time.Minute))
	seedInventoryValuationMovement(t, fx, fx.otherOrgID, foreignItemID, 7000, "purchase", inventoryValuationIntPointer(500), nil, nil, "system", base)

	input := json.RawMessage(`{"belowReorderOnly":false}`)
	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryStockReportCapabilityID, "inventory.read", input, "human", "", "inventory-report-valuation-scope"),
		inventoryStockReportCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("stockReport result=%+v err=%v", result, err)
	}
	var report InventoryStockReportOutput
	if err := json.Unmarshal(result.Data, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Items) != 1 {
		t.Fatalf("stockReport returned %d rows, want only the local tenant item: %+v", len(report.Items), report.Items)
	}
	row := report.Items[0]
	if row.SKU != "SKU-EXEC-VALUATION" || row.OnHandThousandths != 7500 || row.ValueMinor != 9000 || row.AvgUnitCostMinor != 1200 {
		t.Fatalf("stockReport row=%+v, want 7500 thousandths valued at 9000 minor (average 1200)", row)
	}
	if report.TotalValueMinor != 9000 {
		t.Fatalf("stockReport totalValueMinor=%d, want local ledger value 9000", report.TotalValueMinor)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, inventoryStockReportCapabilityID); got != 1 {
		t.Fatalf("stock report audit events=%d, want one governed execution", got)
	}
}
