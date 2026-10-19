package capability

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const purchasingGetPurchaseOrderCapabilityID = "purchasing.getPurchaseOrder"

type PurchasingGetPurchaseOrderInput struct {
	PONumber int64 `json:"poNumber"`
}

type PurchasingPurchaseOrderLine struct {
	LineNumber           int64  `json:"lineNumber"`
	Description          string `json:"description"`
	Quantity             int64  `json:"quantity"`
	UnitPriceMinor       int64  `json:"unitPriceMinor"`
	LineTotalMinor       int64  `json:"lineTotalMinor"`
	AcceptedThousandths  int64  `json:"acceptedThousandths"`
	RejectedThousandths  int64  `json:"rejectedThousandths"`
	ReturnedThousandths  int64  `json:"returnedThousandths"`
	RemainingThousandths int64  `json:"remainingThousandths"`
}

type PurchasingPurchaseOrderOutput struct {
	PONumber      int64                         `json:"poNumber"`
	VendorID      string                        `json:"vendorId"`
	VendorName    string                        `json:"vendorName"`
	Status        string                        `json:"status"`
	Memo          *string                       `json:"memo"`
	OrderedAt     *string                       `json:"orderedAt"`
	PromisedAt    *string                       `json:"promisedAt"`
	TotalMinor    int64                         `json:"totalMinor"`
	Lines         []PurchasingPurchaseOrderLine `json:"lines"`
	Receipts      []LifecycleReceipt            `json:"receipts"`
	FullyReceived bool                          `json:"fullyReceived"`
	Backordered   bool                          `json:"backordered"`
}

func ParsePurchasingGetPurchaseOrderInput(raw json.RawMessage) (PurchasingGetPurchaseOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PurchasingGetPurchaseOrderInput{}, err
	}
	for key := range fields {
		if key != "poNumber" {
			return PurchasingGetPurchaseOrderInput{}, errors.New("unsupported purchasing.getPurchaseOrder argument")
		}
	}
	number, err := requiredSafeInteger(fields, "poNumber")
	if err != nil || number <= 0 || number > maxDatabaseInteger {
		return PurchasingGetPurchaseOrderInput{}, errors.New("poNumber must be a positive integer")
	}
	return PurchasingGetPurchaseOrderInput{PONumber: number}, nil
}

func purchasingGetPurchaseOrder(ctx context.Context, tx pgx.Tx, orgID string, input PurchasingGetPurchaseOrderInput) (PurchasingPurchaseOrderOutput, error) {
	var output PurchasingPurchaseOrderOutput
	var poID string
	var orderedAt, promisedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT po.id::text, po.number, po.vendor_id::text, v.name, po.status, po.memo,
		       po.ordered_at, po.promised_at, po.backordered
		FROM purchase_orders po
		JOIN vendors v ON v.id = po.vendor_id AND v.org_id = po.org_id
		WHERE po.org_id = $1::uuid AND po.number = $2
		LIMIT 1`, orgID, input.PONumber).Scan(
		&poID, &output.PONumber, &output.VendorID, &output.VendorName, &output.Status,
		&output.Memo, &orderedAt, &promisedAt, &output.Backordered,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PurchasingPurchaseOrderOutput{}, errors.New("purchase order not found")
		}
		return PurchasingPurchaseOrderOutput{}, err
	}
	if orderedAt != nil {
		value := paymentRunsTimestamp(*orderedAt)
		output.OrderedAt = &value
	}
	if promisedAt != nil {
		value := paymentRunsTimestamp(*promisedAt)
		output.PromisedAt = &value
	}

	receipts, err := listReceipts(ctx, tx, orgID, ListReceiptsInput{PONumber: input.PONumber})
	if err != nil {
		return PurchasingPurchaseOrderOutput{}, err
	}
	lifecycleByPosition := make(map[int64]LifecycleOrderLine, len(receipts.OrderLines))
	for _, line := range receipts.OrderLines {
		lifecycleByPosition[line.Position] = line
	}
	output.Receipts = receipts.Receipts

	rows, err := tx.Query(ctx, `
		SELECT position, description, quantity, unit_price_minor, item_id::text, COALESCE(service_accepted_thousandths, 0)
		FROM po_lines
		WHERE po_id = $1::uuid
		ORDER BY position`, poID)
	if err != nil {
		return PurchasingPurchaseOrderOutput{}, err
	}
	defer rows.Close()
	output.Lines = make([]PurchasingPurchaseOrderLine, 0, 8)
	output.FullyReceived = true
	for rows.Next() {
		var line PurchasingPurchaseOrderLine
		var itemID *string
		var serviceAccepted int64
		if err := rows.Scan(&line.LineNumber, &line.Description, &line.Quantity, &line.UnitPriceMinor, &itemID, &serviceAccepted); err != nil {
			return PurchasingPurchaseOrderOutput{}, err
		}
		line.LineTotalMinor, err = inventoryJsRoundProductDiv(line.Quantity, line.UnitPriceMinor, 1000)
		if err != nil {
			return PurchasingPurchaseOrderOutput{}, err
		}
		output.TotalMinor, err = inventoryAddSafeIntegers(output.TotalMinor, line.LineTotalMinor)
		if err != nil {
			return PurchasingPurchaseOrderOutput{}, err
		}
		if itemID == nil {
			// Service lines carry acceptance on the order line itself, not in
			// goods receipts, and the close check reads the same column.
			line.AcceptedThousandths = serviceAccepted
			line.RemainingThousandths = line.Quantity - serviceAccepted
			if line.RemainingThousandths < 0 {
				line.RemainingThousandths = 0
			}
		} else if lifecycle, ok := lifecycleByPosition[line.LineNumber]; ok {
			line.AcceptedThousandths = lifecycle.AcceptedThousandths
			line.RejectedThousandths = lifecycle.RejectedThousandths
			line.ReturnedThousandths = lifecycle.ReturnedThousandths
			// Match the purchasing close check: returns reopen the supplier
			// obligation, while rejected goods count as delivered but unusable.
			line.RemainingThousandths = line.Quantity - (lifecycle.AcceptedThousandths - lifecycle.ReturnedThousandths + lifecycle.RejectedThousandths)
			if line.RemainingThousandths < 0 {
				line.RemainingThousandths = 0
			}
		}
		if line.RemainingThousandths > 0 {
			output.FullyReceived = false
		}
		output.Lines = append(output.Lines, line)
	}
	if err := rows.Err(); err != nil {
		return PurchasingPurchaseOrderOutput{}, err
	}
	if len(output.Lines) == 0 {
		output.FullyReceived = false
	}
	return output, nil
}
