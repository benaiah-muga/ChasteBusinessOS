package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	manufacturingDefineBomCapabilityID      = "manufacturing.defineBom"
	manufacturingDeleteBomCapabilityID      = "manufacturing.deleteBom"
	manufacturingBomTreeCapabilityID        = "manufacturing.bomTree"
	manufacturingBomReportCapabilityID      = "manufacturing.bomReport"
	manufacturingCostPreviewCapabilityID    = "manufacturing.costPreview"
	manufacturingLotTraceCapabilityID       = "manufacturing.lotTrace"
	manufacturingProductionRunsCapabilityID = "manufacturing.productionRuns"
)

type ManufacturingBomComponentInput struct {
	SKU                 string `json:"sku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
	ScrapPctThousandths int64  `json:"scrapPctThousandths"`
}

type ManufacturingDefineBomInput struct {
	AssemblySKU string                           `json:"assemblySku"`
	Components  []ManufacturingBomComponentInput `json:"components"`
}

type ManufacturingDefineBomOutput struct {
	AssemblyItemID string `json:"assemblyItemId"`
	ComponentCount int    `json:"componentCount"`
}

type ManufacturingDeleteBomInput struct {
	AssemblySKU string `json:"assemblySku"`
}

type ManufacturingDeleteBomLine struct {
	SKU                 string `json:"sku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
	ScrapPctThousandths int64  `json:"scrapPctThousandths"`
}

type ManufacturingDeleteBomOutput struct {
	RemovedCount int                          `json:"removedCount"`
	RemovedLines []ManufacturingDeleteBomLine `json:"removedLines"`
}

type ManufacturingBomTreeNode struct {
	SKU                 string                     `json:"sku"`
	Name                string                     `json:"name"`
	QuantityThousandths int64                      `json:"quantityThousandths"`
	Children            []ManufacturingBomTreeNode `json:"children"`
}

type ManufacturingBomTreeInput struct {
	AssemblySKU         string `json:"assemblySku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
}

type ManufacturingBomTreeOutput struct {
	HasBom bool                     `json:"hasBom"`
	Root   ManufacturingBomTreeNode `json:"root"`
}

type ManufacturingBomReportInput struct {
	AssemblySKU         string `json:"assemblySku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
}

type ManufacturingBomReportLine struct {
	SKU                  string `json:"sku"`
	Name                 string `json:"name"`
	RequiredThousandths  int64  `json:"requiredThousandths"`
	OnHandThousandths    int64  `json:"onHandThousandths"`
	ShortfallThousandths int64  `json:"shortfallThousandths"`
}

type ManufacturingBomReportOutput struct {
	Producible                bool                         `json:"producible"`
	TotalShortfallThousandths int64                        `json:"totalShortfallThousandths"`
	Lines                     []ManufacturingBomReportLine `json:"lines"`
}

type ManufacturingCostPreviewInput struct {
	AssemblySKU         string `json:"assemblySku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
	YieldPctThousandths int64  `json:"yieldPctThousandths"`
}

type ManufacturingCostPreviewLine struct {
	SKU                 string `json:"sku"`
	Name                string `json:"name"`
	RequiredThousandths int64  `json:"requiredThousandths"`
	UnitCostMinor       int64  `json:"unitCostMinor"`
	CostMinor           int64  `json:"costMinor"`
}

type ManufacturingCostPreviewOutput struct {
	PlannedThousandths                int64                          `json:"plannedThousandths"`
	ExpectedGoodThousandths           int64                          `json:"expectedGoodThousandths"`
	Lines                             []ManufacturingCostPreviewLine `json:"lines"`
	TotalCostMinor                    int64                          `json:"totalCostMinor"`
	ResultingAvgFinishedUnitCostMinor int64                          `json:"resultingAvgFinishedUnitCostMinor"`
	Producible                        bool                           `json:"producible"`
}

type ManufacturingLotTraceInput struct {
	SKU     string `json:"sku"`
	LotCode string `json:"lotCode"`
}

type ManufacturingLotTraceNode struct {
	LotCode string                      `json:"lotCode"`
	SKU     string                      `json:"sku"`
	FedBy   []ManufacturingLotTraceNode `json:"fedBy"`
}

type ManufacturingLotTraceOutput struct {
	Found bool                        `json:"found"`
	Tree  []ManufacturingLotTraceNode `json:"tree"`
}

type ManufacturingProductionRunConsumed struct {
	SKU                 string `json:"sku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
}

type ManufacturingProductionRun struct {
	RunRef              string                               `json:"runRef"`
	WorkOrderNumber     *int64                               `json:"workOrderNumber"`
	AssemblySKU         string                               `json:"assemblySku"`
	ProducedThousandths int64                                `json:"producedThousandths"`
	Consumed            []ManufacturingProductionRunConsumed `json:"consumed"`
	CostRolledUpMinor   int64                                `json:"costRolledUpMinor"`
	Reversed            bool                                 `json:"reversed"`
	ActorType           string                               `json:"actorType"`
	CreatedAt           string                               `json:"createdAt"`
}

type ManufacturingProductionRunsInput struct {
	Limit int64 `json:"limit"`
}

type ManufacturingProductionRunsOutput struct {
	Runs []ManufacturingProductionRun `json:"runs"`
}

func ParseManufacturingDefineBomInput(raw json.RawMessage) (ManufacturingDefineBomInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingDefineBomInput{}, err
	}
	var input ManufacturingDefineBomInput
	if input.AssemblySKU, err = requiredCRMDealString(fields, "assemblySku", 0, 0); err != nil {
		return ManufacturingDefineBomInput{}, err
	}
	rawComponents, ok := fields["components"]
	if !ok {
		return ManufacturingDefineBomInput{}, errors.New("components is required")
	}
	var components []json.RawMessage
	if err := json.Unmarshal(rawComponents, &components); err != nil {
		return ManufacturingDefineBomInput{}, errors.New("components must be an array")
	}
	if len(components) < 1 {
		return ManufacturingDefineBomInput{}, errors.New("components must have at least 1 items")
	}
	if len(components) > 100 {
		return ManufacturingDefineBomInput{}, errors.New("components must have at most 100 items")
	}
	for _, rawComponent := range components {
		var componentFields map[string]json.RawMessage
		if err := json.Unmarshal(rawComponent, &componentFields); err != nil {
			return ManufacturingDefineBomInput{}, errors.New("components must be objects")
		}
		component := ManufacturingBomComponentInput{}
		if component.SKU, err = requiredCRMDealString(componentFields, "sku", 0, 0); err != nil {
			return ManufacturingDefineBomInput{}, err
		}
		if component.QuantityThousandths, err = manufacturingRequiredPositiveQuantity(componentFields, "quantityThousandths"); err != nil {
			return ManufacturingDefineBomInput{}, err
		}
		if component.ScrapPctThousandths, err = manufacturingOptionalPctThousandths(componentFields, "scrapPctThousandths", 0); err != nil {
			return ManufacturingDefineBomInput{}, err
		}
		input.Components = append(input.Components, component)
	}
	return input, nil
}

func ParseManufacturingDeleteBomInput(raw json.RawMessage) (ManufacturingDeleteBomInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingDeleteBomInput{}, err
	}
	var input ManufacturingDeleteBomInput
	if input.AssemblySKU, err = requiredCRMDealString(fields, "assemblySku", 0, 0); err != nil {
		return ManufacturingDeleteBomInput{}, err
	}
	return input, nil
}

func parseManufacturingBomQuantityWithDefault(raw json.RawMessage, key string, defaultValue int64) (int64, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return 0, err
	}
	quantity := defaultValue
	if _, ok := fields[key]; ok {
		if quantity, err = manufacturingRequiredPositiveQuantity(fields, key); err != nil {
			return 0, err
		}
	}
	return quantity, nil
}

func ParseManufacturingBomTreeInput(raw json.RawMessage) (ManufacturingBomTreeInput, error) {
	var input ManufacturingBomTreeInput
	var err error
	if input.AssemblySKU, err = requiredCRMDealString(mustDecodeObjectForField(raw), "assemblySku", 0, 0); err != nil {
		return ManufacturingBomTreeInput{}, err
	}
	if input.QuantityThousandths, err = parseManufacturingBomQuantityWithDefault(raw, "quantityThousandths", 1000); err != nil {
		return ManufacturingBomTreeInput{}, err
	}
	return input, nil
}

func ParseManufacturingBomReportInput(raw json.RawMessage) (ManufacturingBomReportInput, error) {
	var input ManufacturingBomReportInput
	var err error
	if input.AssemblySKU, err = requiredCRMDealString(mustDecodeObjectForField(raw), "assemblySku", 0, 0); err != nil {
		return ManufacturingBomReportInput{}, err
	}
	if input.QuantityThousandths, err = parseManufacturingBomQuantityWithDefault(raw, "quantityThousandths", 1000); err != nil {
		return ManufacturingBomReportInput{}, err
	}
	return input, nil
}

func ParseManufacturingCostPreviewInput(raw json.RawMessage) (ManufacturingCostPreviewInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingCostPreviewInput{}, err
	}
	var input ManufacturingCostPreviewInput
	if input.AssemblySKU, err = requiredCRMDealString(fields, "assemblySku", 0, 0); err != nil {
		return ManufacturingCostPreviewInput{}, err
	}
	if input.QuantityThousandths, err = manufacturingRequiredPositiveQuantity(fields, "quantityThousandths"); err != nil {
		return ManufacturingCostPreviewInput{}, err
	}
	if input.YieldPctThousandths, err = manufacturingOptionalPctThousandths(fields, "yieldPctThousandths", manufacturingPctScale); err != nil {
		return ManufacturingCostPreviewInput{}, err
	}
	return input, nil
}

func ParseManufacturingLotTraceInput(raw json.RawMessage) (ManufacturingLotTraceInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingLotTraceInput{}, err
	}
	var input ManufacturingLotTraceInput
	if input.SKU, err = requiredCRMDealString(fields, "sku", 0, 0); err != nil {
		return ManufacturingLotTraceInput{}, err
	}
	if input.LotCode, err = requiredCRMDealString(fields, "lotCode", 0, 0); err != nil {
		return ManufacturingLotTraceInput{}, err
	}
	return input, nil
}

func ParseManufacturingProductionRunsInput(raw json.RawMessage) (ManufacturingProductionRunsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ManufacturingProductionRunsInput{}, err
	}
	input := ManufacturingProductionRunsInput{Limit: 25}
	if _, ok := fields["limit"]; ok {
		if input.Limit, err = requiredSafeInteger(fields, "limit"); err != nil {
			return ManufacturingProductionRunsInput{}, err
		}
		if input.Limit < 1 || input.Limit > 100 {
			return ManufacturingProductionRunsInput{}, errors.New("limit must be between 1 and 100")
		}
	}
	return input, nil
}

func parseManufacturingBomInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case manufacturingDefineBomCapabilityID:
		return ParseManufacturingDefineBomInput(raw)
	case manufacturingDeleteBomCapabilityID:
		return ParseManufacturingDeleteBomInput(raw)
	case manufacturingBomTreeCapabilityID:
		return ParseManufacturingBomTreeInput(raw)
	case manufacturingBomReportCapabilityID:
		return ParseManufacturingBomReportInput(raw)
	case manufacturingCostPreviewCapabilityID:
		return ParseManufacturingCostPreviewInput(raw)
	case manufacturingLotTraceCapabilityID:
		return ParseManufacturingLotTraceInput(raw)
	case manufacturingProductionRunsCapabilityID:
		return ParseManufacturingProductionRunsInput(raw)
	default:
		return nil, errors.New("unsupported manufacturing BOM capability")
	}
}

func mustDecodeObjectForField(raw json.RawMessage) map[string]json.RawMessage {
	fields, _ := decodeJSONObject(raw)
	return fields
}

func manufacturingItemIDBySKU(ctx context.Context, tx pgx.Tx, orgID, sku string) (string, error) {
	var itemID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM items WHERE org_id=$1::uuid AND sku=$2 LIMIT 1`, orgID, sku).Scan(&itemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("no item with SKU %s", sku)
	}
	return itemID, err
}

func manufacturingDefineBom(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ManufacturingDefineBomInput) (ManufacturingDefineBomOutput, error) {
	assemblyID, err := manufacturingItemIDBySKU(ctx, tx, claims.OrganizationID, input.AssemblySKU)
	if err != nil {
		return ManufacturingDefineBomOutput{}, err
	}
	resolved := map[string]string{}
	for _, component := range input.Components {
		if component.SKU == input.AssemblySKU {
			return ManufacturingDefineBomOutput{}, errors.New("an assembly cannot contain itself")
		}
		componentID, err := manufacturingItemIDBySKU(ctx, tx, claims.OrganizationID, component.SKU)
		if err != nil {
			return ManufacturingDefineBomOutput{}, err
		}
		resolved[component.SKU] = componentID
	}
	if _, err := tx.Exec(ctx, `DELETE FROM bom_lines WHERE org_id=$1::uuid AND assembly_item_id=$2::uuid`, claims.OrganizationID, assemblyID); err != nil {
		return ManufacturingDefineBomOutput{}, err
	}
	for _, component := range input.Components {
		if _, err := tx.Exec(ctx, `
			INSERT INTO bom_lines (org_id, assembly_item_id, component_item_id, quantity_thousandths, scrap_pct_thousandths)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
			claims.OrganizationID, assemblyID, resolved[component.SKU], component.QuantityThousandths, component.ScrapPctThousandths); err != nil {
			return ManufacturingDefineBomOutput{}, err
		}
	}
	allEdges, err := manufacturingOrgBomEdges(ctx, tx, claims.OrganizationID, nil)
	if err != nil {
		return ManufacturingDefineBomOutput{}, err
	}
	if _, err := manufacturingExplodeBom(allEdges, assemblyID, 1000); err != nil {
		return ManufacturingDefineBomOutput{}, fmt.Errorf("rejected: %s", err.Error())
	}
	return ManufacturingDefineBomOutput{AssemblyItemID: assemblyID, ComponentCount: len(input.Components)}, nil
}

func manufacturingDeleteBom(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ManufacturingDeleteBomInput) (ManufacturingDeleteBomOutput, error) {
	assemblyID, err := manufacturingItemIDBySKU(ctx, tx, claims.OrganizationID, input.AssemblySKU)
	if err != nil {
		return ManufacturingDeleteBomOutput{}, err
	}
	rows, err := tx.Query(ctx, `
		DELETE FROM bom_lines WHERE org_id=$1::uuid AND assembly_item_id=$2::uuid
		RETURNING component_item_id::text, quantity_thousandths, scrap_pct_thousandths`,
		claims.OrganizationID, assemblyID)
	if err != nil {
		return ManufacturingDeleteBomOutput{}, err
	}
	type removedLine struct {
		componentItemID     string
		quantityThousandths int64
		scrapPctThousandths int64
	}
	var removed []removedLine
	for rows.Next() {
		var line removedLine
		if err := rows.Scan(&line.componentItemID, &line.quantityThousandths, &line.scrapPctThousandths); err != nil {
			rows.Close()
			return ManufacturingDeleteBomOutput{}, err
		}
		removed = append(removed, line)
	}
	rows.Close()
	if len(removed) == 0 {
		return ManufacturingDeleteBomOutput{}, fmt.Errorf("%s has no bill of materials", input.AssemblySKU)
	}
	skuByItem, err := manufacturingSkuMap(ctx, tx, claims.OrganizationID)
	if err != nil {
		return ManufacturingDeleteBomOutput{}, err
	}
	out := ManufacturingDeleteBomOutput{RemovedCount: len(removed)}
	for _, line := range removed {
		sku, ok := skuByItem[line.componentItemID]
		if !ok {
			sku = line.componentItemID
		}
		out.RemovedLines = append(out.RemovedLines, ManufacturingDeleteBomLine{
			SKU: sku, QuantityThousandths: line.quantityThousandths, ScrapPctThousandths: line.scrapPctThousandths,
		})
	}
	return out, nil
}

func manufacturingBomTree(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingBomTreeInput) (ManufacturingBomTreeOutput, error) {
	edges, err := manufacturingOrgBomEdges(ctx, tx, orgID, nil)
	if err != nil {
		return ManufacturingBomTreeOutput{}, err
	}
	type itemRow struct {
		id   string
		sku  string
		name string
	}
	itemRows, err := tx.Query(ctx, `SELECT id::text, sku, name FROM items WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return ManufacturingBomTreeOutput{}, err
	}
	var items []itemRow
	for itemRows.Next() {
		var row itemRow
		if err := itemRows.Scan(&row.id, &row.sku, &row.name); err != nil {
			itemRows.Close()
			return ManufacturingBomTreeOutput{}, err
		}
		items = append(items, row)
	}
	itemRows.Close()
	var root *itemRow
	edgesByAssembly := map[string][]manufacturingBomEdge{}
	for _, edge := range edges {
		edgesByAssembly[edge.assemblyItemID] = append(edgesByAssembly[edge.assemblyItemID], edge)
	}
	itemByID := map[string]itemRow{}
	for i := range items {
		itemByID[items[i].id] = items[i]
		if items[i].sku == input.AssemblySKU {
			root = &items[i]
		}
	}
	if root == nil {
		return ManufacturingBomTreeOutput{}, fmt.Errorf("no item with SKU %s", input.AssemblySKU)
	}
	var build func(itemID string, qty int64, path map[string]bool) ManufacturingBomTreeNode
	build = func(itemID string, qty int64, path map[string]bool) ManufacturingBomTreeNode {
		item := itemByID[itemID]
		node := ManufacturingBomTreeNode{SKU: item.sku, Name: item.name, QuantityThousandths: qty, Children: []ManufacturingBomTreeNode{}}
		if path[itemID] {
			return node
		}
		nextPath := map[string]bool{}
		for key := range path {
			nextPath[key] = true
		}
		nextPath[itemID] = true
		for _, edge := range edgesByAssembly[itemID] {
			scaled := (edge.quantityThousandths*qty + 500) / 1000
			node.Children = append(node.Children, build(edge.componentItemID, scaled, nextPath))
		}
		return node
	}
	rootNode := build(root.id, input.QuantityThousandths, map[string]bool{})
	return ManufacturingBomTreeOutput{HasBom: len(rootNode.Children) > 0, Root: rootNode}, nil
}

func manufacturingBomReport(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingBomReportInput) (ManufacturingBomReportOutput, error) {
	assemblyID, err := manufacturingItemIDBySKU(ctx, tx, orgID, input.AssemblySKU)
	if err != nil {
		return ManufacturingBomReportOutput{}, err
	}
	requirements, hasBom, err := manufacturingScrapAdjustedRequirements(ctx, tx, orgID, assemblyID, input.QuantityThousandths)
	if err != nil {
		return ManufacturingBomReportOutput{}, err
	}
	if !hasBom {
		return ManufacturingBomReportOutput{}, fmt.Errorf("%s has no bill of materials", input.AssemblySKU)
	}
	itemRows, err := tx.Query(ctx, `SELECT id::text, sku, name FROM items WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return ManufacturingBomReportOutput{}, err
	}
	type itemRow struct {
		id   string
		sku  string
		name string
	}
	itemsByID := map[string]itemRow{}
	for itemRows.Next() {
		var row itemRow
		if err := itemRows.Scan(&row.id, &row.sku, &row.name); err != nil {
			itemRows.Close()
			return ManufacturingBomReportOutput{}, err
		}
		itemsByID[row.id] = row
	}
	itemRows.Close()
	onHandByItem := map[string]int64{}
	for _, requirement := range requirements {
		onHand, err := inventoryStockOnHand(ctx, tx, orgID, requirement.itemID, nil)
		if err != nil {
			return ManufacturingBomReportOutput{}, err
		}
		onHandByItem[requirement.itemID] = onHand
	}
	availability := manufacturingCheckAvailability(requirements, onHandByItem)
	out := ManufacturingBomReportOutput{Producible: availability.producible, TotalShortfallThousandths: availability.totalShortfallThousandths, Lines: []ManufacturingBomReportLine{}}
	for _, line := range availability.lines {
		item := itemsByID[line.itemID]
		out.Lines = append(out.Lines, ManufacturingBomReportLine{
			SKU: item.sku, Name: item.name,
			RequiredThousandths: line.quantityThousandths, OnHandThousandths: line.onHandThousandths, ShortfallThousandths: line.shortfallThousandths,
		})
	}
	return out, nil
}

func manufacturingCostPreview(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingCostPreviewInput) (ManufacturingCostPreviewOutput, error) {
	assemblyID, err := manufacturingItemIDBySKU(ctx, tx, orgID, input.AssemblySKU)
	if err != nil {
		return ManufacturingCostPreviewOutput{}, err
	}
	requirements, hasBom, err := manufacturingScrapAdjustedRequirements(ctx, tx, orgID, assemblyID, input.QuantityThousandths)
	if err != nil {
		return ManufacturingCostPreviewOutput{}, err
	}
	if !hasBom {
		return ManufacturingCostPreviewOutput{}, fmt.Errorf("%s has no bill of materials", input.AssemblySKU)
	}
	itemRows, err := tx.Query(ctx, `SELECT id::text, sku, name FROM items WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return ManufacturingCostPreviewOutput{}, err
	}
	type itemRow struct {
		id   string
		sku  string
		name string
	}
	itemsByID := map[string]itemRow{}
	for itemRows.Next() {
		var row itemRow
		if err := itemRows.Scan(&row.id, &row.sku, &row.name); err != nil {
			itemRows.Close()
			return ManufacturingCostPreviewOutput{}, err
		}
		itemsByID[row.id] = row
	}
	itemRows.Close()
	onHandByItem := map[string]int64{}
	costsByItem := map[string]int64{}
	for _, requirement := range requirements {
		unitCost, err := manufacturingAvgUnitCost(ctx, tx, orgID, requirement.itemID)
		if err != nil {
			return ManufacturingCostPreviewOutput{}, err
		}
		costsByItem[requirement.itemID] = unitCost
		onHand, err := inventoryStockOnHand(ctx, tx, orgID, requirement.itemID, nil)
		if err != nil {
			return ManufacturingCostPreviewOutput{}, err
		}
		onHandByItem[requirement.itemID] = onHand
	}
	availability := manufacturingCheckAvailability(requirements, onHandByItem)
	out := ManufacturingCostPreviewOutput{
		PlannedThousandths:      input.QuantityThousandths,
		ExpectedGoodThousandths: manufacturingPlannedGoodQuantity(input.QuantityThousandths, input.YieldPctThousandths),
		Lines:                   []ManufacturingCostPreviewLine{},
		Producible:              availability.producible,
	}
	for _, requirement := range requirements {
		unitCost := costsByItem[requirement.itemID]
		line := ManufacturingCostPreviewLine{
			SKU: itemsByID[requirement.itemID].sku, Name: itemsByID[requirement.itemID].name,
			RequiredThousandths: requirement.quantityThousandths, UnitCostMinor: unitCost,
			CostMinor: (requirement.quantityThousandths*unitCost + 500) / 1000,
		}
		out.TotalCostMinor += line.CostMinor
		out.Lines = append(out.Lines, line)
	}
	if input.QuantityThousandths > 0 {
		out.ResultingAvgFinishedUnitCostMinor = (out.TotalCostMinor*1000 + 500) / input.QuantityThousandths
	}
	return out, nil
}

type manufacturingTraceEdge struct {
	consumerLotID       string
	sourceLotID         string
	quantityThousandths int64
	viaRef              string
}

type manufacturingTraceNode struct {
	lotID string
	links []manufacturingTraceLink
}

type manufacturingTraceLink struct {
	node                manufacturingTraceNode
	quantityThousandths int64
	viaRef              string
}

func manufacturingTraceLotUpstream(edges []manufacturingTraceEdge, rootLotID string) manufacturingTraceNode {
	byConsumer := map[string][]manufacturingTraceEdge{}
	for _, edge := range edges {
		byConsumer[edge.consumerLotID] = append(byConsumer[edge.consumerLotID], edge)
	}
	const maxTraceDepth = 32
	var walk func(lotID string, depth int, path map[string]bool) manufacturingTraceNode
	walk = func(lotID string, depth int, path map[string]bool) manufacturingTraceNode {
		if depth > maxTraceDepth || path[lotID] {
			return manufacturingTraceNode{lotID: lotID}
		}
		nextPath := map[string]bool{}
		for key := range path {
			nextPath[key] = true
		}
		nextPath[lotID] = true
		node := manufacturingTraceNode{lotID: lotID}
		for _, edge := range byConsumer[lotID] {
			node.links = append(node.links, manufacturingTraceLink{
				node:                walk(edge.sourceLotID, depth+1, nextPath),
				quantityThousandths: edge.quantityThousandths,
				viaRef:              edge.viaRef,
			})
		}
		return node
	}
	return walk(rootLotID, 0, map[string]bool{})
}

func manufacturingLotTrace(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingLotTraceInput) (ManufacturingLotTraceOutput, error) {
	itemID, err := manufacturingItemIDBySKU(ctx, tx, orgID, input.SKU)
	if err != nil {
		return ManufacturingLotTraceOutput{}, err
	}
	var lotID string
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM lots WHERE org_id=$1::uuid AND item_id=$2::uuid AND lot_code=$3 LIMIT 1`,
		orgID, itemID, input.LotCode).Scan(&lotID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManufacturingLotTraceOutput{}, fmt.Errorf("no lot %q for %s", input.LotCode, input.SKU)
	}
	if err != nil {
		return ManufacturingLotTraceOutput{}, err
	}
	moveRows, err := tx.Query(ctx, `
		SELECT ref_id, quantity_delta, lot_id::text FROM stock_movements
		WHERE org_id=$1::uuid AND ref_type='production' AND lot_id IS NOT NULL`, orgID)
	if err != nil {
		return ManufacturingLotTraceOutput{}, err
	}
	type productionLeg struct {
		refID string
		delta int64
		lotID string
	}
	var legs []productionLeg
	for moveRows.Next() {
		var leg productionLeg
		var refID *string
		if err := moveRows.Scan(&refID, &leg.delta, &leg.lotID); err != nil {
			moveRows.Close()
			return ManufacturingLotTraceOutput{}, err
		}
		if refID != nil {
			leg.refID = *refID
			legs = append(legs, leg)
		}
	}
	moveRows.Close()
	legsByRef := map[string][]productionLeg{}
	for _, leg := range legs {
		legsByRef[leg.refID] = append(legsByRef[leg.refID], leg)
	}
	var traceEdges []manufacturingTraceEdge
	for ref, group := range legsByRef {
		for _, out := range group {
			if out.delta <= 0 {
				continue
			}
			for _, in := range group {
				if in.delta >= 0 {
					continue
				}
				viaRef := ref
				if len(viaRef) > 8 {
					viaRef = ref[:8]
				}
				traceEdges = append(traceEdges, manufacturingTraceEdge{
					consumerLotID: out.lotID, sourceLotID: in.lotID,
					quantityThousandths: -in.delta, viaRef: viaRef,
				})
			}
		}
	}
	trace := manufacturingTraceLotUpstream(traceEdges, lotID)
	lotRows, err := tx.Query(ctx, `SELECT id::text, item_id::text, lot_code FROM lots WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return ManufacturingLotTraceOutput{}, err
	}
	lotCodeByLot := map[string]string{}
	itemIDByLot := map[string]string{}
	for lotRows.Next() {
		var lotRowID, lotItemID, lotCode string
		if err := lotRows.Scan(&lotRowID, &lotItemID, &lotCode); err != nil {
			lotRows.Close()
			return ManufacturingLotTraceOutput{}, err
		}
		lotCodeByLot[lotRowID] = lotCode
		itemIDByLot[lotRowID] = lotItemID
	}
	lotRows.Close()
	skuByItem, err := manufacturingSkuMap(ctx, tx, orgID)
	if err != nil {
		return ManufacturingLotTraceOutput{}, err
	}
	var decorate func(node manufacturingTraceNode) ManufacturingLotTraceNode
	decorate = func(node manufacturingTraceNode) ManufacturingLotTraceNode {
		out := ManufacturingLotTraceNode{LotCode: node.lotID, SKU: "", FedBy: []ManufacturingLotTraceNode{}}
		if code, ok := lotCodeByLot[node.lotID]; ok {
			out.LotCode = code
		}
		if itemID, ok := itemIDByLot[node.lotID]; ok {
			if sku, ok := skuByItem[itemID]; ok {
				out.SKU = sku
			}
		}
		for _, link := range node.links {
			child := decorate(link.node)
			out.FedBy = append(out.FedBy, child)
		}
		return out
	}
	return ManufacturingLotTraceOutput{Found: true, Tree: []ManufacturingLotTraceNode{decorate(trace)}}, nil
}

func manufacturingProductionRuns(ctx context.Context, tx pgx.Tx, orgID string, input ManufacturingProductionRunsInput) (ManufacturingProductionRunsOutput, error) {
	moveRows, err := tx.Query(ctx, `
		SELECT ref_id, item_id::text, quantity_delta, unit_cost_minor, actor_type, created_at
		FROM stock_movements WHERE org_id=$1::uuid AND ref_type='production'
		ORDER BY created_at DESC LIMIT $2`, orgID, input.Limit*20)
	if err != nil {
		return ManufacturingProductionRunsOutput{}, err
	}
	type runMovement struct {
		refID     string
		itemID    string
		delta     int64
		unitCost  *int64
		actorType string
		createdAt time.Time
	}
	movementsByRef := map[string][]runMovement{}
	var refOrder []string
	for moveRows.Next() {
		var movement runMovement
		var refID *string
		if err := moveRows.Scan(&refID, &movement.itemID, &movement.delta, &movement.unitCost, &movement.actorType, &movement.createdAt); err != nil {
			moveRows.Close()
			return ManufacturingProductionRunsOutput{}, err
		}
		if refID == nil {
			continue
		}
		movement.refID = *refID
		if _, seen := movementsByRef[movement.refID]; !seen {
			refOrder = append(refOrder, movement.refID)
		}
		movementsByRef[movement.refID] = append(movementsByRef[movement.refID], movement)
	}
	moveRows.Close()
	if len(refOrder) > int(input.Limit) {
		refOrder = refOrder[:input.Limit]
	}
	woNumbers := map[string]int64{}
	woRows, err := tx.Query(ctx, `SELECT id::text, number FROM work_orders WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return ManufacturingProductionRunsOutput{}, err
	}
	for woRows.Next() {
		var id string
		var number int64
		if err := woRows.Scan(&id, &number); err != nil {
			woRows.Close()
			return ManufacturingProductionRunsOutput{}, err
		}
		woNumbers[id] = number
	}
	woRows.Close()
	skuByItem, err := manufacturingSkuMap(ctx, tx, orgID)
	if err != nil {
		return ManufacturingProductionRunsOutput{}, err
	}
	reversalRefs := map[string]bool{}
	reversalRows, err := tx.Query(ctx, `
		SELECT DISTINCT ref_id FROM stock_movements WHERE org_id=$1::uuid AND ref_type='production_reversal' AND ref_id IS NOT NULL`, orgID)
	if err != nil {
		return ManufacturingProductionRunsOutput{}, err
	}
	for reversalRows.Next() {
		var refID string
		if err := reversalRows.Scan(&refID); err != nil {
			reversalRows.Close()
			return ManufacturingProductionRunsOutput{}, err
		}
		reversalRefs[refID] = true
	}
	reversalRows.Close()
	out := ManufacturingProductionRunsOutput{Runs: []ManufacturingProductionRun{}}
	for _, runRef := range refOrder {
		movements := movementsByRef[runRef]
		var outMovement *runMovement
		for i := range movements {
			if movements[i].delta > 0 {
				outMovement = &movements[i]
				break
			}
		}
		if outMovement == nil {
			continue
		}
		run := ManufacturingProductionRun{
			RunRef: runRef, AssemblySKU: outMovement.itemID,
			ProducedThousandths: outMovement.delta, Reversed: reversalRefs[runRef],
			ActorType: outMovement.actorType,
			CreatedAt: outMovement.createdAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		}
		if sku, ok := skuByItem[outMovement.itemID]; ok {
			run.AssemblySKU = sku
		}
		if number, ok := woNumbers[runRef]; ok {
			number := number
			run.WorkOrderNumber = &number
		}
		for _, movement := range movements {
			if movement.delta >= 0 {
				continue
			}
			unitCost := int64(0)
			if movement.unitCost != nil {
				unitCost = *movement.unitCost
			} else if outMovement.unitCost != nil {
				unitCost = *outMovement.unitCost
			}
			run.CostRolledUpMinor += (-movement.delta*unitCost + 500) / 1000
			consumedSKU := movement.itemID
			if sku, ok := skuByItem[movement.itemID]; ok {
				consumedSKU = sku
			}
			run.Consumed = append(run.Consumed, ManufacturingProductionRunConsumed{SKU: consumedSKU, QuantityThousandths: -movement.delta})
		}
		out.Runs = append(out.Runs, run)
	}
	return out, nil
}
