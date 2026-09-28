package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	inventoryAdjustStockCapabilityID     = "inventory.adjustStock"
	inventoryCreateTransferCapabilityID  = "inventory.createTransfer"
	inventoryConfirmTransferCapabilityID = "inventory.confirmTransfer"
	inventoryReverseTransferCapabilityID = "inventory.reverseTransfer"
	inventoryCancelTransferCapabilityID  = "inventory.cancelTransfer"
	inventoryListTransfersCapabilityID   = "inventory.listTransfers"
)

type InventoryAdjustStockInput struct {
	SKU           string  `json:"sku"`
	QuantityDelta int64   `json:"quantityDelta"`
	Note          string  `json:"note"`
	LotCode       *string `json:"lotCode,omitempty"`
	LocationCode  *string `json:"locationCode,omitempty"`
}

type InventoryAdjustStockOutput struct {
	OnHandThousandths int64 `json:"onHandThousandths"`
}

type InventoryTransferLineInput struct {
	SKU                 string  `json:"sku"`
	QuantityThousandths int64   `json:"quantityThousandths"`
	LotCode             *string `json:"lotCode,omitempty"`
}

type InventoryCreateTransferInput struct {
	FromLocationCode string                       `json:"fromLocationCode"`
	ToLocationCode   string                       `json:"toLocationCode"`
	Lines            []InventoryTransferLineInput `json:"lines"`
	Note             *string                      `json:"note,omitempty"`
}

type InventoryCreateTransferOutput struct {
	TransferID string `json:"transferId"`
	Number     int64  `json:"number"`
	Status     string `json:"status"`
}

type InventoryConfirmTransferLineInput struct {
	LineID              string `json:"lineId"`
	QuantityThousandths int64  `json:"quantityThousandths"`
}

type InventoryConfirmTransferInput struct {
	TransferID string                               `json:"transferId"`
	Lines      *[]InventoryConfirmTransferLineInput `json:"lines,omitempty"`
}

type InventoryConfirmTransferOutput struct {
	TransferID              string `json:"transferId"`
	Status                  string `json:"status"`
	ConfirmedNowThousandths int64  `json:"confirmedNowThousandths"`
}

type InventoryCancelTransferInput struct {
	TransferID string `json:"transferId"`
}

type InventoryReverseTransferInput struct {
	TransferID string `json:"transferId"`
}

type InventoryReverseTransferOutput struct {
	Reversed           bool   `json:"reversed"`
	ReversalTransferID string `json:"reversalTransferId"`
}

type InventoryCancelTransferOutput struct {
	Cancelled bool `json:"cancelled"`
}

type InventoryListTransfersInput struct {
	OpenOnly bool `json:"openOnly,omitempty"`
}

type InventoryListTransferItem struct {
	ID        string  `json:"id"`
	Number    int64   `json:"number"`
	Status    string  `json:"status"`
	Note      *string `json:"note"`
	CreatedAt string  `json:"createdAt"`
}

type InventoryListTransfersOutput struct {
	Transfers []InventoryListTransferItem `json:"transfers"`
}

func parseInventoryStockInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case inventoryAdjustStockCapabilityID:
		return ParseInventoryAdjustStockInput(raw)
	case inventoryCreateTransferCapabilityID:
		return ParseInventoryCreateTransferInput(raw)
	case inventoryConfirmTransferCapabilityID:
		return ParseInventoryConfirmTransferInput(raw)
	case inventoryReverseTransferCapabilityID:
		return ParseInventoryReverseTransferInput(raw)
	case inventoryCancelTransferCapabilityID:
		return ParseInventoryCancelTransferInput(raw)
	case inventoryListTransfersCapabilityID:
		return ParseInventoryListTransfersInput(raw)
	default:
		return nil, errors.New("unsupported inventory stock capability")
	}
}

func ParseInventoryReverseTransferInput(raw json.RawMessage) (InventoryReverseTransferInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryReverseTransferInput{}, err
	}
	transferID, err := salesRequiredUUID(fields, "transferId")
	if err != nil {
		return InventoryReverseTransferInput{}, err
	}
	return InventoryReverseTransferInput{TransferID: transferID}, nil
}

func ParseInventoryAdjustStockInput(raw json.RawMessage) (InventoryAdjustStockInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryAdjustStockInput{}, err
	}
	sku, err := requiredCRMDealString(fields, "sku", 0, 0)
	if err != nil {
		return InventoryAdjustStockInput{}, err
	}
	quantityDelta, err := inventoryRequiredQuantity(fields, "quantityDelta")
	if err != nil {
		return InventoryAdjustStockInput{}, err
	}
	if quantityDelta == 0 {
		return InventoryAdjustStockInput{}, errors.New("zero adjustments are pointless")
	}
	note, err := requiredCRMDealString(fields, "note", 3, 0)
	if err != nil {
		return InventoryAdjustStockInput{}, err
	}
	lotCode, err := inventoryOptionalCode(fields, "lotCode", 40)
	if err != nil {
		return InventoryAdjustStockInput{}, err
	}
	locationCode, err := inventoryOptionalCode(fields, "locationCode", 20)
	if err != nil {
		return InventoryAdjustStockInput{}, err
	}
	return InventoryAdjustStockInput{
		SKU: sku, QuantityDelta: quantityDelta, Note: note,
		LotCode: lotCode, LocationCode: locationCode,
	}, nil
}

func parseInventoryTransferLines(lineValues []json.RawMessage) ([]InventoryTransferLineInput, error) {
	if len(lineValues) > 50 {
		return nil, errors.New("lines must contain at most 50 lines")
	}
	lines := make([]InventoryTransferLineInput, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return nil, errors.New("each transfer line must be an object")
		}
		sku, err := requiredCRMDealString(lineFields, "sku", 1, 0)
		if err != nil {
			return nil, err
		}
		quantity, err := inventoryRequiredQuantity(lineFields, "quantityThousandths")
		if err != nil || quantity <= 0 {
			return nil, errors.New("quantityThousandths must be a positive integer")
		}
		lotCode, err := inventoryOptionalCode(lineFields, "lotCode", 40)
		if err != nil {
			return nil, err
		}
		lines = append(lines, InventoryTransferLineInput{SKU: sku, QuantityThousandths: quantity, LotCode: lotCode})
	}
	return lines, nil
}

func ParseInventoryCreateTransferInput(raw json.RawMessage) (InventoryCreateTransferInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryCreateTransferInput{}, err
	}
	fromLocationCode, err := requiredCRMDealString(fields, "fromLocationCode", 1, 20)
	if err != nil {
		return InventoryCreateTransferInput{}, err
	}
	toLocationCode, err := requiredCRMDealString(fields, "toLocationCode", 1, 20)
	if err != nil {
		return InventoryCreateTransferInput{}, err
	}
	note, err := optionalCRMDealString(fields, "note", 300, false)
	if err != nil {
		return InventoryCreateTransferInput{}, err
	}
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return InventoryCreateTransferInput{}, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) == 0 {
		return InventoryCreateTransferInput{}, errors.New("lines must contain at least one line")
	}
	lines, err := parseInventoryTransferLines(lineValues)
	if err != nil {
		return InventoryCreateTransferInput{}, err
	}
	return InventoryCreateTransferInput{
		FromLocationCode: fromLocationCode, ToLocationCode: toLocationCode,
		Lines: lines, Note: note,
	}, nil
}

func ParseInventoryConfirmTransferInput(raw json.RawMessage) (InventoryConfirmTransferInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryConfirmTransferInput{}, err
	}
	transferID, err := salesRequiredUUID(fields, "transferId")
	if err != nil {
		return InventoryConfirmTransferInput{}, err
	}
	input := InventoryConfirmTransferInput{TransferID: transferID}
	rawLines, ok := fields["lines"]
	if !ok {
		return input, nil
	}
	if bytes.Equal(bytes.TrimSpace(rawLines), []byte("null")) {
		return InventoryConfirmTransferInput{}, errors.New("lines must be an array")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(rawLines, &lineValues); err != nil {
		return InventoryConfirmTransferInput{}, errors.New("lines must be an array")
	}
	if len(lineValues) > 50 {
		return InventoryConfirmTransferInput{}, errors.New("lines must contain at most 50 lines")
	}
	lines := make([]InventoryConfirmTransferLineInput, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return InventoryConfirmTransferInput{}, errors.New("each confirmation line must be an object")
		}
		lineID, err := requiredCRMDealString(lineFields, "lineId", 0, 0)
		if err != nil {
			return InventoryConfirmTransferInput{}, err
		}
		if !isZodUUID(lineID) {
			return InventoryConfirmTransferInput{}, errors.New("lineId must be a UUID")
		}
		quantity, err := inventoryRequiredQuantity(lineFields, "quantityThousandths")
		if err != nil || quantity <= 0 {
			return InventoryConfirmTransferInput{}, errors.New("quantityThousandths must be a positive integer")
		}
		lines = append(lines, InventoryConfirmTransferLineInput{LineID: lineID, QuantityThousandths: quantity})
	}
	input.Lines = &lines
	return input, nil
}

func ParseInventoryCancelTransferInput(raw json.RawMessage) (InventoryCancelTransferInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryCancelTransferInput{}, err
	}
	transferID, err := salesRequiredUUID(fields, "transferId")
	if err != nil {
		return InventoryCancelTransferInput{}, err
	}
	return InventoryCancelTransferInput{TransferID: transferID}, nil
}

func ParseInventoryListTransfersInput(raw json.RawMessage) (InventoryListTransfersInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryListTransfersInput{}, err
	}
	input := InventoryListTransfersInput{}
	if rawOpen, ok := fields["openOnly"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawOpen), []byte("null")) {
			return InventoryListTransfersInput{}, errors.New("openOnly must be a boolean")
		}
		if err := json.Unmarshal(rawOpen, &input.OpenOnly); err != nil {
			return InventoryListTransfersInput{}, errors.New("openOnly must be a boolean")
		}
	}
	return input, nil
}

func inventoryStringRef(value string) *string { return &value }

// inventoryRequiredQuantity mirrors zod's z.number().int(): a JSON string
// such as "5" must not pass, even though the shared integer helper keeps JS
// numeric spellings like 1e3.
func inventoryRequiredQuantity(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, fmt.Errorf("%s is required", key)
	}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte(`"`)) {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return requiredSafeInteger(fields, key)
}

func inventoryOptionalCode(fields map[string]json.RawMessage, key string, maxLength int) (*string, error) {
	value, err := optionalCRMDealString(fields, key, maxLength, false)
	if err != nil || value == nil {
		return value, err
	}
	if utf16Length(*value) < 1 {
		return nil, fmt.Errorf("%s must contain at least 1 character(s)", key)
	}
	return value, nil
}

func inventorySortedUniqueIDs(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	ids := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		ids = append(ids, value)
	}
	sort.Strings(ids)
	return ids
}

func inventoryLockStockItems(ctx context.Context, tx pgx.Tx, itemIDs []string) error {
	ids := inventorySortedUniqueIDs(itemIDs)
	if len(ids) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, ids)
	return err
}

func inventoryStockOnHand(ctx context.Context, tx pgx.Tx, orgID, itemID string, locationID *string) (int64, error) {
	if locationID != nil {
		var total int64
		err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(quantity), 0) FROM stock_balances
			WHERE org_id = $1::uuid AND item_id = $2::uuid AND location_id = $3::uuid`,
			orgID, itemID, *locationID).Scan(&total)
		return total, err
	}
	var total int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances
		WHERE org_id = $1::uuid AND item_id = $2::uuid`, orgID, itemID).Scan(&total)
	return total, err
}

func inventoryGetOrCreateLot(ctx context.Context, tx pgx.Tx, orgID, itemID, lotCode string) (string, error) {
	var lotID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM lots
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND lot_code = $3
		LIMIT 1`, orgID, itemID, lotCode).Scan(&lotID)
	if err == nil {
		return lotID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO lots (org_id, item_id, lot_code) VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT DO NOTHING`, orgID, itemID, lotCode); err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM lots
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND lot_code = $3
		LIMIT 1`, orgID, itemID, lotCode).Scan(&lotID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("could not resolve lot %q", lotCode)
	}
	if err != nil {
		return "", err
	}
	return lotID, nil
}

func inventoryLocationIDByCode(ctx context.Context, tx pgx.Tx, orgID, code string) (string, error) {
	var locationID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM stock_locations
		WHERE org_id = $1::uuid AND code = $2
		LIMIT 1`, orgID, code).Scan(&locationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("no location with code %s", code)
	}
	if err != nil {
		return "", err
	}
	return locationID, nil
}

// inventoryApplyStockDelta mirrors the shared inventory command service: it
// locks the item rows, re-checks the guards against the serialized state,
// then appends the movement. The stock_balances projection is maintained by
// the database trigger, so the only write here is the ledger append.
func inventoryApplyStockDelta(ctx context.Context, tx pgx.Tx, orgID, itemID string, quantityDelta int64, reason, note string, refType, refID, locationID, lotID *string, actorType string, actorID *string) (int64, error) {
	if err := inventoryLockStockItems(ctx, tx, []string{itemID}); err != nil {
		return 0, err
	}
	if lotID != nil {
		var lotItemID string
		err := tx.QueryRow(ctx, `
			SELECT item_id::text FROM lots WHERE id = $1::uuid AND org_id = $2::uuid`,
			*lotID, orgID).Scan(&lotItemID)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("lot %s does not exist in this organization", *lotID)
		}
		if err != nil {
			return 0, err
		}
		if lotItemID != itemID {
			return 0, fmt.Errorf("lot %s belongs to a different item; a lot cannot move another item's stock", *lotID)
		}
	}
	onHand, err := inventoryStockOnHand(ctx, tx, orgID, itemID, nil)
	if err != nil {
		return 0, err
	}
	if onHand+quantityDelta < 0 {
		return 0, fmt.Errorf("cannot move %d thousandths of stock that is not there: only %d on hand for this item", -quantityDelta, onHand)
	}
	if locationID != nil {
		atLocation, err := inventoryStockOnHand(ctx, tx, orgID, itemID, locationID)
		if err != nil {
			return 0, err
		}
		if atLocation+quantityDelta < 0 {
			return 0, fmt.Errorf("cannot move %d thousandths from this location: only %d on hand there", -quantityDelta, atLocation)
		}
	}
	var noteValue any
	if note != "" {
		noteValue = note
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, ref_type, ref_id, unit_cost_minor, location_id, lot_id, actor_type, actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, NULL, $8::uuid, $9::uuid, $10, $11::uuid)`,
		orgID, itemID, quantityDelta, reason, noteValue, refType, refID, locationID, lotID, actorType, actorID); err != nil {
		return 0, err
	}
	return onHand + quantityDelta, nil
}

func inventoryAdjustStock(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryAdjustStockInput) (InventoryAdjustStockOutput, error) {
	orgID := claims.OrganizationID
	var itemID, itemName, kind string
	err := tx.QueryRow(ctx, `
		SELECT id::text, name, kind FROM items
		WHERE org_id = $1::uuid AND sku = $2
		LIMIT 1`, orgID, input.SKU).Scan(&itemID, &itemName, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryAdjustStockOutput{}, fmt.Errorf("no item with SKU %s", input.SKU)
	}
	if err != nil {
		return InventoryAdjustStockOutput{}, err
	}
	if kind == "service" {
		return InventoryAdjustStockOutput{}, fmt.Errorf("%q is a service; there is nothing to stock", itemName)
	}
	var lotID *string
	if input.LotCode != nil {
		if input.QuantityDelta < 0 {
			return InventoryAdjustStockOutput{}, errors.New("lotCode applies only to inward corrections")
		}
		created, err := inventoryGetOrCreateLot(ctx, tx, orgID, itemID, *input.LotCode)
		if err != nil {
			return InventoryAdjustStockOutput{}, err
		}
		lotID = &created
	}
	var locationID *string
	if input.LocationCode != nil {
		resolved, err := inventoryLocationIDByCode(ctx, tx, orgID, *input.LocationCode)
		if err != nil {
			return InventoryAdjustStockOutput{}, err
		}
		locationID = &resolved
	}
	onHand, err := inventoryApplyStockDelta(ctx, tx, orgID, itemID, input.QuantityDelta, "adjustment", input.Note, nil, nil, locationID, lotID, claims.ActorType, claims.ActorID)
	if err != nil {
		return InventoryAdjustStockOutput{}, err
	}
	return InventoryAdjustStockOutput{OnHandThousandths: onHand}, nil
}

type inventoryTransferRow struct {
	id           string
	number       int64
	fromLocation string
	toLocation   string
	status       string
}

func inventoryLoadTransfer(ctx context.Context, tx pgx.Tx, orgID, transferID string) (*inventoryTransferRow, error) {
	return inventoryLoadTransferWithLock(ctx, tx, orgID, transferID, false)
}

func inventoryLoadTransferForUpdate(ctx context.Context, tx pgx.Tx, orgID, transferID string) (*inventoryTransferRow, error) {
	return inventoryLoadTransferWithLock(ctx, tx, orgID, transferID, true)
}

func inventoryLoadTransferWithLock(ctx context.Context, tx pgx.Tx, orgID, transferID string, forUpdate bool) (*inventoryTransferRow, error) {
	var transfer inventoryTransferRow
	query := `
		SELECT id::text, number, from_location_id::text, to_location_id::text, status
		FROM stock_transfers
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	err := tx.QueryRow(ctx, query, transferID, orgID).
		Scan(&transfer.id, &transfer.number, &transfer.fromLocation, &transfer.toLocation, &transfer.status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &transfer, nil
}

type inventoryTransferLineRow struct {
	id        string
	itemID    string
	lotID     *string
	quantity  int64
	confirmed int64
}

func inventoryLoadTransferLines(ctx context.Context, tx pgx.Tx, transferID string) ([]inventoryTransferLineRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, item_id::text, lot_id::text, quantity_thousandths, confirmed_thousandths
		FROM stock_transfer_lines
		WHERE transfer_id = $1::uuid
		ORDER BY id`, transferID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := make([]inventoryTransferLineRow, 0, 4)
	for rows.Next() {
		var line inventoryTransferLineRow
		if err := rows.Scan(&line.id, &line.itemID, &line.lotID, &line.quantity, &line.confirmed); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	return lines, rows.Err()
}

// inventoryConfirmLine writes the paired value-neutral out/in legs for one
// line, refusing quantities the line's remaining balance and the source
// location's on-hand cannot cover.
func inventoryConfirmLine(ctx context.Context, tx pgx.Tx, orgID string, transfer *inventoryTransferRow, line inventoryTransferLineRow, quantity int64, actorType string, actorID *string) error {
	remaining := line.quantity - line.confirmed
	if quantity <= 0 || quantity > remaining {
		return fmt.Errorf("confirm quantity must be between 1 and %d thousandths for this line", remaining)
	}
	atSource, err := inventoryStockOnHand(ctx, tx, orgID, line.itemID, &transfer.fromLocation)
	if err != nil {
		return err
	}
	if quantity > atSource {
		return fmt.Errorf("insufficient stock at source location: %d thousandths on hand, %d requested", atSource, quantity)
	}
	refType := inventoryStringRef("stock_transfer")
	refID := transfer.id
	if _, err := inventoryApplyStockDelta(ctx, tx, orgID, line.itemID, -quantity, "transfer", "", refType, &refID, &transfer.fromLocation, line.lotID, actorType, actorID); err != nil {
		return err
	}
	if _, err := inventoryApplyStockDelta(ctx, tx, orgID, line.itemID, quantity, "transfer", "", refType, &refID, &transfer.toLocation, line.lotID, actorType, actorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE stock_transfer_lines SET confirmed_thousandths = $1 WHERE id = $2::uuid`,
		line.confirmed+quantity, line.id); err != nil {
		return err
	}
	return nil
}

func inventoryCreateTransfer(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryCreateTransferInput) (InventoryCreateTransferOutput, error) {
	orgID := claims.OrganizationID
	if input.FromLocationCode == input.ToLocationCode {
		return InventoryCreateTransferOutput{}, errors.New("source and destination locations must differ")
	}
	fromLocationID, err := inventoryLocationIDByCode(ctx, tx, orgID, input.FromLocationCode)
	if err != nil {
		return InventoryCreateTransferOutput{}, err
	}
	toLocationID, err := inventoryLocationIDByCode(ctx, tx, orgID, input.ToLocationCode)
	if err != nil {
		return InventoryCreateTransferOutput{}, err
	}
	type resolvedLine struct {
		itemID   string
		lotID    *string
		quantity int64
	}
	resolved := make([]resolvedLine, 0, len(input.Lines))
	for _, line := range input.Lines {
		var itemID string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
			orgID, line.SKU).Scan(&itemID)
		if errors.Is(err, pgx.ErrNoRows) {
			return InventoryCreateTransferOutput{}, fmt.Errorf("no item with SKU %s", line.SKU)
		}
		if err != nil {
			return InventoryCreateTransferOutput{}, err
		}
		var lotID *string
		if line.LotCode != nil {
			created, err := inventoryGetOrCreateLot(ctx, tx, orgID, itemID, *line.LotCode)
			if err != nil {
				return InventoryCreateTransferOutput{}, err
			}
			lotID = &created
		}
		resolved = append(resolved, resolvedLine{itemID: itemID, lotID: lotID, quantity: line.QuantityThousandths})
	}
	var number int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(number), 0) + 1 FROM stock_transfers WHERE org_id = $1::uuid`,
		orgID).Scan(&number); err != nil {
		return InventoryCreateTransferOutput{}, err
	}
	var transferID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO stock_transfers (org_id, number, from_location_id, to_location_id, note, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7::uuid)
		RETURNING id::text`, orgID, number, fromLocationID, toLocationID, input.Note, claims.ActorType, claims.ActorID).
		Scan(&transferID); err != nil {
		return InventoryCreateTransferOutput{}, err
	}
	for _, line := range resolved {
		if _, err := tx.Exec(ctx, `
			INSERT INTO stock_transfer_lines (org_id, transfer_id, item_id, quantity_thousandths, lot_id)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
			orgID, transferID, line.itemID, line.quantity, line.lotID); err != nil {
			return InventoryCreateTransferOutput{}, err
		}
	}
	return InventoryCreateTransferOutput{TransferID: transferID, Number: number, Status: "pending"}, nil
}

func inventoryConfirmTransfer(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryConfirmTransferInput, now time.Time) (InventoryConfirmTransferOutput, error) {
	orgID := claims.OrganizationID
	transfer, err := inventoryLoadTransferForUpdate(ctx, tx, orgID, input.TransferID)
	if err != nil {
		return InventoryConfirmTransferOutput{}, err
	}
	if transfer == nil {
		return InventoryConfirmTransferOutput{}, fmt.Errorf("no transfer %s", input.TransferID)
	}
	if transfer.status == "confirmed" {
		return InventoryConfirmTransferOutput{}, errors.New("transfer is already fully confirmed")
	}
	if transfer.status != "pending" && transfer.status != "partial" {
		return InventoryConfirmTransferOutput{}, fmt.Errorf("transfer is %s; only pending or partial transfers can be confirmed", transfer.status)
	}
	lines, err := inventoryLoadTransferLines(ctx, tx, transfer.id)
	if err != nil {
		return InventoryConfirmTransferOutput{}, err
	}
	itemIDs := make([]string, 0, len(lines))
	for _, line := range lines {
		itemIDs = append(itemIDs, line.itemID)
	}
	// Lock every touched item in stable id order before any feasibility
	// check, so a concurrent sale or second transfer serializes instead of
	// racing the same stock.
	if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
		return InventoryConfirmTransferOutput{}, err
	}
	overrides := make(map[string]int64, len(lines))
	if input.Lines != nil {
		for _, requested := range *input.Lines {
			overrides[requested.LineID] = requested.QuantityThousandths
		}
	}
	var confirmedNow int64
	for _, line := range lines {
		quantity, overridden := overrides[line.id]
		delete(overrides, line.id)
		if !overridden {
			quantity = line.quantity - line.confirmed
		}
		if line.confirmed >= line.quantity {
			continue
		}
		if err := inventoryConfirmLine(ctx, tx, orgID, transfer, line, quantity, claims.ActorType, claims.ActorID); err != nil {
			return InventoryConfirmTransferOutput{}, err
		}
		confirmedNow += quantity
	}
	if len(overrides) > 0 {
		return InventoryConfirmTransferOutput{}, errors.New("confirmation references a line that does not belong to this transfer")
	}
	fullyConfirmed := true
	rows, err := tx.Query(ctx, `
		SELECT quantity_thousandths, confirmed_thousandths
		FROM stock_transfer_lines WHERE transfer_id = $1::uuid`, transfer.id)
	if err != nil {
		return InventoryConfirmTransferOutput{}, err
	}
	for rows.Next() {
		var quantity, confirmed int64
		if err := rows.Scan(&quantity, &confirmed); err != nil {
			rows.Close()
			return InventoryConfirmTransferOutput{}, err
		}
		if confirmed < quantity {
			fullyConfirmed = false
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryConfirmTransferOutput{}, err
	}
	rows.Close()
	status := "partial"
	var confirmedAt *time.Time
	if fullyConfirmed {
		status = "confirmed"
		confirmedAt = &now
	}
	if _, err := tx.Exec(ctx, `
		UPDATE stock_transfers SET status = $1, confirmed_at = $2 WHERE id = $3::uuid`,
		status, confirmedAt, transfer.id); err != nil {
		return InventoryConfirmTransferOutput{}, err
	}
	return InventoryConfirmTransferOutput{TransferID: transfer.id, Status: status, ConfirmedNowThousandths: confirmedNow}, nil
}

func inventoryCancelTransfer(ctx context.Context, tx pgx.Tx, orgID string, input InventoryCancelTransferInput, now time.Time) (InventoryCancelTransferOutput, error) {
	transfer, err := inventoryLoadTransferForUpdate(ctx, tx, orgID, input.TransferID)
	if err != nil {
		return InventoryCancelTransferOutput{}, err
	}
	if transfer == nil {
		return InventoryCancelTransferOutput{}, fmt.Errorf("no transfer %s", input.TransferID)
	}
	if transfer.status != "pending" {
		return InventoryCancelTransferOutput{}, fmt.Errorf("transfer is %s; only untouched drafts can be cancelled - reverse it instead", transfer.status)
	}
	var moved int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(confirmed_thousandths), 0) FROM stock_transfer_lines WHERE transfer_id = $1::uuid`,
		transfer.id).Scan(&moved); err != nil {
		return InventoryCancelTransferOutput{}, err
	}
	if moved > 0 {
		return InventoryCancelTransferOutput{}, errors.New("quantity already moved; reverse the transfer instead")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE stock_transfers SET status = 'cancelled', cancelled_at = $1 WHERE id = $2::uuid`,
		now, transfer.id); err != nil {
		return InventoryCancelTransferOutput{}, err
	}
	return InventoryCancelTransferOutput{Cancelled: true}, nil
}

func inventoryReverseTransfer(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryReverseTransferInput, now time.Time) (InventoryReverseTransferOutput, error) {
	orgID := claims.OrganizationID
	transfer, err := inventoryLoadTransferForUpdate(ctx, tx, orgID, input.TransferID)
	if err != nil {
		return InventoryReverseTransferOutput{}, err
	}
	if transfer == nil {
		return InventoryReverseTransferOutput{}, fmt.Errorf("no transfer %s", input.TransferID)
	}
	var alreadyReversed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM stock_transfers
			WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid
		)`, orgID, transfer.id).Scan(&alreadyReversed); err != nil {
		return InventoryReverseTransferOutput{}, err
	}
	if alreadyReversed {
		return InventoryReverseTransferOutput{}, fmt.Errorf("transfer %s has already been reversed", transfer.id)
	}
	if transfer.status != "confirmed" && transfer.status != "partial" {
		return InventoryReverseTransferOutput{}, fmt.Errorf("transfer is %s; only moved transfers can be reversed", transfer.status)
	}
	lines, err := inventoryLoadTransferLines(ctx, tx, transfer.id)
	if err != nil {
		return InventoryReverseTransferOutput{}, err
	}
	moved := make([]inventoryTransferLineRow, 0, len(lines))
	itemIDs := make([]string, 0, len(lines))
	for _, line := range lines {
		if line.confirmed > 0 {
			moved = append(moved, line)
			itemIDs = append(itemIDs, line.itemID)
		}
	}
	if len(moved) == 0 {
		return InventoryReverseTransferOutput{}, errors.New("nothing was confirmed; cancel the draft instead")
	}
	if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
		return InventoryReverseTransferOutput{}, err
	}
	var number int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(number), 0) + 1 FROM stock_transfers WHERE org_id = $1::uuid`, orgID).Scan(&number); err != nil {
		return InventoryReverseTransferOutput{}, err
	}
	var reversalID string
	note := fmt.Sprintf("Reversal of transfer #%d", transfer.number)
	if err := tx.QueryRow(ctx, `
		INSERT INTO stock_transfers (
			org_id, number, from_location_id, to_location_id, status, note,
			reversal_of_id, created_by_actor_type, created_by_actor_id, confirmed_at
		)
		VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'confirmed', $5,
			$6::uuid, $7, $8::uuid, $9)
		RETURNING id::text`,
		orgID, number, transfer.toLocation, transfer.fromLocation, note,
		transfer.id, claims.ActorType, claims.ActorID, now).Scan(&reversalID); err != nil {
		return InventoryReverseTransferOutput{}, err
	}
	reversal := &inventoryTransferRow{
		id: reversalID, number: number,
		fromLocation: transfer.toLocation, toLocation: transfer.fromLocation,
		status: "confirmed",
	}
	for _, line := range moved {
		var reversalLineID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO stock_transfer_lines (org_id, transfer_id, item_id, quantity_thousandths, lot_id)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)
			RETURNING id::text`, orgID, reversalID, line.itemID, line.confirmed, line.lotID).Scan(&reversalLineID); err != nil {
			return InventoryReverseTransferOutput{}, err
		}
		if err := inventoryConfirmLine(ctx, tx, orgID, reversal, inventoryTransferLineRow{
			id: reversalLineID, itemID: line.itemID, lotID: line.lotID,
			quantity: line.confirmed,
		}, line.confirmed, claims.ActorType, claims.ActorID); err != nil {
			return InventoryReverseTransferOutput{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE stock_transfers SET status = 'reversed' WHERE id = $1::uuid`, transfer.id); err != nil {
		return InventoryReverseTransferOutput{}, err
	}
	return InventoryReverseTransferOutput{Reversed: true, ReversalTransferID: reversalID}, nil
}

func inventoryListTransfers(ctx context.Context, tx pgx.Tx, orgID string, input InventoryListTransfersInput) (InventoryListTransfersOutput, error) {
	query := `
		SELECT id::text, number, status, note, created_at
		FROM stock_transfers WHERE org_id = $1::uuid`
	args := []any{orgID}
	if input.OpenOnly {
		query += ` AND status IN ('pending', 'partial')`
	}
	query += ` ORDER BY created_at DESC LIMIT 100`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return InventoryListTransfersOutput{}, err
	}
	defer rows.Close()
	transfers := make([]InventoryListTransferItem, 0)
	for rows.Next() {
		var transfer InventoryListTransferItem
		var createdAt time.Time
		if err := rows.Scan(&transfer.ID, &transfer.Number, &transfer.Status, &transfer.Note, &createdAt); err != nil {
			return InventoryListTransfersOutput{}, err
		}
		transfer.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		transfers = append(transfers, transfer)
	}
	if err := rows.Err(); err != nil {
		return InventoryListTransfersOutput{}, err
	}
	return InventoryListTransfersOutput{Transfers: transfers}, nil
}
