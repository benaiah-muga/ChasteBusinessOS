package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	purchasingSupplierPerformanceCapabilityID = "purchasing.supplierPerformance"
	purchasingPriceHistoryCapabilityID        = "purchasing.priceHistory"
	purchasingSupplierStatementCapabilityID   = "purchasing.supplierStatement"
)

type PurchasingSupplierPerformanceInput struct{}

type PurchasingSupplierPerformanceVendor struct {
	VendorID          string   `json:"vendorId"`
	VendorName        string   `json:"vendorName"`
	Orders            int      `json:"orders"`
	AvgLeadTimeDays   *float64 `json:"avgLeadTimeDays"`
	OnTimeRate        *int64   `json:"onTimeRate"`
	FillRate          *int64   `json:"fillRate"`
	BackorderedOrders int64    `json:"backorderedOrders"`
}

type PurchasingSupplierPerformanceOutput struct {
	Vendors []PurchasingSupplierPerformanceVendor `json:"vendors"`
}

type PurchasingPriceHistoryInput struct {
	SKU *string `json:"sku"`
}

type PurchasingPriceHistoryRow struct {
	VendorName      string  `json:"vendorName"`
	ItemSKU         *string `json:"itemSku"`
	ItemDescription string  `json:"itemDescription"`
	UnitPriceMinor  int64   `json:"unitPriceMinor"`
	OrderedAt       *string `json:"orderedAt"`
}

type PurchasingPriceHistoryOutput struct {
	Rows []PurchasingPriceHistoryRow `json:"rows"`
}

type PurchasingSupplierStatementInput struct {
	VendorID string `json:"vendorId"`
}

type PurchasingSupplierStatementRow struct {
	Date         string `json:"date"`
	Kind         string `json:"kind"`
	Ref          string `json:"ref"`
	AmountMinor  int64  `json:"amountMinor"`
	BalanceMinor int64  `json:"balanceMinor"`
}

type PurchasingSupplierStatementOutput struct {
	ClosingBalanceMinor int64                            `json:"closingBalanceMinor"`
	Rows                []PurchasingSupplierStatementRow `json:"rows"`
}

func ParsePurchasingSupplierPerformanceInput(raw json.RawMessage) (PurchasingSupplierPerformanceInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return PurchasingSupplierPerformanceInput{}, err
	}
	return PurchasingSupplierPerformanceInput{}, nil
}

func ParsePurchasingPriceHistoryInput(raw json.RawMessage) (PurchasingPriceHistoryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PurchasingPriceHistoryInput{}, err
	}
	var input PurchasingPriceHistoryInput
	if rawSKU, ok := fields["sku"]; ok && string(rawSKU) != "null" {
		var sku string
		if err := json.Unmarshal(rawSKU, &sku); err != nil {
			return PurchasingPriceHistoryInput{}, errors.New("sku must be a string")
		}
		input.SKU = &sku
	}
	return input, nil
}

func ParsePurchasingSupplierStatementInput(raw json.RawMessage) (PurchasingSupplierStatementInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PurchasingSupplierStatementInput{}, err
	}
	var input PurchasingSupplierStatementInput
	if input.VendorID, err = projectRequiredUUID(fields, "vendorId"); err != nil {
		return PurchasingSupplierStatementInput{}, err
	}
	return input, nil
}

func parsePurchasingReadsInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case purchasingSupplierPerformanceCapabilityID:
		return ParsePurchasingSupplierPerformanceInput(raw)
	case purchasingPriceHistoryCapabilityID:
		return ParsePurchasingPriceHistoryInput(raw)
	case purchasingSupplierStatementCapabilityID:
		return ParsePurchasingSupplierStatementInput(raw)
	default:
		return nil, errors.New("unsupported purchasing read capability")
	}
}

func purchasingAcceptedMinusReturnedForLine(ctx context.Context, tx pgx.Tx, poLineID string) (int64, error) {
	var net int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(accepted_thousandths), 0) - COALESCE(SUM(returned_thousandths), 0)
		FROM goods_receipt_lines WHERE po_line_id=$1::uuid`, poLineID).Scan(&net)
	if err != nil {
		return 0, err
	}
	var legacy int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity_delta), 0)
		FROM stock_movements WHERE ref_type='po_line' AND ref_id=$1::uuid`, poLineID).Scan(&legacy); err != nil {
		return 0, err
	}
	return net + legacy, nil
}

func purchasingFirstReceiptAt(ctx context.Context, tx pgx.Tx, orgID, poID string) (*time.Time, error) {
	var firstAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT min(received_at) FROM goods_receipts WHERE org_id=$1::uuid AND po_id=$2::uuid`, orgID, poID).Scan(&firstAt)
	return firstAt, err
}

func purchasingFirstLegacyMovementAt(ctx context.Context, tx pgx.Tx, poLineID string) (*time.Time, error) {
	var firstAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT created_at FROM stock_movements WHERE ref_type='po_line' AND ref_id=$1::uuid
		ORDER BY created_at ASC LIMIT 1`, poLineID).Scan(&firstAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return firstAt, err
}

func purchasingSupplierPerformance(ctx context.Context, tx pgx.Tx, orgID string, input PurchasingSupplierPerformanceInput) (PurchasingSupplierPerformanceOutput, error) {
	vendorRows, err := tx.Query(ctx, `SELECT id::text, name FROM vendors WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return PurchasingSupplierPerformanceOutput{}, err
	}
	type vendorRow struct {
		id   string
		name string
	}
	var vendors []vendorRow
	for vendorRows.Next() {
		var vendor vendorRow
		if err := vendorRows.Scan(&vendor.id, &vendor.name); err != nil {
			vendorRows.Close()
			return PurchasingSupplierPerformanceOutput{}, err
		}
		vendors = append(vendors, vendor)
	}
	if err := vendorRows.Err(); err != nil {
		vendorRows.Close()
		return PurchasingSupplierPerformanceOutput{}, err
	}
	vendorRows.Close()

	out := PurchasingSupplierPerformanceOutput{Vendors: []PurchasingSupplierPerformanceVendor{}}
	for _, vendor := range vendors {
		poRows, err := tx.Query(ctx, `
			SELECT id::text, backordered, ordered_at, promised_at FROM purchase_orders
			WHERE org_id=$1::uuid AND vendor_id=$2::uuid AND status <> 'void'`, orgID, vendor.id)
		if err != nil {
			return PurchasingSupplierPerformanceOutput{}, err
		}
		type poRow struct {
			id          string
			backordered bool
			orderedAt   *time.Time
			promisedAt  *time.Time
		}
		var orders []poRow
		for poRows.Next() {
			var order poRow
			if err := poRows.Scan(&order.id, &order.backordered, &order.orderedAt, &order.promisedAt); err != nil {
				poRows.Close()
				return PurchasingSupplierPerformanceOutput{}, err
			}
			orders = append(orders, order)
		}
		if err := poRows.Err(); err != nil {
			poRows.Close()
			return PurchasingSupplierPerformanceOutput{}, err
		}
		poRows.Close()

		var live []poRow
		for _, order := range orders {
			if order.orderedAt == nil {
				continue
			}
			live = append(live, order)
		}

		var leadSum float64
		var leadCount int
		var onTime, promised int64
		var orderedTotal, receivedTotal int64
		var backordered int64
		for _, order := range live {
			if order.backordered {
				backordered++
			}
			lineRows, err := tx.Query(ctx, `
				SELECT id::text, item_id, quantity, COALESCE(service_accepted_thousandths, 0)
				FROM po_lines WHERE po_id=$1::uuid ORDER BY id`, order.id)
			if err != nil {
				return PurchasingSupplierPerformanceOutput{}, err
			}
			type poLineRow struct {
				id                         string
				itemID                     *string
				quantity                   int64
				serviceAcceptedThousandths int64
			}
			var lines []poLineRow
			for lineRows.Next() {
				var line poLineRow
				if err := lineRows.Scan(&line.id, &line.itemID, &line.quantity, &line.serviceAcceptedThousandths); err != nil {
					lineRows.Close()
					return PurchasingSupplierPerformanceOutput{}, err
				}
				lines = append(lines, line)
			}
			if err := lineRows.Err(); err != nil {
				lineRows.Close()
				return PurchasingSupplierPerformanceOutput{}, err
			}
			lineRows.Close()

			for _, line := range lines {
				orderedTotal += line.quantity
				net, err := purchasingAcceptedMinusReturnedForLine(ctx, tx, line.id)
				if err != nil {
					return PurchasingSupplierPerformanceOutput{}, err
				}
				received := net
				if received < 0 {
					received = 0
				}
				if received > line.quantity {
					received = line.quantity
				}
				receivedTotal += received
			}

			firstAt, err := purchasingFirstReceiptAt(ctx, tx, orgID, order.id)
			if err != nil {
				return PurchasingSupplierPerformanceOutput{}, err
			}
			if firstAt == nil && len(lines) > 0 {
				firstAt, err = purchasingFirstLegacyMovementAt(ctx, tx, lines[0].id)
				if err != nil {
					return PurchasingSupplierPerformanceOutput{}, err
				}
			}
			touched := false
			for _, line := range lines {
				if line.itemID != nil {
					touched = true
					break
				}
			}
			if !touched {
				for _, line := range lines {
					if line.serviceAcceptedThousandths > 0 {
						touched = true
						break
					}
				}
			}
			if firstAt != nil && order.orderedAt != nil && touched {
				leadDays := firstAt.Sub(*order.orderedAt).Hours() / 24
				if leadDays < 0 {
					leadDays = 0
				}
				leadSum += leadDays
				leadCount++
				if order.promisedAt != nil {
					promised++
					if !firstAt.After(*order.promisedAt) {
						onTime++
					}
				}
			}
		}

		entry := PurchasingSupplierPerformanceVendor{
			VendorID: vendor.id, VendorName: vendor.name,
			Orders: len(live), BackorderedOrders: backordered,
		}
		if leadCount > 0 {
			rounded := float64(int64((leadSum/float64(leadCount))*10+0.5)) / 10
			entry.AvgLeadTimeDays = &rounded
		}
		if promised > 0 {
			rate := int64((float64(onTime)/float64(promised))*100 + 0.5)
			entry.OnTimeRate = &rate
		}
		if orderedTotal > 0 {
			capped := receivedTotal
			if capped > orderedTotal {
				capped = orderedTotal
			}
			rate := int64((float64(capped)/float64(orderedTotal))*100 + 0.5)
			entry.FillRate = &rate
		}
		out.Vendors = append(out.Vendors, entry)
	}
	return out, nil
}

func purchasingPriceHistory(ctx context.Context, tx pgx.Tx, orgID string, input PurchasingPriceHistoryInput) (PurchasingPriceHistoryOutput, error) {
	var rows []PurchasingPriceHistoryRow
	var err error
	if input.SKU != nil {
		rows, err = purchasingPriceHistoryQuery(ctx, tx, orgID, true, *input.SKU)
	} else {
		rows, err = purchasingPriceHistoryQuery(ctx, tx, orgID, false, "")
	}
	if err != nil {
		return PurchasingPriceHistoryOutput{}, err
	}
	return PurchasingPriceHistoryOutput{Rows: rows}, nil
}

func purchasingPriceHistoryQuery(ctx context.Context, tx pgx.Tx, orgID string, filterBySKU bool, sku string) ([]PurchasingPriceHistoryRow, error) {
	query := `
		SELECT vendors.name, items.sku, po_lines.description, po_lines.unit_price_minor, purchase_orders.ordered_at
		FROM po_lines
		INNER JOIN purchase_orders ON po_lines.po_id = purchase_orders.id
		INNER JOIN vendors ON purchase_orders.vendor_id = vendors.id
		LEFT JOIN items ON po_lines.item_id = items.id
		WHERE purchase_orders.org_id=$1::uuid`
	args := []any{orgID}
	if filterBySKU {
		query += ` AND items.sku=$2`
		args = append(args, sku)
	}
	query += ` ORDER BY purchase_orders.ordered_at DESC LIMIT 300`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PurchasingPriceHistoryRow{}
	for rows.Next() {
		var row PurchasingPriceHistoryRow
		var orderedAt *time.Time
		if err := rows.Scan(&row.VendorName, &row.ItemSKU, &row.ItemDescription, &row.UnitPriceMinor, &orderedAt); err != nil {
			return nil, err
		}
		if orderedAt != nil {
			formatted := orderedAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
			row.OrderedAt = &formatted
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func purchasingSupplierStatement(ctx context.Context, tx pgx.Tx, orgID string, input PurchasingSupplierStatementInput) (PurchasingSupplierStatementOutput, error) {
	billRows, err := tx.Query(ctx, `
		SELECT id::text, number, total_minor, bill_date, created_at, voided_at
		FROM vendor_bills WHERE org_id=$1::uuid AND vendor_id=$2::uuid`, orgID, input.VendorID)
	if err != nil {
		return PurchasingSupplierStatementOutput{}, err
	}
	type billRow struct {
		id         string
		number     int64
		totalMinor int64
		date       time.Time
		voidedAt   *time.Time
	}
	var bills []billRow
	for billRows.Next() {
		var bill billRow
		var billDate, createdAt *time.Time
		if err := billRows.Scan(&bill.id, &bill.number, &bill.totalMinor, &billDate, &createdAt, &bill.voidedAt); err != nil {
			billRows.Close()
			return PurchasingSupplierStatementOutput{}, err
		}
		if createdAt != nil {
			bill.date = *createdAt
		}
		if billDate != nil {
			bill.date = *billDate
		}
		bills = append(bills, bill)
	}
	if err := billRows.Err(); err != nil {
		billRows.Close()
		return PurchasingSupplierStatementOutput{}, err
	}
	billRows.Close()

	type statementRow struct {
		date        time.Time
		kind        string
		ref         string
		amountMinor int64
	}
	var rows []statementRow
	liveBills := map[string]billRow{}
	for _, bill := range bills {
		if bill.voidedAt != nil {
			continue
		}
		liveBills[bill.id] = bill
		rows = append(rows, statementRow{
			date: bill.date, kind: "bill",
			ref: fmt.Sprintf("Bill #%d", bill.number), amountMinor: bill.totalMinor,
		})
	}
	for _, bill := range bills {
		if bill.voidedAt != nil {
			continue
		}
		creditRows, err := tx.Query(ctx, `
			SELECT journal_entries.posted_at, journal_lines.debit_minor, journal_lines.credit_minor
			FROM journal_entries
			INNER JOIN journal_lines ON journal_lines.entry_id = journal_entries.id
			INNER JOIN accounts ON accounts.id = journal_lines.account_id
			WHERE journal_entries.org_id=$1::uuid AND journal_entries.source_type='vendor_credit_note'
			  AND accounts.code='2000' AND journal_entries.source_id=$2::uuid`,
			orgID, bill.id)
		if err != nil {
			return PurchasingSupplierStatementOutput{}, err
		}
		for creditRows.Next() {
			var postedAt time.Time
			var debit, credit int64
			if err := creditRows.Scan(&postedAt, &debit, &credit); err != nil {
				creditRows.Close()
				return PurchasingSupplierStatementOutput{}, err
			}
			rows = append(rows, statementRow{
				date: postedAt, kind: "credit_note",
				ref:         fmt.Sprintf("Credit on bill #%d", bill.number),
				amountMinor: -(debit - credit),
			})
		}
		if err := creditRows.Err(); err != nil {
			creditRows.Close()
			return PurchasingSupplierStatementOutput{}, err
		}
		creditRows.Close()
	}

	paymentRows, err := tx.Query(ctx, `
		SELECT vendor_payments.bill_id::text, vendor_payments.amount_minor, vendor_payments.paid_at
		FROM vendor_payments WHERE org_id=$1::uuid`, orgID)
	if err != nil {
		return PurchasingSupplierStatementOutput{}, err
	}
	for paymentRows.Next() {
		var billID string
		var amount int64
		var paidAt *time.Time
		if err := paymentRows.Scan(&billID, &amount, &paidAt); err != nil {
			paymentRows.Close()
			return PurchasingSupplierStatementOutput{}, err
		}
		if _, ok := liveBills[billID]; !ok {
			continue
		}
		if paidAt == nil {
			continue
		}
		rows = append(rows, statementRow{date: *paidAt, kind: "payment", ref: "Payment sent", amountMinor: -amount})
	}
	if err := paymentRows.Err(); err != nil {
		paymentRows.Close()
		return PurchasingSupplierStatementOutput{}, err
	}
	paymentRows.Close()

	sort.SliceStable(rows, func(i, j int) bool {
		if !rows[i].date.Equal(rows[j].date) {
			return rows[i].date.Before(rows[j].date)
		}
		return rows[i].kind < rows[j].kind
	})
	out := PurchasingSupplierStatementOutput{Rows: []PurchasingSupplierStatementRow{}}
	var running int64
	for _, row := range rows {
		running += row.amountMinor
		out.Rows = append(out.Rows, PurchasingSupplierStatementRow{
			Date: row.date.UTC().Format("2006-01-02T15:04:05.000Z07:00"), Kind: row.kind,
			Ref: row.ref, AmountMinor: row.amountMinor, BalanceMinor: running,
		})
	}
	out.ClosingBalanceMinor = running
	return out, nil
}
