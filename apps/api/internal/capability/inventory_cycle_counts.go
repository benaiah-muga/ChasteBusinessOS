package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	inventoryCreateCycleCountCapabilityID  = "inventory.createCycleCount"
	inventoryRecordCycleCountsCapabilityID = "inventory.recordCycleCounts"
	inventoryPostCycleCountCapabilityID    = "inventory.postCycleCount"
	inventoryCancelCycleCountCapabilityID  = "inventory.cancelCycleCount"
	inventoryListCycleCountsCapabilityID   = "inventory.listCycleCounts"
)

type InventoryListCycleCountsInput struct{}

type InventoryListCycleCountLine struct {
	SKU                 string `json:"sku"`
	ExpectedThousandths int64  `json:"expectedThousandths"`
	CountedThousandths  *int64 `json:"countedThousandths"`
	VarianceThousandths *int64 `json:"varianceThousandths"`
}

type InventoryListCycleCount struct {
	ID           string                        `json:"id"`
	Status       string                        `json:"status"`
	Note         *string                       `json:"note"`
	LocationCode *string                       `json:"locationCode"`
	CreatedAt    string                        `json:"createdAt"`
	Lines        []InventoryListCycleCountLine `json:"lines"`
}

type InventoryListCycleCountsOutput struct {
	CycleCounts []InventoryListCycleCount `json:"cycleCounts"`
}

type InventoryCreateCycleCountInput struct {
	Note       *string   `json:"note,omitempty"`
	SKUs       *[]string `json:"skus,omitempty"`
	LocationID *string   `json:"locationId,omitempty"`
}

type InventoryCreateCycleCountOutput struct {
	CountID   string `json:"countId"`
	LineCount int64  `json:"lineCount"`
}

type InventoryCycleCountLineInput struct {
	SKU                string `json:"sku"`
	CountedThousandths int64  `json:"countedThousandths"`
}

type InventoryRecordCycleCountsInput struct {
	CountID string                         `json:"countId"`
	Counts  []InventoryCycleCountLineInput `json:"counts"`
}

type InventoryRecordCycleCountsOutput struct {
	Recorded int64 `json:"recorded"`
}

type InventoryPostCycleCountInput struct {
	CountID string `json:"countId"`
}

type InventoryPostCycleCountOutput struct {
	Posted                 bool  `json:"posted"`
	PostedVariances        int64 `json:"postedVariances"`
	NetVarianceThousandths int64 `json:"netVarianceThousandths"`
}

type InventoryCancelCycleCountInput struct {
	CountID string `json:"countId"`
}

type InventoryCancelCycleCountOutput struct {
	Cancelled bool `json:"cancelled"`
}

func parseInventoryCycleCountInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case inventoryCreateCycleCountCapabilityID:
		return ParseInventoryCreateCycleCountInput(raw)
	case inventoryRecordCycleCountsCapabilityID:
		return ParseInventoryRecordCycleCountsInput(raw)
	case inventoryPostCycleCountCapabilityID:
		return ParseInventoryPostCycleCountInput(raw)
	case inventoryCancelCycleCountCapabilityID:
		return ParseInventoryCancelCycleCountInput(raw)
	case inventoryListCycleCountsCapabilityID:
		return ParseInventoryListCycleCountsInput(raw)
	default:
		return nil, errors.New("unsupported inventory cycle count capability")
	}
}

func ParseInventoryListCycleCountsInput(raw json.RawMessage) (InventoryListCycleCountsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return InventoryListCycleCountsInput{}, err
	}
	return InventoryListCycleCountsInput{}, nil
}

func inventoryListCycleCounts(ctx context.Context, tx pgx.Tx, orgID string, _ InventoryListCycleCountsInput) (InventoryListCycleCountsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT counts.id::text, counts.status, counts.note, locations.code, counts.created_at
		FROM cycle_counts counts
		LEFT JOIN stock_locations locations
		  ON locations.id = counts.location_id AND locations.org_id = counts.org_id
		WHERE counts.org_id = $1::uuid
		ORDER BY counts.created_at DESC
		LIMIT 20`, orgID)
	if err != nil {
		return InventoryListCycleCountsOutput{}, err
	}
	cycleCounts := make([]InventoryListCycleCount, 0)
	countIDs := make([]string, 0)
	for rows.Next() {
		var count InventoryListCycleCount
		var createdAt time.Time
		if err := rows.Scan(&count.ID, &count.Status, &count.Note, &count.LocationCode, &createdAt); err != nil {
			rows.Close()
			return InventoryListCycleCountsOutput{}, err
		}
		count.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		count.Lines = make([]InventoryListCycleCountLine, 0)
		countIDs = append(countIDs, count.ID)
		cycleCounts = append(cycleCounts, count)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryListCycleCountsOutput{}, err
	}
	rows.Close()
	if len(countIDs) == 0 {
		return InventoryListCycleCountsOutput{CycleCounts: cycleCounts}, nil
	}

	lineRows, err := tx.Query(ctx, `
		SELECT lines.count_id::text, COALESCE(items.sku, ''), lines.expected_thousandths, lines.counted_thousandths
		FROM cycle_count_lines lines
		LEFT JOIN items ON items.id = lines.item_id AND items.org_id = lines.org_id
		WHERE lines.org_id = $1::uuid AND lines.count_id = ANY($2::uuid[])`, orgID, countIDs)
	if err != nil {
		return InventoryListCycleCountsOutput{}, err
	}
	defer lineRows.Close()
	indexByID := make(map[string]int, len(cycleCounts))
	for index := range cycleCounts {
		indexByID[cycleCounts[index].ID] = index
	}
	for lineRows.Next() {
		var countID string
		var line InventoryListCycleCountLine
		if err := lineRows.Scan(&countID, &line.SKU, &line.ExpectedThousandths, &line.CountedThousandths); err != nil {
			return InventoryListCycleCountsOutput{}, err
		}
		if line.CountedThousandths != nil {
			variance := *line.CountedThousandths - line.ExpectedThousandths
			line.VarianceThousandths = &variance
		}
		if index, ok := indexByID[countID]; ok {
			cycleCounts[index].Lines = append(cycleCounts[index].Lines, line)
		}
	}
	if err := lineRows.Err(); err != nil {
		return InventoryListCycleCountsOutput{}, err
	}
	return InventoryListCycleCountsOutput{CycleCounts: cycleCounts}, nil
}

func ParseInventoryCreateCycleCountInput(raw json.RawMessage) (InventoryCreateCycleCountInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryCreateCycleCountInput{}, err
	}
	input := InventoryCreateCycleCountInput{}
	if input.Note, err = optionalCRMDealString(fields, "note", 200, false); err != nil {
		return InventoryCreateCycleCountInput{}, err
	}
	if rawSKUs, ok := fields["skus"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawSKUs), []byte("null")) {
			return InventoryCreateCycleCountInput{}, errors.New("skus must be an array")
		}
		var values []json.RawMessage
		if err := json.Unmarshal(rawSKUs, &values); err != nil || values == nil {
			return InventoryCreateCycleCountInput{}, errors.New("skus must be an array")
		}
		if len(values) > 500 {
			return InventoryCreateCycleCountInput{}, errors.New("skus must contain at most 500 items")
		}
		skus := make([]string, 0, len(values))
		for _, rawSKU := range values {
			var sku string
			if err := json.Unmarshal(rawSKU, &sku); err != nil || utf16Length(sku) < 1 || utf16Length(sku) > 40 {
				return InventoryCreateCycleCountInput{}, errors.New("each SKU must contain between 1 and 40 characters")
			}
			skus = append(skus, sku)
		}
		input.SKUs = &skus
	}
	if input.LocationID, err = optionalCRMDealString(fields, "locationId", 0, false); err != nil {
		return InventoryCreateCycleCountInput{}, errors.New("locationId must be a UUID")
	}
	if input.LocationID != nil && !isZodUUID(*input.LocationID) {
		return InventoryCreateCycleCountInput{}, errors.New("locationId must be a UUID")
	}
	return input, nil
}

func ParseInventoryRecordCycleCountsInput(raw json.RawMessage) (InventoryRecordCycleCountsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryRecordCycleCountsInput{}, err
	}
	countID, err := salesRequiredUUID(fields, "countId")
	if err != nil {
		return InventoryRecordCycleCountsInput{}, err
	}
	rawCounts, ok := fields["counts"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawCounts), []byte("null")) {
		return InventoryRecordCycleCountsInput{}, errors.New("counts must contain at least one item")
	}
	var values []json.RawMessage
	if err := json.Unmarshal(rawCounts, &values); err != nil || values == nil || len(values) == 0 {
		return InventoryRecordCycleCountsInput{}, errors.New("counts must contain at least one item")
	}
	if len(values) > 500 {
		return InventoryRecordCycleCountsInput{}, errors.New("counts must contain at most 500 items")
	}
	counts := make([]InventoryCycleCountLineInput, 0, len(values))
	for _, rawCount := range values {
		lineFields, err := decodeJSONObject(rawCount)
		if err != nil {
			return InventoryRecordCycleCountsInput{}, errors.New("each count must be an object")
		}
		sku, err := requiredCRMDealString(lineFields, "sku", 0, 0)
		if err != nil {
			return InventoryRecordCycleCountsInput{}, err
		}
		counted, err := requiredSafeInteger(lineFields, "countedThousandths")
		if err != nil || counted < 0 {
			return InventoryRecordCycleCountsInput{}, errors.New("countedThousandths must be a non-negative integer")
		}
		counts = append(counts, InventoryCycleCountLineInput{SKU: sku, CountedThousandths: counted})
	}
	return InventoryRecordCycleCountsInput{CountID: countID, Counts: counts}, nil
}

func ParseInventoryPostCycleCountInput(raw json.RawMessage) (InventoryPostCycleCountInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryPostCycleCountInput{}, err
	}
	countID, err := salesRequiredUUID(fields, "countId")
	if err != nil {
		return InventoryPostCycleCountInput{}, err
	}
	return InventoryPostCycleCountInput{CountID: countID}, nil
}

func ParseInventoryCancelCycleCountInput(raw json.RawMessage) (InventoryCancelCycleCountInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryCancelCycleCountInput{}, err
	}
	countID, err := salesRequiredUUID(fields, "countId")
	if err != nil {
		return InventoryCancelCycleCountInput{}, err
	}
	return InventoryCancelCycleCountInput{CountID: countID}, nil
}

type inventoryCycleCount struct {
	id         string
	status     string
	locationID *string
}

func inventoryLoadCycleCount(ctx context.Context, tx pgx.Tx, orgID, countID string) (*inventoryCycleCount, error) {
	var count inventoryCycleCount
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, location_id::text
		FROM cycle_counts WHERE org_id = $1::uuid AND id = $2::uuid
		FOR UPDATE`, orgID, countID).Scan(&count.id, &count.status, &count.locationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("no cycle count %s", countID)
	}
	if err != nil {
		return nil, err
	}
	return &count, nil
}

type inventoryCycleCountItem struct {
	id  string
	sku string
}

func inventoryItemMovementCounts(ctx context.Context, tx pgx.Tx, orgID string, itemIDs []string) (map[string]int64, error) {
	counts := make(map[string]int64, len(itemIDs))
	for _, itemID := range itemIDs {
		counts[itemID] = 0
	}
	if len(itemIDs) == 0 {
		return counts, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT item_id::text, count(*)::bigint
		FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = ANY($2::uuid[])
		GROUP BY item_id`, orgID, itemIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var itemID string
		var count int64
		if err := rows.Scan(&itemID, &count); err != nil {
			return nil, err
		}
		counts[itemID] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return counts, nil
}

func inventoryCreateCycleCount(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryCreateCycleCountInput) (InventoryCreateCycleCountOutput, error) {
	orgID := claims.OrganizationID
	if input.LocationID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM stock_locations WHERE org_id = $1::uuid AND id = $2::uuid)`,
			orgID, *input.LocationID).Scan(&exists); err != nil {
			return InventoryCreateCycleCountOutput{}, err
		}
		if !exists {
			return InventoryCreateCycleCountOutput{}, errors.New("location not found")
		}
	}
	query := `SELECT id::text, sku FROM items WHERE org_id = $1::uuid AND archived_at IS NULL`
	args := []any{orgID}
	if input.SKUs != nil {
		query += ` AND sku = ANY($2::text[])`
		args = append(args, *input.SKUs)
	}
	query += ` ORDER BY id`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return InventoryCreateCycleCountOutput{}, err
	}
	items := make([]inventoryCycleCountItem, 0)
	for rows.Next() {
		var item inventoryCycleCountItem
		if err := rows.Scan(&item.id, &item.sku); err != nil {
			rows.Close()
			return InventoryCreateCycleCountOutput{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryCreateCycleCountOutput{}, err
	}
	rows.Close()
	if len(items) == 0 {
		if input.SKUs != nil {
			return InventoryCreateCycleCountOutput{}, errors.New("none of the requested SKUs are active items")
		}
		return InventoryCreateCycleCountOutput{}, errors.New("no items to count")
	}
	var countID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO cycle_counts (org_id, location_id, note, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
		RETURNING id::text`, orgID, input.LocationID, input.Note, claims.ActorType, claims.ActorID).Scan(&countID); err != nil {
		return InventoryCreateCycleCountOutput{}, err
	}
	itemIDs := make([]string, 0, len(items))
	for _, item := range items {
		itemIDs = append(itemIDs, item.id)
	}
	if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
		return InventoryCreateCycleCountOutput{}, err
	}
	movementCounts, err := inventoryItemMovementCounts(ctx, tx, orgID, itemIDs)
	if err != nil {
		return InventoryCreateCycleCountOutput{}, err
	}
	for _, item := range items {
		expected, err := inventoryStockOnHand(ctx, tx, orgID, item.id, input.LocationID)
		if err != nil {
			return InventoryCreateCycleCountOutput{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO cycle_count_lines (org_id, count_id, item_id, expected_thousandths, expected_movement_count)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
			orgID, countID, item.id, expected, movementCounts[item.id]); err != nil {
			return InventoryCreateCycleCountOutput{}, err
		}
	}
	return InventoryCreateCycleCountOutput{CountID: countID, LineCount: int64(len(items))}, nil
}

func inventoryRecordCycleCounts(ctx context.Context, tx pgx.Tx, orgID string, input InventoryRecordCycleCountsInput) (InventoryRecordCycleCountsOutput, error) {
	count, err := inventoryLoadCycleCount(ctx, tx, orgID, input.CountID)
	if err != nil {
		return InventoryRecordCycleCountsOutput{}, err
	}
	if count.status != "open" {
		return InventoryRecordCycleCountsOutput{}, fmt.Errorf("cycle count is %s; only open counts accept entries", count.status)
	}
	var recorded int64
	for _, entry := range input.Counts {
		var itemID string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
			orgID, entry.SKU).Scan(&itemID)
		if errors.Is(err, pgx.ErrNoRows) {
			return InventoryRecordCycleCountsOutput{}, fmt.Errorf("no item with SKU %s", entry.SKU)
		}
		if err != nil {
			return InventoryRecordCycleCountsOutput{}, err
		}
		var lineID string
		err = tx.QueryRow(ctx, `
			UPDATE cycle_count_lines SET counted_thousandths = $4
			WHERE org_id = $1::uuid AND count_id = $2::uuid AND item_id = $3::uuid
			RETURNING id::text`, orgID, count.id, itemID, entry.CountedThousandths).Scan(&lineID)
		if errors.Is(err, pgx.ErrNoRows) {
			return InventoryRecordCycleCountsOutput{}, fmt.Errorf("SKU %s is not part of this count", entry.SKU)
		}
		if err != nil {
			return InventoryRecordCycleCountsOutput{}, err
		}
		recorded++
	}
	return InventoryRecordCycleCountsOutput{Recorded: recorded}, nil
}

func inventoryPostCycleCount(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryPostCycleCountInput, now time.Time) (InventoryPostCycleCountOutput, error) {
	count, err := inventoryLoadCycleCount(ctx, tx, claims.OrganizationID, input.CountID)
	if err != nil {
		return InventoryPostCycleCountOutput{}, err
	}
	if count.status != "open" {
		return InventoryPostCycleCountOutput{}, fmt.Errorf("cycle count is %s; only open counts can post", count.status)
	}
	rows, err := tx.Query(ctx, `
		SELECT item_id::text, expected_thousandths, expected_movement_count, counted_thousandths
		FROM cycle_count_lines WHERE org_id = $1::uuid AND count_id = $2::uuid ORDER BY item_id`,
		claims.OrganizationID, count.id)
	if err != nil {
		return InventoryPostCycleCountOutput{}, err
	}
	type line struct {
		itemID                string
		expected              int64
		expectedMovementCount int64
		counted               *int64
	}
	lines := make([]line, 0)
	var itemIDs []string
	for rows.Next() {
		var current line
		if err := rows.Scan(&current.itemID, &current.expected, &current.expectedMovementCount, &current.counted); err != nil {
			rows.Close()
			return InventoryPostCycleCountOutput{}, err
		}
		lines = append(lines, current)
		if current.counted != nil {
			itemIDs = append(itemIDs, current.itemID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return InventoryPostCycleCountOutput{}, err
	}
	rows.Close()
	hasCount := false
	for _, current := range lines {
		if current.counted != nil {
			hasCount = true
			break
		}
	}
	if !hasCount {
		return InventoryPostCycleCountOutput{}, errors.New("no counted quantity recorded on any line; enter counts before posting")
	}
	if err := inventoryLockStockItems(ctx, tx, itemIDs); err != nil {
		return InventoryPostCycleCountOutput{}, err
	}
	for _, current := range lines {
		if current.counted == nil {
			continue
		}
		movementCounts, err := inventoryItemMovementCounts(ctx, tx, claims.OrganizationID, []string{current.itemID})
		if err != nil {
			return InventoryPostCycleCountOutput{}, err
		}
		movements := movementCounts[current.itemID]
		if movements != current.expectedMovementCount {
			return InventoryPostCycleCountOutput{}, fmt.Errorf(
				"stock for one of the counted items moved since the snapshot (%d movements since); start a fresh count",
				movements-current.expectedMovementCount)
		}
	}
	output := InventoryPostCycleCountOutput{Posted: true}
	countID := count.id
	shortID := countID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	for _, current := range lines {
		if current.counted == nil {
			continue
		}
		delta := *current.counted - current.expected
		if delta == 0 {
			continue
		}
		note := fmt.Sprintf("cycle count %s variance", shortID)
		if count.locationID != nil {
			note += " (bin-scoped)"
		}
		refType := "cycle_count"
		if _, err := inventoryApplyStockDelta(ctx, tx, claims.OrganizationID, current.itemID, delta,
			"adjustment", note, &refType, &countID, count.locationID, nil, claims.ActorType, claims.ActorID); err != nil {
			return InventoryPostCycleCountOutput{}, err
		}
		output.PostedVariances++
		output.NetVarianceThousandths += delta
	}
	if _, err := tx.Exec(ctx, `
		UPDATE cycle_counts SET status = 'posted', posted_at = $3
		WHERE org_id = $1::uuid AND id = $2::uuid`, claims.OrganizationID, count.id, now); err != nil {
		return InventoryPostCycleCountOutput{}, err
	}
	return output, nil
}

func inventoryCancelCycleCount(ctx context.Context, tx pgx.Tx, orgID string, input InventoryCancelCycleCountInput, now time.Time) (InventoryCancelCycleCountOutput, error) {
	count, err := inventoryLoadCycleCount(ctx, tx, orgID, input.CountID)
	if err != nil {
		return InventoryCancelCycleCountOutput{}, err
	}
	if count.status != "open" {
		return InventoryCancelCycleCountOutput{}, fmt.Errorf("cycle count is %s; only open counts can be cancelled", count.status)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE cycle_counts SET status = 'cancelled', cancelled_at = $3
		WHERE org_id = $1::uuid AND id = $2::uuid`, orgID, count.id, now); err != nil {
		return InventoryCancelCycleCountOutput{}, err
	}
	return InventoryCancelCycleCountOutput{Cancelled: true}, nil
}
