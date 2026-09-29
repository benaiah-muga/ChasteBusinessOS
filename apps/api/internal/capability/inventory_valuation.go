package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	inventoryPostValuationSummaryCapabilityID    = "inventory.postValuationSummary"
	inventoryReverseValuationSummaryCapabilityID = "inventory.reverseValuationSummary"
	inventoryStockReportCapabilityID             = "inventory.stockReport"
	inventoryItemHistoryCapabilityID             = "inventory.itemHistory"
	inventoryListLotsCapabilityID                = "inventory.listLots"
	inventoryRebuildStockProjectionsCapabilityID = "inventory.rebuildStockProjections"
)

const (
	inventoryValuationAccountCode = "1200"
	inventoryCOGSAccountCode      = "5000"
	// The reversal source type is deliberately distinct so accounting.reverseEntry
	// domain routing sends these entries back to inventory.reverseValuationSummary.
	inventoryValuationSourceType         = "inventory-valuation"
	inventoryValuationReversalSourceType = "inventory-valuation-reversal"

	inventoryValuationMemoDefault = "Inventory valuation summary - stock ledger to GL"
)

type InventoryPostValuationSummaryInput struct {
	Memo string `json:"memo"`
}

type InventoryPostValuationSummaryOutput struct {
	Posted           bool    `json:"posted"`
	EntryID          *string `json:"entryId"`
	VarianceMinor    int64   `json:"varianceMinor"`
	LedgerValueMinor int64   `json:"ledgerValueMinor"`
	GLBalanceMinor   int64   `json:"glBalanceMinor"`
}

type InventoryReverseValuationSummaryInput struct {
	EntryID string `json:"entryId"`
}

type InventoryReverseValuationSummaryOutput struct {
	Reversed        bool   `json:"reversed"`
	ReversalEntryID string `json:"reversalEntryId"`
}

type InventoryStockReportInput struct {
	BelowReorderOnly bool `json:"belowReorderOnly,omitempty"`
}

type InventoryStockReportItem struct {
	SKU                     string   `json:"sku"`
	Name                    string   `json:"name"`
	Kind                    string   `json:"kind"`
	UnitLabel               string   `json:"unitLabel"`
	SalePriceMinor          int64    `json:"salePriceMinor"`
	ImageURL                *string  `json:"imageUrl"`
	Tags                    []string `json:"tags"`
	Barcode                 *string  `json:"barcode"`
	OnHandThousandths       int64    `json:"onHandThousandths"`
	ValueMinor              int64    `json:"valueMinor"`
	AvgUnitCostMinor        int64    `json:"avgUnitCostMinor"`
	ReservedThousandths     int64    `json:"reservedThousandths"`
	AvailableThousandths    int64    `json:"availableThousandths"`
	ReorderPointThousandths int64    `json:"reorderPointThousandths"`
	ReorderNeeded           bool     `json:"reorderNeeded"`
}

type InventoryStockReportOutput struct {
	Items           []InventoryStockReportItem `json:"items"`
	TotalValueMinor int64                      `json:"totalValueMinor"`
}

type InventoryItemHistoryInput struct {
	SKU   string `json:"sku"`
	Limit int64  `json:"limit"`
}

type InventoryItemHistoryMovement struct {
	ID            string  `json:"id"`
	QuantityDelta int64   `json:"quantityDelta"`
	Reason        string  `json:"reason"`
	Note          *string `json:"note"`
	RefType       *string `json:"refType"`
	UnitCostMinor *int64  `json:"unitCostMinor"`
	LotCode       *string `json:"lotCode"`
	LocationCode  *string `json:"locationCode"`
	ActorType     string  `json:"actorType"`
	CreatedAt     string  `json:"createdAt"`
}

type InventoryItemHistoryOutput struct {
	Movements []InventoryItemHistoryMovement `json:"movements"`
}

type InventoryListLotsInput struct{}

type InventoryListLotRow struct {
	ID                 string  `json:"id"`
	SKU                string  `json:"sku"`
	LotCode            string  `json:"lotCode"`
	BalanceThousandths int64   `json:"balanceThousandths"`
	ExpiresAt          *string `json:"expiresAt"`
}

type InventoryListLotsOutput struct {
	Lots []InventoryListLotRow `json:"lots"`
}

type InventoryRebuildStockProjectionsInput struct{}

type InventoryRebuildStockProjectionsOutput struct {
	Rows                     int64 `json:"rows"`
	TotalQuantityThousandths int64 `json:"totalQuantityThousandths"`
}

func parseInventoryValuationInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case inventoryPostValuationSummaryCapabilityID:
		return ParseInventoryPostValuationSummaryInput(raw)
	case inventoryReverseValuationSummaryCapabilityID:
		return ParseInventoryReverseValuationSummaryInput(raw)
	case inventoryStockReportCapabilityID:
		return ParseInventoryStockReportInput(raw)
	case inventoryItemHistoryCapabilityID:
		return ParseInventoryItemHistoryInput(raw)
	case inventoryListLotsCapabilityID:
		return ParseInventoryListLotsInput(raw)
	case inventoryRebuildStockProjectionsCapabilityID:
		return ParseInventoryRebuildStockProjectionsInput(raw)
	default:
		return nil, errors.New("unsupported inventory valuation capability")
	}
}

func ParseInventoryPostValuationSummaryInput(raw json.RawMessage) (InventoryPostValuationSummaryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryPostValuationSummaryInput{}, err
	}
	memo := inventoryValuationMemoDefault
	if _, ok := fields["memo"]; ok {
		value, err := optionalCRMDealString(fields, "memo", 300, false)
		if err != nil {
			return InventoryPostValuationSummaryInput{}, err
		}
		if value == nil {
			return InventoryPostValuationSummaryInput{}, errors.New("memo must be a string")
		}
		if utf16Length(*value) < 3 {
			return InventoryPostValuationSummaryInput{}, errors.New("memo must contain at least 3 character(s)")
		}
		memo = *value
	}
	return InventoryPostValuationSummaryInput{Memo: memo}, nil
}

func ParseInventoryReverseValuationSummaryInput(raw json.RawMessage) (InventoryReverseValuationSummaryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryReverseValuationSummaryInput{}, err
	}
	entryID, err := salesRequiredUUID(fields, "entryId")
	if err != nil {
		return InventoryReverseValuationSummaryInput{}, err
	}
	return InventoryReverseValuationSummaryInput{EntryID: entryID}, nil
}

func ParseInventoryStockReportInput(raw json.RawMessage) (InventoryStockReportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryStockReportInput{}, err
	}
	input := InventoryStockReportInput{}
	if rawValue, ok := fields["belowReorderOnly"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawValue), []byte("null")) {
			return InventoryStockReportInput{}, errors.New("belowReorderOnly must be a boolean")
		}
		if err := json.Unmarshal(rawValue, &input.BelowReorderOnly); err != nil {
			return InventoryStockReportInput{}, errors.New("belowReorderOnly must be a boolean")
		}
	}
	return input, nil
}

func ParseInventoryItemHistoryInput(raw json.RawMessage) (InventoryItemHistoryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryItemHistoryInput{}, err
	}
	sku, err := requiredCRMDealString(fields, "sku", 0, 0)
	if err != nil {
		return InventoryItemHistoryInput{}, err
	}
	limit := int64(50)
	if _, ok := fields["limit"]; ok {
		value, err := inventoryRequiredQuantity(fields, "limit")
		if err != nil {
			return InventoryItemHistoryInput{}, err
		}
		if value < 1 {
			return InventoryItemHistoryInput{}, errors.New("limit must be at least 1")
		}
		if value > 200 {
			return InventoryItemHistoryInput{}, errors.New("limit must be at most 200")
		}
		limit = value
	}
	return InventoryItemHistoryInput{SKU: sku, Limit: limit}, nil
}

func ParseInventoryListLotsInput(raw json.RawMessage) (InventoryListLotsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return InventoryListLotsInput{}, err
	}
	return InventoryListLotsInput{}, nil
}

func ParseInventoryRebuildStockProjectionsInput(raw json.RawMessage) (InventoryRebuildStockProjectionsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return InventoryRebuildStockProjectionsInput{}, err
	}
	return InventoryRebuildStockProjectionsInput{}, nil
}

type inventoryValuationState struct {
	quantityOnHand  int64
	totalValueMinor int64
}

type inventoryValuationMovement struct {
	quantityDelta int64
	unitCostMinor *int64
	reason        string
}

func inventorySafeInteger(value int64) bool {
	return value >= -maxSafeInteger && value <= maxSafeInteger
}

func inventoryAddSafeIntegers(left, right int64) (int64, error) {
	if !inventorySafeInteger(left) || !inventorySafeInteger(right) ||
		(right > 0 && left > maxSafeInteger-right) ||
		(right < 0 && left < -maxSafeInteger-right) {
		return 0, errors.New("inventory valuation exceeds the supported amount range")
	}
	return left + right, nil
}

// inventoryJsRoundProductDiv keeps the intermediate product exact while
// preserving JavaScript Math.round's ties-toward-positive-infinity behavior.
func inventoryJsRoundProductDiv(left, right, denominator int64) (int64, error) {
	if denominator <= 0 || !inventorySafeInteger(left) || !inventorySafeInteger(right) {
		return 0, errors.New("inventory valuation exceeds the supported amount range")
	}
	numerator := new(big.Int).Mul(big.NewInt(left), big.NewInt(right))
	numerator.Mul(numerator, big.NewInt(2))
	numerator.Add(numerator, big.NewInt(denominator))
	divisor := new(big.Int).Mul(big.NewInt(denominator), big.NewInt(2))
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, divisor, remainder)
	if numerator.Sign() < 0 && remainder.Sign() != 0 {
		quotient.Sub(quotient, big.NewInt(1))
	}
	if !quotient.IsInt64() || !inventorySafeInteger(quotient.Int64()) {
		return 0, errors.New("inventory valuation exceeds the supported amount range")
	}
	return quotient.Int64(), nil
}

func inventoryAverageUnitCost(state inventoryValuationState) (int64, error) {
	if state.quantityOnHand <= 0 {
		return 0, nil
	}
	return inventoryJsRoundProductDiv(state.totalValueMinor, 1000, state.quantityOnHand)
}

func inventoryApplyValuationMovement(state inventoryValuationState, movement inventoryValuationMovement) (inventoryValuationState, error) {
	if !inventorySafeInteger(state.quantityOnHand) || !inventorySafeInteger(state.totalValueMinor) ||
		!inventorySafeInteger(movement.quantityDelta) ||
		(movement.unitCostMinor != nil && !inventorySafeInteger(*movement.unitCostMinor)) {
		return inventoryValuationState{}, errors.New("inventory valuation exceeds the supported amount range")
	}
	// Transfer legs relocate quantity between locations without acquiring or
	// consuming value, so round trips cannot drift the moving average.
	if movement.reason == "transfer" {
		quantity, err := inventoryAddSafeIntegers(state.quantityOnHand, movement.quantityDelta)
		if err != nil {
			return inventoryValuationState{}, err
		}
		return inventoryValuationState{
			quantityOnHand:  quantity,
			totalValueMinor: state.totalValueMinor,
		}, nil
	}
	if movement.quantityDelta > 0 {
		cost, err := inventoryAverageUnitCost(state)
		if err != nil {
			return inventoryValuationState{}, err
		}
		if movement.unitCostMinor != nil {
			cost = *movement.unitCostMinor
		}
		valueIn, err := inventoryJsRoundProductDiv(movement.quantityDelta, cost, 1000)
		if err != nil {
			return inventoryValuationState{}, err
		}
		quantity, err := inventoryAddSafeIntegers(state.quantityOnHand, movement.quantityDelta)
		if err != nil {
			return inventoryValuationState{}, err
		}
		value, err := inventoryAddSafeIntegers(state.totalValueMinor, valueIn)
		if err != nil {
			return inventoryValuationState{}, err
		}
		return inventoryValuationState{
			quantityOnHand:  quantity,
			totalValueMinor: value,
		}, nil
	}
	if movement.quantityDelta < 0 {
		out := -movement.quantityDelta
		if out > state.quantityOnHand {
			return inventoryValuationState{}, errors.New("insufficient stock")
		}
		valueOut := int64(0)
		if state.quantityOnHand != 0 {
			var err error
			valueOut, err = inventoryJsRoundProductDiv(state.totalValueMinor, out, state.quantityOnHand)
			if err != nil {
				return inventoryValuationState{}, err
			}
		}
		quantity, err := inventoryAddSafeIntegers(state.quantityOnHand, -out)
		if err != nil {
			return inventoryValuationState{}, err
		}
		value, err := inventoryAddSafeIntegers(state.totalValueMinor, -valueOut)
		if err != nil {
			return inventoryValuationState{}, err
		}
		return inventoryValuationState{
			quantityOnHand:  quantity,
			totalValueMinor: value,
		}, nil
	}
	return state, nil
}

func inventoryReplayValuation(history []inventoryValuationMovement) (inventoryValuationState, error) {
	state := inventoryValuationState{}
	for _, movement := range history {
		next, err := inventoryApplyValuationMovement(state, movement)
		if err != nil {
			return inventoryValuationState{}, err
		}
		state = next
	}
	return state, nil
}

func inventoryNeedsReorder(quantityOnHand, reorderPoint int64) bool {
	return reorderPoint > 0 && quantityOnHand <= reorderPoint
}

func inventoryMovementHistory(ctx context.Context, tx pgx.Tx, orgID, itemID string) ([]inventoryValuationMovement, error) {
	rows, err := tx.Query(ctx, `
		SELECT quantity_delta, unit_cost_minor, reason
		FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid
		ORDER BY created_at ASC`, orgID, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	history := make([]inventoryValuationMovement, 0)
	for rows.Next() {
		var movement inventoryValuationMovement
		if err := rows.Scan(&movement.quantityDelta, &movement.unitCostMinor, &movement.reason); err != nil {
			return nil, err
		}
		history = append(history, movement)
	}
	return history, rows.Err()
}

func inventoryLedgerValueMinor(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	rows, err := tx.Query(ctx, `SELECT id::text FROM items WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return 0, err
	}
	itemIDs := make([]string, 0)
	for rows.Next() {
		var itemID string
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return 0, err
		}
		itemIDs = append(itemIDs, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	var total int64
	for _, itemID := range itemIDs {
		history, err := inventoryMovementHistory(ctx, tx, orgID, itemID)
		if err != nil {
			return 0, err
		}
		valuation, err := inventoryReplayValuation(history)
		if err != nil {
			return 0, err
		}
		total, err = inventoryAddSafeIntegers(total, valuation.totalValueMinor)
		if err != nil {
			return 0, err
		}
	}
	return total, nil
}

func inventoryGLAccountBalanceMinor(ctx context.Context, tx pgx.Tx, orgID, code string) (int64, error) {
	var balance int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl
		JOIN accounts a ON jl.account_id = a.id
		WHERE a.org_id = $1::uuid AND a.code = $2`, orgID, code).Scan(&balance)
	if err == nil && !inventorySafeInteger(balance) {
		err = errors.New("inventory GL balance exceeds the supported amount range")
	}
	return balance, err
}

func inventoryBaseCurrency(ctx context.Context, tx pgx.Tx, orgID string) (string, error) {
	var currency string
	err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&currency)
	if errors.Is(err, pgx.ErrNoRows) {
		return "USD", nil
	}
	return currency, err
}

// inventoryValuationAdjustmentLines is the one balanced entry that closes the
// gap between the stock ledger and the GL inventory account: variance > 0
// under-states the books (DR inventory, relieve COGS), variance < 0
// over-states them (expense shrinkage, CR inventory). Zero variance posts
// nothing: an empty entry must not exist.
func inventoryValuationAdjustmentLines(varianceMinor int64) []JournalEntryLineInput {
	switch {
	case varianceMinor == 0:
		return nil
	case varianceMinor > 0:
		return []JournalEntryLineInput{
			{AccountCode: inventoryValuationAccountCode, DebitMinor: varianceMinor},
			{AccountCode: inventoryCOGSAccountCode, CreditMinor: varianceMinor},
		}
	default:
		shrinkage := -varianceMinor
		return []JournalEntryLineInput{
			{AccountCode: inventoryCOGSAccountCode, DebitMinor: shrinkage},
			{AccountCode: inventoryValuationAccountCode, CreditMinor: shrinkage},
		}
	}
}

func inventoryPostValuationSummary(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryPostValuationSummaryInput, now time.Time) (InventoryPostValuationSummaryOutput, error) {
	orgID := claims.OrganizationID
	ledgerValueMinor, err := inventoryLedgerValueMinor(ctx, tx, orgID)
	if err != nil {
		return InventoryPostValuationSummaryOutput{}, err
	}
	glBalanceMinor, err := inventoryGLAccountBalanceMinor(ctx, tx, orgID, inventoryValuationAccountCode)
	if err != nil {
		return InventoryPostValuationSummaryOutput{}, err
	}
	varianceMinor, err := inventoryAddSafeIntegers(ledgerValueMinor, -glBalanceMinor)
	if err != nil {
		return InventoryPostValuationSummaryOutput{}, err
	}
	// Already reconciled: an empty entry must never exist, so the honest
	// answer is an explicit no-op, not a zero posting.
	if varianceMinor == 0 {
		return InventoryPostValuationSummaryOutput{
			Posted: false, EntryID: nil,
			VarianceMinor: varianceMinor, LedgerValueMinor: ledgerValueMinor, GLBalanceMinor: glBalanceMinor,
		}, nil
	}
	currency, err := inventoryBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return InventoryPostValuationSummaryOutput{}, err
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:      orgID,
		Memo:       input.Memo,
		SourceType: inventoryValuationSourceType,
		Currency:   currency,
		PostedAt:   now,
		ActorType:  claims.ActorType,
		ActorID:    claims.ActorID,
		Lines:      inventoryValuationAdjustmentLines(varianceMinor),
	})
	if err != nil {
		return InventoryPostValuationSummaryOutput{}, err
	}
	return InventoryPostValuationSummaryOutput{
		Posted: true, EntryID: &entryID,
		VarianceMinor: varianceMinor, LedgerValueMinor: ledgerValueMinor, GLBalanceMinor: glBalanceMinor,
	}, nil
}

func inventoryReverseValuationSummary(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryReverseValuationSummaryInput, now time.Time) (InventoryReverseValuationSummaryOutput, error) {
	orgID := claims.OrganizationID
	var memo, sourceType string
	err := tx.QueryRow(ctx, `
		SELECT memo, source_type FROM journal_entries
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.EntryID, orgID).Scan(&memo, &sourceType)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryReverseValuationSummaryOutput{}, fmt.Errorf("no journal entry %s", input.EntryID)
	}
	if err != nil {
		return InventoryReverseValuationSummaryOutput{}, err
	}
	if sourceType != inventoryValuationSourceType {
		return InventoryReverseValuationSummaryOutput{}, fmt.Errorf("entry %s is not an inventory valuation summary", input.EntryID)
	}
	var alreadyReversed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM journal_entries
			WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid
		)`, orgID, input.EntryID).Scan(&alreadyReversed); err != nil {
		return InventoryReverseValuationSummaryOutput{}, err
	}
	if alreadyReversed {
		return InventoryReverseValuationSummaryOutput{}, fmt.Errorf("entry %s has already been reversed", input.EntryID)
	}
	rows, err := tx.Query(ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl
		JOIN accounts a ON jl.account_id = a.id
		WHERE jl.entry_id = $1::uuid`, input.EntryID)
	if err != nil {
		return InventoryReverseValuationSummaryOutput{}, err
	}
	lines := make([]JournalEntryLineInput, 0, 2)
	for rows.Next() {
		var line JournalEntryLineInput
		if err := rows.Scan(&line.AccountCode, &line.DebitMinor, &line.CreditMinor); err != nil {
			rows.Close()
			return InventoryReverseValuationSummaryOutput{}, err
		}
		line.DebitMinor, line.CreditMinor = line.CreditMinor, line.DebitMinor
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryReverseValuationSummaryOutput{}, err
	}
	rows.Close()
	currency, err := inventoryBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return InventoryReverseValuationSummaryOutput{}, err
	}
	reversalEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:        orgID,
		Memo:         "Reversal: " + memo,
		SourceType:   inventoryValuationReversalSourceType,
		ReversalOfID: &input.EntryID,
		Currency:     currency,
		PostedAt:     now,
		ActorType:    claims.ActorType,
		ActorID:      claims.ActorID,
		Lines:        lines,
	})
	if err != nil {
		return InventoryReverseValuationSummaryOutput{}, err
	}
	return InventoryReverseValuationSummaryOutput{Reversed: true, ReversalEntryID: reversalEntryID}, nil
}

type inventoryStockReportItemRow struct {
	id                      string
	sku                     string
	name                    string
	kind                    string
	unitLabel               string
	salePriceMinor          int64
	imageURL                *string
	tags                    []string
	barcode                 *string
	reorderPointThousandths int64
}

func inventoryStockReport(ctx context.Context, tx pgx.Tx, orgID string, input InventoryStockReportInput) (InventoryStockReportOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, sku, name, kind, unit_label, sale_price_minor, image_url, tags, barcode, reorder_point_thousandths
		FROM items
		WHERE org_id = $1::uuid AND archived_at IS NULL
		ORDER BY sku ASC`, orgID)
	if err != nil {
		return InventoryStockReportOutput{}, err
	}
	itemRows := make([]inventoryStockReportItemRow, 0)
	for rows.Next() {
		var item inventoryStockReportItemRow
		var rawTags []byte
		if err := rows.Scan(&item.id, &item.sku, &item.name, &item.kind, &item.unitLabel,
			&item.salePriceMinor, &item.imageURL, &rawTags, &item.barcode, &item.reorderPointThousandths); err != nil {
			rows.Close()
			return InventoryStockReportOutput{}, err
		}
		if err := json.Unmarshal(rawTags, &item.tags); err != nil {
			rows.Close()
			return InventoryStockReportOutput{}, err
		}
		itemRows = append(itemRows, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryStockReportOutput{}, err
	}
	rows.Close()
	items := make([]InventoryStockReportItem, 0, len(itemRows))
	var totalValueMinor int64
	for _, item := range itemRows {
		level, err := inventoryStockOnHand(ctx, tx, orgID, item.id, nil)
		if err != nil {
			return InventoryStockReportOutput{}, err
		}
		history, err := inventoryMovementHistory(ctx, tx, orgID, item.id)
		if err != nil {
			return InventoryStockReportOutput{}, err
		}
		valuation, err := inventoryReplayValuation(history)
		if err != nil {
			return InventoryStockReportOutput{}, err
		}
		reserved, err := inventoryOpenReserved(ctx, tx, orgID, item.id)
		if err != nil {
			return InventoryStockReportOutput{}, err
		}
		available := inventoryAvailableToPromise(level, reserved)
		totalValueMinor, err = inventoryAddSafeIntegers(totalValueMinor, valuation.totalValueMinor)
		if err != nil {
			return InventoryStockReportOutput{}, err
		}
		reorderNeeded := inventoryNeedsReorder(level, item.reorderPointThousandths)
		if input.BelowReorderOnly && !reorderNeeded {
			continue
		}
		var avgUnitCostMinor int64
		if level > 0 {
			avgUnitCostMinor, err = inventoryAverageUnitCost(valuation)
			if err != nil {
				return InventoryStockReportOutput{}, err
			}
		}
		items = append(items, InventoryStockReportItem{
			SKU: item.sku, Name: item.name, Kind: item.kind, UnitLabel: item.unitLabel,
			SalePriceMinor: item.salePriceMinor, ImageURL: item.imageURL, Tags: item.tags, Barcode: item.barcode,
			OnHandThousandths: level, ValueMinor: valuation.totalValueMinor, AvgUnitCostMinor: avgUnitCostMinor,
			ReservedThousandths: reserved, AvailableThousandths: available,
			ReorderPointThousandths: item.reorderPointThousandths, ReorderNeeded: reorderNeeded,
		})
	}
	return InventoryStockReportOutput{Items: items, TotalValueMinor: totalValueMinor}, nil
}

func inventoryItemBySku(ctx context.Context, tx pgx.Tx, orgID, sku string) (string, error) {
	var itemID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM items
		WHERE org_id = $1::uuid AND sku = $2
		LIMIT 1`, orgID, sku).Scan(&itemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("no item with SKU %s", sku)
	}
	return itemID, err
}

func inventoryItemHistory(ctx context.Context, tx pgx.Tx, orgID string, input InventoryItemHistoryInput) (InventoryItemHistoryOutput, error) {
	itemID, err := inventoryItemBySku(ctx, tx, orgID, input.SKU)
	if err != nil {
		return InventoryItemHistoryOutput{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT sm.id::text, sm.quantity_delta, sm.reason, sm.note, sm.ref_type, sm.unit_cost_minor,
			lots.lot_code, stock_locations.code, sm.actor_type, sm.created_at
		FROM stock_movements sm
		LEFT JOIN lots ON sm.lot_id = lots.id
		LEFT JOIN stock_locations ON sm.location_id = stock_locations.id
		WHERE sm.org_id = $1::uuid AND sm.item_id = $2::uuid
		ORDER BY sm.created_at DESC
		LIMIT $3`, orgID, itemID, input.Limit)
	if err != nil {
		return InventoryItemHistoryOutput{}, err
	}
	defer rows.Close()
	movements := make([]InventoryItemHistoryMovement, 0)
	for rows.Next() {
		var movement InventoryItemHistoryMovement
		var createdAt time.Time
		if err := rows.Scan(&movement.ID, &movement.QuantityDelta, &movement.Reason, &movement.Note,
			&movement.RefType, &movement.UnitCostMinor, &movement.LotCode, &movement.LocationCode,
			&movement.ActorType, &createdAt); err != nil {
			return InventoryItemHistoryOutput{}, err
		}
		movement.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		movements = append(movements, movement)
	}
	if err := rows.Err(); err != nil {
		return InventoryItemHistoryOutput{}, err
	}
	return InventoryItemHistoryOutput{Movements: movements}, nil
}

func inventoryListLots(ctx context.Context, tx pgx.Tx, orgID string, input InventoryListLotsInput) (InventoryListLotsOutput, error) {
	rows, err := tx.Query(ctx, `SELECT id::text, sku FROM items WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return InventoryListLotsOutput{}, err
	}
	skuOf := make(map[string]string)
	for rows.Next() {
		var itemID, sku string
		if err := rows.Scan(&itemID, &sku); err != nil {
			rows.Close()
			return InventoryListLotsOutput{}, err
		}
		skuOf[itemID] = sku
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryListLotsOutput{}, err
	}
	rows.Close()
	lotRows, err := tx.Query(ctx, `
		SELECT lots.id::text, lots.item_id::text, lots.lot_code, COALESCE(SUM(stock_movements.quantity_delta), 0), lots.expires_at
		FROM lots
		LEFT JOIN stock_movements ON stock_movements.lot_id = lots.id
		WHERE lots.org_id = $1::uuid
		GROUP BY lots.id
		ORDER BY lots.created_at DESC
		LIMIT 200`, orgID)
	if err != nil {
		return InventoryListLotsOutput{}, err
	}
	defer lotRows.Close()
	lots := make([]InventoryListLotRow, 0)
	for lotRows.Next() {
		var lot InventoryListLotRow
		var itemID string
		var expiresAt *time.Time
		if err := lotRows.Scan(&lot.ID, &itemID, &lot.LotCode, &lot.BalanceThousandths, &expiresAt); err != nil {
			return InventoryListLotsOutput{}, err
		}
		if expiresAt != nil {
			formatted := expiresAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
			lot.ExpiresAt = &formatted
		}
		lot.SKU = skuOf[itemID]
		if lot.SKU == "" {
			lot.SKU = itemID
		}
		lots = append(lots, lot)
	}
	if err := lotRows.Err(); err != nil {
		return InventoryListLotsOutput{}, err
	}
	return InventoryListLotsOutput{Lots: lots}, nil
}

// inventoryRebuildStockBalances replays the append-only ledger into the
// stock_balances read projection for one org. It mirrors the TypeScript
// repair exactly: delete the projection rows, re-insert the grouped ledger
// sums, then report what landed. The ledger itself is never touched.
func inventoryRebuildStockBalances(ctx context.Context, tx pgx.Tx, orgID string) (int64, int64, error) {
	if _, err := tx.Exec(ctx, `DELETE FROM stock_balances WHERE org_id = $1::uuid`, orgID); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO stock_balances (org_id, item_id, location_id, lot_id, quantity)
		SELECT org_id, item_id, location_id, lot_id, SUM(quantity_delta)::integer
		FROM stock_movements
		WHERE org_id = $1::uuid
		GROUP BY org_id, item_id, location_id, lot_id`, orgID); err != nil {
		return 0, 0, err
	}
	var rowCount, totalQuantity int64
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(SUM(quantity), 0)
		FROM stock_balances
		WHERE org_id = $1::uuid`, orgID).Scan(&rowCount, &totalQuantity); err != nil {
		return 0, 0, err
	}
	return rowCount, totalQuantity, nil
}

func inventoryRebuildStockProjections(ctx context.Context, tx pgx.Tx, orgID string, input InventoryRebuildStockProjectionsInput) (InventoryRebuildStockProjectionsOutput, error) {
	rows, err := tx.Query(ctx, `SELECT id::text FROM items WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return InventoryRebuildStockProjectionsOutput{}, err
	}
	itemIDs := make([]string, 0)
	for rows.Next() {
		var itemID string
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return InventoryRebuildStockProjectionsOutput{}, err
		}
		itemIDs = append(itemIDs, itemID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryRebuildStockProjectionsOutput{}, err
	}
	rows.Close()
	// Hold the ledger's command locks while replaying, so no movement lands
	// between the delete and the re-read.
	if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
		return InventoryRebuildStockProjectionsOutput{}, err
	}
	rowCount, totalQuantity, err := inventoryRebuildStockBalances(ctx, tx, orgID)
	if err != nil {
		return InventoryRebuildStockProjectionsOutput{}, err
	}
	return InventoryRebuildStockProjectionsOutput{Rows: rowCount, TotalQuantityThousandths: totalQuantity}, nil
}
