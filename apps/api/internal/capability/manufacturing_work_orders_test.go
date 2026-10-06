package capability

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func manufacturingClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func manufacturingInOrgTx[T any](t *testing.T, fx *executorFixture, orgID string, run func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, run)
	if err != nil {
		t.Fatalf("manufacturing work orders transaction: %v", err)
	}
	return output
}

func manufacturingExpectError(t *testing.T, fx *executorFixture, orgID, wantErr string, run func(tx pgx.Tx) error) {
	t.Helper()
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, run(tx)
	}); err == nil || err.Error() != wantErr {
		t.Fatalf("manufacturing work orders error = %v, want %q", err, wantErr)
	}
}

func cleanupManufacturingWorkOrdersFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin manufacturing fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable manufacturing fixture ledger cleanup: %v", err)
			return
		}
		steps := []string{
			`DELETE FROM stock_movements WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM work_orders WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM lots WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM bom_lines WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM doc_counters WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, step := range steps {
			if _, err := tx.Exec(fx.ctx, step, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("manufacturing fixture cleanup step failed: %v", err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit manufacturing fixture cleanup: %v", err)
		}
	})
}

func seedManufacturingItem(t *testing.T, fx *executorFixture, orgID, sku string) string {
	t.Helper()
	var itemID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, $2, $3, 'goods')
		RETURNING id::text`, orgID, sku, sku+" name").Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func seedManufacturingStock(t *testing.T, fx *executorFixture, orgID, itemID string, quantityThousandths int64, unitCostMinor *int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, unit_cost_minor, actor_type)
		VALUES ($1::uuid, $2::uuid, $3, 'adjustment', 'manufacturing fixture stock', $4, 'system')`,
		orgID, itemID, quantityThousandths, unitCostMinor); err != nil {
		t.Fatal(err)
	}
}

func seedManufacturingBomLine(t *testing.T, fx *executorFixture, orgID, assemblyItemID, componentItemID string, quantityThousandths, scrapPctThousandths int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO bom_lines (org_id, assembly_item_id, component_item_id, quantity_thousandths, scrap_pct_thousandths)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
		orgID, assemblyItemID, componentItemID, quantityThousandths, scrapPctThousandths); err != nil {
		t.Fatal(err)
	}
}

func seedManufacturingWorkOrderRow(t *testing.T, fx *executorFixture, orgID string, number int64, assemblyItemID, status string, planned, produced int64, releasedAt, completedAt *time.Time) string {
	t.Helper()
	var workOrderID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO work_orders (org_id, number, assembly_item_id, planned_qty_thousandths, produced_qty_thousandths, status, released_at, completed_at)
		VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8)
		RETURNING id::text`,
		orgID, number, assemblyItemID, planned, produced, status, releasedAt, completedAt).Scan(&workOrderID); err != nil {
		t.Fatal(err)
	}
	return workOrderID
}

func manufacturingRelease(t *testing.T, fx *executorFixture, claims authbridge.CapabilityClaims, workOrderID string, now time.Time) ManufacturingReleaseWorkOrderOutput {
	t.Helper()
	return manufacturingInOrgTx(t, fx, claims.OrganizationID, func(tx pgx.Tx) (ManufacturingReleaseWorkOrderOutput, error) {
		return manufacturingReleaseWorkOrder(fx.ctx, tx, claims.OrganizationID, ManufacturingWorkOrderIDInput{WorkOrderID: workOrderID}, now)
	})
}

func TestManufacturingWorkOrdersParsersMirrorZodContracts(t *testing.T) {
	workOrderUUID := "44444444-4444-4444-8444-444444444444"
	runUUID := "55555555-5555-4555-8555-555555555555"

	created, err := ParseManufacturingCreateWorkOrderInput(json.RawMessage(`{"assemblySku":"BIKE","plannedQtyThousandths":3000,"yieldPctThousandths":900000,"workCenter":"bay-2","note":"spring batch","unknown":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.AssemblySKU != "BIKE" || created.PlannedQtyThousandths != 3000 || created.YieldPctThousandths != 900000 ||
		created.WorkCenter == nil || *created.WorkCenter != "bay-2" || created.Note == nil || *created.Note != "spring batch" {
		t.Fatalf("ParseManufacturingCreateWorkOrderInput() = %+v, want the full payload", created)
	}
	defaulted, err := ParseManufacturingCreateWorkOrderInput(json.RawMessage(`{"assemblySku":"BIKE","plannedQtyThousandths":1}`))
	if err != nil || defaulted.YieldPctThousandths != 1_000_000 || defaulted.WorkCenter != nil || defaulted.Note != nil {
		t.Fatalf("defaulted createWorkOrder input = %+v, %v, want the full yield default", defaulted, err)
	}
	maxPlanned, err := ParseManufacturingCreateWorkOrderInput(json.RawMessage(`{"assemblySku":"BIKE","plannedQtyThousandths":2147483647}`))
	if err != nil || maxPlanned.PlannedQtyThousandths != 2_147_483_647 {
		t.Fatalf("maximum createWorkOrder planned quantity = %+v, %v, want MaxInt32", maxPlanned, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"plannedQtyThousandths":3000}`,
		`{"assemblySku":null,"plannedQtyThousandths":3000}`,
		`{"assemblySku":"BIKE"}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":0}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":-5}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":1.5}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":"5"}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":2147483648}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":3000,"yieldPctThousandths":null}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":3000,"yieldPctThousandths":-1}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":3000,"yieldPctThousandths":1000001}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":3000,"yieldPctThousandths":0.5}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":3000,"workCenter":"` + strings.Repeat("x", 81) + `"}`,
		`{"assemblySku":"BIKE","plannedQtyThousandths":3000,"note":"` + strings.Repeat("x", 501) + `"}`,
	} {
		if _, err := ParseManufacturingCreateWorkOrderInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseManufacturingCreateWorkOrderInput accepted %s", raw)
		}
	}

	for _, parse := range []func(json.RawMessage) (ManufacturingWorkOrderIDInput, error){
		ParseManufacturingReleaseWorkOrderInput, ParseManufacturingCancelWorkOrderInput,
	} {
		accepted, err := parse(json.RawMessage(`{"workOrderId":"` + workOrderUUID + `","unknown":1}`))
		if err != nil || accepted.WorkOrderID != workOrderUUID {
			t.Fatalf("%T() = %+v, %v, want the work order id", parse, accepted, err)
		}
		for _, raw := range []string{
			`{}`,
			`{"workOrderId":null}`,
			`{"workOrderId":"nope"}`,
			`{"workOrderId":5}`,
		} {
			if _, err := parse(json.RawMessage(raw)); err == nil {
				t.Errorf("%T accepted %s", parse, raw)
			}
		}
	}

	completed, err := ParseManufacturingCompleteWorkOrderInput(json.RawMessage(`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":1000,"lotCode":"LOT-1"}`))
	if err != nil || completed.WorkOrderID != workOrderUUID || completed.QuantityThousandths != 1000 || completed.LotCode == nil || *completed.LotCode != "LOT-1" {
		t.Fatalf("ParseManufacturingCompleteWorkOrderInput() = %+v, %v", completed, err)
	}
	bare, err := ParseManufacturingCompleteWorkOrderInput(json.RawMessage(`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":1000}`))
	if err != nil || bare.LotCode != nil {
		t.Fatalf("bare complete input = %+v, %v, want absent lot", bare, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"workOrderId":"` + workOrderUUID + `"}`,
		`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":0}`,
		`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":-1}`,
		`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":2.5}`,
		`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":1000,"lotCode":""}`,
		`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":1000,"lotCode":"` + strings.Repeat("x", 41) + `"}`,
		`{"workOrderId":"` + workOrderUUID + `","quantityThousandths":1000,"lotCode":null}`,
	} {
		if _, err := ParseManufacturingCompleteWorkOrderInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseManufacturingCompleteWorkOrderInput accepted %s", raw)
		}
	}

	reversed, err := ParseManufacturingReverseProductionRunInput(json.RawMessage(`{"runRef":"` + runUUID + `"}`))
	if err != nil || reversed.RunRef != runUUID {
		t.Fatalf("ParseManufacturingReverseProductionRunInput() = %+v, %v", reversed, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"runRef":null}`,
		`{"runRef":"not-a-uuid"}`,
		`{"runRef":7}`,
	} {
		if _, err := ParseManufacturingReverseProductionRunInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseManufacturingReverseProductionRunInput accepted %s", raw)
		}
	}

	feasibility, err := ParseManufacturingCheckProductionFeasibilityInput(json.RawMessage(`{"assemblySku":"CHAIR","desiredUnitsThousandths":500000,"unknown":true}`))
	if err != nil || feasibility.AssemblySKU != "CHAIR" || feasibility.DesiredUnitsThousandths != 500000 {
		t.Fatalf("ParseManufacturingCheckProductionFeasibilityInput() = %+v, %v", feasibility, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"assemblySku":"CHAIR"}`,
		`{"assemblySku":"CHAIR","desiredUnitsThousandths":0}`,
		`{"assemblySku":"CHAIR","desiredUnitsThousandths":100.5}`,
		`{"assemblySku":"CHAIR","desiredUnitsThousandths":"1"}`,
	} {
		if _, err := ParseManufacturingCheckProductionFeasibilityInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseManufacturingCheckProductionFeasibilityInput accepted %s", raw)
		}
	}

	listed, err := ParseManufacturingWorkOrdersListInput(json.RawMessage(`{"status":"released","limit":10}`))
	if err != nil || listed.Status == nil || *listed.Status != "released" || listed.Limit != 10 {
		t.Fatalf("ParseManufacturingWorkOrdersListInput() = %+v, %v", listed, err)
	}
	defaultList, err := ParseManufacturingWorkOrdersListInput(json.RawMessage(`{}`))
	if err != nil || defaultList.Status != nil || defaultList.Limit != 50 {
		t.Fatalf("default list input = %+v, %v, want limit 50 and no status", defaultList, err)
	}
	for _, raw := range []string{
		`[]`,
		`{"status":"bogus"}`,
		`{"status":null}`,
		`{"limit":0}`,
		`{"limit":101}`,
		`{"limit":2.5}`,
		`{"limit":"10"}`,
	} {
		if _, err := ParseManufacturingWorkOrdersListInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseManufacturingWorkOrdersListInput accepted %s", raw)
		}
	}

	produced, err := ParseManufacturingProduceFromBomInput(json.RawMessage(`{"assemblySku":"BIKE","quantityThousandths":2000,"lotCode":"BIKE-LOT-1"}`))
	if err != nil || produced.AssemblySKU != "BIKE" || produced.QuantityThousandths != 2000 || produced.LotCode == nil || *produced.LotCode != "BIKE-LOT-1" {
		t.Fatalf("ParseManufacturingProduceFromBomInput() = %+v, %v", produced, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"assemblySku":"BIKE"}`,
		`{"assemblySku":"BIKE","quantityThousandths":0}`,
		`{"assemblySku":"BIKE","quantityThousandths":-3}`,
		`{"assemblySku":"BIKE","quantityThousandths":1.25}`,
		`{"assemblySku":"BIKE","quantityThousandths":2000,"lotCode":""}`,
		`{"assemblySku":"BIKE","quantityThousandths":2000,"lotCode":"` + strings.Repeat("y", 41) + `"}`,
	} {
		if _, err := ParseManufacturingProduceFromBomInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseManufacturingProduceFromBomInput accepted %s", raw)
		}
	}

	if _, err := parseManufacturingWorkOrderInput("manufacturing.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported manufacturing work order capability" {
		t.Fatalf("parseManufacturingWorkOrderInput(unknown) err = %v, want dispatcher refusal", err)
	}
	for capabilityID, raw := range map[string]string{
		manufacturingCreateWorkOrderCapabilityID:            `{"assemblySku":"BIKE","plannedQtyThousandths":1000}`,
		manufacturingReleaseWorkOrderCapabilityID:           `{"workOrderId":"` + workOrderUUID + `"}`,
		manufacturingCompleteWorkOrderCapabilityID:          `{"workOrderId":"` + workOrderUUID + `","quantityThousandths":1000}`,
		manufacturingCancelWorkOrderCapabilityID:            `{"workOrderId":"` + workOrderUUID + `"}`,
		manufacturingReverseProductionRunCapabilityID:       `{"runRef":"` + runUUID + `"}`,
		manufacturingCheckProductionFeasibilityCapabilityID: `{"assemblySku":"BIKE","desiredUnitsThousandths":1000}`,
		manufacturingWorkOrdersListCapabilityID:             `{}`,
		manufacturingProduceFromBomCapabilityID:             `{"assemblySku":"BIKE","quantityThousandths":2000}`,
	} {
		if _, err := parseManufacturingWorkOrderInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseManufacturingWorkOrderInput(%s) err = %v", capabilityID, err)
		}
	}
}

func TestManufacturingWorkOrdersPureMathMirrorsErpCore(t *testing.T) {
	if got := manufacturingPlannedGoodQuantity(3000, 900_000); got != 2700 {
		t.Fatalf("manufacturingPlannedGoodQuantity(3000, 900000) = %d, want floor of 90 percent", got)
	}
	if got := manufacturingPlannedGoodQuantity(1000, 1_000_000); got != 1000 {
		t.Fatalf("manufacturingPlannedGoodQuantity(1000, 1000000) = %d, want 1000", got)
	}
	if got := manufacturingPlannedGoodQuantity(1000, 999_999); got != 999 {
		t.Fatalf("manufacturingPlannedGoodQuantity(1000, 999999) = %d, want 999 (rounded down)", got)
	}
	if got := manufacturingPlannedGoodQuantity(0, 900_000); got != 0 {
		t.Fatalf("manufacturingPlannedGoodQuantity(0, ...) = %d, want 0", got)
	}
	if got := manufacturingPlannedGoodQuantity(1000, 1_500_000); got != 1000 {
		t.Fatalf("manufacturingPlannedGoodQuantity yield clamped = %d, want 1000", got)
	}

	scrap, err := manufacturingApplyScrap(32_000, 50_000)
	if err != nil || scrap != 33_600 {
		t.Fatalf("manufacturingApplyScrap(32000, 50000) = %d, %v, want 33600", scrap, err)
	}
	plain, err := manufacturingApplyScrap(32_000, 0)
	if err != nil || plain != 32_000 {
		t.Fatalf("manufacturingApplyScrap without scrap = %d, %v, want 32000", plain, err)
	}
	zero, err := manufacturingApplyScrap(0, 50_000)
	if err != nil || zero != 0 {
		t.Fatalf("manufacturingApplyScrap(0, ...) = %d, %v, want 0", zero, err)
	}

	wheelID, rimID, spokeID, frameID, bikeID := "a1", "a2", "a3", "a4", "a5"
	edges := []manufacturingBomEdge{
		{assemblyItemID: wheelID, componentItemID: rimID, quantityThousandths: 1000},
		{assemblyItemID: wheelID, componentItemID: spokeID, quantityThousandths: 32_000},
		{assemblyItemID: bikeID, componentItemID: frameID, quantityThousandths: 1000},
		{assemblyItemID: bikeID, componentItemID: wheelID, quantityThousandths: 2000},
	}
	requirements, err := manufacturingExplodeBom(edges, bikeID, 2000)
	if err != nil {
		t.Fatal(err)
	}
	// 2000 bikes need 4000 wheel assemblies, so the wheel children scale to
	// 4000 rims and 128000 spokes while the frame scales to 2000.
	want := []manufacturingRequirement{
		{itemID: rimID, quantityThousandths: 4000},
		{itemID: spokeID, quantityThousandths: 128_000},
		{itemID: frameID, quantityThousandths: 2000},
	}
	if len(requirements) != len(want) {
		t.Fatalf("exploded requirements = %+v, want %+v", requirements, want)
	}
	for index, requirement := range requirements {
		if requirement != want[index] {
			t.Fatalf("exploded requirement %d = %+v, want %+v", index, requirement, want[index])
		}
	}
	if _, err := manufacturingExplodeBom([]manufacturingBomEdge{
		{assemblyItemID: "x1", componentItemID: "x2", quantityThousandths: 1000},
		{assemblyItemID: "x2", componentItemID: "x1", quantityThousandths: 1000},
	}, "x1", 1000); err == nil || err.Error() != "bill of materials contains a cycle" {
		t.Fatalf("cycle explosion err = %v, want cycle refusal", err)
	}

	availability := manufacturingCheckAvailability(requirements, map[string]int64{
		rimID: 4000, spokeID: 30_000, frameID: 2000,
	})
	if availability.producible || availability.totalShortfallThousandths != 98_000 {
		t.Fatalf("availability = %+v, want spokes short by 98000", availability)
	}
	satisfied := manufacturingCheckAvailability(want, map[string]int64{
		rimID: 4000, spokeID: 128_000, frameID: 2000,
	})
	if !satisfied.producible || satisfied.totalShortfallThousandths != 0 {
		t.Fatalf("satisfied availability = %+v, want producible", satisfied)
	}

	ceiling := manufacturingMaxProducibleUnits(
		[]manufacturingPerUnitNeed{{componentItemID: spokeID, perUnitThousandths: 33_600}, {componentItemID: rimID, perUnitThousandths: 1000}},
		map[string]int64{spokeID: 700_000, rimID: 600_000},
	)
	if ceiling != 20_833 {
		t.Fatalf("ceiling = %d, want 20833 from the spoke constraint", ceiling)
	}
	if got := manufacturingMaxProducibleUnits(nil, map[string]int64{}); got != 0 {
		t.Fatalf("empty needs ceiling = %d, want 0", got)
	}
}

func TestManufacturingWorkOrdersCreateAllocatesNumbersAndGuardsBoms(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupManufacturingWorkOrdersFixture(t, fx)
	claims := manufacturingClaims(fx)

	frameID := seedManufacturingItem(t, fx, fx.orgID, "FRAME")
	rimID := seedManufacturingItem(t, fx, fx.orgID, "RIM")
	spokeID := seedManufacturingItem(t, fx, fx.orgID, "SPOKE")
	wheelID := seedManufacturingItem(t, fx, fx.orgID, "WHEEL-ASSY")
	bikeID := seedManufacturingItem(t, fx, fx.orgID, "BIKE")
	seedManufacturingBomLine(t, fx, fx.orgID, wheelID, rimID, 1000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, wheelID, spokeID, 32_000, 50_000)
	seedManufacturingBomLine(t, fx, fx.orgID, bikeID, frameID, 1000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, bikeID, wheelID, 2000, 0)
	foreignBikeID := seedManufacturingItem(t, fx, fx.otherOrgID, "BIKE")
	seedManufacturingBomLine(t, fx, fx.otherOrgID, foreignBikeID, wheelID, 1000, 0)

	manufacturingExpectError(t, fx, fx.orgID, "no item with SKU NOPE", func(tx pgx.Tx) error {
		_, err := manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{AssemblySKU: "NOPE", PlannedQtyThousandths: 1000})
		return err
	})
	seedManufacturingItem(t, fx, fx.orgID, "WHEELLESS")
	manufacturingExpectError(t, fx, fx.orgID, "WHEELLESS has no bill of materials; define one first", func(tx pgx.Tx) error {
		_, err := manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{AssemblySKU: "WHEELLESS", PlannedQtyThousandths: 1000})
		return err
	})
	if got := fx.count(`SELECT count(*) FROM work_orders WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("refused work orders stored %d rows, want 0", got)
	}

	created := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{
			AssemblySKU: "BIKE", PlannedQtyThousandths: 3000, YieldPctThousandths: 900_000,
			WorkCenter: crmStringPointer("bay-2"), Note: crmStringPointer("spring batch"),
		})
	})
	if !isUUID(created.WorkOrderID) || created.Number != 1 || created.ExpectedGoodThousandths != 2700 {
		t.Fatalf("createWorkOrder output = %+v, want work order 1 expecting 2700 good units", created)
	}
	if encoded, err := marshalJS(created); err != nil {
		t.Fatal(err)
	} else if string(encoded) != fmt.Sprintf(`{"workOrderId":%q,"number":1,"expectedGoodThousandths":2700}`, created.WorkOrderID) {
		t.Fatalf("createWorkOrder output JSON = %s", encoded)
	}
	var number int64
	var status string
	var planned, produced, yield int64
	var workCenter, note *string
	var actorType string
	var actorID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT number, status, planned_qty_thousandths, produced_qty_thousandths, yield_pct_thousandths, work_center, note, created_by_actor_type, created_by_actor_id::text
		FROM work_orders WHERE id = $1::uuid`, created.WorkOrderID).Scan(&number, &status, &planned, &produced, &yield, &workCenter, &note, &actorType, &actorID); err != nil {
		t.Fatal(err)
	}
	if number != 1 || status != "draft" || planned != 3000 || produced != 0 || yield != 900_000 ||
		workCenter == nil || *workCenter != "bay-2" || note == nil || *note != "spring batch" ||
		actorType != "human" || actorID == nil || *actorID != fx.userID {
		t.Fatalf("stored work order = #%d %s planned=%d produced=%d yield=%d center=%v note=%v actor=%s/%v",
			number, status, planned, produced, yield, workCenter, note, actorType, actorID)
	}
	if got := fx.count(`SELECT "next" FROM doc_counters WHERE org_id = $1::uuid AND kind = 'work_order'`, fx.orgID); got != 1 {
		t.Fatalf("work_order counter = %d, want sequence resting at 1", got)
	}

	defaulted := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		// The yield default is a parser concern; direct construction passes
		// the parsed shape explicitly.
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{
			AssemblySKU: "BIKE", PlannedQtyThousandths: 1000, YieldPctThousandths: 1_000_000,
		})
	})
	if defaulted.Number != 2 || defaulted.ExpectedGoodThousandths != 1000 {
		t.Fatalf("second createWorkOrder output = %+v, want number 2 at full yield", defaulted)
	}
	var defaultYield int64
	var defaultCenter *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT yield_pct_thousandths, work_center FROM work_orders WHERE id = $1::uuid`, defaulted.WorkOrderID).Scan(&defaultYield, &defaultCenter); err != nil {
		t.Fatal(err)
	}
	if defaultYield != 1_000_000 || defaultCenter != nil {
		t.Fatalf("second work order yield=%d center=%v, want the full yield default and no center", defaultYield, defaultCenter)
	}

	legacyAssembly := seedManufacturingItem(t, fx, fx.otherOrgID, "LEGACY-GEAR")
	seedManufacturingBomLine(t, fx, fx.otherOrgID, legacyAssembly, wheelID, 1000, 0)
	seedManufacturingWorkOrderRow(t, fx, fx.otherOrgID, 42, legacyAssembly, "draft", 1000, 0, nil, nil)
	foreignClaims := manufacturingClaims(fx)
	foreignClaims.OrganizationID = fx.otherOrgID
	legacy := manufacturingInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, foreignClaims, ManufacturingCreateWorkOrderInput{AssemblySKU: "LEGACY-GEAR", PlannedQtyThousandths: 1000})
	})
	if legacy.Number != 43 {
		t.Fatalf("legacy org work order number = %d, want 43 seeded from MAX(number)", legacy.Number)
	}
	// Org scoping: the main org's create call resolves its own BIKE item
	// even though the other organization also defines a BIKE.
	var mainOrgAssemblyID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT assembly_item_id::text FROM work_orders WHERE id = $1::uuid`, created.WorkOrderID).Scan(&mainOrgAssemblyID); err != nil {
		t.Fatal(err)
	}
	if mainOrgAssemblyID != bikeID {
		t.Fatalf("main org work order assembly = %s, want the org-local BIKE item %s", mainOrgAssemblyID, bikeID)
	}
}

func TestManufacturingWorkOrdersReleaseGuardsStateAndAvailability(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupManufacturingWorkOrdersFixture(t, fx)
	claims := manufacturingClaims(fx)
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	frameID := seedManufacturingItem(t, fx, fx.orgID, "FRAME")
	rimID := seedManufacturingItem(t, fx, fx.orgID, "RIM")
	spokeID := seedManufacturingItem(t, fx, fx.orgID, "SPOKE")
	wheelID := seedManufacturingItem(t, fx, fx.orgID, "WHEEL-ASSY")
	bikeID := seedManufacturingItem(t, fx, fx.orgID, "BIKE")
	seedManufacturingBomLine(t, fx, fx.orgID, wheelID, rimID, 1000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, wheelID, spokeID, 32_000, 50_000)
	seedManufacturingBomLine(t, fx, fx.orgID, bikeID, frameID, 1000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, bikeID, wheelID, 2000, 0)
	seedManufacturingStock(t, fx, fx.orgID, frameID, 10_000, nil)
	seedManufacturingStock(t, fx, fx.orgID, rimID, 10_000, nil)
	seedManufacturingStock(t, fx, fx.orgID, spokeID, 300_000, nil)

	unknownWorkOrderID := executorUUID(t)
	manufacturingExpectError(t, fx, fx.orgID, fmt.Sprintf("no work order %s", unknownWorkOrderID), func(tx pgx.Tx) error {
		_, err := manufacturingReleaseWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: unknownWorkOrderID}, now)
		return err
	})

	created := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{
			AssemblySKU: "BIKE", PlannedQtyThousandths: 3000, YieldPctThousandths: 900_000,
		})
	})
	manufacturingExpectError(t, fx, fx.otherOrgID, fmt.Sprintf("no work order %s", created.WorkOrderID), func(tx pgx.Tx) error {
		_, err := manufacturingReleaseWorkOrder(fx.ctx, tx, fx.otherOrgID, ManufacturingWorkOrderIDInput{WorkOrderID: created.WorkOrderID}, now)
		return err
	})

	released := manufacturingRelease(t, fx, claims, created.WorkOrderID, now)
	if encoded, err := marshalJS(released); err != nil || string(encoded) != `{"released":true}` {
		t.Fatalf("release output = %s, %v", encoded, err)
	}
	var status string
	var releasedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, released_at FROM work_orders WHERE id = $1::uuid`, created.WorkOrderID).Scan(&status, &releasedAt); err != nil {
		t.Fatal(err)
	}
	if status != "released" || releasedAt == nil || !releasedAt.Equal(now) {
		t.Fatalf("released work order = %s at %v, want released at %v", status, releasedAt, now)
	}
	manufacturingExpectError(t, fx, fx.orgID, "work order #1 is released; only drafts can be released", func(tx pgx.Tx) error {
		_, err := manufacturingReleaseWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: created.WorkOrderID}, now)
		return err
	})

	short := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{AssemblySKU: "BIKE", PlannedQtyThousandths: 3000})
	})
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, actor_type)
		VALUES ($1::uuid, $2::uuid, -300000, 'adjustment', 'drain spokes', 'system')`, fx.orgID, spokeID); err != nil {
		t.Fatal(err)
	}
	manufacturingExpectError(t, fx, fx.orgID, "cannot release: components short of stock (SPOKE)", func(tx pgx.Tx) error {
		_, err := manufacturingReleaseWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: short.WorkOrderID}, now)
		return err
	})
	if got := fx.count(`SELECT count(*) FROM work_orders WHERE id = $1::uuid AND status = 'draft'`, short.WorkOrderID); got != 1 {
		t.Fatalf("refused release left %d draft rows, want the draft untouched", got)
	}

	noBom := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{AssemblySKU: "WHEEL-ASSY", PlannedQtyThousandths: 1000})
	})
	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM bom_lines WHERE org_id = $1::uuid AND assembly_item_id = $2::uuid`, fx.orgID, wheelID); err != nil {
		t.Fatal(err)
	}
	manufacturingExpectError(t, fx, fx.orgID, fmt.Sprintf("work order #%d: its bill of materials was deleted", noBom.Number), func(tx pgx.Tx) error {
		_, err := manufacturingReleaseWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: noBom.WorkOrderID}, now)
		return err
	})
}

func TestManufacturingWorkOrdersCompleteConsumesAndCloses(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupManufacturingWorkOrdersFixture(t, fx)
	claims := manufacturingClaims(fx)
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	frameID := seedManufacturingItem(t, fx, fx.orgID, "FRAME")
	rimID := seedManufacturingItem(t, fx, fx.orgID, "RIM")
	spokeID := seedManufacturingItem(t, fx, fx.orgID, "SPOKE")
	wheelID := seedManufacturingItem(t, fx, fx.orgID, "WHEEL-ASSY")
	bikeID := seedManufacturingItem(t, fx, fx.orgID, "BIKE")
	seedManufacturingBomLine(t, fx, fx.orgID, wheelID, rimID, 1000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, wheelID, spokeID, 32_000, 50_000)
	seedManufacturingBomLine(t, fx, fx.orgID, bikeID, frameID, 1000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, bikeID, wheelID, 2000, 0)
	frameCost, rimCost, spokeCost := int64(900_000), int64(2_000), int64(5)
	seedManufacturingStock(t, fx, fx.orgID, frameID, 10_000, &frameCost)
	seedManufacturingStock(t, fx, fx.orgID, rimID, 10_000, &rimCost)
	seedManufacturingStock(t, fx, fx.orgID, spokeID, 400_000, &spokeCost)

	created := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{
			AssemblySKU: "BIKE", PlannedQtyThousandths: 3000, YieldPctThousandths: 900_000,
		})
	})
	manufacturingExpectError(t, fx, fx.orgID, "work order #1 is draft; only released orders can complete", func(tx pgx.Tx) error {
		_, err := manufacturingCompleteWorkOrder(fx.ctx, tx, claims, ManufacturingCompleteWorkOrderInput{WorkOrderID: created.WorkOrderID, QuantityThousandths: 1000}, now)
		return err
	})
	missingWorkOrderID := executorUUID(t)
	manufacturingExpectError(t, fx, fx.orgID, fmt.Sprintf("no work order %s", missingWorkOrderID), func(tx pgx.Tx) error {
		_, err := manufacturingCompleteWorkOrder(fx.ctx, tx, claims, ManufacturingCompleteWorkOrderInput{WorkOrderID: missingWorkOrderID, QuantityThousandths: 1000}, now)
		return err
	})
	manufacturingRelease(t, fx, claims, created.WorkOrderID, now)

	// 1 bike: FRAME 1000, RIM 2000, SPOKE ceil(64000 x 1.05) = 67200.
	// Value: 900000 + 4000 + 336 = 904336 minor rolled onto the output.
	first := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCompleteWorkOrderOutput, error) {
		return manufacturingCompleteWorkOrder(fx.ctx, tx, claims, ManufacturingCompleteWorkOrderInput{WorkOrderID: created.WorkOrderID, QuantityThousandths: 1000}, now)
	})
	if !isUUID(first.RunRef) || first.Completed || first.ProducedTotalThousandths != 1000 || first.Status != "released" ||
		first.ProducedThousandths != 1000 || first.CostRolledUpMinor != 904_336 || len(first.ConsumedComponents) != 3 {
		t.Fatalf("first completion = %+v, want a partial build costing 904336", first)
	}
	wantConsumed := map[string]int64{"FRAME": 1000, "RIM": 2000, "SPOKE": 67_200}
	for _, component := range first.ConsumedComponents {
		if wantConsumed[component.SKU] != component.QuantityThousandths {
			t.Fatalf("consumed %s = %d, want %d", component.SKU, component.QuantityThousandths, wantConsumed[component.SKU])
		}
	}
	if encoded, err := marshalJS(first); err != nil {
		t.Fatal(err)
	} else if !strings.HasPrefix(string(encoded), fmt.Sprintf(`{"runRef":%q,"completed":false,"producedTotalThousandths":1000,"status":"released","producedThousandths":1000,"consumedComponents":[`, first.RunRef)) {
		t.Fatalf("completion output JSON = %s", encoded)
	}
	manufacturingExpectError(t, fx, fx.orgID, "completion exceeds plan: only 2000 thousandths remain on work order #1", func(tx pgx.Tx) error {
		_, err := manufacturingCompleteWorkOrder(fx.ctx, tx, claims, ManufacturingCompleteWorkOrderInput{WorkOrderID: created.WorkOrderID, QuantityThousandths: 9000}, now)
		return err
	})

	second := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCompleteWorkOrderOutput, error) {
		return manufacturingCompleteWorkOrder(fx.ctx, tx, claims, ManufacturingCompleteWorkOrderInput{WorkOrderID: created.WorkOrderID, QuantityThousandths: 2000}, now)
	})
	if !second.Completed || second.Status != "completed" || second.ProducedTotalThousandths != 3000 || second.ProducedThousandths != 2000 {
		t.Fatalf("second completion = %+v, want the order closed at 3000 built", second)
	}
	var status string
	var producedQty int64
	var completedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, produced_qty_thousandths, completed_at FROM work_orders WHERE id = $1::uuid`, created.WorkOrderID).Scan(&status, &producedQty, &completedAt); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || producedQty != 3000 || completedAt == nil || !completedAt.Equal(now) {
		t.Fatalf("completed work order = %s produced=%d at %v", status, producedQty, completedAt)
	}

	for itemID, wantOnHand := range map[string]int64{frameID: 7000, rimID: 4000, spokeID: 198_400, bikeID: 3000} {
		var onHand int64
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id = $1::uuid AND item_id = $2::uuid`,
			fx.orgID, itemID).Scan(&onHand); err != nil {
			t.Fatal(err)
		}
		if onHand != wantOnHand {
			t.Fatalf("on hand for %s = %d, want %d", itemID, onHand, wantOnHand)
		}
	}
	var outputUnitCost *int64
	var outputNote, outputRefID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT unit_cost_minor, note, ref_id::text FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND ref_type = 'production' AND quantity_delta = 1000`,
		fx.orgID, bikeID).Scan(&outputUnitCost, &outputNote, &outputRefID); err != nil {
		t.Fatal(err)
	}
	if outputUnitCost == nil || *outputUnitCost != 904_336 || outputNote != "produced from BOM (3 component kinds)" || outputRefID != first.RunRef {
		t.Fatalf("output leg = cost %v note %q ref %s", outputUnitCost, outputNote, outputRefID)
	}
	if got := fx.count(`
		SELECT count(*) FROM stock_movements
		WHERE org_id = $1::uuid AND ref_type = 'production' AND ref_id = $2::uuid`, fx.orgID, first.RunRef); got != 4 {
		t.Fatalf("run %s posted %d movements, want 3 consumption legs plus 1 output leg", first.RunRef, got)
	}
	var spokeConsumedCost *int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT unit_cost_minor FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND ref_id = $3::uuid AND quantity_delta = -67200`,
		fx.orgID, spokeID, first.RunRef).Scan(&spokeConsumedCost); err != nil {
		t.Fatal(err)
	}
	if spokeConsumedCost == nil || *spokeConsumedCost != 5 {
		t.Fatalf("spoke consumption unit cost = %v, want 5 minor per unit", spokeConsumedCost)
	}

	manufacturingExpectError(t, fx, fx.orgID, "work order #1 is completed and cannot be cancelled; use reverseProductionRun", func(tx pgx.Tx) error {
		_, err := manufacturingCancelWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: created.WorkOrderID}, now)
		return err
	})

	partial := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{AssemblySKU: "BIKE", PlannedQtyThousandths: 2000})
	})
	manufacturingRelease(t, fx, claims, partial.WorkOrderID, now)
	partialDone := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCompleteWorkOrderOutput, error) {
		return manufacturingCompleteWorkOrder(fx.ctx, tx, claims, ManufacturingCompleteWorkOrderInput{
			WorkOrderID: partial.WorkOrderID, QuantityThousandths: 1000, LotCode: crmStringPointer("BIKE-LOT-9"),
		}, now)
	})
	if partialDone.Completed || partialDone.Status != "released" {
		t.Fatalf("lotted partial completion = %+v, want the order still released", partialDone)
	}
	var lotID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM lots WHERE org_id = $1::uuid AND item_id = $2::uuid AND lot_code = 'BIKE-LOT-9'`,
		fx.orgID, bikeID).Scan(&lotID); err != nil {
		t.Fatal(err)
	}
	var lottedMovementLot *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT lot_id::text FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND ref_id = $3::uuid AND quantity_delta = 1000`,
		fx.orgID, bikeID, partialDone.RunRef).Scan(&lottedMovementLot); err != nil {
		t.Fatal(err)
	}
	if lottedMovementLot == nil || *lottedMovementLot != lotID {
		t.Fatalf("lotted output leg lot = %v, want %s", lottedMovementLot, lotID)
	}
	manufacturingExpectError(t, fx, fx.orgID, "work order #2 has partial completions and cannot be cancelled; reverse them via manufacturing.reverseProductionRun first", func(tx pgx.Tx) error {
		_, err := manufacturingCancelWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: partial.WorkOrderID}, now)
		return err
	})

	draft := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{AssemblySKU: "BIKE", PlannedQtyThousandths: 1000})
	})
	cancelled := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCancelWorkOrderOutput, error) {
		return manufacturingCancelWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: draft.WorkOrderID}, now)
	})
	if encoded, err := marshalJS(cancelled); err != nil || string(encoded) != `{"cancelled":true}` {
		t.Fatalf("cancel output = %s, %v", encoded, err)
	}
	var cancelledStatus string
	var cancelledAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, cancelled_at FROM work_orders WHERE id = $1::uuid`, draft.WorkOrderID).Scan(&cancelledStatus, &cancelledAt); err != nil {
		t.Fatal(err)
	}
	if cancelledStatus != "cancelled" || cancelledAt == nil || !cancelledAt.Equal(now) {
		t.Fatalf("cancelled work order = %s at %v", cancelledStatus, cancelledAt)
	}
	manufacturingExpectError(t, fx, fx.orgID, fmt.Sprintf("work order #%d is already cancelled", draft.Number), func(tx pgx.Tx) error {
		_, err := manufacturingCancelWorkOrder(fx.ctx, tx, fx.orgID, ManufacturingWorkOrderIDInput{WorkOrderID: draft.WorkOrderID}, now)
		return err
	})
	manufacturingExpectError(t, fx, fx.otherOrgID, fmt.Sprintf("no work order %s", draft.WorkOrderID), func(tx pgx.Tx) error {
		_, err := manufacturingCancelWorkOrder(fx.ctx, tx, fx.otherOrgID, ManufacturingWorkOrderIDInput{WorkOrderID: draft.WorkOrderID}, now)
		return err
	})

	// Complete-time feasibility refuses with SKU labels, mirroring postRun.
	shortage := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{AssemblySKU: "BIKE", PlannedQtyThousandths: 1000})
	})
	manufacturingRelease(t, fx, claims, shortage.WorkOrderID, now)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, actor_type)
		VALUES ($1::uuid, $2::uuid, -131200, 'adjustment', 'drain spokes', 'system')`, fx.orgID, spokeID); err != nil {
		t.Fatal(err)
	}
	manufacturingExpectError(t, fx, fx.orgID, "insufficient stock: SPOKE short 67.200", func(tx pgx.Tx) error {
		_, err := manufacturingCompleteWorkOrder(fx.ctx, tx, claims, ManufacturingCompleteWorkOrderInput{WorkOrderID: shortage.WorkOrderID, QuantityThousandths: 1000}, now)
		return err
	})
	if got := fx.count(`SELECT count(*) FROM work_orders WHERE id = $1::uuid AND status = 'released' AND produced_qty_thousandths = 0`, shortage.WorkOrderID); got != 1 {
		t.Fatalf("refused completion mutated the work order, want it untouched (got %d)", got)
	}
}

func TestManufacturingWorkOrdersProduceAndReverseRun(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupManufacturingWorkOrdersFixture(t, fx)
	claims := manufacturingClaims(fx)

	boltID := seedManufacturingItem(t, fx, fx.orgID, "BOLT")
	frameID := seedManufacturingItem(t, fx, fx.orgID, "FRAME")
	chairID := seedManufacturingItem(t, fx, fx.orgID, "CHAIR-ASSY")
	seedManufacturingBomLine(t, fx, fx.orgID, chairID, boltID, 2000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, chairID, frameID, 1000, 0)
	boltCost, frameCost := int64(100), int64(90_000)
	seedManufacturingStock(t, fx, fx.orgID, boltID, 700_000, &boltCost)
	seedManufacturingStock(t, fx, fx.orgID, frameID, 600_000, &frameCost)
	seedManufacturingItem(t, fx, fx.orgID, "NOBOM")

	manufacturingExpectError(t, fx, fx.orgID, "no item with SKU NOPE", func(tx pgx.Tx) error {
		_, err := manufacturingProduceFromBom(fx.ctx, tx, claims, ManufacturingProduceFromBomInput{AssemblySKU: "NOPE", QuantityThousandths: 1000})
		return err
	})
	manufacturingExpectError(t, fx, fx.orgID, "NOBOM has no bill of materials; define one first", func(tx pgx.Tx) error {
		_, err := manufacturingProduceFromBom(fx.ctx, tx, claims, ManufacturingProduceFromBomInput{AssemblySKU: "NOBOM", QuantityThousandths: 1000})
		return err
	})
	// produceFromBom names shortfalls by raw item id, matching the TypeScript;
	// both components are short, joined in explodeBom's item id order.
	boltShort := fmt.Sprintf("%s short 999300.000", boltID)
	frameShort := fmt.Sprintf("%s short 499400.000", frameID)
	wantShortage := "insufficient stock: " + boltShort + "; " + frameShort
	if boltID > frameID {
		wantShortage = "insufficient stock: " + frameShort + "; " + boltShort
	}
	manufacturingExpectError(t, fx, fx.orgID, wantShortage, func(tx pgx.Tx) error {
		_, err := manufacturingProduceFromBom(fx.ctx, tx, claims, ManufacturingProduceFromBomInput{AssemblySKU: "CHAIR-ASSY", QuantityThousandths: 500_000_000})
		return err
	})

	produced := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingProduceFromBomOutput, error) {
		return manufacturingProduceFromBom(fx.ctx, tx, claims, ManufacturingProduceFromBomInput{AssemblySKU: "CHAIR-ASSY", QuantityThousandths: 100_000})
	})
	if !isUUID(produced.RunRef) || produced.ProducedThousandths != 100_000 || produced.CostRolledUpMinor != 9_020_000 || len(produced.ConsumedComponents) != 2 {
		t.Fatalf("produceFromBom output = %+v, want 100 units at 9020000 minor", produced)
	}
	wantConsumed := map[string]int64{"BOLT": 200_000, "FRAME": 100_000}
	for _, component := range produced.ConsumedComponents {
		if wantConsumed[component.SKU] != component.QuantityThousandths {
			t.Fatalf("consumed %s = %d, want %d", component.SKU, component.QuantityThousandths, wantConsumed[component.SKU])
		}
	}
	if encoded, err := marshalJS(produced); err != nil {
		t.Fatal(err)
	} else if !strings.HasPrefix(string(encoded), fmt.Sprintf(`{"runRef":%q,"producedThousandths":100000,"consumedComponents":[`, produced.RunRef)) {
		t.Fatalf("produceFromBom output JSON = %s", encoded)
	}
	var outputLot *string
	var outputUnitCost *int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT lot_id::text, unit_cost_minor FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND ref_id = $3::uuid AND quantity_delta > 0`,
		fx.orgID, chairID, produced.RunRef).Scan(&outputLot, &outputUnitCost); err != nil {
		t.Fatal(err)
	}
	if outputLot != nil || outputUnitCost == nil || *outputUnitCost != 90_200 {
		t.Fatalf("produce output leg = lot %v cost %v, want no lot at 90200 per unit", outputLot, outputUnitCost)
	}

	type reversalResult struct {
		output ManufacturingReverseProductionRunOutput
		err    error
	}
	start := make(chan struct{})
	results := make(chan reversalResult, 2)
	for range 2 {
		go func() {
			<-start
			output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ManufacturingReverseProductionRunOutput, error) {
				return manufacturingReverseProductionRun(fx.ctx, tx, claims, ManufacturingRunRefInput{RunRef: produced.RunRef})
			})
			results <- reversalResult{output: output, err: err}
		}()
	}
	close(start)
	var reversed ManufacturingReverseProductionRunOutput
	var reversalSuccesses int
	var reversalRefusals int
	for range 2 {
		result := <-results
		if result.err == nil {
			reversed = result.output
			reversalSuccesses++
		} else if strings.Contains(result.err.Error(), "this production run has already been reversed") {
			reversalRefusals++
		} else {
			t.Fatalf("concurrent reversal failed unexpectedly: %v", result.err)
		}
	}
	if reversalSuccesses != 1 || reversalRefusals != 1 {
		t.Fatalf("concurrent reversal results: %d succeeded, %d were refused, want one of each", reversalSuccesses, reversalRefusals)
	}
	if reversed.ReversedMovements != 3 || reversed.RemovedFinishedThousandths != 100_000 || len(reversed.RemovedProduced) != 1 || len(reversed.RestoredComponents) != 2 {
		t.Fatalf("reversal = %+v, want 3 mirrored movements and the finished units removed", reversed)
	}
	sort.Slice(reversed.RestoredComponents, func(i, j int) bool { return reversed.RestoredComponents[i].SKU < reversed.RestoredComponents[j].SKU })
	if reversed.RestoredComponents[0].SKU != "BOLT" || reversed.RestoredComponents[0].QuantityThousandths != 200_000 ||
		reversed.RestoredComponents[1].SKU != "FRAME" || reversed.RestoredComponents[1].QuantityThousandths != 100_000 {
		t.Fatalf("restored components = %+v, want BOLT 200000 and FRAME 100000", reversed.RestoredComponents)
	}
	if encoded, err := marshalJS(reversed); err != nil {
		t.Fatal(err)
	} else if !strings.HasPrefix(string(encoded), `{"reversedMovements":3,"removedFinishedThousandths":100000,"restoredComponents":[`) {
		t.Fatalf("reversal output JSON = %s", encoded)
	}
	for itemID, wantOnHand := range map[string]int64{boltID: 700_000, frameID: 600_000, chairID: 0} {
		var onHand int64
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id = $1::uuid AND item_id = $2::uuid`,
			fx.orgID, itemID).Scan(&onHand); err != nil {
			t.Fatal(err)
		}
		if onHand != wantOnHand {
			t.Fatalf("on hand after reversal for %s = %d, want %d", itemID, onHand, wantOnHand)
		}
	}
	reversalLegs := fx.count(`
		SELECT count(*) FROM stock_movements
		WHERE org_id = $1::uuid AND ref_type = 'production_reversal' AND ref_id = $2::uuid`, fx.orgID, produced.RunRef)
	if reversalLegs != 3 {
		t.Fatalf("reversal appended %d movements, want 3 append-only mirror legs", reversalLegs)
	}
	manufacturingExpectError(t, fx, fx.orgID, "this production run has already been reversed", func(tx pgx.Tx) error {
		_, err := manufacturingReverseProductionRun(fx.ctx, tx, claims, ManufacturingRunRefInput{RunRef: produced.RunRef})
		return err
	})
	unknownRunRef := executorUUID(t)
	manufacturingExpectError(t, fx, fx.orgID, fmt.Sprintf("no production run found for %s", unknownRunRef), func(tx pgx.Tx) error {
		_, err := manufacturingReverseProductionRun(fx.ctx, tx, claims, ManufacturingRunRefInput{RunRef: unknownRunRef})
		return err
	})
	manufacturingExpectError(t, fx, fx.otherOrgID, fmt.Sprintf("no production run found for %s", produced.RunRef), func(tx pgx.Tx) error {
		foreignClaims := manufacturingClaims(fx)
		foreignClaims.OrganizationID = fx.otherOrgID
		_, err := manufacturingReverseProductionRun(fx.ctx, tx, foreignClaims, ManufacturingRunRefInput{RunRef: produced.RunRef})
		return err
	})

	// A run whose produced units already left stock refuses to reverse.
	again := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingProduceFromBomOutput, error) {
		return manufacturingProduceFromBom(fx.ctx, tx, claims, ManufacturingProduceFromBomInput{AssemblySKU: "CHAIR-ASSY", QuantityThousandths: 100_000})
	})
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, actor_type)
		VALUES ($1::uuid, $2::uuid, -50000, 'sale', 'chairs sold', 'system')`, fx.orgID, chairID); err != nil {
		t.Fatal(err)
	}
	manufacturingExpectError(t, fx, fx.orgID, "cannot reverse: produced units have already been consumed or sold", func(tx pgx.Tx) error {
		_, err := manufacturingReverseProductionRun(fx.ctx, tx, claims, ManufacturingRunRefInput{RunRef: again.RunRef})
		return err
	})
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id = $1::uuid AND ref_type = 'production_reversal' AND ref_id = $2::uuid`, fx.orgID, again.RunRef); got != 0 {
		t.Fatalf("refused reversal appended %d movements, want none", got)
	}
}

func TestManufacturingWorkOrdersFeasibilityAndList(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupManufacturingWorkOrdersFixture(t, fx)
	claims := manufacturingClaims(fx)

	boltID := seedManufacturingItem(t, fx, fx.orgID, "BOLT")
	frameID := seedManufacturingItem(t, fx, fx.orgID, "FRAME")
	chairID := seedManufacturingItem(t, fx, fx.orgID, "CHAIR-ASSY")
	seedManufacturingBomLine(t, fx, fx.orgID, chairID, boltID, 2000, 0)
	seedManufacturingBomLine(t, fx, fx.orgID, chairID, frameID, 1000, 0)
	seedManufacturingStock(t, fx, fx.orgID, boltID, 700_000, nil)
	seedManufacturingStock(t, fx, fx.orgID, frameID, 600_000, nil)
	seedManufacturingItem(t, fx, fx.orgID, "NOBOM")
	releasedAt := time.Date(2026, 9, 25, 8, 0, 0, 0, time.UTC)
	completedAt := time.Date(2026, 9, 27, 8, 0, 0, 0, time.UTC)
	seedManufacturingWorkOrderRow(t, fx, fx.orgID, 1, chairID, "completed", 10_000, 10_000, &releasedAt, &completedAt)

	manufacturingExpectError(t, fx, fx.orgID, "no item with sku NOPE", func(tx pgx.Tx) error {
		_, err := manufacturingCheckProductionFeasibility(fx.ctx, tx, fx.orgID, ManufacturingCheckProductionFeasibilityInput{AssemblySKU: "NOPE", DesiredUnitsThousandths: 1000})
		return err
	})
	manufacturingExpectError(t, fx, fx.orgID, "item NOBOM has no bill of materials; nothing to explode", func(tx pgx.Tx) error {
		_, err := manufacturingCheckProductionFeasibility(fx.ctx, tx, fx.orgID, ManufacturingCheckProductionFeasibilityInput{AssemblySKU: "NOBOM", DesiredUnitsThousandths: 1000})
		return err
	})

	answer := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCheckProductionFeasibilityOutput, error) {
		return manufacturingCheckProductionFeasibility(fx.ctx, tx, fx.orgID, ManufacturingCheckProductionFeasibilityInput{AssemblySKU: "CHAIR-ASSY", DesiredUnitsThousandths: 500_000})
	})
	if answer.Producible || answer.MaxProducibleThousandths != 350_000 || answer.EstimatedLeadTimeDays == nil || *answer.EstimatedLeadTimeDays != 2 {
		t.Fatalf("feasibility = %+v, want infeasible with ceiling 350000 and lead 2 days", answer)
	}
	if len(answer.Lines) != 2 {
		t.Fatalf("feasibility lines = %+v, want one line per component", answer.Lines)
	}
	for _, line := range answer.Lines {
		if line.ItemID == boltID {
			if line.RequiredThousandths != 1_000_000 || line.OnHandThousandths != 700_000 || line.ShortfallThousandths != 300_000 {
				t.Fatalf("bolt line = %+v, want 300000 short", line)
			}
		} else if line.ItemID == frameID {
			if line.RequiredThousandths != 500_000 || line.OnHandThousandths != 600_000 || line.ShortfallThousandths != 0 {
				t.Fatalf("frame line = %+v, want satisfied", line)
			}
		} else {
			t.Fatalf("unexpected feasibility line %s", line.ItemID)
		}
	}
	answerJSON, err := marshalJS(answer)
	if err != nil {
		t.Fatal(err)
	}
	// explodeBom sorts requirements by item id, so build the expected pair
	// in that order instead of assuming which uuid sorts first.
	boltLine := fmt.Sprintf(`{"itemId":%q,"requiredThousandths":1000000,"onHandThousandths":700000,"shortfallThousandths":300000}`, boltID)
	frameLine := fmt.Sprintf(`{"itemId":%q,"requiredThousandths":500000,"onHandThousandths":600000,"shortfallThousandths":0}`, frameID)
	pair := "[" + frameLine + "," + boltLine + "]"
	if boltID < frameID {
		pair = "[" + boltLine + "," + frameLine + "]"
	}
	wantJSON := fmt.Sprintf(`{"producible":false,"maxProducibleThousandths":350000,"estimatedLeadTimeDays":2,"lines":%s}`, pair)
	if string(answerJSON) != wantJSON {
		t.Fatalf("feasibility JSON = %s, want %s", answerJSON, wantJSON)
	}

	producible := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCheckProductionFeasibilityOutput, error) {
		return manufacturingCheckProductionFeasibility(fx.ctx, tx, fx.orgID, ManufacturingCheckProductionFeasibilityInput{AssemblySKU: "CHAIR-ASSY", DesiredUnitsThousandths: 350_000})
	})
	if !producible.Producible || producible.MaxProducibleThousandths != 350_000 {
		t.Fatalf("producible answer = %+v, want producible at the ceiling", producible)
	}

	manufacturingExpectError(t, fx, fx.otherOrgID, "no item with sku CHAIR-ASSY", func(tx pgx.Tx) error {
		_, err := manufacturingCheckProductionFeasibility(fx.ctx, tx, fx.otherOrgID, ManufacturingCheckProductionFeasibilityInput{AssemblySKU: "CHAIR-ASSY", DesiredUnitsThousandths: 1000})
		return err
	})

	emptyList := manufacturingInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (ManufacturingWorkOrdersListOutput, error) {
		return manufacturingWorkOrdersList(fx.ctx, tx, fx.otherOrgID, ManufacturingWorkOrdersListInput{Limit: 50})
	})
	if encoded, err := marshalJS(emptyList); err != nil || string(encoded) != `{"workOrders":[]}` {
		t.Fatalf("empty list = %s, %v", encoded, err)
	}

	draft := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{
			AssemblySKU: "CHAIR-ASSY", PlannedQtyThousandths: 3000, YieldPctThousandths: 900_000, Note: crmStringPointer("autumn run"),
		})
	})
	toRelease := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{
			AssemblySKU: "CHAIR-ASSY", PlannedQtyThousandths: 1000, YieldPctThousandths: 1_000_000,
		})
	})
	manufacturingRelease(t, fx, claims, toRelease.WorkOrderID, time.Date(2026, 9, 29, 13, 0, 0, 0, time.UTC))
	toCancel := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingCreateWorkOrderOutput, error) {
		return manufacturingCreateWorkOrder(fx.ctx, tx, claims, ManufacturingCreateWorkOrderInput{
			AssemblySKU: "CHAIR-ASSY", PlannedQtyThousandths: 1000, YieldPctThousandths: 1_000_000,
		})
	})
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE work_orders SET status = 'cancelled', cancelled_at = $2 WHERE id = $1::uuid`,
		toCancel.WorkOrderID, time.Date(2026, 9, 29, 14, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	all := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingWorkOrdersListOutput, error) {
		return manufacturingWorkOrdersList(fx.ctx, tx, fx.orgID, ManufacturingWorkOrdersListInput{Limit: 50})
	})
	if len(all.WorkOrders) != 4 {
		t.Fatalf("list = %+v, want the four organization work orders (three created plus the seeded completed row)", all.WorkOrders)
	}
	if all.WorkOrders[0].ID != toCancel.WorkOrderID || all.WorkOrders[1].ID != toRelease.WorkOrderID || all.WorkOrders[2].ID != draft.WorkOrderID {
		t.Fatalf("list order = %s, %s, %s, want newest first", all.WorkOrders[0].ID, all.WorkOrders[1].ID, all.WorkOrders[2].ID)
	}
	latest := all.WorkOrders[0]
	if latest.Status != "cancelled" || latest.AssemblySKU != "CHAIR-ASSY" ||
		latest.PlannedQtyThousandths != 1000 || latest.ProducedQtyThousandths != 0 ||
		latest.YieldPctThousandths != 1_000_000 || latest.ExpectedGoodThousandths != 1000 || latest.Note != nil {
		t.Fatalf("latest list item = %+v, want the cancelled order at full yield", latest)
	}
	var storedCreatedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT created_at FROM work_orders WHERE id = $1::uuid`, draft.WorkOrderID).Scan(&storedCreatedAt); err != nil {
		t.Fatal(err)
	}
	oldest := all.WorkOrders[2]
	if oldest.YieldPctThousandths != 900_000 || oldest.ExpectedGoodThousandths != 2700 || oldest.Note == nil || *oldest.Note != "autumn run" {
		t.Fatalf("draft list item = %+v, want the 90 percent yield draft", oldest)
	}
	if oldest.CreatedAt != storedCreatedAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z") {
		t.Fatalf("createdAt %s does not match the stored row %v", oldest.CreatedAt, storedCreatedAt)
	}

	releasedOnly := manufacturingInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ManufacturingWorkOrdersListOutput, error) {
		return manufacturingWorkOrdersList(fx.ctx, tx, fx.orgID, ManufacturingWorkOrdersListInput{Status: crmStringPointer("released"), Limit: 50})
	})
	if len(releasedOnly.WorkOrders) != 1 || releasedOnly.WorkOrders[0].ID != toRelease.WorkOrderID {
		t.Fatalf("released filter = %+v, want only the released order", releasedOnly.WorkOrders)
	}
	if encoded, err := marshalJS(releasedOnly); err != nil {
		t.Fatal(err)
	} else if !strings.HasPrefix(string(encoded), fmt.Sprintf(`{"workOrders":[{"id":%q,"number":%d,"assemblySku":"CHAIR-ASSY","status":"released","plannedQtyThousandths":1000`, toRelease.WorkOrderID, toRelease.Number)) {
		t.Fatalf("released filter JSON = %s", encoded)
	}

	foreignList := manufacturingInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (ManufacturingWorkOrdersListOutput, error) {
		return manufacturingWorkOrdersList(fx.ctx, tx, fx.otherOrgID, ManufacturingWorkOrdersListInput{Limit: 50})
	})
	if len(foreignList.WorkOrders) != 0 {
		t.Fatalf("foreign list = %+v, want no cross-organization rows", foreignList.WorkOrders)
	}
}
