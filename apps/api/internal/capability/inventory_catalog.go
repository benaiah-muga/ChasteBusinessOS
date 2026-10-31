package capability

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

const inventoryListItemMetadataCapabilityID = "inventory.listItemMetadata"

type InventoryListItemMetadataInput struct{}

type InventoryItemMetadataRow struct {
	ID             string  `json:"id"`
	SKU            string  `json:"sku"`
	Kind           string  `json:"kind"`
	UnitLabel      string  `json:"unitLabel"`
	SalePriceMinor int64   `json:"salePriceMinor"`
	Barcode        *string `json:"barcode"`
}

type InventoryListItemMetadataOutput struct {
	Items []InventoryItemMetadataRow `json:"items"`
}

func ParseInventoryListItemMetadataInput(raw json.RawMessage) (InventoryListItemMetadataInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return InventoryListItemMetadataInput{}, err
	}
	return InventoryListItemMetadataInput{}, nil
}

func inventoryListItemMetadata(ctx context.Context, tx pgx.Tx, orgID string, input InventoryListItemMetadataInput) (InventoryListItemMetadataOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, sku, kind, unit_label, sale_price_minor, barcode
		FROM items WHERE org_id = $1::uuid ORDER BY sku ASC`, orgID)
	if err != nil {
		return InventoryListItemMetadataOutput{}, err
	}
	defer rows.Close()
	items := make([]InventoryItemMetadataRow, 0)
	for rows.Next() {
		var item InventoryItemMetadataRow
		if err := rows.Scan(&item.ID, &item.SKU, &item.Kind, &item.UnitLabel, &item.SalePriceMinor, &item.Barcode); err != nil {
			return InventoryListItemMetadataOutput{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return InventoryListItemMetadataOutput{}, err
	}
	return InventoryListItemMetadataOutput{Items: items}, nil
}
