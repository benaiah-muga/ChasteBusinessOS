package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const createPurchaseOrderCapabilityID = "purchasing.createPurchaseOrder"

const maxPurchaseOrderJavaScriptInteger int64 = 1<<53 - 1

var purchaseOrderAccountPattern = regexp.MustCompile(`^[0-9]{4}$`)

type CreatePurchaseOrderLineInput struct {
	Description        string  `json:"description"`
	Quantity           int64   `json:"quantity"`
	UnitPriceMinor     int64   `json:"unitPriceMinor"`
	ExpenseAccountCode string  `json:"expenseAccountCode"`
	SKU                *string `json:"sku,omitempty"`
}

type CreatePurchaseOrderInput struct {
	VendorID   string                         `json:"vendorId"`
	Memo       *string                        `json:"memo,omitempty"`
	PromisedAt *string                        `json:"promisedAt,omitempty"`
	Lines      []CreatePurchaseOrderLineInput `json:"lines"`
}

type CreatePurchaseOrderOutput struct {
	PONumber int64 `json:"poNumber"`
}

func ParseCreatePurchaseOrderInput(raw json.RawMessage) (CreatePurchaseOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatePurchaseOrderInput{}, err
	}
	var input CreatePurchaseOrderInput
	if err := json.Unmarshal(fields["vendorId"], &input.VendorID); err != nil || input.VendorID == "" {
		return input, errors.New("vendorId is required")
	}
	if rawMemo, ok := fields["memo"]; ok {
		if err := json.Unmarshal(rawMemo, &input.Memo); err != nil || input.Memo == nil {
			return input, errors.New("memo must be a string")
		}
	}
	if rawPromisedAt, ok := fields["promisedAt"]; ok {
		var value string
		if err := json.Unmarshal(rawPromisedAt, &value); err != nil {
			return input, errors.New("promisedAt must be a datetime")
		}
		if !strings.HasSuffix(value, "Z") {
			return input, errors.New("promisedAt must be a datetime")
		}
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			return input, errors.New("promisedAt must be a datetime")
		}
		input.PromisedAt = &value
	}
	rawLines, ok := fields["lines"]
	if !ok || json.Unmarshal(rawLines, &[]json.RawMessage{}) != nil {
		return input, errors.New("lines must be an array")
	}
	var lineFields []json.RawMessage
	if err := json.Unmarshal(rawLines, &lineFields); err != nil || len(lineFields) == 0 {
		return input, errors.New("lines must contain at least one line")
	}
	input.Lines = make([]CreatePurchaseOrderLineInput, 0, len(lineFields))
	for index, rawLine := range lineFields {
		fields, err := decodeJSONObject(rawLine)
		if err != nil {
			return input, fmt.Errorf("line %d: %w", index+1, err)
		}
		var line CreatePurchaseOrderLineInput
		if err := json.Unmarshal(fields["description"], &line.Description); err != nil || line.Description == "" {
			return input, fmt.Errorf("line %d: description is required", index+1)
		}
		if err := json.Unmarshal(fields["quantity"], &line.Quantity); err != nil || line.Quantity <= 0 || line.Quantity > maxPurchaseOrderJavaScriptInteger {
			return input, fmt.Errorf("line %d: quantity must be a positive integer", index+1)
		}
		if err := json.Unmarshal(fields["unitPriceMinor"], &line.UnitPriceMinor); err != nil || line.UnitPriceMinor < 0 || line.UnitPriceMinor > maxPurchaseOrderJavaScriptInteger {
			return input, fmt.Errorf("line %d: unitPriceMinor must be a nonnegative integer", index+1)
		}
		line.ExpenseAccountCode = "6000"
		if rawCode, ok := fields["expenseAccountCode"]; ok {
			if err := json.Unmarshal(rawCode, &line.ExpenseAccountCode); err != nil || !purchaseOrderAccountPattern.MatchString(line.ExpenseAccountCode) {
				return input, fmt.Errorf("line %d: expenseAccountCode must be a four digit account code", index+1)
			}
		}
		if rawSKU, ok := fields["sku"]; ok {
			if strings.TrimSpace(string(rawSKU)) == "null" {
				return input, fmt.Errorf("line %d: sku must be a string", index+1)
			}
			var sku string
			if err := json.Unmarshal(rawSKU, &sku); err != nil {
				return input, fmt.Errorf("line %d: sku must be a string", index+1)
			}
			line.SKU = &sku
		}
		input.Lines = append(input.Lines, line)
	}
	return input, nil
}

func createPurchaseOrder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreatePurchaseOrderInput, now time.Time) (CreatePurchaseOrderOutput, error) {
	orgID := claims.OrganizationID
	var vendorID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM vendors WHERE id = $1::uuid AND org_id = $2::uuid`, input.VendorID, orgID).Scan(&vendorID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CreatePurchaseOrderOutput{}, errors.New("vendor not found")
		}
		return CreatePurchaseOrderOutput{}, err
	}
	number, err := nextPurchaseOrderNumber(ctx, tx, orgID)
	if err != nil {
		return CreatePurchaseOrderOutput{}, err
	}
	if number <= 0 || number > 1<<31-1 {
		return CreatePurchaseOrderOutput{}, errors.New("purchase order number exceeds the database integer range")
	}

	itemIDs := make(map[string]string)
	skus := make([]string, 0, len(input.Lines))
	seenSKUs := make(map[string]bool)
	for _, line := range input.Lines {
		if line.SKU != nil && *line.SKU != "" && !seenSKUs[*line.SKU] {
			seenSKUs[*line.SKU] = true
			skus = append(skus, *line.SKU)
		}
	}
	if len(skus) > 0 {
		rows, err := tx.Query(ctx, `SELECT id::text, sku FROM items WHERE org_id = $1::uuid AND sku = ANY($2::text[])`, orgID, skus)
		if err != nil {
			return CreatePurchaseOrderOutput{}, err
		}
		for rows.Next() {
			var id, sku string
			if err := rows.Scan(&id, &sku); err != nil {
				rows.Close()
				return CreatePurchaseOrderOutput{}, err
			}
			itemIDs[sku] = id
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return CreatePurchaseOrderOutput{}, err
		}
		rows.Close()
	}

	var promisedAt *time.Time
	if input.PromisedAt != nil {
		parsed, err := time.Parse(time.RFC3339Nano, *input.PromisedAt)
		if err != nil {
			return CreatePurchaseOrderOutput{}, errors.New("promisedAt must be a datetime")
		}
		value := parsed.UTC().Truncate(time.Millisecond)
		promisedAt = &value
	}
	var poID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, memo, ordered_at, promised_at)
		VALUES ($1::uuid, $2::uuid, $3, 'ordered', $4, $5, $6)
		RETURNING id::text`, orgID, vendorID, number, input.Memo, now.UTC().Truncate(time.Millisecond), promisedAt).Scan(&poID); err != nil {
		return CreatePurchaseOrderOutput{}, err
	}
	for index, line := range input.Lines {
		var itemID *string
		if line.SKU != nil && *line.SKU != "" {
			if id, ok := itemIDs[*line.SKU]; ok {
				itemID = &id
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, expense_account_code, item_id, position)
			VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7)`,
			poID, line.Description, line.Quantity, line.UnitPriceMinor, line.ExpenseAccountCode, itemID, index+1); err != nil {
			return CreatePurchaseOrderOutput{}, err
		}
	}
	return CreatePurchaseOrderOutput{PONumber: number}, nil
}

func nextPurchaseOrderNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		SELECT $1::uuid, 'purchase_order', COALESCE(MAX(number), 0) + 1 FROM purchase_orders WHERE org_id = $1::uuid
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate purchase order number: %w", err)
	}
	return number, nil
}
