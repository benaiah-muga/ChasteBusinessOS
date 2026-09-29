package capability

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	manufacturingCreateWorkOrderCapabilityID            = "manufacturing.createWorkOrder"
	manufacturingReleaseWorkOrderCapabilityID           = "manufacturing.releaseWorkOrder"
	manufacturingCompleteWorkOrderCapabilityID          = "manufacturing.completeWorkOrder"
	manufacturingCancelWorkOrderCapabilityID            = "manufacturing.cancelWorkOrder"
	manufacturingReverseProductionRunCapabilityID       = "manufacturing.reverseProductionRun"
	manufacturingCheckProductionFeasibilityCapabilityID = "manufacturing.checkProductionFeasibility"
	manufacturingWorkOrdersListCapabilityID             = "manufacturing.workOrdersList"
	manufacturingProduceFromBomCapabilityID             = "manufacturing.produceFromBom"
)

// Percentages are stored as thousandths of a percent (5% = 5000) and
// quantities as thousandths of a unit (1 unit = 1000), mirroring the
// TypeScript manufacturing module conventions.
const manufacturingPctScale = 1_000_000

const manufacturingMaxBomDepth = 16

var manufacturingWorkOrderStatuses = []string{"draft", "released", "completed", "cancelled"}

type ManufacturingCreateWorkOrderInput struct {
	AssemblySKU           string  `json:"assemblySku"`
	PlannedQtyThousandths int64   `json:"plannedQtyThousandths"`
	YieldPctThousandths   int64   `json:"yieldPctThousandths"`
	WorkCenter            *string `json:"workCenter,omitempty"`
	Note                  *string `json:"note,omitempty"`
}

type ManufacturingCreateWorkOrderOutput struct {
	WorkOrderID             string `json:"workOrderId"`
	Number                  int64  `json:"number"`
	ExpectedGoodThousandths int64  `json:"expectedGoodThousandths"`
}

type ManufacturingWorkOrderIDInput struct {
	WorkOrderID string `json:"workOrderId"`
}

type ManufacturingReleaseWorkOrderOutput struct {
	Released bool `json:"released"`
}

type ManufacturingCancelWorkOrderOutput struct {
	Cancelled bool `json:"cancelled"`
}

type ManufacturingCompleteWorkOrderInput struct {
	WorkOrderID         string  `json:"workOrderId"`
	QuantityThousandths int64   `json:"quantityThousandths"`
	LotCode             *string `json:"lotCode,omitempty"`
}

type ManufacturingConsumedComponent struct {
	SKU                 string `json:"sku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
}

type ManufacturingCompleteWorkOrderOutput struct {
	RunRef                   string                           `json:"runRef"`
	Completed                bool                             `json:"completed"`
	ProducedTotalThousandths int64                            `json:"producedTotalThousandths"`
	Status                   string                           `json:"status"`
	ProducedThousandths      int64                            `json:"producedThousandths"`
	ConsumedComponents       []ManufacturingConsumedComponent `json:"consumedComponents"`
	CostRolledUpMinor        int64                            `json:"costRolledUpMinor"`
}

type ManufacturingRunRefInput struct {
	RunRef string `json:"runRef"`
}

type ManufacturingReverseProductionRunOutput struct {
	ReversedMovements          int                              `json:"reversedMovements"`
	RemovedFinishedThousandths int64                            `json:"removedFinishedThousandths"`
	RestoredComponents         []ManufacturingConsumedComponent `json:"restoredComponents"`
	RemovedProduced            []ManufacturingConsumedComponent `json:"removedProduced"`
}

type ManufacturingCheckProductionFeasibilityInput struct {
	AssemblySKU             string `json:"assemblySku"`
	DesiredUnitsThousandths int64  `json:"desiredUnitsThousandths"`
}

type ManufacturingFeasibilityLine struct {
	ItemID               string `json:"itemId"`
	RequiredThousandths  int64  `json:"requiredThousandths"`
	OnHandThousandths    int64  `json:"onHandThousandths"`
	ShortfallThousandths int64  `json:"shortfallThousandths"`
}

type ManufacturingCheckProductionFeasibilityOutput struct {
	Producible               bool                           `json:"producible"`
	MaxProducibleThousandths int64                          `json:"maxProducibleThousandths"`
	EstimatedLeadTimeDays    *int64                         `json:"estimatedLeadTimeDays"`
	Lines                    []ManufacturingFeasibilityLine `json:"lines"`
}

type ManufacturingWorkOrdersListInput struct {
	Status *string `json:"status,omitempty"`
	Limit  int64   `json:"limit"`
}

type ManufacturingWorkOrderListItem struct {
	ID                      string  `json:"id"`
	Number                  int64   `json:"number"`
	AssemblySKU             string  `json:"assemblySku"`
	Status                  string  `json:"status"`
	PlannedQtyThousandths   int64   `json:"plannedQtyThousandths"`
	ProducedQtyThousandths  int64   `json:"producedQtyThousandths"`
	YieldPctThousandths     int64   `json:"yieldPctThousandths"`
	ExpectedGoodThousandths int64   `json:"expectedGoodThousandths"`
	Note                    *string `json:"note"`
	CreatedAt               string  `json:"createdAt"`
}

type ManufacturingWorkOrdersListOutput struct {
	WorkOrders []ManufacturingWorkOrderListItem `json:"workOrders"`
}

type ManufacturingProduceFromBomInput struct {
	AssemblySKU         string  `json:"assemblySku"`
	QuantityThousandths int64   `json:"quantityThousandths"`
	LotCode             *string `json:"lotCode,omitempty"`
}

type ManufacturingProduceFromBomOutput struct {
	RunRef              string                           `json:"runRef"`
	ProducedThousandths int64                            `json:"producedThousandths"`
	ConsumedComponents  []ManufacturingConsumedComponent `json:"consumedComponents"`
	CostRolledUpMinor   int64                            `json:"costRolledUpMinor"`
}

func manufacturingRequiredPositiveQuantity(fields map[string]json.RawMessage, key string) (int64, error) {
	quantity, err := inventoryRequiredQuantity(fields, key)
	if err != nil || quantity <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return quantity, nil
}

// manufacturingOptionalPctThousandths mirrors the shared pctInput schema:
// thousandths of a percent in [0, 1000000], with a default when the key is
// absent (zod .default applies to undefined, never to an explicit null).
func manufacturingOptionalPctThousandths(fields map[string]json.RawMessage, key string, defaultValue int64) (int64, error) {
	if _, ok := fields[key]; !ok {
		return defaultValue, nil
	}
	value, err := inventoryRequiredQuantity(fields, key)
	if err != nil {
		return 0, err
	}
	if value < 0 || value > manufacturingPctScale {
		return 0, fmt.Errorf("%s must be between 0 and %d", key, manufacturingPctScale)
	}
	return value, nil
}

func ParseManufacturingCreateWorkOrderInput(raw json.RawMessage) (ManufacturingCreateWorkOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingCreateWorkOrderInput{}, err
	}
	var input ManufacturingCreateWorkOrderInput
	if input.AssemblySKU, err = requiredCRMDealString(fields, "assemblySku", 0, 0); err != nil {
		return ManufacturingCreateWorkOrderInput{}, err
	}
	if input.PlannedQtyThousandths, err = manufacturingRequiredPositiveQuantity(fields, "plannedQtyThousandths"); err != nil {
		return ManufacturingCreateWorkOrderInput{}, err
	}
	if input.YieldPctThousandths, err = manufacturingOptionalPctThousandths(fields, "yieldPctThousandths", manufacturingPctScale); err != nil {
		return ManufacturingCreateWorkOrderInput{}, err
	}
	if input.WorkCenter, err = optionalCRMDealString(fields, "workCenter", 80, false); err != nil {
		return ManufacturingCreateWorkOrderInput{}, err
	}
	if input.Note, err = optionalCRMDealString(fields, "note", 500, false); err != nil {
		return ManufacturingCreateWorkOrderInput{}, err
	}
	return input, nil
}

func parseManufacturingWorkOrderID(raw json.RawMessage) (ManufacturingWorkOrderIDInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingWorkOrderIDInput{}, err
	}
	workOrderID, err := salesRequiredUUID(fields, "workOrderId")
	if err != nil {
		return ManufacturingWorkOrderIDInput{}, err
	}
	return ManufacturingWorkOrderIDInput{WorkOrderID: workOrderID}, nil
}

func ParseManufacturingReleaseWorkOrderInput(raw json.RawMessage) (ManufacturingWorkOrderIDInput, error) {
	return parseManufacturingWorkOrderID(raw)
}

func ParseManufacturingCancelWorkOrderInput(raw json.RawMessage) (ManufacturingWorkOrderIDInput, error) {
	return parseManufacturingWorkOrderID(raw)
}

func ParseManufacturingCompleteWorkOrderInput(raw json.RawMessage) (ManufacturingCompleteWorkOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingCompleteWorkOrderInput{}, err
	}
	var input ManufacturingCompleteWorkOrderInput
	if input.WorkOrderID, err = salesRequiredUUID(fields, "workOrderId"); err != nil {
		return ManufacturingCompleteWorkOrderInput{}, err
	}
	if input.QuantityThousandths, err = manufacturingRequiredPositiveQuantity(fields, "quantityThousandths"); err != nil {
		return ManufacturingCompleteWorkOrderInput{}, err
	}
	if input.LotCode, err = inventoryOptionalCode(fields, "lotCode", 40); err != nil {
		return ManufacturingCompleteWorkOrderInput{}, err
	}
	return input, nil
}

func ParseManufacturingReverseProductionRunInput(raw json.RawMessage) (ManufacturingRunRefInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingRunRefInput{}, err
	}
	runRef, err := salesRequiredUUID(fields, "runRef")
	if err != nil {
		return ManufacturingRunRefInput{}, err
	}
	return ManufacturingRunRefInput{RunRef: runRef}, nil
}

func ParseManufacturingCheckProductionFeasibilityInput(raw json.RawMessage) (ManufacturingCheckProductionFeasibilityInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingCheckProductionFeasibilityInput{}, err
	}
	var input ManufacturingCheckProductionFeasibilityInput
	if input.AssemblySKU, err = requiredCRMDealString(fields, "assemblySku", 0, 0); err != nil {
		return ManufacturingCheckProductionFeasibilityInput{}, err
	}
	if input.DesiredUnitsThousandths, err = manufacturingRequiredPositiveQuantity(fields, "desiredUnitsThousandths"); err != nil {
		return ManufacturingCheckProductionFeasibilityInput{}, err
	}
	return input, nil
}

func ParseManufacturingWorkOrdersListInput(raw json.RawMessage) (ManufacturingWorkOrdersListInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingWorkOrdersListInput{}, err
	}
	input := ManufacturingWorkOrdersListInput{Limit: 50}
	if _, ok := fields["status"]; ok {
		status, err := projectOptionalEnum(fields, "status", manufacturingWorkOrderStatuses)
		if err != nil {
			return ManufacturingWorkOrdersListInput{}, err
		}
		input.Status = status
	}
	if _, ok := fields["limit"]; ok {
		limit, err := inventoryRequiredQuantity(fields, "limit")
		if err != nil {
			return ManufacturingWorkOrdersListInput{}, err
		}
		if limit < 1 || limit > 100 {
			return ManufacturingWorkOrdersListInput{}, errors.New("limit must be between 1 and 100")
		}
		input.Limit = limit
	}
	return input, nil
}

func ParseManufacturingProduceFromBomInput(raw json.RawMessage) (ManufacturingProduceFromBomInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingProduceFromBomInput{}, err
	}
	var input ManufacturingProduceFromBomInput
	if input.AssemblySKU, err = requiredCRMDealString(fields, "assemblySku", 0, 0); err != nil {
		return ManufacturingProduceFromBomInput{}, err
	}
	if input.QuantityThousandths, err = manufacturingRequiredPositiveQuantity(fields, "quantityThousandths"); err != nil {
		return ManufacturingProduceFromBomInput{}, err
	}
	if input.LotCode, err = inventoryOptionalCode(fields, "lotCode", 40); err != nil {
		return ManufacturingProduceFromBomInput{}, err
	}
	return input, nil
}

type manufacturingRequirement struct {
	itemID              string
	quantityThousandths int64
}

type manufacturingBomEdge struct {
	assemblyItemID      string
	componentItemID     string
	quantityThousandths int64
	scrapPctThousandths int64
}

type manufacturingPerUnitNeed struct {
	componentItemID    string
	perUnitThousandths int64
}

type manufacturingAvailabilityLine struct {
	itemID               string
	quantityThousandths  int64
	onHandThousandths    int64
	shortfallThousandths int64
}

type manufacturingAvailability struct {
	producible                bool
	lines                     []manufacturingAvailabilityLine
	totalShortfallThousandths int64
}

// manufacturingApplyScrap mirrors erp-core applyScrap: a scrap allowance
// scales a requirement up with an always-safe ceil, because consumption can
// be fractional but shortfall math must never understate the need.
func manufacturingApplyScrap(quantityThousandths, scrapPctThousandths int64) (int64, error) {
	if quantityThousandths <= 0 {
		return 0, nil
	}
	if scrapPctThousandths <= 0 {
		return quantityThousandths, nil
	}
	numerator := new(big.Int).Mul(big.NewInt(quantityThousandths), big.NewInt(manufacturingPctScale+scrapPctThousandths))
	numerator.Add(numerator, big.NewInt(manufacturingPctScale-1))
	numerator.Div(numerator, big.NewInt(manufacturingPctScale))
	if !numerator.IsInt64() || !inventorySafeInteger(numerator.Int64()) {
		return 0, errors.New("manufacturing requirement exceeds the supported amount range")
	}
	return numerator.Int64(), nil
}

// manufacturingPlannedGoodQuantity mirrors erp-core plannedGoodQuantity: good
// output expected at a yield percentage, rounded down so a promise never
// exceeds what the process reliably yields.
func manufacturingPlannedGoodQuantity(plannedThousandths, yieldPctThousandths int64) int64 {
	if plannedThousandths <= 0 {
		return 0
	}
	yield := yieldPctThousandths
	if yield < 0 {
		yield = 0
	}
	if yield > manufacturingPctScale {
		yield = manufacturingPctScale
	}
	return (plannedThousandths * yield) / manufacturingPctScale
}

// manufacturingExplodeBom mirrors erp-core explodeBom: recursive expansion of
// sub-assemblies into leaf-level requirements with shared-component
// aggregation, refusing cycles (by path) and runaway depth. Pure.
func manufacturingExplodeBom(edges []manufacturingBomEdge, assemblyItemID string, quantityThousandths int64) ([]manufacturingRequirement, error) {
	byAssembly := make(map[string][]manufacturingBomEdge)
	for _, edge := range edges {
		byAssembly[edge.assemblyItemID] = append(byAssembly[edge.assemblyItemID], edge)
	}
	totals := make(map[string]int64)
	var walk func(itemID string, quantity int64, depth int, path map[string]struct{}) error
	walk = func(itemID string, quantity int64, depth int, path map[string]struct{}) error {
		if depth > manufacturingMaxBomDepth {
			return fmt.Errorf("BOM deeper than %d levels", manufacturingMaxBomDepth)
		}
		if _, cyclic := path[itemID]; cyclic {
			return errors.New("bill of materials contains a cycle")
		}
		children := byAssembly[itemID]
		if len(children) == 0 {
			total := totals[itemID] + quantity
			if !inventorySafeInteger(total) {
				return errors.New("manufacturing requirement exceeds the supported amount range")
			}
			totals[itemID] = total
			return nil
		}
		nextPath := make(map[string]struct{}, len(path)+1)
		for id := range path {
			nextPath[id] = struct{}{}
		}
		nextPath[itemID] = struct{}{}
		for _, child := range children {
			if child.quantityThousandths <= 0 {
				continue
			}
			scaled, err := inventoryJsRoundProductDiv(child.quantityThousandths, quantity, 1000)
			if err != nil {
				return err
			}
			if err := walk(child.componentItemID, scaled, depth+1, nextPath); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(assemblyItemID, quantityThousandths, 0, map[string]struct{}{}); err != nil {
		return nil, err
	}
	requirements := make([]manufacturingRequirement, 0, len(totals))
	for itemID, total := range totals {
		if total > 0 {
			requirements = append(requirements, manufacturingRequirement{itemID: itemID, quantityThousandths: total})
		}
	}
	sort.Slice(requirements, func(i, j int) bool { return requirements[i].itemID < requirements[j].itemID })
	return requirements, nil
}

func manufacturingCheckAvailability(requirements []manufacturingRequirement, onHandByItem map[string]int64) manufacturingAvailability {
	availability := manufacturingAvailability{producible: true, lines: make([]manufacturingAvailabilityLine, 0, len(requirements))}
	for _, requirement := range requirements {
		onHand := onHandByItem[requirement.itemID]
		shortfall := requirement.quantityThousandths - onHand
		if shortfall < 0 {
			shortfall = 0
		}
		if shortfall > 0 {
			availability.producible = false
			availability.totalShortfallThousandths += shortfall
		}
		availability.lines = append(availability.lines, manufacturingAvailabilityLine{
			itemID:               requirement.itemID,
			quantityThousandths:  requirement.quantityThousandths,
			onHandThousandths:    onHand,
			shortfallThousandths: shortfall,
		})
	}
	return availability
}

// manufacturingMaxProducibleUnits mirrors erp-core maxProducibleUnits: the
// largest whole-unit ceiling every component can support, zero-need
// components never constraining. The float arithmetic reproduces the
// TypeScript floor((stock / perUnit) * 1000) exactly.
func manufacturingMaxProducibleUnits(needs []manufacturingPerUnitNeed, stockByItem map[string]int64) int64 {
	ceiling := int64(-1)
	for _, need := range needs {
		if need.perUnitThousandths <= 0 {
			continue
		}
		available := stockByItem[need.componentItemID]
		fromComponent := int64(math.Floor((float64(available) / float64(need.perUnitThousandths)) * 1000))
		if fromComponent < 0 {
			fromComponent = 0
		}
		if ceiling < 0 || fromComponent < ceiling {
			ceiling = fromComponent
		}
	}
	if ceiling < 0 {
		return 0
	}
	return ceiling
}

func manufacturingMovementHistory(ctx context.Context, tx pgx.Tx, orgID, itemID string) ([]inventoryValuationMovement, error) {
	rows, err := tx.Query(ctx, `
		SELECT quantity_delta, unit_cost_minor
		FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid
		ORDER BY created_at ASC`, orgID, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// The reason column is deliberately not loaded: the manufacturing
	// valuation replay treats every leg as value-affecting, exactly like the
	// TypeScript avgUnitCost mapping that drops the transfer flag.
	history := make([]inventoryValuationMovement, 0, 8)
	for rows.Next() {
		var movement inventoryValuationMovement
		if err := rows.Scan(&movement.quantityDelta, &movement.unitCostMinor); err != nil {
			return nil, err
		}
		history = append(history, movement)
	}
	return history, rows.Err()
}

func manufacturingAvgUnitCost(ctx context.Context, tx pgx.Tx, orgID, itemID string) (int64, error) {
	history, err := manufacturingMovementHistory(ctx, tx, orgID, itemID)
	if err != nil {
		return 0, err
	}
	state, err := inventoryReplayValuation(history)
	if err != nil {
		return 0, err
	}
	return inventoryAverageUnitCost(state)
}

func manufacturingOrgBomEdges(ctx context.Context, tx pgx.Tx, orgID string, assemblyItemID *string) ([]manufacturingBomEdge, error) {
	query := `
		SELECT assembly_item_id::text, component_item_id::text, quantity_thousandths, scrap_pct_thousandths
		FROM bom_lines
		WHERE org_id = $1::uuid`
	args := []any{orgID}
	if assemblyItemID != nil {
		query += ` AND assembly_item_id = $2::uuid`
		args = append(args, *assemblyItemID)
	}
	query += ` ORDER BY id`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	edges := make([]manufacturingBomEdge, 0, 8)
	for rows.Next() {
		var edge manufacturingBomEdge
		if err := rows.Scan(&edge.assemblyItemID, &edge.componentItemID, &edge.quantityThousandths, &edge.scrapPctThousandths); err != nil {
			return nil, err
		}
		edges = append(edges, edge)
	}
	return edges, rows.Err()
}

// manufacturingScrapAdjustedRequirements mirrors the TypeScript helper of the
// same name: the whole graph must be loaded (sub-assemblies expand through
// their own edges), and scrap lives per BOM edge, taking the max allowance
// per component so a part reached through several paths keeps its protection.
// hasBom is false when the assembly has no BOM at all.
func manufacturingScrapAdjustedRequirements(ctx context.Context, tx pgx.Tx, orgID, assemblyItemID string, quantityThousandths int64) (requirements []manufacturingRequirement, hasBom bool, err error) {
	edges, err := manufacturingOrgBomEdges(ctx, tx, orgID, nil)
	if err != nil {
		return nil, false, err
	}
	reachesAssembly := false
	for _, edge := range edges {
		if edge.assemblyItemID == assemblyItemID {
			reachesAssembly = true
			break
		}
	}
	if !reachesAssembly {
		return nil, false, nil
	}
	raw, err := manufacturingExplodeBom(edges, assemblyItemID, quantityThousandths)
	if err != nil {
		return nil, false, err
	}
	scrapByComponent := make(map[string]int64, len(edges))
	for _, edge := range edges {
		if edge.scrapPctThousandths > scrapByComponent[edge.componentItemID] {
			scrapByComponent[edge.componentItemID] = edge.scrapPctThousandths
		}
	}
	requirements = make([]manufacturingRequirement, 0, len(raw))
	for _, requirement := range raw {
		adjusted, err := manufacturingApplyScrap(requirement.quantityThousandths, scrapByComponent[requirement.itemID])
		if err != nil {
			return nil, false, err
		}
		requirements = append(requirements, manufacturingRequirement{itemID: requirement.itemID, quantityThousandths: adjusted})
	}
	return requirements, true, nil
}

func manufacturingSkuMap(ctx context.Context, tx pgx.Tx, orgID string) (map[string]string, error) {
	rows, err := tx.Query(ctx, `SELECT id::text, sku FROM items WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	skus := make(map[string]string, 16)
	for rows.Next() {
		var id, sku string
		if err := rows.Scan(&id, &sku); err != nil {
			return nil, err
		}
		skus[id] = sku
	}
	return skus, rows.Err()
}

// manufacturingSkuByID mirrors the TypeScript skuById fallback: a missing
// items row degrades to the raw id instead of failing the capability.
func manufacturingSkuByID(ctx context.Context, tx pgx.Tx, orgID, itemID string) (string, error) {
	var sku string
	err := tx.QueryRow(ctx, `
		SELECT sku FROM items WHERE org_id = $1::uuid AND id = $2::uuid LIMIT 1`, orgID, itemID).Scan(&sku)
	if errors.Is(err, pgx.ErrNoRows) {
		return itemID, nil
	}
	if err != nil {
		return "", err
	}
	return sku, nil
}

type manufacturingWorkOrderRow struct {
	id                     string
	number                 int64
	assemblyItemID         string
	plannedQtyThousandths  int64
	producedQtyThousandths int64
	yieldPctThousandths    int64
	status                 string
}

func manufacturingLoadWorkOrder(ctx context.Context, tx pgx.Tx, orgID, workOrderID string, forUpdate bool) (*manufacturingWorkOrderRow, error) {
	query := `
		SELECT id::text, number, assembly_item_id::text, planned_qty_thousandths,
			produced_qty_thousandths, yield_pct_thousandths, status
		FROM work_orders
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	var workOrder manufacturingWorkOrderRow
	err := tx.QueryRow(ctx, query, workOrderID, orgID).Scan(
		&workOrder.id, &workOrder.number, &workOrder.assemblyItemID,
		&workOrder.plannedQtyThousandths, &workOrder.producedQtyThousandths,
		&workOrder.yieldPctThousandths, &workOrder.status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("no work order %s", workOrderID)
	}
	if err != nil {
		return nil, err
	}
	return &workOrder, nil
}

// manufacturingNextWorkOrderNumber mirrors the shared nextDocNumber allocator
// for the "work_order" sequence: the first allocation seeds from MAX(number)
// so legacy documents are honored, and the counter row is locked by the
// UPDATE until commit so concurrent creators cannot collide.
func manufacturingNextWorkOrderNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		SELECT $1::uuid, 'work_order', COALESCE(MAX(number), 0) + 1 FROM work_orders
		WHERE org_id = $1::uuid
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate work order number: %w", err)
	}
	if number <= 0 || number > maxDatabaseInteger {
		return 0, errors.New("work order number exceeds the database integer range")
	}
	return number, nil
}

// manufacturingNewRunRef mints the run reference the TypeScript code gets
// from crypto.randomUUID(); it tags every movement of one production run so
// reversal and traceability can target the build as a whole.
func manufacturingNewRunRef() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16]), nil
}

// manufacturingApplyStockDelta mirrors the shared inventory writer with unit
// cost support: lock the item, assert lot ownership, refuse a negative
// resulting balance, then append the movement. The stock_balances projection
// is maintained by the database trigger; the ledger itself is append-only.
func manufacturingApplyStockDelta(ctx context.Context, tx pgx.Tx, orgID, itemID string, quantityDelta int64, reason, note string, refType, refID string, unitCostMinor *int64, locationID, lotID *string, actorType string, actorID *string) error {
	if err := inventoryLockStockItems(ctx, tx, []string{itemID}); err != nil {
		return err
	}
	if lotID != nil {
		var lotItemID string
		err := tx.QueryRow(ctx, `
			SELECT item_id::text FROM lots WHERE id = $1::uuid AND org_id = $2::uuid`,
			*lotID, orgID).Scan(&lotItemID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lot %s does not exist in this organization", *lotID)
		}
		if err != nil {
			return err
		}
		if lotItemID != itemID {
			return fmt.Errorf("lot %s belongs to a different item; a lot cannot move another item's stock", *lotID)
		}
	}
	onHand, err := inventoryStockOnHand(ctx, tx, orgID, itemID, nil)
	if err != nil {
		return err
	}
	if onHand+quantityDelta < 0 {
		return fmt.Errorf("cannot move %d thousandths of stock that is not there: only %d on hand for this item", -quantityDelta, onHand)
	}
	if locationID != nil {
		atLocation, err := inventoryStockOnHand(ctx, tx, orgID, itemID, locationID)
		if err != nil {
			return err
		}
		if atLocation+quantityDelta < 0 {
			return fmt.Errorf("cannot move %d thousandths from this location: only %d on hand there", -quantityDelta, atLocation)
		}
	}
	var noteValue any
	if note != "" {
		noteValue = note
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, ref_type, ref_id, unit_cost_minor, location_id, lot_id, actor_type, actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9::uuid, $10::uuid, $11, $12::uuid)`,
		orgID, itemID, quantityDelta, reason, noteValue, refType, refID, unitCostMinor, locationID, lotID, actorType, actorID); err != nil {
		return err
	}
	return nil
}

// manufacturingFixedThree renders (thousandths / 1000) as the decimal string
// the TypeScript message builds with toFixed(3), without going through floats.
func manufacturingFixedThree(thousandths int64) string {
	return fmt.Sprintf("%d.%03d", thousandths/1000, thousandths%1000)
}

func manufacturingShortfallMessage(lines []manufacturingAvailabilityLine, skuByItem map[string]string, useSKU bool) string {
	parts := make([]string, 0, len(lines))
	for _, line := range lines {
		if line.shortfallThousandths <= 0 {
			continue
		}
		label := line.itemID
		if useSKU {
			if sku, ok := skuByItem[line.itemID]; ok {
				label = sku
			}
		}
		parts = append(parts, fmt.Sprintf("%s short %s", label, manufacturingFixedThree(line.shortfallThousandths)))
	}
	return strings.Join(parts, "; ")
}

type manufacturingRunPosting struct {
	producedThousandths int64
	consumedComponents  []ManufacturingConsumedComponent
	costRolledUpMinor   int64
}

// manufacturingPostRun mirrors the TypeScript shared completion posting: it
// consumes exploded, scrap-adjusted components at moving-average cost and
// adds finished units at rolled-up cost inside one transaction. runRef tags
// every leg so reversal and traceability find the build. The noBomMessage
// wording differs between the two callers exactly as it does in TypeScript.
func manufacturingPostRun(ctx context.Context, tx pgx.Tx, orgID, actorType string, actorID *string, assemblyItemID, assemblySKU string, quantityThousandths int64, runRef string, lotCode *string, shortfallUsesSKU bool, noBomMessage string) (manufacturingRunPosting, error) {
	requirements, hasBom, err := manufacturingScrapAdjustedRequirements(ctx, tx, orgID, assemblyItemID, quantityThousandths)
	if err != nil {
		return manufacturingRunPosting{}, err
	}
	if !hasBom {
		return manufacturingRunPosting{}, fmt.Errorf(noBomMessage, assemblySKU)
	}
	skuByItem, err := manufacturingSkuMap(ctx, tx, orgID)
	if err != nil {
		return manufacturingRunPosting{}, err
	}
	itemIDs := make([]string, 0, len(requirements)+1)
	for _, requirement := range requirements {
		itemIDs = append(itemIDs, requirement.itemID)
	}
	itemIDs = append(itemIDs, assemblyItemID)
	// Lock every item this run touches (stable id order) before the
	// availability check, so a concurrent sale cannot spend the same units.
	if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
		return manufacturingRunPosting{}, err
	}
	onHandByItem := make(map[string]int64, len(requirements))
	for _, requirement := range requirements {
		onHand, err := inventoryStockOnHand(ctx, tx, orgID, requirement.itemID, nil)
		if err != nil {
			return manufacturingRunPosting{}, err
		}
		onHandByItem[requirement.itemID] = onHand
	}
	check := manufacturingCheckAvailability(requirements, onHandByItem)
	if !check.producible {
		return manufacturingRunPosting{}, fmt.Errorf("insufficient stock: %s", manufacturingShortfallMessage(check.lines, skuByItem, shortfallUsesSKU))
	}
	var outLotID *string
	if lotCode != nil {
		created, err := inventoryGetOrCreateLot(ctx, tx, orgID, assemblyItemID, *lotCode)
		if err != nil {
			return manufacturingRunPosting{}, err
		}
		outLotID = &created
	}
	posting := manufacturingRunPosting{producedThousandths: quantityThousandths, consumedComponents: []ManufacturingConsumedComponent{}}
	for _, requirement := range requirements {
		unitCost, err := manufacturingAvgUnitCost(ctx, tx, orgID, requirement.itemID)
		if err != nil {
			return manufacturingRunPosting{}, err
		}
		consumedValue, err := inventoryJsRoundProductDiv(requirement.quantityThousandths, unitCost, 1000)
		if err != nil {
			return manufacturingRunPosting{}, err
		}
		costRolledUp, err := inventoryAddSafeIntegers(posting.costRolledUpMinor, consumedValue)
		if err != nil {
			return manufacturingRunPosting{}, err
		}
		posting.costRolledUpMinor = costRolledUp
		var unitCostRef *int64
		if unitCost > 0 {
			unitCostRef = &unitCost
		}
		note := fmt.Sprintf("consumed by production of %s", assemblySKU)
		if err := manufacturingApplyStockDelta(ctx, tx, orgID, requirement.itemID, -requirement.quantityThousandths, "production", note, "production", runRef, unitCostRef, nil, nil, actorType, actorID); err != nil {
			return manufacturingRunPosting{}, err
		}
		sku, ok := skuByItem[requirement.itemID]
		if !ok {
			sku = requirement.itemID
		}
		posting.consumedComponents = append(posting.consumedComponents, ManufacturingConsumedComponent{SKU: sku, QuantityThousandths: requirement.quantityThousandths})
	}
	rolledUnitCost := int64(0)
	if quantityThousandths > 0 {
		rolledUnitCost, err = inventoryJsRoundProductDiv(posting.costRolledUpMinor, 1000, quantityThousandths)
		if err != nil {
			return manufacturingRunPosting{}, err
		}
	}
	var rolledRef *int64
	if rolledUnitCost > 0 {
		rolledRef = &rolledUnitCost
	}
	note := fmt.Sprintf("produced from BOM (%d component kinds)", len(posting.consumedComponents))
	if err := manufacturingApplyStockDelta(ctx, tx, orgID, assemblyItemID, quantityThousandths, "production", note, "production", runRef, rolledRef, nil, outLotID, actorType, actorID); err != nil {
		return manufacturingRunPosting{}, err
	}
	return posting, nil
}

func manufacturingCreateWorkOrder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ManufacturingCreateWorkOrderInput) (ManufacturingCreateWorkOrderOutput, error) {
	orgID := claims.OrganizationID
	var assemblyItemID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
		orgID, input.AssemblySKU).Scan(&assemblyItemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManufacturingCreateWorkOrderOutput{}, fmt.Errorf("no item with SKU %s", input.AssemblySKU)
	}
	if err != nil {
		return ManufacturingCreateWorkOrderOutput{}, err
	}
	if _, hasBom, err := manufacturingScrapAdjustedRequirements(ctx, tx, orgID, assemblyItemID, input.PlannedQtyThousandths); err != nil {
		return ManufacturingCreateWorkOrderOutput{}, err
	} else if !hasBom {
		return ManufacturingCreateWorkOrderOutput{}, fmt.Errorf("%s has no bill of materials; define one first", input.AssemblySKU)
	}
	number, err := manufacturingNextWorkOrderNumber(ctx, tx, orgID)
	if err != nil {
		return ManufacturingCreateWorkOrderOutput{}, err
	}
	var workOrderID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO work_orders (org_id, number, assembly_item_id, planned_qty_thousandths, work_center, yield_pct_thousandths, note, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::uuid)
		RETURNING id::text`,
		orgID, number, assemblyItemID, input.PlannedQtyThousandths, input.WorkCenter, input.YieldPctThousandths, input.Note, claims.ActorType, claims.ActorID).Scan(&workOrderID); err != nil {
		return ManufacturingCreateWorkOrderOutput{}, err
	}
	return ManufacturingCreateWorkOrderOutput{
		WorkOrderID:             workOrderID,
		Number:                  number,
		ExpectedGoodThousandths: manufacturingPlannedGoodQuantity(input.PlannedQtyThousandths, input.YieldPctThousandths),
	}, nil
}

func manufacturingReleaseWorkOrder(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingWorkOrderIDInput, now time.Time) (ManufacturingReleaseWorkOrderOutput, error) {
	workOrder, err := manufacturingLoadWorkOrder(ctx, tx, orgID, input.WorkOrderID, true)
	if err != nil {
		return ManufacturingReleaseWorkOrderOutput{}, err
	}
	if workOrder.status != "draft" {
		return ManufacturingReleaseWorkOrderOutput{}, fmt.Errorf("work order #%d is %s; only drafts can be released", workOrder.number, workOrder.status)
	}
	requirements, hasBom, err := manufacturingScrapAdjustedRequirements(ctx, tx, orgID, workOrder.assemblyItemID, workOrder.plannedQtyThousandths)
	if err != nil {
		return ManufacturingReleaseWorkOrderOutput{}, err
	}
	if !hasBom {
		return ManufacturingReleaseWorkOrderOutput{}, fmt.Errorf("work order #%d: its bill of materials was deleted", workOrder.number)
	}
	onHandByItem := make(map[string]int64, len(requirements))
	for _, requirement := range requirements {
		onHand, err := inventoryStockOnHand(ctx, tx, orgID, requirement.itemID, nil)
		if err != nil {
			return ManufacturingReleaseWorkOrderOutput{}, err
		}
		onHandByItem[requirement.itemID] = onHand
	}
	check := manufacturingCheckAvailability(requirements, onHandByItem)
	if !check.producible {
		shortItemIDs := make([]string, 0, len(check.lines))
		for _, line := range check.lines {
			if line.shortfallThousandths > 0 {
				shortItemIDs = append(shortItemIDs, line.itemID)
			}
		}
		skus := make([]string, 0, len(shortItemIDs))
		for _, itemID := range shortItemIDs {
			sku, err := manufacturingSkuByID(ctx, tx, orgID, itemID)
			if err != nil {
				return ManufacturingReleaseWorkOrderOutput{}, err
			}
			skus = append(skus, sku)
		}
		return ManufacturingReleaseWorkOrderOutput{}, fmt.Errorf("cannot release: components short of stock (%s)", strings.Join(skus, ", "))
	}
	if _, err := tx.Exec(ctx, `
		UPDATE work_orders SET status = 'released', released_at = $2 WHERE id = $1::uuid`,
		workOrder.id, now); err != nil {
		return ManufacturingReleaseWorkOrderOutput{}, err
	}
	return ManufacturingReleaseWorkOrderOutput{Released: true}, nil
}

func manufacturingCancelWorkOrder(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingWorkOrderIDInput, now time.Time) (ManufacturingCancelWorkOrderOutput, error) {
	workOrder, err := manufacturingLoadWorkOrder(ctx, tx, orgID, input.WorkOrderID, true)
	if err != nil {
		return ManufacturingCancelWorkOrderOutput{}, err
	}
	if workOrder.status == "completed" {
		return ManufacturingCancelWorkOrderOutput{}, fmt.Errorf("work order #%d is completed and cannot be cancelled; use reverseProductionRun", workOrder.number)
	}
	if workOrder.status == "cancelled" {
		return ManufacturingCancelWorkOrderOutput{}, fmt.Errorf("work order #%d is already cancelled", workOrder.number)
	}
	if workOrder.producedQtyThousandths > 0 {
		return ManufacturingCancelWorkOrderOutput{}, fmt.Errorf("work order #%d has partial completions and cannot be cancelled; reverse them via manufacturing.reverseProductionRun first", workOrder.number)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE work_orders SET status = 'cancelled', cancelled_at = $2 WHERE id = $1::uuid`,
		workOrder.id, now); err != nil {
		return ManufacturingCancelWorkOrderOutput{}, err
	}
	return ManufacturingCancelWorkOrderOutput{Cancelled: true}, nil
}

func manufacturingCompleteWorkOrder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ManufacturingCompleteWorkOrderInput, now time.Time) (ManufacturingCompleteWorkOrderOutput, error) {
	orgID := claims.OrganizationID
	workOrder, err := manufacturingLoadWorkOrder(ctx, tx, orgID, input.WorkOrderID, true)
	if err != nil {
		return ManufacturingCompleteWorkOrderOutput{}, err
	}
	if workOrder.status != "released" {
		return ManufacturingCompleteWorkOrderOutput{}, fmt.Errorf("work order #%d is %s; only released orders can complete", workOrder.number, workOrder.status)
	}
	remaining := workOrder.plannedQtyThousandths - workOrder.producedQtyThousandths
	if input.QuantityThousandths > remaining {
		return ManufacturingCompleteWorkOrderOutput{}, fmt.Errorf("completion exceeds plan: only %d thousandths remain on work order #%d", remaining, workOrder.number)
	}
	assemblySKU, err := manufacturingSkuByID(ctx, tx, orgID, workOrder.assemblyItemID)
	if err != nil {
		return ManufacturingCompleteWorkOrderOutput{}, err
	}
	runRef, err := manufacturingNewRunRef()
	if err != nil {
		return ManufacturingCompleteWorkOrderOutput{}, err
	}
	posting, err := manufacturingPostRun(ctx, tx, orgID, claims.ActorType, claims.ActorID, workOrder.assemblyItemID, assemblySKU, input.QuantityThousandths, runRef, input.LotCode, true, "%s has no bill of materials")
	if err != nil {
		return ManufacturingCompleteWorkOrderOutput{}, err
	}
	producedTotal := workOrder.producedQtyThousandths + input.QuantityThousandths
	// The order closes when the plan is reached; partial completions keep it
	// released so the remainder can still be built.
	done := producedTotal >= workOrder.plannedQtyThousandths
	if done {
		_, err = tx.Exec(ctx, `
			UPDATE work_orders SET status = 'completed', completed_at = $2, produced_qty_thousandths = $3 WHERE id = $1::uuid`,
			workOrder.id, now, producedTotal)
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE work_orders SET produced_qty_thousandths = $2 WHERE id = $1::uuid`,
			workOrder.id, producedTotal)
	}
	if err != nil {
		return ManufacturingCompleteWorkOrderOutput{}, err
	}
	status := "released"
	if done {
		status = "completed"
	}
	return ManufacturingCompleteWorkOrderOutput{
		RunRef:                   runRef,
		Completed:                done,
		ProducedTotalThousandths: producedTotal,
		Status:                   status,
		ProducedThousandths:      posting.producedThousandths,
		ConsumedComponents:       posting.consumedComponents,
		CostRolledUpMinor:        posting.costRolledUpMinor,
	}, nil
}

func manufacturingReverseProductionRun(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ManufacturingRunRefInput) (ManufacturingReverseProductionRunOutput, error) {
	orgID := claims.OrganizationID
	var alreadyReversed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM stock_movements
			WHERE org_id = $1::uuid AND ref_type = 'production_reversal' AND ref_id = $2::uuid
		)`, orgID, input.RunRef).Scan(&alreadyReversed); err != nil {
		return ManufacturingReverseProductionRunOutput{}, err
	}
	if alreadyReversed {
		return ManufacturingReverseProductionRunOutput{}, errors.New("this production run has already been reversed")
	}
	type runMovement struct {
		itemID        string
		quantityDelta int64
		unitCostMinor *int64
		locationID    *string
		lotID         *string
	}
	rows, err := tx.Query(ctx, `
		SELECT item_id::text, quantity_delta, unit_cost_minor, location_id::text, lot_id::text
		FROM stock_movements
		WHERE org_id = $1::uuid AND ref_type = 'production' AND ref_id = $2::uuid
		ORDER BY created_at DESC`, orgID, input.RunRef)
	if err != nil {
		return ManufacturingReverseProductionRunOutput{}, err
	}
	runMovements := make([]runMovement, 0, 8)
	for rows.Next() {
		var movement runMovement
		if err := rows.Scan(&movement.itemID, &movement.quantityDelta, &movement.unitCostMinor, &movement.locationID, &movement.lotID); err != nil {
			rows.Close()
			return ManufacturingReverseProductionRunOutput{}, err
		}
		runMovements = append(runMovements, movement)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ManufacturingReverseProductionRunOutput{}, err
	}
	rows.Close()
	if len(runMovements) == 0 {
		return ManufacturingReverseProductionRunOutput{}, fmt.Errorf("no production run found for %s", input.RunRef)
	}
	// Net per item; removing produced goods must not drive stock negative.
	netByItem := make(map[string]int64, len(runMovements))
	for _, movement := range runMovements {
		netByItem[movement.itemID] += movement.quantityDelta
	}
	netItemIDs := make([]string, 0, len(netByItem))
	for itemID := range netByItem {
		netItemIDs = append(netItemIDs, itemID)
	}
	sort.Strings(netItemIDs)
	for _, itemID := range netItemIDs {
		net := netByItem[itemID]
		if net <= 0 {
			continue
		}
		onHand, err := inventoryStockOnHand(ctx, tx, orgID, itemID, nil)
		if err != nil {
			return ManufacturingReverseProductionRunOutput{}, err
		}
		if net > onHand {
			return ManufacturingReverseProductionRunOutput{}, errors.New("cannot reverse: produced units have already been consumed or sold")
		}
	}
	// Reversal legs are outbound for produced items, so lock before writing
	// and keep the checks serialized against concurrent sales.
	if err := inventoryLockStockItems(ctx, tx, netItemIDs); err != nil {
		return ManufacturingReverseProductionRunOutput{}, err
	}
	restored := []ManufacturingConsumedComponent{}
	removedProduced := []ManufacturingConsumedComponent{}
	var removedFinishedThousandths int64
	// Mirror every movement in reverse chronological order so the reversal
	// replays the run backwards; ledger rows are never mutated or deleted.
	for index := len(runMovements) - 1; index >= 0; index-- {
		movement := runMovements[index]
		note := fmt.Sprintf("reversal of production run %s", input.RunRef[:8])
		if err := manufacturingApplyStockDelta(ctx, tx, orgID, movement.itemID, -movement.quantityDelta, "adjustment", note, "production_reversal", input.RunRef, movement.unitCostMinor, movement.locationID, movement.lotID, claims.ActorType, claims.ActorID); err != nil {
			return ManufacturingReverseProductionRunOutput{}, err
		}
		sku, err := manufacturingSkuByID(ctx, tx, orgID, movement.itemID)
		if err != nil {
			return ManufacturingReverseProductionRunOutput{}, err
		}
		if movement.quantityDelta > 0 {
			removedProduced = append(removedProduced, ManufacturingConsumedComponent{SKU: sku, QuantityThousandths: movement.quantityDelta})
			removedFinishedThousandths += movement.quantityDelta
		} else {
			restored = append(restored, ManufacturingConsumedComponent{SKU: sku, QuantityThousandths: -movement.quantityDelta})
		}
	}
	return ManufacturingReverseProductionRunOutput{
		ReversedMovements:          len(runMovements),
		RemovedFinishedThousandths: removedFinishedThousandths,
		RestoredComponents:         restored,
		RemovedProduced:            removedProduced,
	}, nil
}

func manufacturingProduceFromBom(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ManufacturingProduceFromBomInput) (ManufacturingProduceFromBomOutput, error) {
	orgID := claims.OrganizationID
	var assemblyItemID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
		orgID, input.AssemblySKU).Scan(&assemblyItemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManufacturingProduceFromBomOutput{}, fmt.Errorf("no item with SKU %s", input.AssemblySKU)
	}
	if err != nil {
		return ManufacturingProduceFromBomOutput{}, err
	}
	runRef, err := manufacturingNewRunRef()
	if err != nil {
		return ManufacturingProduceFromBomOutput{}, err
	}
	posting, err := manufacturingPostRun(ctx, tx, orgID, claims.ActorType, claims.ActorID, assemblyItemID, input.AssemblySKU, input.QuantityThousandths, runRef, input.LotCode, false, "%s has no bill of materials; define one first")
	if err != nil {
		return ManufacturingProduceFromBomOutput{}, err
	}
	return ManufacturingProduceFromBomOutput{
		RunRef:              runRef,
		ProducedThousandths: posting.producedThousandths,
		ConsumedComponents:  posting.consumedComponents,
		CostRolledUpMinor:   posting.costRolledUpMinor,
	}, nil
}

func manufacturingCheckProductionFeasibility(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingCheckProductionFeasibilityInput) (ManufacturingCheckProductionFeasibilityOutput, error) {
	var assemblyItemID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
		orgID, input.AssemblySKU).Scan(&assemblyItemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManufacturingCheckProductionFeasibilityOutput{}, fmt.Errorf("no item with sku %s", input.AssemblySKU)
	}
	if err != nil {
		return ManufacturingCheckProductionFeasibilityOutput{}, err
	}
	edges, err := manufacturingOrgBomEdges(ctx, tx, orgID, &assemblyItemID)
	if err != nil {
		return ManufacturingCheckProductionFeasibilityOutput{}, err
	}
	if len(edges) == 0 {
		return ManufacturingCheckProductionFeasibilityOutput{}, fmt.Errorf("item %s has no bill of materials; nothing to explode", input.AssemblySKU)
	}
	requirements, err := manufacturingExplodeBom(edges, assemblyItemID, input.DesiredUnitsThousandths)
	if err != nil {
		return ManufacturingCheckProductionFeasibilityOutput{}, err
	}
	onHandByItem := make(map[string]int64, len(requirements))
	for _, requirement := range requirements {
		onHand, err := inventoryStockOnHand(ctx, tx, orgID, requirement.itemID, nil)
		if err != nil {
			return ManufacturingCheckProductionFeasibilityOutput{}, err
		}
		onHandByItem[requirement.itemID] = onHand
	}
	check := manufacturingCheckAvailability(requirements, onHandByItem)
	// Ceiling from per-unit needs: exploding one unit keeps the answer
	// independent of the desired quantity.
	perUnit, err := manufacturingExplodeBom(edges, assemblyItemID, 1000)
	if err != nil {
		return ManufacturingCheckProductionFeasibilityOutput{}, err
	}
	needs := make([]manufacturingPerUnitNeed, 0, len(perUnit))
	for _, requirement := range perUnit {
		needs = append(needs, manufacturingPerUnitNeed{componentItemID: requirement.itemID, perUnitThousandths: requirement.quantityThousandths})
	}
	ceiling := manufacturingMaxProducibleUnits(needs, onHandByItem)
	var avgDays float64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - released_at)) / 86400), 0)
		FROM work_orders
		WHERE org_id = $1::uuid AND assembly_item_id = $2::uuid AND status = 'completed'`,
		orgID, assemblyItemID).Scan(&avgDays); err != nil {
		return ManufacturingCheckProductionFeasibilityOutput{}, err
	}
	lines := make([]ManufacturingFeasibilityLine, 0, len(check.lines))
	for _, line := range check.lines {
		lines = append(lines, ManufacturingFeasibilityLine{
			ItemID:               line.itemID,
			RequiredThousandths:  line.quantityThousandths,
			OnHandThousandths:    line.onHandThousandths,
			ShortfallThousandths: line.shortfallThousandths,
		})
	}
	output := ManufacturingCheckProductionFeasibilityOutput{
		Producible:               check.producible,
		MaxProducibleThousandths: ceiling,
		Lines:                    lines,
	}
	if avgDays > 0 {
		leadTimeDays := int64(math.Ceil(avgDays))
		output.EstimatedLeadTimeDays = &leadTimeDays
	}
	return output, nil
}

func manufacturingWorkOrdersTimestamp(at time.Time) string {
	return at.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func manufacturingWorkOrdersList(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingWorkOrdersListInput) (ManufacturingWorkOrdersListOutput, error) {
	query := `
		SELECT wo.id::text, wo.number, i.sku, wo.status, wo.planned_qty_thousandths,
			wo.produced_qty_thousandths, wo.yield_pct_thousandths, wo.note, wo.created_at
		FROM work_orders wo
		INNER JOIN items i ON i.id = wo.assembly_item_id
		WHERE wo.org_id = $1::uuid`
	args := []any{orgID}
	if input.Status != nil {
		query += ` AND wo.status = $2`
		args = append(args, *input.Status)
	}
	query += fmt.Sprintf(` ORDER BY wo.created_at DESC LIMIT $%d`, len(args)+1)
	args = append(args, input.Limit)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return ManufacturingWorkOrdersListOutput{}, err
	}
	defer rows.Close()
	workOrders := []ManufacturingWorkOrderListItem{}
	for rows.Next() {
		var item ManufacturingWorkOrderListItem
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.Number, &item.AssemblySKU, &item.Status,
			&item.PlannedQtyThousandths, &item.ProducedQtyThousandths, &item.YieldPctThousandths,
			&item.Note, &createdAt); err != nil {
			return ManufacturingWorkOrdersListOutput{}, err
		}
		item.CreatedAt = manufacturingWorkOrdersTimestamp(createdAt)
		item.ExpectedGoodThousandths = manufacturingPlannedGoodQuantity(item.PlannedQtyThousandths, item.YieldPctThousandths)
		workOrders = append(workOrders, item)
	}
	if err := rows.Err(); err != nil {
		return ManufacturingWorkOrdersListOutput{}, err
	}
	return ManufacturingWorkOrdersListOutput{WorkOrders: workOrders}, nil
}

func parseManufacturingWorkOrderInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case manufacturingCreateWorkOrderCapabilityID:
		return ParseManufacturingCreateWorkOrderInput(raw)
	case manufacturingReleaseWorkOrderCapabilityID:
		return ParseManufacturingReleaseWorkOrderInput(raw)
	case manufacturingCompleteWorkOrderCapabilityID:
		return ParseManufacturingCompleteWorkOrderInput(raw)
	case manufacturingCancelWorkOrderCapabilityID:
		return ParseManufacturingCancelWorkOrderInput(raw)
	case manufacturingReverseProductionRunCapabilityID:
		return ParseManufacturingReverseProductionRunInput(raw)
	case manufacturingCheckProductionFeasibilityCapabilityID:
		return ParseManufacturingCheckProductionFeasibilityInput(raw)
	case manufacturingWorkOrdersListCapabilityID:
		return ParseManufacturingWorkOrdersListInput(raw)
	case manufacturingProduceFromBomCapabilityID:
		return ParseManufacturingProduceFromBomInput(raw)
	default:
		return nil, errors.New("unsupported manufacturing work order capability")
	}
}
