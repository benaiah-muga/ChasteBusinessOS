package capability

import (
	"encoding/json"
	"strings"
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

func TestInventoryHistoryAndLotsGovernedExecutorPreservesTenantScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	grantWavePermission(t, fx, "inventory.read")

	localItemID := seedInventoryValuationItem(t, fx, fx.orgID, "SKU-HISTORY-EXEC", "goods", 0, 0, nil)
	foreignItemID := seedInventoryValuationItem(t, fx, fx.otherOrgID, "SKU-HISTORY-EXEC", "goods", 0, 0, nil)
	base := time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)
	localLot := seedInventoryValuationLot(t, fx, fx.orgID, localItemID, "LOT-HISTORY-LOCAL", base)
	foreignLot := seedInventoryValuationLot(t, fx, fx.otherOrgID, foreignItemID, "LOT-HISTORY-FOREIGN", base)
	locationID := seedInventoryStockLocation(t, fx, fx.orgID, "WH-HISTORY-EXEC", "History warehouse")
	seedInventoryValuationMovement(t, fx, fx.orgID, localItemID, 5000, "purchase", inventoryValuationIntPointer(1250), &localLot, &locationID, "system", base.Add(time.Hour))
	seedInventoryValuationNotedMovement(t, fx, fx.orgID, localItemID, -1250, "sale", "counter sale", "pos_sale", "human", base.Add(2*time.Hour), &localLot, &locationID)
	seedInventoryValuationMovement(t, fx, fx.otherOrgID, foreignItemID, 9000, "purchase", inventoryValuationIntPointer(700), &foreignLot, nil, "system", base.Add(3*time.Hour))

	input := json.RawMessage(`{"sku":"SKU-HISTORY-EXEC","limit":1}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryItemHistoryCapabilityID, "crm.read", input, "human", "", "inventory-history-wrong-permission"),
		inventoryItemHistoryCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: inventory.read") {
		t.Fatalf("itemHistory wrong-permission result=%+v err=%v, want inventory.read denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, inventoryItemHistoryCapabilityID); got != 0 {
		t.Fatalf("denied itemHistory audit events=%d, want none", got)
	}

	historyResult, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryItemHistoryCapabilityID, "inventory.read", input, "human", "", "inventory-history-executor-scope"),
		inventoryItemHistoryCapabilityID,
		input,
	)
	if err != nil || !historyResult.OK {
		t.Fatalf("itemHistory result=%+v err=%v", historyResult, err)
	}
	var history InventoryItemHistoryOutput
	if err := json.Unmarshal(historyResult.Data, &history); err != nil {
		t.Fatalf("decode itemHistory output %s: %v", historyResult.Data, err)
	}
	if len(history.Movements) != 1 {
		t.Fatalf("itemHistory returned %d movements, want limit 1 and no foreign movement: %+v", len(history.Movements), history.Movements)
	}
	newest := history.Movements[0]
	if newest.QuantityDelta != -1250 || newest.Reason != "sale" || newest.Note == nil || *newest.Note != "counter sale" ||
		newest.RefType == nil || *newest.RefType != "pos_sale" || newest.LotCode == nil || *newest.LotCode != "LOT-HISTORY-LOCAL" ||
		newest.LocationCode == nil || *newest.LocationCode != "WH-HISTORY-EXEC" || newest.ActorType != "human" ||
		newest.CreatedAt != "2026-09-20T10:00:00.000Z" {
		t.Fatalf("itemHistory movement=%+v, want latest local sale with its note, lot, location, actor and timestamp", newest)
	}

	lotsInput := json.RawMessage(`{}`)
	lotsResult, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryListLotsCapabilityID, "inventory.read", lotsInput, "human", "", "inventory-lots-executor-scope"),
		inventoryListLotsCapabilityID,
		lotsInput,
	)
	if err != nil || !lotsResult.OK {
		t.Fatalf("listLots result=%+v err=%v", lotsResult, err)
	}
	var lots InventoryListLotsOutput
	if err := json.Unmarshal(lotsResult.Data, &lots); err != nil {
		t.Fatalf("decode listLots output %s: %v", lotsResult.Data, err)
	}
	if len(lots.Lots) != 1 || lots.Lots[0].LotCode != "LOT-HISTORY-LOCAL" || lots.Lots[0].SKU != "SKU-HISTORY-EXEC" || lots.Lots[0].BalanceThousandths != 3750 {
		t.Fatalf("listLots returned %+v, want only the local 3750-thousandth lot", lots.Lots)
	}
	for _, capabilityID := range []string{inventoryItemHistoryCapabilityID, inventoryListLotsCapabilityID} {
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, capabilityID); got != 1 {
			t.Fatalf("%s human execution audit events=%d, want one", capabilityID, got)
		}
	}
}
