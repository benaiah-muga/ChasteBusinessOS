package capability

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func seedManufacturingBomItem(t *testing.T, fx *executorFixture, orgID, sku, name string) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO items (org_id, sku, name, kind, unit_label, sale_price_minor, reorder_point_thousandths, tags)
		VALUES ($1::uuid, $2, $3, 'goods', 'pc', 0, 0, '[]'::jsonb)
		RETURNING id::text`, orgID, sku, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestManufacturingBomParsersMirrorZodContracts(t *testing.T) {
	defined, err := ParseManufacturingDefineBomInput(json.RawMessage(`{"assemblySku":"DESK","components":[{"sku":"LEG","quantityThousandths":4000},{"sku":"TOP","quantityThousandths":1000,"scrapPctThousandths":50000}]}`))
	if err != nil || len(defined.Components) != 2 || defined.Components[0].ScrapPctThousandths != 0 || defined.Components[1].ScrapPctThousandths != 50000 {
		t.Fatalf("defineBom parse=%+v err=%v", defined, err)
	}
	if _, err := ParseManufacturingDefineBomInput(json.RawMessage(`{"assemblySku":"DESK","components":[]}`)); err == nil {
		t.Fatal("empty components refused")
	}
	tree, err := ParseManufacturingBomTreeInput(json.RawMessage(`{"assemblySku":"DESK"}`))
	if err != nil || tree.QuantityThousandths != 1000 {
		t.Fatalf("tree parse=%+v err=%v, want default 1000", tree, err)
	}
	preview, err := ParseManufacturingCostPreviewInput(json.RawMessage(`{"assemblySku":"DESK","quantityThousandths":2000}`))
	if err != nil || preview.YieldPctThousandths != manufacturingPctScale {
		t.Fatalf("costPreview parse=%+v err=%v, want full yield default", preview, err)
	}
	runs, err := ParseManufacturingProductionRunsInput(json.RawMessage(`{}`))
	if err != nil || runs.Limit != 25 {
		t.Fatalf("productionRuns parse=%+v err=%v, want default 25", runs, err)
	}
	if _, err := ParseManufacturingProductionRunsInput(json.RawMessage(`{"limit":101}`)); err == nil {
		t.Fatal("limit over 100 refused")
	}
	if _, err := parseManufacturingBomInput(manufacturingLotTraceCapabilityID, json.RawMessage(`{"sku":"DESK","lotCode":"LOT-1"}`)); err != nil {
		t.Fatalf("dispatcher refused lotTrace: %v", err)
	}
	if _, err := parseManufacturingBomInput("manufacturing.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("dispatcher refused unknown id")
	}
}

func TestManufacturingBomLifecycleAndTree(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin bom cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable bom cleanup: %v", err)
			return
		}
		for _, stmt := range []string{
			`DELETE FROM stock_movements WHERE org_id=$1::uuid`,
			`DELETE FROM stock_balances WHERE org_id=$1::uuid`,
			`DELETE FROM lots WHERE org_id=$1::uuid`,
			`DELETE FROM work_orders WHERE org_id=$1::uuid`,
			`DELETE FROM bom_lines WHERE org_id=$1::uuid`,
			`DELETE FROM items WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("bom cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit bom cleanup: %v", err)
		}
	})
	claims := authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human"}

	assemblyID := seedManufacturingBomItem(t, fx, fx.orgID, "DESK", "Desk")
	legID := seedManufacturingBomItem(t, fx, fx.orgID, "LEG", "Leg")
	seedManufacturingBomItem(t, fx, fx.orgID, "TOP", "Top")

	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		defined, err := manufacturingDefineBom(context.Background(), tx, claims, ManufacturingDefineBomInput{
			AssemblySKU: "DESK",
			Components: []ManufacturingBomComponentInput{
				{SKU: "LEG", QuantityThousandths: 4000},
				{SKU: "TOP", QuantityThousandths: 1000},
			},
		})
		if err != nil {
			return struct{}{}, err
		}
		if defined.AssemblyItemID != assemblyID || defined.ComponentCount != 2 {
			t.Fatalf("defineBom output=%+v, want two components on the assembly", defined)
		}
		if _, err := manufacturingDefineBom(context.Background(), tx, claims, ManufacturingDefineBomInput{
			AssemblySKU: "DESK",
			Components:  []ManufacturingBomComponentInput{{SKU: "DESK", QuantityThousandths: 1000}},
		}); err == nil || err.Error() != "an assembly cannot contain itself" {
			t.Fatalf("self containment err=%v, want refusal", err)
		}
		if _, err := manufacturingDefineBom(context.Background(), tx, claims, ManufacturingDefineBomInput{
			AssemblySKU: "LEG",
			Components:  []ManufacturingBomComponentInput{{SKU: "DESK", QuantityThousandths: 1000}},
		}); err == nil || !strings.HasPrefix(err.Error(), "rejected: ") {
			t.Fatalf("cycle define err=%v, want rejected prefix", err)
		}
		if _, err := tx.Exec(context.Background(), `DELETE FROM bom_lines WHERE org_id=$1::uuid AND assembly_item_id=$2::uuid`, fx.orgID, legID); err != nil {
			return struct{}{}, err
		}

		tree, err := manufacturingBomTree(context.Background(), tx, fx.orgID, ManufacturingBomTreeInput{AssemblySKU: "DESK", QuantityThousandths: 2000})
		if err != nil {
			return struct{}{}, err
		}
		if !tree.HasBom || tree.Root.SKU != "DESK" || tree.Root.QuantityThousandths != 2000 || len(tree.Root.Children) != 2 {
			t.Fatalf("bomTree output=%+v, want DESK with two children", tree.Root)
		}
		for _, child := range tree.Root.Children {
			if child.QuantityThousandths != 2*child.QuantityThousandths/2 || (child.SKU != "LEG" && child.SKU != "TOP") {
				t.Fatalf("bomTree child=%+v, want scaled LEG and TOP", child)
			}
		}
		if child := tree.Root.Children[0]; child.Children == nil {
			t.Fatalf("bomTree children must marshal as arrays, got %+v", child)
		}

		report, err := manufacturingBomReport(context.Background(), tx, fx.orgID, ManufacturingBomReportInput{AssemblySKU: "DESK", QuantityThousandths: 1000})
		if err != nil {
			return struct{}{}, err
		}
		if report.Producible || report.TotalShortfallThousandths != 5000 {
			t.Fatalf("bomReport output=%+v, want shortfall of 5000 without stock", report)
		}

		preview, err := manufacturingCostPreview(context.Background(), tx, fx.orgID, ManufacturingCostPreviewInput{AssemblySKU: "DESK", QuantityThousandths: 1000, YieldPctThousandths: manufacturingPctScale})
		if err != nil {
			return struct{}{}, err
		}
		if preview.TotalCostMinor != 0 || len(preview.Lines) != 2 || preview.ExpectedGoodThousandths != 1000 {
			t.Fatalf("costPreview output=%+v, want two zero-cost lines at full yield", preview)
		}
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestManufacturingBomProductionRunsAndLotTrace(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin run cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable run cleanup: %v", err)
			return
		}
		for _, stmt := range []string{
			`DELETE FROM stock_movements WHERE org_id=$1::uuid`,
			`DELETE FROM stock_balances WHERE org_id=$1::uuid`,
			`DELETE FROM lots WHERE org_id=$1::uuid`,
			`DELETE FROM work_orders WHERE org_id=$1::uuid`,
			`DELETE FROM bom_lines WHERE org_id=$1::uuid`,
			`DELETE FROM items WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("run cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit run cleanup: %v", err)
		}
	})

	assemblyID := seedManufacturingBomItem(t, fx, fx.orgID, "WIDGET", "Widget")
	componentID := seedManufacturingBomItem(t, fx, fx.orgID, "WIRE", "Wire")

	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		runRef, err := manufacturingNewRunRef()
		if err != nil {
			return struct{}{}, err
		}
		seedRef, refErr := manufacturingNewRunRef()
		if refErr != nil {
			return struct{}{}, refErr
		}
		if err := manufacturingApplyStockDelta(context.Background(), tx, fx.orgID, componentID, 5000, "purchase", "wave7 stock seed", "purchase", seedRef, nil, nil, nil, "system", nil); err != nil {
			return struct{}{}, err
		}
		consumerLot, err := inventoryGetOrCreateLot(context.Background(), tx, fx.orgID, assemblyID, "LOT-W1")
		if err != nil {
			return struct{}{}, err
		}
		sourceLot, err := inventoryGetOrCreateLot(context.Background(), tx, fx.orgID, componentID, "LOT-C1")
		if err != nil {
			return struct{}{}, err
		}
		unitCost := int64(90000)
		if err := manufacturingApplyStockDelta(context.Background(), tx, fx.orgID, componentID, -2000, "production", "consumed by production of WIDGET", "production", runRef, &unitCost, nil, &sourceLot, "human", &fx.userID); err != nil {
			return struct{}{}, err
		}
		rolled := int64(90000)
		if err := manufacturingApplyStockDelta(context.Background(), tx, fx.orgID, assemblyID, 1000, "production", "produced from BOM", "production", runRef, &rolled, nil, &consumerLot, "human", &fx.userID); err != nil {
			return struct{}{}, err
		}

		runs, err := manufacturingProductionRuns(context.Background(), tx, fx.orgID, ManufacturingProductionRunsInput{Limit: 25})
		if err != nil {
			return struct{}{}, err
		}
		if len(runs.Runs) != 1 || runs.Runs[0].RunRef != runRef || runs.Runs[0].ProducedThousandths != 1000 {
			t.Fatalf("productionRuns output=%+v, want the seeded run", runs)
		}
		if runs.Runs[0].AssemblySKU != "WIDGET" || len(runs.Runs[0].Consumed) != 1 || runs.Runs[0].Consumed[0].SKU != "WIRE" || runs.Runs[0].Consumed[0].QuantityThousandths != 2000 {
			t.Fatalf("productionRun detail=%+v, want WIDGET built from 2000 WIRE", runs.Runs[0])
		}
		if runs.Runs[0].CostRolledUpMinor != 180000 || runs.Runs[0].Reversed {
			t.Fatalf("productionRun cost=%d reversed=%v, want 180000 unreversed", runs.Runs[0].CostRolledUpMinor, runs.Runs[0].Reversed)
		}

		trace, err := manufacturingLotTrace(context.Background(), tx, fx.orgID, ManufacturingLotTraceInput{SKU: "WIDGET", LotCode: "LOT-W1"})
		if err != nil {
			return struct{}{}, err
		}
		if !trace.Found || len(trace.Tree) != 1 || trace.Tree[0].LotCode != "LOT-W1" || trace.Tree[0].SKU != "WIDGET" {
			t.Fatalf("lotTrace output=%+v, want the WIDGET lot root", trace)
		}
		if len(trace.Tree[0].FedBy) != 1 || trace.Tree[0].FedBy[0].LotCode != "LOT-C1" || trace.Tree[0].FedBy[0].SKU != "WIRE" {
			t.Fatalf("lotTrace fedBy=%+v, want the WIRE source lot", trace.Tree[0].FedBy)
		}

		if _, err := manufacturingLotTrace(context.Background(), tx, fx.orgID, ManufacturingLotTraceInput{SKU: "WIDGET", LotCode: "LOT-MISSING"}); err == nil || !strings.Contains(err.Error(), `no lot "LOT-MISSING" for WIDGET`) {
			t.Fatalf("missing lot err=%v, want explicit refusal", err)
		}
		if _, err := manufacturingBomReport(context.Background(), tx, fx.orgID, ManufacturingBomReportInput{AssemblySKU: "WIDGET", QuantityThousandths: 1000}); err == nil || !strings.Contains(err.Error(), "has no bill of materials") {
			t.Fatalf("report without bom err=%v, want refusal", err)
		}
		if _, err := manufacturingDeleteBom(context.Background(), tx, authbridge.CapabilityClaims{OrganizationID: fx.orgID}, ManufacturingDeleteBomInput{AssemblySKU: "WIDGET"}); err == nil || !strings.Contains(err.Error(), "has no bill of materials") {
			t.Fatalf("delete without bom err=%v, want refusal", err)
		}
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
}
