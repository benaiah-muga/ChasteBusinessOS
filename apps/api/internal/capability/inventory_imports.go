package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	inventoryImportItemsCapabilityID        = "inventory.importItems"
	inventoryUndoItemImportCapabilityID     = "inventory.undoItemImport"
	inventoryRestoreItemImportCapabilityID  = "inventory.restoreItemImport"
	inventoryReserveStockCapabilityID       = "inventory.reserveStock"
	inventoryReleaseReservationCapabilityID = "inventory.releaseReservation"
	inventoryListReservationsCapabilityID   = "inventory.listReservations"
)

type InventoryImportItemRow struct {
	RowNumber               int64    `json:"rowNumber"`
	SKU                     string   `json:"sku"`
	Name                    string   `json:"name"`
	Kind                    string   `json:"kind"`
	UnitLabel               string   `json:"unitLabel"`
	SalePriceMinor          int64    `json:"salePriceMinor"`
	ReorderPointThousandths int64    `json:"reorderPointThousandths"`
	Barcode                 *string  `json:"barcode,omitempty"`
	Tags                    []string `json:"tags"`
}

type InventoryImportItemsInput struct {
	Rows []InventoryImportItemRow `json:"rows"`
}

type InventoryImportItemsOutput struct {
	CreatedIDs           []string `json:"createdIds"`
	Imported             int64    `json:"imported"`
	SkippedDuplicateRows []int64  `json:"skippedDuplicateRows"`
}

type InventoryUndoItemImportInput struct {
	ItemIDs []string `json:"itemIds"`
}

type InventoryUndoItemImportOutput struct {
	ItemIDs  []string `json:"itemIds"`
	Archived int64    `json:"archived"`
}

type InventoryRestoreItemImportInput struct {
	ItemIDs []string `json:"itemIds"`
}

type InventoryRestoreItemImportOutput struct {
	ItemIDs  []string `json:"itemIds"`
	Restored int64    `json:"restored"`
}

type InventoryReserveStockInput struct {
	SKU                 string `json:"sku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
	Reason              string `json:"reason"`
}

type InventoryReserveStockOutput struct {
	ReservationID             string `json:"reservationId"`
	AvailableAfterThousandths int64  `json:"availableAfterThousandths"`
}

type InventoryReleaseReservationInput struct {
	ReservationID string `json:"reservationId"`
}

type InventoryReleaseReservationOutput struct {
	Released bool `json:"released"`
}

type InventoryListReservationsInput struct {
	OpenOnly bool `json:"openOnly"`
}

type InventoryListReservationRow struct {
	ID                  string `json:"id"`
	SKU                 string `json:"sku"`
	QuantityThousandths int64  `json:"quantityThousandths"`
	Reason              string `json:"reason"`
	Status              string `json:"status"`
	CreatedAt           string `json:"createdAt"`
}

type InventoryListReservationsOutput struct {
	Reservations []InventoryListReservationRow `json:"reservations"`
}

// inventoryImportsTrimmedString mirrors a zod `z.string().trim()` chain: the
// value is trimmed with JS whitespace semantics before the length bounds are
// checked, so a once-padded value survives and an all-whitespace value fails.
func inventoryImportsTrimmedString(fields map[string]json.RawMessage, key string, minLength, maxLength int) (string, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", fmt.Errorf("%s is required", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	trimmed := strings.TrimFunc(value, isJSWhitespace)
	length := utf16Length(trimmed)
	if length < minLength {
		return "", fmt.Errorf("%s must contain at least %d character(s)", key, minLength)
	}
	if maxLength > 0 && length > maxLength {
		return "", fmt.Errorf("%s must be at most %d characters", key, maxLength)
	}
	return trimmed, nil
}

func inventoryImportsTrimmedStringWithDefault(fields map[string]json.RawMessage, key, defaultValue string, minLength, maxLength int) (string, error) {
	if _, ok := fields[key]; !ok {
		return defaultValue, nil
	}
	return inventoryImportsTrimmedString(fields, key, minLength, maxLength)
}

// inventoryImportsPositiveInteger mirrors a zod `z.number().int().positive()`
// chain on top of the shared safe-integer reader.
func inventoryImportsPositiveInteger(fields map[string]json.RawMessage, key string) (int64, error) {
	value, err := inventoryRequiredQuantity(fields, key)
	if err != nil {
		return 0, err
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}

func inventoryImportsItemIDList(fields map[string]json.RawMessage) ([]string, error) {
	rawIDs, ok := fields["itemIds"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawIDs), []byte("null")) {
		return nil, errors.New("itemIds must contain at least one id")
	}
	var values []json.RawMessage
	if err := json.Unmarshal(rawIDs, &values); err != nil || values == nil {
		return nil, errors.New("itemIds must be an array")
	}
	if len(values) == 0 {
		return nil, errors.New("itemIds must contain at least one id")
	}
	if len(values) > 5000 {
		return nil, errors.New("itemIds must contain at most 5000 ids")
	}
	ids := make([]string, 0, len(values))
	for _, rawID := range values {
		var id string
		if err := json.Unmarshal(rawID, &id); err != nil || !isZodUUID(id) {
			return nil, errors.New("each itemId must be a UUID")
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func parseInventoryImportItemRow(raw json.RawMessage) (InventoryImportItemRow, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryImportItemRow{}, errors.New("each import row must be an object")
	}
	var row InventoryImportItemRow
	if row.RowNumber, err = inventoryImportsPositiveInteger(fields, "rowNumber"); err != nil {
		return InventoryImportItemRow{}, err
	}
	if row.SKU, err = inventoryImportsTrimmedString(fields, "sku", 1, 40); err != nil {
		return InventoryImportItemRow{}, err
	}
	if row.Name, err = inventoryImportsTrimmedString(fields, "name", 1, 120); err != nil {
		return InventoryImportItemRow{}, err
	}
	row.Kind = "goods"
	if rawKind, ok := fields["kind"]; ok {
		value, err := readOptionalString(rawKind)
		if err != nil || value == nil || (*value != "goods" && *value != "service") {
			return InventoryImportItemRow{}, errors.New("kind must be goods or service")
		}
		row.Kind = *value
	}
	if row.UnitLabel, err = inventoryImportsTrimmedStringWithDefault(fields, "unitLabel", "unit", 1, 20); err != nil {
		return InventoryImportItemRow{}, err
	}
	if row.SalePriceMinor, err = inventoryRequiredQuantity(fields, "salePriceMinor"); err != nil {
		return InventoryImportItemRow{}, err
	}
	if row.SalePriceMinor < 0 {
		return InventoryImportItemRow{}, errors.New("salePriceMinor must be a nonnegative integer")
	}
	if row.ReorderPointThousandths, err = inventoryItemNonNegativeInt(fields, "reorderPointThousandths", 0); err != nil {
		return InventoryImportItemRow{}, err
	}
	if rawBarcode, ok := fields["barcode"]; ok && !bytes.Equal(bytes.TrimSpace(rawBarcode), []byte("null")) {
		var value string
		if err := json.Unmarshal(rawBarcode, &value); err != nil {
			return InventoryImportItemRow{}, errors.New("barcode must be a string")
		}
		trimmed := strings.TrimFunc(value, isJSWhitespace)
		length := utf16Length(trimmed)
		if length < 3 || length > 64 {
			return InventoryImportItemRow{}, errors.New("barcode must contain between 3 and 64 characters")
		}
		row.Barcode = &trimmed
	}
	row.Tags = []string{}
	if rawTags, ok := fields["tags"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawTags), []byte("null")) {
			return InventoryImportItemRow{}, errors.New("tags must be an array")
		}
		var values []json.RawMessage
		if err := json.Unmarshal(rawTags, &values); err != nil || values == nil {
			return InventoryImportItemRow{}, errors.New("tags must be an array")
		}
		if len(values) > 20 {
			return InventoryImportItemRow{}, errors.New("tags must contain at most 20 items")
		}
		tags := make([]string, 0, len(values))
		for _, rawTag := range values {
			var tag string
			if err := json.Unmarshal(rawTag, &tag); err != nil {
				return InventoryImportItemRow{}, errors.New("each tag must be a string")
			}
			trimmed := strings.TrimFunc(tag, isJSWhitespace)
			length := utf16Length(trimmed)
			if length < 1 || length > 30 {
				return InventoryImportItemRow{}, errors.New("each tag must contain between 1 and 30 characters")
			}
			tags = append(tags, trimmed)
		}
		row.Tags = tags
	}
	return row, nil
}

func ParseInventoryImportItemsInput(raw json.RawMessage) (InventoryImportItemsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryImportItemsInput{}, err
	}
	rawRows, ok := fields["rows"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawRows), []byte("null")) {
		return InventoryImportItemsInput{}, errors.New("rows must contain at least one row")
	}
	var rowValues []json.RawMessage
	if err := json.Unmarshal(rawRows, &rowValues); err != nil || rowValues == nil {
		return InventoryImportItemsInput{}, errors.New("rows must be an array")
	}
	if len(rowValues) == 0 {
		return InventoryImportItemsInput{}, errors.New("rows must contain at least one row")
	}
	if len(rowValues) > 5000 {
		return InventoryImportItemsInput{}, errors.New("rows must contain at most 5000 rows")
	}
	rows := make([]InventoryImportItemRow, 0, len(rowValues))
	for _, rowRaw := range rowValues {
		row, err := parseInventoryImportItemRow(rowRaw)
		if err != nil {
			return InventoryImportItemsInput{}, err
		}
		rows = append(rows, row)
	}
	return InventoryImportItemsInput{Rows: rows}, nil
}

func ParseInventoryUndoItemImportInput(raw json.RawMessage) (InventoryUndoItemImportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryUndoItemImportInput{}, err
	}
	ids, err := inventoryImportsItemIDList(fields)
	if err != nil {
		return InventoryUndoItemImportInput{}, err
	}
	return InventoryUndoItemImportInput{ItemIDs: ids}, nil
}

func ParseInventoryRestoreItemImportInput(raw json.RawMessage) (InventoryRestoreItemImportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryRestoreItemImportInput{}, err
	}
	ids, err := inventoryImportsItemIDList(fields)
	if err != nil {
		return InventoryRestoreItemImportInput{}, err
	}
	return InventoryRestoreItemImportInput{ItemIDs: ids}, nil
}

func ParseInventoryReserveStockInput(raw json.RawMessage) (InventoryReserveStockInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryReserveStockInput{}, err
	}
	sku, err := requiredCRMDealString(fields, "sku", 0, 0)
	if err != nil {
		return InventoryReserveStockInput{}, err
	}
	quantity, err := inventoryImportsPositiveInteger(fields, "quantityThousandths")
	if err != nil {
		return InventoryReserveStockInput{}, err
	}
	reason, err := requiredCRMDealString(fields, "reason", 3, 200)
	if err != nil {
		return InventoryReserveStockInput{}, err
	}
	return InventoryReserveStockInput{SKU: sku, QuantityThousandths: quantity, Reason: reason}, nil
}

func ParseInventoryReleaseReservationInput(raw json.RawMessage) (InventoryReleaseReservationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryReleaseReservationInput{}, err
	}
	reservationID, err := salesRequiredUUID(fields, "reservationId")
	if err != nil {
		return InventoryReleaseReservationInput{}, err
	}
	return InventoryReleaseReservationInput{ReservationID: reservationID}, nil
}

func ParseInventoryListReservationsInput(raw json.RawMessage) (InventoryListReservationsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryListReservationsInput{}, err
	}
	input := InventoryListReservationsInput{OpenOnly: true}
	if rawOpenOnly, ok := fields["openOnly"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawOpenOnly), []byte("null")) {
			return InventoryListReservationsInput{}, errors.New("openOnly must be a boolean")
		}
		if err := json.Unmarshal(rawOpenOnly, &input.OpenOnly); err != nil {
			return InventoryListReservationsInput{}, errors.New("openOnly must be a boolean")
		}
	}
	return input, nil
}

// inventoryAvailableToPromise mirrors the erp-core helper: what is on hand
// minus what open commitments claim, clamped at zero on both sides. It stays
// pure so the reservation guard keeps its property-test surface.
func inventoryAvailableToPromise(onHandThousandths, reservedOpenThousandths int64) int64 {
	if reservedOpenThousandths < 0 {
		reservedOpenThousandths = 0
	}
	available := onHandThousandths - reservedOpenThousandths
	if available < 0 {
		return 0
	}
	return available
}

func inventoryOpenReserved(ctx context.Context, tx pgx.Tx, orgID, itemID string) (int64, error) {
	var total int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity_thousandths), 0) FROM stock_reservations
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND status = 'open'`,
		orgID, itemID).Scan(&total)
	return total, err
}

func inventoryImportsInsertChunk(ctx context.Context, tx pgx.Tx, orgID string, chunk []InventoryImportItemRow) ([]string, error) {
	var builder strings.Builder
	args := make([]any, 0, len(chunk)*9)
	builder.WriteString(`INSERT INTO items (org_id, sku, name, kind, unit_label, sale_price_minor, reorder_point_thousandths, barcode, tags) VALUES `)
	for index, row := range chunk {
		if index > 0 {
			builder.WriteString(", ")
		}
		reorderPoint := row.ReorderPointThousandths
		barcode := row.Barcode
		// Services never stock: a reorder point would fire phantom alerts
		// and a service barcode could block a real product's code.
		if row.Kind == "service" {
			reorderPoint = 0
			barcode = nil
		}
		if row.SalePriceMinor > maxDatabaseInteger || reorderPoint > maxDatabaseInteger {
			return nil, errors.New("item amount exceeds the database integer range")
		}
		tags := row.Tags
		if tags == nil {
			tags = []string{}
		}
		base := len(args)
		fmt.Fprintf(&builder, "($%d::uuid, $%d, $%d, $%d, $%d, $%d, $%d, $%d, $%d::jsonb)",
			base+1, base+2, base+3, base+4, base+5, base+6, base+7, base+8, base+9)
		args = append(args, orgID, row.SKU, row.Name, row.Kind, row.UnitLabel, row.SalePriceMinor, reorderPoint, barcode, tags)
	}
	builder.WriteString(` RETURNING id::text`)
	rows, err := tx.Query(ctx, builder.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, len(chunk))
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func inventoryImportItems(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryImportItemsInput) (InventoryImportItemsOutput, error) {
	orgID := claims.OrganizationID
	rows, err := tx.Query(ctx, `SELECT sku, barcode FROM items WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return InventoryImportItemsOutput{}, err
	}
	seenSku := make(map[string]struct{})
	seenBarcode := make(map[string]struct{})
	for rows.Next() {
		var sku string
		var barcode *string
		if err := rows.Scan(&sku, &barcode); err != nil {
			rows.Close()
			return InventoryImportItemsOutput{}, err
		}
		seenSku[strings.ToLower(strings.TrimFunc(sku, isJSWhitespace))] = struct{}{}
		if barcode != nil {
			seenBarcode[strings.ToLower(strings.TrimFunc(*barcode, isJSWhitespace))] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryImportItemsOutput{}, err
	}
	rows.Close()
	output := InventoryImportItemsOutput{CreatedIDs: []string{}, SkippedDuplicateRows: []int64{}}
	fresh := make([]InventoryImportItemRow, 0, len(input.Rows))
	for _, row := range input.Rows {
		sku := strings.ToLower(row.SKU)
		barcode := ""
		if row.Barcode != nil {
			barcode = strings.ToLower(*row.Barcode)
		}
		_, skuTaken := seenSku[sku]
		_, barcodeTaken := seenBarcode[barcode]
		if skuTaken || (barcode != "" && barcodeTaken) {
			output.SkippedDuplicateRows = append(output.SkippedDuplicateRows, row.RowNumber)
			continue
		}
		seenSku[sku] = struct{}{}
		if barcode != "" {
			seenBarcode[barcode] = struct{}{}
		}
		fresh = append(fresh, row)
	}
	for offset := 0; offset < len(fresh); offset += 500 {
		end := offset + 500
		if end > len(fresh) {
			end = len(fresh)
		}
		created, err := inventoryImportsInsertChunk(ctx, tx, orgID, fresh[offset:end])
		if err != nil {
			return InventoryImportItemsOutput{}, err
		}
		output.CreatedIDs = append(output.CreatedIDs, created...)
	}
	output.Imported = int64(len(output.CreatedIDs))
	return output, nil
}

func inventoryUndoItemImport(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryUndoItemImportInput, now time.Time) (InventoryUndoItemImportOutput, error) {
	rows, err := tx.Query(ctx, `
		UPDATE items SET archived_at = $1
		WHERE org_id = $2::uuid AND id = ANY($3::uuid[]) AND archived_at IS NULL
		RETURNING id::text`,
		now, claims.OrganizationID, inventorySortedUniqueIDs(input.ItemIDs))
	if err != nil {
		return InventoryUndoItemImportOutput{}, err
	}
	defer rows.Close()
	output := InventoryUndoItemImportOutput{ItemIDs: []string{}}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return InventoryUndoItemImportOutput{}, err
		}
		output.ItemIDs = append(output.ItemIDs, id)
	}
	if err := rows.Err(); err != nil {
		return InventoryUndoItemImportOutput{}, err
	}
	output.Archived = int64(len(output.ItemIDs))
	return output, nil
}

func inventoryRestoreItemImport(ctx context.Context, tx pgx.Tx, orgID string, input InventoryRestoreItemImportInput) (InventoryRestoreItemImportOutput, error) {
	rows, err := tx.Query(ctx, `
		UPDATE items SET archived_at = NULL
		WHERE org_id = $1::uuid AND id = ANY($2::uuid[]) AND archived_at IS NOT NULL
		RETURNING id::text`,
		orgID, inventorySortedUniqueIDs(input.ItemIDs))
	if err != nil {
		return InventoryRestoreItemImportOutput{}, err
	}
	defer rows.Close()
	output := InventoryRestoreItemImportOutput{ItemIDs: []string{}}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return InventoryRestoreItemImportOutput{}, err
		}
		output.ItemIDs = append(output.ItemIDs, id)
	}
	if err := rows.Err(); err != nil {
		return InventoryRestoreItemImportOutput{}, err
	}
	output.Restored = int64(len(output.ItemIDs))
	return output, nil
}

func inventoryReserveStock(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryReserveStockInput) (InventoryReserveStockOutput, error) {
	orgID := claims.OrganizationID
	var itemID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
		orgID, input.SKU).Scan(&itemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryReserveStockOutput{}, fmt.Errorf("no item with SKU %s", input.SKU)
	}
	if err != nil {
		return InventoryReserveStockOutput{}, err
	}
	// N22: a reservation and a sale of the same last unit cannot both
	// succeed, so the availability read is serialized against sellers.
	if err := inventoryLockStockItems(ctx, tx, []string{itemID}); err != nil {
		return InventoryReserveStockOutput{}, err
	}
	onHand, err := inventoryStockOnHand(ctx, tx, orgID, itemID, nil)
	if err != nil {
		return InventoryReserveStockOutput{}, err
	}
	reserved, err := inventoryOpenReserved(ctx, tx, orgID, itemID)
	if err != nil {
		return InventoryReserveStockOutput{}, err
	}
	available := inventoryAvailableToPromise(onHand, reserved)
	if input.QuantityThousandths > available {
		return InventoryReserveStockOutput{}, fmt.Errorf("only %d thousandths available to promise (%d on hand, %d reserved)", available, onHand, reserved)
	}
	var reservationID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO stock_reservations (org_id, item_id, quantity_thousandths, reason, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)
		RETURNING id::text`,
		orgID, itemID, input.QuantityThousandths, input.Reason, claims.ActorType, claims.ActorID).Scan(&reservationID); err != nil {
		return InventoryReserveStockOutput{}, err
	}
	return InventoryReserveStockOutput{ReservationID: reservationID, AvailableAfterThousandths: available - input.QuantityThousandths}, nil
}

func inventoryReleaseReservation(ctx context.Context, tx pgx.Tx, orgID string, input InventoryReleaseReservationInput, now time.Time) (InventoryReleaseReservationOutput, error) {
	var status string
	err := tx.QueryRow(ctx, `
		SELECT status FROM stock_reservations
		WHERE org_id = $1::uuid AND id = $2::uuid LIMIT 1`,
		orgID, input.ReservationID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryReleaseReservationOutput{}, fmt.Errorf("no reservation %s", input.ReservationID)
	}
	if err != nil {
		return InventoryReleaseReservationOutput{}, err
	}
	if status != "open" {
		return InventoryReleaseReservationOutput{}, fmt.Errorf("reservation is %s, only open ones can be released", status)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE stock_reservations SET status = 'released', released_at = $1 WHERE id = $2::uuid`,
		now, input.ReservationID); err != nil {
		return InventoryReleaseReservationOutput{}, err
	}
	return InventoryReleaseReservationOutput{Released: true}, nil
}

func inventoryListReservations(ctx context.Context, tx pgx.Tx, orgID string, input InventoryListReservationsInput) (InventoryListReservationsOutput, error) {
	query := `
		SELECT r.id::text, i.sku, r.quantity_thousandths, r.reason, r.status, r.created_at
		FROM stock_reservations r
		INNER JOIN items i ON i.id = r.item_id
		WHERE r.org_id = $1::uuid`
	if input.OpenOnly {
		query += ` AND r.status = 'open'`
	}
	query += ` ORDER BY r.created_at DESC LIMIT 100`
	rows, err := tx.Query(ctx, query, orgID)
	if err != nil {
		return InventoryListReservationsOutput{}, err
	}
	defer rows.Close()
	reservations := make([]InventoryListReservationRow, 0)
	for rows.Next() {
		var row InventoryListReservationRow
		var createdAt time.Time
		if err := rows.Scan(&row.ID, &row.SKU, &row.QuantityThousandths, &row.Reason, &row.Status, &createdAt); err != nil {
			return InventoryListReservationsOutput{}, err
		}
		row.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		reservations = append(reservations, row)
	}
	if err := rows.Err(); err != nil {
		return InventoryListReservationsOutput{}, err
	}
	return InventoryListReservationsOutput{Reservations: reservations}, nil
}

func parseInventoryImportInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case inventoryImportItemsCapabilityID:
		return ParseInventoryImportItemsInput(raw)
	case inventoryUndoItemImportCapabilityID:
		return ParseInventoryUndoItemImportInput(raw)
	case inventoryRestoreItemImportCapabilityID:
		return ParseInventoryRestoreItemImportInput(raw)
	case inventoryReserveStockCapabilityID:
		return ParseInventoryReserveStockInput(raw)
	case inventoryReleaseReservationCapabilityID:
		return ParseInventoryReleaseReservationInput(raw)
	case inventoryListReservationsCapabilityID:
		return ParseInventoryListReservationsInput(raw)
	default:
		return nil, errors.New("unsupported inventory import capability")
	}
}
