package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestGoManufacturingOverviewReportPreservesLegacyShapeAndOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "manufacturing.read")

	assemblyID := seedManufacturingItem(t, fx, fx.orgID, "REPORT-CHAIR")
	componentID := seedManufacturingItem(t, fx, fx.orgID, "REPORT-SEAT")
	otherItemID := seedManufacturingItem(t, fx, fx.otherOrgID, "FOREIGN-ITEM")
	seedManufacturingBomLine(t, fx, fx.orgID, assemblyID, componentID, 4000, 20000)
	seedManufacturingBomLine(t, fx, fx.otherOrgID, otherItemID, otherItemID, 9000, 0)

	completedAt := time.Date(2026, time.May, 12, 12, 0, 0, 0, time.UTC)
	workOrderID := seedManufacturingWorkOrderRow(t, fx, fx.orgID, 7, assemblyID, "completed", 10000, 4000, nil, &completedAt)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE work_orders SET note='report fixture' WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, workOrderID); err != nil {
		t.Fatal(err)
	}

	lotID := seedInventoryValuationLot(t, fx, fx.orgID, componentID, "REPORT-SEAT-LOT", completedAt)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE lots SET expires_at=$2 WHERE org_id=$1::uuid AND id=$3::uuid`, fx.orgID, completedAt.Add(24*time.Hour), lotID); err != nil {
		t.Fatal(err)
	}
	foreignLotID := seedInventoryValuationLot(t, fx, fx.otherOrgID, otherItemID, "FOREIGN-LOT", completedAt)

	unitCost := int64(12000)
	componentCost := int64(3000)
	runAt := completedAt.Add(-time.Hour)
	localRunRef := executorUUID(t)
	foreignRunRef := executorUUID(t)
	for _, move := range []struct {
		orgID, itemID  string
		quantity       int64
		cost           *int64
		lotID          *string
		refType, refID string
		createdAt      time.Time
	}{
		{fx.orgID, assemblyID, 2000, &unitCost, nil, "production", localRunRef, runAt},
		{fx.orgID, componentID, -8000, &componentCost, &lotID, "production", localRunRef, runAt.Add(time.Second)},
		{fx.orgID, assemblyID, -2000, nil, nil, "production_reversal", localRunRef, runAt.Add(2 * time.Second)},
		{fx.otherOrgID, otherItemID, 7000, &unitCost, &foreignLotID, "production", foreignRunRef, runAt.Add(time.Hour)},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, ref_type, ref_id, unit_cost_minor, lot_id, actor_type, created_at)
			VALUES ($1::uuid, $2::uuid, $3, 'production', $4, $5, $6, $7::uuid, 'human', $8)`,
			move.orgID, move.itemID, move.quantity, move.refType, move.refID, move.cost, move.lotID, move.createdAt); err != nil {
			t.Fatal(err)
		}
	}
	input := json.RawMessage(`{}`)
	result, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingOverviewReportCapabilityID, "manufacturing.read", input, "human", "", "manufacturing-report"), manufacturingOverviewReportCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("overview report result=%+v err=%v", result, err)
	}
	var report ManufacturingOverviewReportOutput
	if err := json.Unmarshal(result.Data, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.BOMs) != 1 || report.BOMs[0].AssemblySKU != "REPORT-CHAIR" || report.BOMs[0].ComponentSKU != "REPORT-SEAT" || report.BOMs[0].ComponentName != "REPORT-SEAT name" {
		t.Fatalf("BOM report=%+v, want organization-scoped edge with item names", report.BOMs)
	}
	if len(report.Assemblies) != 2 {
		t.Fatalf("assemblies=%+v, want the complete local item catalog", report.Assemblies)
	}
	if len(report.WorkOrders) != 1 || report.WorkOrders[0].ID != workOrderID || report.WorkOrders[0].AssemblyName != "REPORT-CHAIR name" || report.WorkOrders[0].ExpectedGoodThousandths != 10000 || report.WorkOrders[0].Note == nil || *report.WorkOrders[0].Note != "report fixture" || report.WorkOrders[0].CompletedAt == nil {
		t.Fatalf("work orders=%+v, want the legacy work order shape", report.WorkOrders)
	}
	if len(report.ProductionRuns) != 1 {
		t.Fatalf("production runs=%+v, want one local run", report.ProductionRuns)
	}
	run := report.ProductionRuns[0]
	if run.RunID != localRunRef || run.AssemblySKU != "REPORT-CHAIR" || run.ProducedThousandths != 2000 || run.UnitCostMinor != unitCost || run.CostTotalMinor != 24000 || !run.Reversed || len(run.Components) != 1 || run.Components[0].SKU != "REPORT-SEAT" || run.Components[0].QuantityThousandths != 8000 || run.Components[0].LotCode == nil || *run.Components[0].LotCode != "REPORT-SEAT-LOT" {
		t.Fatalf("production run=%+v, want output cost, rounded consumed cost, reversal, and lot code", run)
	}
	if len(report.Lots) != 1 || report.Lots[0].ID != lotID || report.Lots[0].SKU != "REPORT-SEAT" || report.Lots[0].BalanceThousandths != -8000 || report.Lots[0].ExpiresAt == nil {
		t.Fatalf("lots=%+v, want org-scoped lot balance", report.Lots)
	}

	badInput := json.RawMessage(`{"limit":10}`)
	bad, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingOverviewReportCapabilityID, "manufacturing.read", badInput, "human", "", "manufacturing-report-bad-input"), manufacturingOverviewReportCapabilityID, badInput)
	if err != nil || bad.OK || !strings.Contains(bad.Error, "invalid input") {
		t.Fatalf("non-empty report input result=%+v err=%v, want strict input rejection", bad, err)
	}

	unauthorized := waveModuleClaims(fx, manufacturingOverviewReportCapabilityID, "crm.read", input, "human", "", "manufacturing-report-denied")
	deniedResult, err := fx.executor.Execute(fx.ctx, unauthorized, manufacturingOverviewReportCapabilityID, input)
	if err != nil || deniedResult.OK || !strings.Contains(deniedResult.Error, "forbidden: missing permission: manufacturing.read") {
		t.Fatalf("unauthorized report result=%+v err=%v, want manufacturing.read denial", deniedResult, err)
	}

	limitNow := time.Now().UTC()
	for index := 0; index < 101; index++ {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, ref_type, ref_id, actor_type, created_at)
			VALUES ($1::uuid, $2::uuid, 1, 'production', 'production', $3::uuid, 'human', $4)`,
			fx.orgID, assemblyID, fmt.Sprintf("00000000-0000-4000-8000-%012x", index+1), limitNow.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 205; index++ {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO lots (org_id, item_id, lot_code, created_at) VALUES ($1::uuid, $2::uuid, $3, $4)`,
			fx.orgID, componentID, fmt.Sprintf("limit-lot-%03d", index), limitNow.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	limited, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingOverviewReportCapabilityID, "manufacturing.read", input, "human", "", "manufacturing-report-limits"), manufacturingOverviewReportCapabilityID, input)
	if err != nil || !limited.OK {
		t.Fatalf("limited overview report result=%+v err=%v", limited, err)
	}
	if err := json.Unmarshal(limited.Data, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.ProductionRuns) != 100 || report.ProductionRuns[0].RunID != "00000000-0000-4000-8000-000000000065" {
		t.Fatalf("production run limit/order got %d runs starting %q", len(report.ProductionRuns), report.ProductionRuns[0].RunID)
	}
	if len(report.Lots) != 200 || report.Lots[0].LotCode != "limit-lot-204" {
		t.Fatalf("lot limit/order got %d lots starting %q", len(report.Lots), report.Lots[0].LotCode)
	}
}
