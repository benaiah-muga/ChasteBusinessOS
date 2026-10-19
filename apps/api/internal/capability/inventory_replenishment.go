package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

const inventoryReplenishmentPlanCapabilityID = "inventory.replenishmentPlan"

const (
	inventoryReplenishmentDefaultLookbackDays = int64(90)
	inventoryReplenishmentDefaultReviewDays   = int64(7)
	inventoryReplenishmentDefaultLeadDays     = int64(14)
	inventoryReplenishmentMaxItems            = 200
)

type InventoryReplenishmentPlanInput struct {
	SKU               string `json:"sku,omitempty"`
	LookbackDays      int64  `json:"lookbackDays,omitempty"`
	ReviewDays        int64  `json:"reviewDays,omitempty"`
	LeadTimeDays      int64  `json:"leadTimeDays,omitempty"`
	ServiceLevel      string `json:"serviceLevel,omitempty"`
	IncludeSufficient bool   `json:"includeSufficient,omitempty"`
}

type InventoryReplenishmentAssumptions struct {
	LookbackDays         int64  `json:"lookbackDays"`
	ReviewDays           int64  `json:"reviewDays"`
	LeadTimeDays         int64  `json:"leadTimeDays"`
	LeadTimeSource       string `json:"leadTimeSource"`
	ServiceLevel         string `json:"serviceLevel"`
	DemandBasis          string `json:"demandBasis"`
	IncomingBasis        string `json:"incomingBasis"`
	ReservationTreatment string `json:"reservationTreatment"`
	SafetyStockMethod    string `json:"safetyStockMethod"`
}

type InventoryReplenishmentSummary struct {
	Evaluated                int   `json:"evaluated"`
	ActionRequired           int   `json:"actionRequired"`
	CoveredByIncoming        int   `json:"coveredByIncoming"`
	Sufficient               int   `json:"sufficient"`
	HistoryInsufficient      int   `json:"historyInsufficient"`
	EstimatedCommitmentMinor int64 `json:"estimatedCommitmentMinor"`
}

type InventoryReplenishmentEvidence struct {
	OutboundThousandths int64   `json:"outboundThousandths"`
	SaleMovementCount   int64   `json:"saleMovementCount"`
	LastSaleAt          *string `json:"lastSaleAt"`
	OpenPurchaseOrders  int64   `json:"openPurchaseOrders"`
	ReorderPointSource  string  `json:"reorderPointSource"`
	UnitCostSource      string  `json:"unitCostSource"`
}

type InventoryReplenishmentItem struct {
	SKU                          string                         `json:"sku"`
	Name                         string                         `json:"name"`
	UnitLabel                    string                         `json:"unitLabel"`
	OnHandThousandths            int64                          `json:"onHandThousandths"`
	ReservedThousandths          int64                          `json:"reservedThousandths"`
	AvailableThousandths         int64                          `json:"availableThousandths"`
	IncomingThousandths          int64                          `json:"incomingThousandths"`
	AvgDailyDemandThousandths    int64                          `json:"avgDailyDemandThousandths"`
	DemandStdDevThousandths      int64                          `json:"demandStdDevThousandths"`
	LeadTimeDays                 int64                          `json:"leadTimeDays"`
	LeadTimeSource               string                         `json:"leadTimeSource"`
	SafetyStockThousandths       int64                          `json:"safetyStockThousandths"`
	ReorderPointThousandths      int64                          `json:"reorderPointThousandths"`
	TargetStockThousandths       int64                          `json:"targetStockThousandths"`
	SuggestedOrderQtyThousandths int64                          `json:"suggestedOrderQtyThousandths"`
	EstimatedUnitCostMinor       int64                          `json:"estimatedUnitCostMinor"`
	EstimatedCostMinor           int64                          `json:"estimatedCostMinor"`
	DaysOfCover                  *float64                       `json:"daysOfCover"`
	Status                       string                         `json:"status"`
	HistoryInsufficient          bool                           `json:"historyInsufficient"`
	Warnings                     []string                       `json:"warnings"`
	Evidence                     InventoryReplenishmentEvidence `json:"evidence"`
}

type InventoryReplenishmentPlanOutput struct {
	AsOf        string                            `json:"asOf"`
	Currency    string                            `json:"currency"`
	Assumptions InventoryReplenishmentAssumptions `json:"assumptions"`
	Summary     InventoryReplenishmentSummary     `json:"summary"`
	Items       []InventoryReplenishmentItem      `json:"items"`
	Warnings    []string                          `json:"warnings"`
	Truncated   bool                              `json:"truncated"`
}

type inventoryReplenishmentItemRow struct {
	id                      string
	sku                     string
	name                    string
	unitLabel               string
	reorderPointThousandths int64
}

type inventoryReplenishmentDemand struct {
	buckets       map[int]int64
	movementCount int64
	lastSaleAt    *time.Time
}

func ParseInventoryReplenishmentPlanInput(raw json.RawMessage) (InventoryReplenishmentPlanInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryReplenishmentPlanInput{}, err
	}
	for key := range fields {
		switch key {
		case "sku", "lookbackDays", "reviewDays", "leadTimeDays", "serviceLevel", "includeSufficient":
		default:
			return InventoryReplenishmentPlanInput{}, fmt.Errorf("unsupported inventory.replenishmentPlan argument %q", key)
		}
	}

	input := InventoryReplenishmentPlanInput{
		LookbackDays: inventoryReplenishmentDefaultLookbackDays,
		ReviewDays:   inventoryReplenishmentDefaultReviewDays,
		LeadTimeDays: inventoryReplenishmentDefaultLeadDays,
		ServiceLevel: "95",
	}
	if _, ok := fields["sku"]; ok {
		value, err := optionalCRMDealString(fields, "sku", 120, true)
		if err != nil {
			return InventoryReplenishmentPlanInput{}, err
		}
		if value == nil || *value == "" {
			return InventoryReplenishmentPlanInput{}, errors.New("sku must be a non-empty string")
		}
		input.SKU = *value
	}
	if input.LookbackDays, err = optionalReplenishmentInteger(fields, "lookbackDays", 7, 365, input.LookbackDays); err != nil {
		return InventoryReplenishmentPlanInput{}, err
	}
	if input.ReviewDays, err = optionalReplenishmentInteger(fields, "reviewDays", 0, 90, input.ReviewDays); err != nil {
		return InventoryReplenishmentPlanInput{}, err
	}
	if input.LeadTimeDays, err = optionalReplenishmentInteger(fields, "leadTimeDays", 1, 365, input.LeadTimeDays); err != nil {
		return InventoryReplenishmentPlanInput{}, err
	}
	if _, ok := fields["serviceLevel"]; ok {
		value, err := optionalCRMDealString(fields, "serviceLevel", 4, true)
		if err != nil {
			return InventoryReplenishmentPlanInput{}, err
		}
		if value == nil {
			return InventoryReplenishmentPlanInput{}, errors.New("serviceLevel must be a string")
		}
		input.ServiceLevel = *value
	}
	if _, supported := replenishmentServiceZ(input.ServiceLevel); !supported {
		return InventoryReplenishmentPlanInput{}, errors.New("serviceLevel must be one of 90, 95, 98, 99")
	}
	if rawValue, ok := fields["includeSufficient"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawValue), []byte("null")) {
			return InventoryReplenishmentPlanInput{}, errors.New("includeSufficient must be a boolean")
		}
		if err := json.Unmarshal(rawValue, &input.IncludeSufficient); err != nil {
			return InventoryReplenishmentPlanInput{}, errors.New("includeSufficient must be a boolean")
		}
	}
	return input, nil
}

func optionalReplenishmentInteger(fields map[string]json.RawMessage, key string, minimum, maximum, fallback int64) (int64, error) {
	if _, ok := fields[key]; !ok {
		return fallback, nil
	}
	value, err := requiredSafeInteger(fields, key)
	if err != nil {
		return 0, err
	}
	if value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minimum, maximum)
	}
	return value, nil
}

func inventoryReplenishmentPlan(ctx context.Context, tx pgx.Tx, orgID string, input InventoryReplenishmentPlanInput, now time.Time) (InventoryReplenishmentPlanOutput, error) {
	now = now.UTC()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	windowStart := dayStart.AddDate(0, 0, -int(input.LookbackDays-1))
	windowEnd := dayStart.AddDate(0, 0, 1)

	var currency string
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id=$1::uuid`, orgID).Scan(&currency); err != nil {
		return InventoryReplenishmentPlanOutput{}, err
	}

	items, truncated, err := inventoryReplenishmentItems(ctx, tx, orgID, input.SKU)
	if err != nil {
		return InventoryReplenishmentPlanOutput{}, err
	}
	if len(items) == 0 {
		return InventoryReplenishmentPlanOutput{
			AsOf:        now.Format(time.RFC3339),
			Currency:    currency,
			Assumptions: inventoryReplenishmentAssumptions(input),
			Summary:     InventoryReplenishmentSummary{},
			Items:       []InventoryReplenishmentItem{},
			Warnings:    []string{"no active goods items matched the plan filter"},
			Truncated:   truncated,
		}, nil
	}

	onHand, err := inventoryReplenishmentOnHand(ctx, tx, orgID)
	if err != nil {
		return InventoryReplenishmentPlanOutput{}, err
	}
	reserved, err := inventoryReplenishmentReserved(ctx, tx, orgID)
	if err != nil {
		return InventoryReplenishmentPlanOutput{}, err
	}
	incoming, openOrders, err := inventoryReplenishmentIncoming(ctx, tx, orgID)
	if err != nil {
		return InventoryReplenishmentPlanOutput{}, err
	}
	demand, err := inventoryReplenishmentDemandByItem(ctx, tx, orgID, windowStart, windowEnd, int(input.LookbackDays), dayStart)
	if err != nil {
		return InventoryReplenishmentPlanOutput{}, err
	}
	costs, err := inventoryReplenishmentLatestCosts(ctx, tx, orgID)
	if err != nil {
		return InventoryReplenishmentPlanOutput{}, err
	}

	z, _ := replenishmentServiceZ(input.ServiceLevel)
	out := InventoryReplenishmentPlanOutput{
		AsOf:        now.Format(time.RFC3339),
		Currency:    currency,
		Assumptions: inventoryReplenishmentAssumptions(input),
		Items:       []InventoryReplenishmentItem{},
		Warnings:    []string{},
		Truncated:   truncated,
	}

	historyInsufficient := 0
	unknownCosts := 0
	for _, item := range items {
		available := inventoryAvailableToPromise(onHand[item.id], reserved[item.id])
		itemIncoming := incoming[item.id]
		itemDemand := demand[item.id]
		daily := make([]int64, input.LookbackDays)
		var totalOutbound int64
		if itemDemand != nil {
			for index, quantity := range itemDemand.buckets {
				if index >= 0 && index < len(daily) {
					daily[index] = quantity
					totalOutbound += quantity
				}
			}
		}
		hasHistory := itemDemand != nil && itemDemand.movementCount > 0 && totalOutbound > 0
		avgDaily := replenishmentAverageDaily(totalOutbound, int(input.LookbackDays))
		stdDev := replenishmentStdDev(daily)
		safety := replenishmentSafetyStock(stdDev, int(input.LeadTimeDays), z)
		computedReorder := avgDaily*input.LeadTimeDays + safety
		effectiveReorder := computedReorder
		reorderSource := "demand_model"
		if item.reorderPointThousandths > effectiveReorder {
			effectiveReorder = item.reorderPointThousandths
			reorderSource = "configured_floor"
		}
		if !hasHistory {
			effectiveReorder = item.reorderPointThousandths
			reorderSource = "configured_reorder_point"
		}
		target := replenishmentTargetStock(effectiveReorder, avgDaily, int(input.ReviewDays))
		suggested := replenishmentSuggestedQty(available, itemIncoming, target)

		status := "sufficient"
		if suggested > 0 {
			status = "reorder"
			out.Summary.ActionRequired++
		} else if available <= effectiveReorder && itemIncoming > 0 {
			status = "covered_by_incoming"
			out.Summary.CoveredByIncoming++
		} else {
			out.Summary.Sufficient++
		}
		if !hasHistory {
			historyInsufficient++
			out.Summary.HistoryInsufficient++
		}

		cost, costKnown := costs[item.id]
		estimatedCost := int64(0)
		if suggested > 0 && costKnown {
			estimatedCost, err = inventoryJsRoundProductDiv(suggested, cost, 1000)
			if err != nil {
				return InventoryReplenishmentPlanOutput{}, err
			}
			out.Summary.EstimatedCommitmentMinor, err = inventoryAddSafeIntegers(out.Summary.EstimatedCommitmentMinor, estimatedCost)
			if err != nil {
				return InventoryReplenishmentPlanOutput{}, err
			}
		}
		if suggested > 0 && !costKnown {
			unknownCosts++
		}

		var daysOfCover *float64
		if cover, ok := replenishmentDaysOfCover(available, avgDaily); ok {
			rounded := math.Round(cover*10) / 10
			daysOfCover = &rounded
		}

		itemWarnings := make([]string, 0, 2)
		if !hasHistory {
			itemWarnings = append(itemWarnings, "no sales history in the lookback window; the configured reorder point is the only demand signal")
		}
		if suggested > 0 && !costKnown {
			itemWarnings = append(itemWarnings, "no recorded unit cost; the cost estimate is unavailable")
		}
		evidence := InventoryReplenishmentEvidence{
			OutboundThousandths: totalOutbound,
			OpenPurchaseOrders:  openOrders[item.id],
			ReorderPointSource:  reorderSource,
			UnitCostSource:      "missing",
		}
		if itemDemand != nil {
			evidence.SaleMovementCount = itemDemand.movementCount
			if itemDemand.lastSaleAt != nil {
				lastSale := itemDemand.lastSaleAt.UTC().Format(time.RFC3339Nano)
				evidence.LastSaleAt = &lastSale
			}
		}
		if costKnown {
			evidence.UnitCostSource = "latest_recorded"
		}
		if input.IncludeSufficient || input.SKU != "" || status != "sufficient" {
			out.Items = append(out.Items, InventoryReplenishmentItem{
				SKU:                          item.sku,
				Name:                         item.name,
				UnitLabel:                    item.unitLabel,
				OnHandThousandths:            onHand[item.id],
				ReservedThousandths:          reserved[item.id],
				AvailableThousandths:         available,
				IncomingThousandths:          itemIncoming,
				AvgDailyDemandThousandths:    avgDaily,
				DemandStdDevThousandths:      int64(math.Round(stdDev)),
				LeadTimeDays:                 input.LeadTimeDays,
				LeadTimeSource:               "configured",
				SafetyStockThousandths:       safety,
				ReorderPointThousandths:      effectiveReorder,
				TargetStockThousandths:       target,
				SuggestedOrderQtyThousandths: suggested,
				EstimatedUnitCostMinor:       cost,
				EstimatedCostMinor:           estimatedCost,
				DaysOfCover:                  daysOfCover,
				Status:                       status,
				HistoryInsufficient:          !hasHistory,
				Warnings:                     itemWarnings,
				Evidence:                     evidence,
			})
		}
	}

	out.Summary.Evaluated = len(items)
	if truncated {
		out.Warnings = append(out.Warnings, fmt.Sprintf("item list truncated at %d; narrow the plan with sku", inventoryReplenishmentMaxItems))
	}
	if historyInsufficient > 0 {
		out.Warnings = append(out.Warnings, fmt.Sprintf("%d item(s) have no sales history; their quantities rely on configured reorder points", historyInsufficient))
	}
	if unknownCosts > 0 {
		out.Warnings = append(out.Warnings, fmt.Sprintf("%d item(s) have no recorded unit cost; the estimated commitment excludes them", unknownCosts))
	}
	out.Warnings = append(out.Warnings, fmt.Sprintf("lead times use the configured %d-day value; supplier delivery history is not applied in this version", input.LeadTimeDays))
	return out, nil
}

func inventoryReplenishmentAssumptions(input InventoryReplenishmentPlanInput) InventoryReplenishmentAssumptions {
	return InventoryReplenishmentAssumptions{
		LookbackDays:         input.LookbackDays,
		ReviewDays:           input.ReviewDays,
		LeadTimeDays:         input.LeadTimeDays,
		LeadTimeSource:       "configured",
		ServiceLevel:         input.ServiceLevel,
		DemandBasis:          "net stock movements with reason sale, including returns, floored at zero per UTC day over the lookback window, including zero-sale days",
		IncomingBasis:        "undelivered quantity on purchase order lines whose order is ordered or partial; accepted goods count as delivered, returned goods reopen the obligation, and rejected goods count as delivered but unusable",
		ReservationTreatment: "open reservations reduce available stock and are not counted again as demand",
		SafetyStockMethod:    "one-sided service-level z multiplied by the population standard deviation of daily sales and the square root of lead time",
	}
}

func inventoryReplenishmentItems(ctx context.Context, tx pgx.Tx, orgID, sku string) ([]inventoryReplenishmentItemRow, bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, sku, name, unit_label, reorder_point_thousandths
		FROM items
		WHERE org_id=$1::uuid AND archived_at IS NULL AND kind='goods'
		  AND ($2::text = '' OR sku=$2::text)
		ORDER BY sku ASC
		LIMIT $3`, orgID, sku, inventoryReplenishmentMaxItems+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]inventoryReplenishmentItemRow, 0)
	for rows.Next() {
		var item inventoryReplenishmentItemRow
		if err := rows.Scan(&item.id, &item.sku, &item.name, &item.unitLabel, &item.reorderPointThousandths); err != nil {
			return nil, false, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := len(items) > inventoryReplenishmentMaxItems
	if truncated {
		items = items[:inventoryReplenishmentMaxItems]
	}
	return items, truncated, nil
}

func inventoryReplenishmentOnHand(ctx context.Context, tx pgx.Tx, orgID string) (map[string]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT item_id::text, COALESCE(SUM(quantity), 0)
		FROM stock_balances
		WHERE org_id=$1::uuid
		GROUP BY item_id`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanInventoryReplenishmentQuantities(rows)
}

func inventoryReplenishmentReserved(ctx context.Context, tx pgx.Tx, orgID string) (map[string]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT item_id::text, COALESCE(SUM(quantity_thousandths), 0)
		FROM stock_reservations
		WHERE org_id=$1::uuid AND status='open'
		GROUP BY item_id`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanInventoryReplenishmentQuantities(rows)
}

// inventoryReplenishmentIncoming returns undelivered order-line quantity and
// the number of distinct open orders per item. The formula matches the
// purchasing close check: accepted goods count as delivered, returned goods
// reopen the supplier obligation, and rejected goods count as delivered but
// unusable so the order can close with an explicit backorder.
func inventoryReplenishmentIncoming(ctx context.Context, tx pgx.Tx, orgID string) (map[string]int64, map[string]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT pl.item_id::text,
		       COALESCE(SUM(GREATEST(pl.quantity - (
		           COALESCE(receipt.accepted, 0) - COALESCE(receipt.returned, 0) + COALESCE(receipt.rejected, 0)
		       ), 0)), 0) AS incoming,
		       COUNT(DISTINCT po.id) AS open_orders
		FROM po_lines pl
		JOIN purchase_orders po ON po.id = pl.po_id
		LEFT JOIN (
			SELECT po_line_id,
			       SUM(accepted_thousandths) AS accepted,
			       SUM(returned_thousandths) AS returned,
			       SUM(rejected_thousandths) AS rejected
			FROM goods_receipt_lines
			WHERE org_id=$1::uuid
			GROUP BY po_line_id
		) receipt ON receipt.po_line_id = pl.id
		WHERE po.org_id=$1::uuid AND po.status IN ('ordered', 'partial') AND pl.item_id IS NOT NULL
		GROUP BY pl.item_id`, orgID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	incoming := make(map[string]int64)
	openOrders := make(map[string]int64)
	for rows.Next() {
		var itemID string
		var quantity, orders int64
		if err := rows.Scan(&itemID, &quantity, &orders); err != nil {
			return nil, nil, err
		}
		incoming[itemID] = quantity
		openOrders[itemID] = orders
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return incoming, openOrders, nil
}

func inventoryReplenishmentDemandByItem(ctx context.Context, tx pgx.Tx, orgID string, start, end time.Time, lookbackDays int, dayStart time.Time) (map[string]*inventoryReplenishmentDemand, error) {
	out := make(map[string]*inventoryReplenishmentDemand)
	bucketRows, err := tx.Query(ctx, `
		SELECT item_id::text, (created_at AT TIME ZONE 'UTC')::date AS day, GREATEST(SUM(-quantity_delta), 0)
		FROM stock_movements
		WHERE org_id=$1::uuid AND reason='sale'
		  AND created_at >= $2 AND created_at < $3
		GROUP BY item_id, day`, orgID, start, end)
	if err != nil {
		return nil, err
	}
	for bucketRows.Next() {
		var itemID string
		var day time.Time
		var quantity int64
		if err := bucketRows.Scan(&itemID, &day, &quantity); err != nil {
			bucketRows.Close()
			return nil, err
		}
		index := int(dayStart.Sub(day.UTC()).Hours() / 24)
		if index < 0 || index >= lookbackDays {
			continue
		}
		entry := out[itemID]
		if entry == nil {
			entry = &inventoryReplenishmentDemand{buckets: make(map[int]int64)}
			out[itemID] = entry
		}
		entry.buckets[index] += quantity
	}
	if err := bucketRows.Err(); err != nil {
		bucketRows.Close()
		return nil, err
	}
	bucketRows.Close()

	statRows, err := tx.Query(ctx, `
		SELECT item_id::text, COUNT(*), MAX(created_at)
		FROM stock_movements
		WHERE org_id=$1::uuid AND reason='sale'
		  AND created_at >= $2 AND created_at < $3
		GROUP BY item_id`, orgID, start, end)
	if err != nil {
		return nil, err
	}
	defer statRows.Close()
	for statRows.Next() {
		var itemID string
		var count int64
		var last time.Time
		if err := statRows.Scan(&itemID, &count, &last); err != nil {
			return nil, err
		}
		entry := out[itemID]
		if entry == nil {
			entry = &inventoryReplenishmentDemand{buckets: make(map[int]int64)}
			out[itemID] = entry
		}
		entry.movementCount = count
		entry.lastSaleAt = &last
	}
	if err := statRows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func inventoryReplenishmentLatestCosts(ctx context.Context, tx pgx.Tx, orgID string) (map[string]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (item_id) item_id::text, unit_cost_minor
		FROM stock_movements
		WHERE org_id=$1::uuid AND unit_cost_minor IS NOT NULL AND unit_cost_minor >= 0
		ORDER BY item_id, created_at DESC, id DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	costs := make(map[string]int64)
	for rows.Next() {
		var itemID string
		var cost int64
		if err := rows.Scan(&itemID, &cost); err != nil {
			return nil, err
		}
		costs[itemID] = cost
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return costs, nil
}

func scanInventoryReplenishmentQuantities(rows pgx.Rows) (map[string]int64, error) {
	quantities := make(map[string]int64)
	for rows.Next() {
		var itemID string
		var quantity int64
		if err := rows.Scan(&itemID, &quantity); err != nil {
			return nil, err
		}
		quantities[itemID] = quantity
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return quantities, nil
}
