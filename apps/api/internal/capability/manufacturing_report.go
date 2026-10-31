package capability

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

const manufacturingOverviewReportCapabilityID = "manufacturing.overviewReport"

type ManufacturingOverviewReportInput struct{}

type ManufacturingOverviewBom struct {
	AssemblySKU         string `json:"assemblySku"`
	ComponentSKU        string `json:"componentSku"`
	ComponentName       string `json:"componentName"`
	QuantityThousandths int64  `json:"quantityThousandths"`
	ScrapPctThousandths int64  `json:"scrapPctThousandths"`
}

type ManufacturingOverviewAssembly struct {
	SKU  string `json:"sku"`
	Name string `json:"name"`
}

type ManufacturingOverviewWorkOrder struct {
	ID                      string  `json:"id"`
	Number                  int64   `json:"number"`
	AssemblySKU             string  `json:"assemblySku"`
	AssemblyName            string  `json:"assemblyName"`
	Status                  string  `json:"status"`
	PlannedQtyThousandths   int64   `json:"plannedQtyThousandths"`
	ProducedQtyThousandths  int64   `json:"producedQtyThousandths"`
	YieldPctThousandths     int64   `json:"yieldPctThousandths"`
	ExpectedGoodThousandths int64   `json:"expectedGoodThousandths"`
	Note                    *string `json:"note"`
	CreatedAt               string  `json:"createdAt"`
	CompletedAt             *string `json:"completedAt"`
}

type ManufacturingOverviewProductionComponent struct {
	SKU                 string  `json:"sku"`
	QuantityThousandths int64   `json:"quantityThousandths"`
	LotCode             *string `json:"lotCode"`
}

type ManufacturingOverviewProductionRun struct {
	RunID               string                                     `json:"runId"`
	OccurredAt          string                                     `json:"occurredAt"`
	AssemblySKU         string                                     `json:"assemblySku"`
	ProducedThousandths int64                                      `json:"producedThousandths"`
	UnitCostMinor       int64                                      `json:"unitCostMinor"`
	CostTotalMinor      int64                                      `json:"costTotalMinor"`
	Reversed            bool                                       `json:"reversed"`
	Components          []ManufacturingOverviewProductionComponent `json:"components"`
}

type ManufacturingOverviewLot struct {
	ID                 string  `json:"id"`
	SKU                string  `json:"sku"`
	LotCode            string  `json:"lotCode"`
	ExpiresAt          *string `json:"expiresAt"`
	BalanceThousandths int64   `json:"balanceThousandths"`
}

type ManufacturingOverviewReportOutput struct {
	BOMs           []ManufacturingOverviewBom           `json:"boms"`
	Assemblies     []ManufacturingOverviewAssembly      `json:"assemblies"`
	WorkOrders     []ManufacturingOverviewWorkOrder     `json:"workOrders"`
	ProductionRuns []ManufacturingOverviewProductionRun `json:"productionRuns"`
	Lots           []ManufacturingOverviewLot           `json:"lots"`
}

type manufacturingReportItem struct{ sku, name string }

func parseManufacturingOverviewReportInput(raw json.RawMessage) (ManufacturingOverviewReportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingOverviewReportInput{}, err
	}
	if len(fields) != 0 {
		return ManufacturingOverviewReportInput{}, errors.New("input must be an empty object")
	}
	return ManufacturingOverviewReportInput{}, nil
}

func manufacturingOverviewReport(ctx context.Context, tx pgx.Tx, orgID string, _ ManufacturingOverviewReportInput) (ManufacturingOverviewReportOutput, error) {
	out := ManufacturingOverviewReportOutput{
		BOMs: []ManufacturingOverviewBom{}, Assemblies: []ManufacturingOverviewAssembly{},
		WorkOrders: []ManufacturingOverviewWorkOrder{}, ProductionRuns: []ManufacturingOverviewProductionRun{}, Lots: []ManufacturingOverviewLot{},
	}

	itemRows, err := tx.Query(ctx, `SELECT id::text, sku, name FROM items WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return ManufacturingOverviewReportOutput{}, err
	}
	itemsByID := make(map[string]manufacturingReportItem)
	for itemRows.Next() {
		var id string
		var item manufacturingReportItem
		if err := itemRows.Scan(&id, &item.sku, &item.name); err != nil {
			itemRows.Close()
			return ManufacturingOverviewReportOutput{}, err
		}
		itemsByID[id] = item
		out.Assemblies = append(out.Assemblies, ManufacturingOverviewAssembly{SKU: item.sku, Name: item.name})
	}
	if err := itemRows.Err(); err != nil {
		itemRows.Close()
		return ManufacturingOverviewReportOutput{}, err
	}
	itemRows.Close()

	bomRows, err := tx.Query(ctx, `
		SELECT bl.assembly_item_id::text, bl.component_item_id::text, bl.quantity_thousandths, bl.scrap_pct_thousandths
		FROM bom_lines bl WHERE bl.org_id=$1::uuid`, orgID)
	if err != nil {
		return ManufacturingOverviewReportOutput{}, err
	}
	for bomRows.Next() {
		var assemblyID, componentID string
		var edge ManufacturingOverviewBom
		if err := bomRows.Scan(&assemblyID, &componentID, &edge.QuantityThousandths, &edge.ScrapPctThousandths); err != nil {
			bomRows.Close()
			return ManufacturingOverviewReportOutput{}, err
		}
		if !reportSafeInteger(edge.QuantityThousandths) || !reportSafeInteger(edge.ScrapPctThousandths) {
			bomRows.Close()
			return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report quantity exceeds the supported amount range")
		}
		assembly, ok := itemsByID[assemblyID]
		if ok {
			edge.AssemblySKU = assembly.sku
		} else {
			edge.AssemblySKU = assemblyID
		}
		component, ok := itemsByID[componentID]
		if ok {
			edge.ComponentSKU = component.sku
			edge.ComponentName = component.name
		} else {
			edge.ComponentSKU = componentID
		}
		out.BOMs = append(out.BOMs, edge)
	}
	if err := bomRows.Err(); err != nil {
		bomRows.Close()
		return ManufacturingOverviewReportOutput{}, err
	}
	bomRows.Close()

	workOrderRows, err := tx.Query(ctx, `
		SELECT wo.id::text, wo.number, i.sku, i.name, wo.status,
			wo.planned_qty_thousandths, wo.produced_qty_thousandths, wo.yield_pct_thousandths,
			wo.note, wo.created_at, wo.completed_at
		FROM work_orders wo INNER JOIN items i ON i.id=wo.assembly_item_id AND i.org_id=wo.org_id
		WHERE wo.org_id=$1::uuid
		ORDER BY wo.created_at DESC LIMIT 100`, orgID)
	if err != nil {
		return ManufacturingOverviewReportOutput{}, err
	}
	for workOrderRows.Next() {
		var row ManufacturingOverviewWorkOrder
		var createdAt time.Time
		var completedAt *time.Time
		if err := workOrderRows.Scan(&row.ID, &row.Number, &row.AssemblySKU, &row.AssemblyName, &row.Status,
			&row.PlannedQtyThousandths, &row.ProducedQtyThousandths, &row.YieldPctThousandths,
			&row.Note, &createdAt, &completedAt); err != nil {
			workOrderRows.Close()
			return ManufacturingOverviewReportOutput{}, err
		}
		if !reportSafeInteger(row.PlannedQtyThousandths) || !reportSafeInteger(row.ProducedQtyThousandths) || !reportSafeInteger(row.YieldPctThousandths) {
			workOrderRows.Close()
			return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report quantity exceeds the supported amount range")
		}
		row.ExpectedGoodThousandths = manufacturingPlannedGoodQuantity(row.PlannedQtyThousandths, row.YieldPctThousandths)
		row.CreatedAt = manufacturingReportTimestamp(createdAt)
		if completedAt != nil {
			formatted := manufacturingReportTimestamp(*completedAt)
			row.CompletedAt = &formatted
		}
		out.WorkOrders = append(out.WorkOrders, row)
	}
	if err := workOrderRows.Err(); err != nil {
		workOrderRows.Close()
		return ManufacturingOverviewReportOutput{}, err
	}
	workOrderRows.Close()

	type movement struct {
		refID     *string
		itemID    string
		delta     int64
		unitCost  *int64
		lotCode   *string
		createdAt time.Time
		actorType string
		refType   string
	}
	moveRows, err := tx.Query(ctx, `
		SELECT sm.ref_id, sm.item_id::text, sm.quantity_delta, sm.unit_cost_minor,
			l.lot_code, sm.created_at, sm.actor_type, sm.ref_type
		FROM stock_movements sm
		LEFT JOIN lots l ON l.id=sm.lot_id AND l.org_id=sm.org_id
		WHERE sm.org_id=$1::uuid AND sm.ref_type IN ('production','production_reversal')
		ORDER BY sm.created_at DESC LIMIT 2000`, orgID)
	if err != nil {
		return ManufacturingOverviewReportOutput{}, err
	}
	grouped := make(map[string][]movement)
	order := make([]string, 0)
	reversedRefs := make(map[string]bool)
	for moveRows.Next() {
		var row movement
		if err := moveRows.Scan(&row.refID, &row.itemID, &row.delta, &row.unitCost, &row.lotCode, &row.createdAt, &row.actorType, &row.refType); err != nil {
			moveRows.Close()
			return ManufacturingOverviewReportOutput{}, err
		}
		if row.refType == "production_reversal" {
			if row.refID != nil {
				reversedRefs[*row.refID] = true
			}
			continue
		}
		if row.refID == nil {
			continue
		}
		if _, seen := grouped[*row.refID]; !seen {
			order = append(order, *row.refID)
		}
		grouped[*row.refID] = append(grouped[*row.refID], row)
	}
	if err := moveRows.Err(); err != nil {
		moveRows.Close()
		return ManufacturingOverviewReportOutput{}, err
	}
	moveRows.Close()
	if len(order) > 100 {
		order = order[:100]
	}
	for _, runID := range order {
		moves := grouped[runID]
		var outputMove *movement
		for i := range moves {
			if moves[i].delta > 0 {
				outputMove = &moves[i]
				break
			}
		}
		if outputMove == nil {
			continue
		}
		if !reportSafeInteger(outputMove.delta) {
			return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report quantity exceeds the supported amount range")
		}
		unitCostMinor := int64(0)
		if outputMove.unitCost != nil {
			unitCostMinor = *outputMove.unitCost
		}
		if !reportSafeInteger(unitCostMinor) {
			return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report cost exceeds the supported amount range")
		}
		run := ManufacturingOverviewProductionRun{
			RunID: runID, OccurredAt: manufacturingReportTimestamp(outputMove.createdAt),
			AssemblySKU: manufacturingReportSKU(itemsByID, outputMove.itemID), ProducedThousandths: outputMove.delta,
			UnitCostMinor: unitCostMinor, Reversed: reversedRefs[runID], Components: []ManufacturingOverviewProductionComponent{},
		}
		var costTotalMinor float64
		for _, row := range moves {
			if row.delta >= 0 {
				continue
			}
			if row.delta == -1<<63 {
				return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report quantity exceeds the supported amount range")
			}
			cost := int64(0)
			if row.unitCost != nil {
				cost = *row.unitCost
			} else if outputMove.unitCost != nil {
				cost = *outputMove.unitCost
			}
			if !reportSafeInteger(cost) {
				return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report cost exceeds the supported amount range")
			}
			consumed := -row.delta
			if !reportSafeInteger(consumed) {
				return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report cost exceeds the supported amount range")
			}
			lineCost := math.Floor(float64(consumed)*float64(cost)/1000 + 0.5)
			costTotalMinor += lineCost
			if math.IsInf(costTotalMinor, 0) || math.IsNaN(costTotalMinor) || math.Abs(costTotalMinor) > 9_007_199_254_740_991 {
				return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report amount exceeds the supported amount range")
			}
			run.Components = append(run.Components, ManufacturingOverviewProductionComponent{
				SKU: manufacturingReportSKU(itemsByID, row.itemID), QuantityThousandths: consumed, LotCode: row.lotCode,
			})
		}
		run.CostTotalMinor = int64(costTotalMinor)
		out.ProductionRuns = append(out.ProductionRuns, run)
	}

	lotRows, err := tx.Query(ctx, `
		SELECT l.id::text, l.item_id::text, l.lot_code, l.expires_at,
			COALESCE(SUM(sm.quantity_delta), 0)::bigint
		FROM lots l LEFT JOIN stock_movements sm ON sm.lot_id=l.id AND sm.org_id=l.org_id
		WHERE l.org_id=$1::uuid
		GROUP BY l.id ORDER BY l.created_at DESC LIMIT 200`, orgID)
	if err != nil {
		return ManufacturingOverviewReportOutput{}, err
	}
	for lotRows.Next() {
		var row ManufacturingOverviewLot
		var itemID string
		var expiresAt *time.Time
		if err := lotRows.Scan(&row.ID, &itemID, &row.LotCode, &expiresAt, &row.BalanceThousandths); err != nil {
			lotRows.Close()
			return ManufacturingOverviewReportOutput{}, err
		}
		if !reportSafeInteger(row.BalanceThousandths) {
			lotRows.Close()
			return ManufacturingOverviewReportOutput{}, errors.New("manufacturing report quantity exceeds the supported amount range")
		}
		row.SKU = manufacturingReportSKU(itemsByID, itemID)
		if expiresAt != nil {
			formatted := manufacturingReportTimestamp(*expiresAt)
			row.ExpiresAt = &formatted
		}
		out.Lots = append(out.Lots, row)
	}
	if err := lotRows.Err(); err != nil {
		lotRows.Close()
		return ManufacturingOverviewReportOutput{}, err
	}
	lotRows.Close()

	return out, nil
}

func manufacturingReportSKU(itemsByID map[string]manufacturingReportItem, itemID string) string {
	if item, ok := itemsByID[itemID]; ok {
		return item.sku
	}
	return itemID
}

func manufacturingReportTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
