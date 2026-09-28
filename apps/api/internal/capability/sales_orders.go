package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	salesCreateOrderCapabilityID  = "sales.createOrder"
	salesConfirmOrderCapabilityID = "sales.confirmOrder"
	salesDeliverOrderCapabilityID = "sales.deliverOrder"
	salesCancelOrderCapabilityID  = "sales.cancelOrder"
	salesListOrdersCapabilityID   = "sales.listOrders"
)

var salesOrderStatusValues = []string{"draft", "confirmed", "delivered", "cancelled"}

type SalesOrderLineInput struct {
	Description    string  `json:"description"`
	Quantity       int64   `json:"quantity"`
	UnitPriceMinor int64   `json:"unitPriceMinor"`
	TaxMinor       *int64  `json:"taxMinor,omitempty"`
	SKU            *string `json:"sku,omitempty"`
}

type SalesCreateOrderInput struct {
	CustomerID string                `json:"customerId"`
	Note       *string               `json:"note,omitempty"`
	Lines      []SalesOrderLineInput `json:"lines"`
}

type SalesCreateOrderOutput struct {
	OrderID     string `json:"orderId"`
	OrderNumber int64  `json:"orderNumber"`
}

type SalesConfirmOrderInput struct {
	OrderID        string `json:"orderId"`
	AllowBackorder *bool  `json:"allowBackorder,omitempty"`
}

type SalesConfirmOrderOutput struct {
	Confirmed           bool  `json:"confirmed"`
	Backordered         bool  `json:"backordered"`
	ReservedThousandths int64 `json:"reservedThousandths"`
}

type SalesDeliverOrderLineInput struct {
	LineID              string `json:"lineId"`
	QuantityThousandths int64  `json:"quantityThousandths"`
}

type SalesDeliverOrderInput struct {
	OrderID string                        `json:"orderId"`
	Lines   *[]SalesDeliverOrderLineInput `json:"lines,omitempty"`
}

type SalesDeliverOrderOutput struct {
	InvoiceID         string `json:"invoiceId"`
	InvoiceNumber     int64  `json:"invoiceNumber"`
	InvoiceTotalMinor int64  `json:"invoiceTotalMinor"`
	OrderStatus       string `json:"orderStatus"`
}

type SalesCancelOrderInput struct {
	OrderID string `json:"orderId"`
}

type SalesCancelOrderOutput struct {
	Status              string `json:"status"`
	ReleasedThousandths int64  `json:"releasedThousandths"`
}

type SalesListOrdersInput struct {
	Status *string `json:"status,omitempty"`
}

type SalesListOrderItem struct {
	ID          string `json:"id"`
	Number      int64  `json:"number"`
	CustomerID  string `json:"customerId"`
	Status      string `json:"status"`
	Backordered bool   `json:"backordered"`
	TotalMinor  int64  `json:"totalMinor"`
	CreatedAt   string `json:"createdAt"`
}

type SalesListOrdersOutput struct {
	Orders []SalesListOrderItem `json:"orders"`
}

func parseSalesInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case salesCreateOrderCapabilityID:
		return ParseSalesCreateOrderInput(raw)
	case salesConfirmOrderCapabilityID:
		return ParseSalesConfirmOrderInput(raw)
	case salesDeliverOrderCapabilityID:
		return ParseSalesDeliverOrderInput(raw)
	case salesCancelOrderCapabilityID:
		return ParseSalesCancelOrderInput(raw)
	case salesListOrdersCapabilityID:
		return ParseSalesListOrdersInput(raw)
	default:
		return nil, errors.New("unsupported sales capability")
	}
}

func ParseSalesCreateOrderInput(raw json.RawMessage) (SalesCreateOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SalesCreateOrderInput{}, err
	}
	customerID, err := requiredCRMDealString(fields, "customerId", 0, 0)
	if err != nil {
		return SalesCreateOrderInput{}, err
	}
	if !isZodUUID(customerID) {
		return SalesCreateOrderInput{}, errors.New("customerId must be a UUID")
	}
	note, err := optionalCRMDealString(fields, "note", 0, false)
	if err != nil {
		return SalesCreateOrderInput{}, err
	}
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return SalesCreateOrderInput{}, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) == 0 {
		return SalesCreateOrderInput{}, errors.New("lines must contain at least one line")
	}
	lines, err := parseSalesOrderLines(lineValues)
	if err != nil {
		return SalesCreateOrderInput{}, err
	}
	return SalesCreateOrderInput{CustomerID: customerID, Note: note, Lines: lines}, nil
}

func parseSalesOrderLines(lineValues []json.RawMessage) ([]SalesOrderLineInput, error) {
	lines := make([]SalesOrderLineInput, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return nil, errors.New("each order line must be an object")
		}
		description, err := requiredCRMDealString(lineFields, "description", 1, 0)
		if err != nil {
			return nil, err
		}
		quantity, err := requiredSafeInteger(lineFields, "quantity")
		if err != nil || quantity <= 0 {
			return nil, errors.New("quantity must be a positive integer")
		}
		unitPriceMinor, err := requiredSafeInteger(lineFields, "unitPriceMinor")
		if err != nil || unitPriceMinor < 0 {
			return nil, errors.New("unitPriceMinor must be a non-negative integer")
		}
		taxMinor, err := optionalSafeInteger(lineFields, "taxMinor")
		if err != nil || taxMinor != nil && *taxMinor < 0 {
			return nil, errors.New("taxMinor must be a non-negative integer")
		}
		sku, err := optionalCRMDealString(lineFields, "sku", 0, false)
		if err != nil {
			return nil, err
		}
		lines = append(lines, SalesOrderLineInput{
			Description: description, Quantity: quantity, UnitPriceMinor: unitPriceMinor,
			TaxMinor: taxMinor, SKU: sku,
		})
	}
	return lines, nil
}

func ParseSalesConfirmOrderInput(raw json.RawMessage) (SalesConfirmOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SalesConfirmOrderInput{}, err
	}
	orderID, err := salesRequiredUUID(fields, "orderId")
	if err != nil {
		return SalesConfirmOrderInput{}, err
	}
	input := SalesConfirmOrderInput{OrderID: orderID}
	if rawAllow, ok := fields["allowBackorder"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawAllow), []byte("null")) {
			return SalesConfirmOrderInput{}, errors.New("allowBackorder must be a boolean")
		}
		var allow bool
		if err := json.Unmarshal(rawAllow, &allow); err != nil {
			return SalesConfirmOrderInput{}, errors.New("allowBackorder must be a boolean")
		}
		input.AllowBackorder = &allow
	}
	return input, nil
}

func ParseSalesDeliverOrderInput(raw json.RawMessage) (SalesDeliverOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SalesDeliverOrderInput{}, err
	}
	orderID, err := salesRequiredUUID(fields, "orderId")
	if err != nil {
		return SalesDeliverOrderInput{}, err
	}
	input := SalesDeliverOrderInput{OrderID: orderID}
	rawLines, ok := fields["lines"]
	if !ok {
		return input, nil
	}
	if bytes.Equal(bytes.TrimSpace(rawLines), []byte("null")) {
		return SalesDeliverOrderInput{}, errors.New("lines must be an array")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(rawLines, &lineValues); err != nil {
		return SalesDeliverOrderInput{}, errors.New("lines must be an array")
	}
	lines := make([]SalesDeliverOrderLineInput, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return SalesDeliverOrderInput{}, errors.New("each delivery line must be an object")
		}
		lineID, err := requiredCRMDealString(lineFields, "lineId", 0, 0)
		if err != nil {
			return SalesDeliverOrderInput{}, err
		}
		if !isZodUUID(lineID) {
			return SalesDeliverOrderInput{}, errors.New("lineId must be a UUID")
		}
		quantity, err := requiredSafeInteger(lineFields, "quantityThousandths")
		if err != nil || quantity <= 0 {
			return SalesDeliverOrderInput{}, errors.New("quantityThousandths must be a positive integer")
		}
		lines = append(lines, SalesDeliverOrderLineInput{LineID: lineID, QuantityThousandths: quantity})
	}
	input.Lines = &lines
	return input, nil
}

func ParseSalesCancelOrderInput(raw json.RawMessage) (SalesCancelOrderInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SalesCancelOrderInput{}, err
	}
	orderID, err := salesRequiredUUID(fields, "orderId")
	if err != nil {
		return SalesCancelOrderInput{}, err
	}
	return SalesCancelOrderInput{OrderID: orderID}, nil
}

func ParseSalesListOrdersInput(raw json.RawMessage) (SalesListOrdersInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SalesListOrdersInput{}, err
	}
	status, err := projectOptionalEnum(fields, "status", salesOrderStatusValues)
	if err != nil {
		return SalesListOrdersInput{}, err
	}
	return SalesListOrdersInput{Status: status}, nil
}

func salesRequiredUUID(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := requiredCRMDealString(fields, key, 0, 0)
	if err != nil {
		return "", err
	}
	if !isZodUUID(value) {
		return "", fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

type salesOrderRow struct {
	id          string
	number      int64
	customerID  string
	status      string
	backordered bool
}

type salesOrderLineRow struct {
	id             string
	itemID         *string
	description    string
	quantity       int64
	unitPriceMinor int64
	taxMinor       int64
	delivered      int64
	reserved       int64
}

func salesLoadOrder(ctx context.Context, tx pgx.Tx, orgID, orderID string) (*salesOrderRow, error) {
	var order salesOrderRow
	err := tx.QueryRow(ctx, `
		SELECT id::text, number, customer_id::text, status, backordered
		FROM sales_orders
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, orderID, orgID).Scan(&order.id, &order.number, &order.customerID, &order.status, &order.backordered)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &order, nil
}

func salesLoadOrderLines(ctx context.Context, tx pgx.Tx, orderID string) ([]salesOrderLineRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, item_id::text, description, quantity, unit_price_minor, tax_minor, delivered_thousandths, reserved_thousandths
		FROM sales_order_lines
		WHERE order_id = $1::uuid
		ORDER BY id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := make([]salesOrderLineRow, 0, 4)
	for rows.Next() {
		var line salesOrderLineRow
		if err := rows.Scan(&line.id, &line.itemID, &line.description, &line.quantity, &line.unitPriceMinor, &line.taxMinor, &line.delivered, &line.reserved); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

func salesNextOrderNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		SELECT $1::uuid, 'sales_order', COALESCE(MAX(number), 0) + 1 FROM sales_orders WHERE org_id = $1::uuid
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate sales order number: %w", err)
	}
	return number, nil
}

type salesOrderTotals struct {
	subtotalMinor int64
	taxMinor      int64
	totalMinor    int64
}

func salesComputeInvoiceTotals(lines []salesOrderLineRow) (salesOrderTotals, error) {
	var subtotal, tax big.Int
	for _, line := range lines {
		if line.quantity <= 0 || line.quantity > maxSafeInteger {
			return salesOrderTotals{}, errors.New("invalid quantity")
		}
		if line.unitPriceMinor < 0 || line.unitPriceMinor > maxSafeInteger {
			return salesOrderTotals{}, errors.New("invalid unit price")
		}
		if line.taxMinor < 0 || line.taxMinor > maxSafeInteger {
			return salesOrderTotals{}, errors.New("invalid tax")
		}
		numerator := new(big.Int).Mul(big.NewInt(line.quantity), big.NewInt(line.unitPriceMinor))
		numerator.Add(numerator, big.NewInt(500))
		subtotal.Add(&subtotal, numerator.Quo(numerator, big.NewInt(1000)))
		tax.Add(&tax, big.NewInt(line.taxMinor))
	}
	total := new(big.Int).Add(&subtotal, &tax)
	if total.Sign() <= 0 {
		return salesOrderTotals{}, errors.New("invoice must have a non-zero total")
	}
	safeMax := big.NewInt(maxSafeInteger)
	if subtotal.Cmp(safeMax) > 0 || tax.Cmp(safeMax) > 0 || total.Cmp(safeMax) > 0 {
		return salesOrderTotals{}, errors.New("invoice total exceeds the supported amount range")
	}
	return salesOrderTotals{subtotalMinor: subtotal.Int64(), taxMinor: tax.Int64(), totalMinor: total.Int64()}, nil
}

func salesOpenARMinor(ctx context.Context, tx pgx.Tx, orgID, customerID string) (int64, error) {
	var total int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(total_minor - paid_minor), 0) FROM invoices
		WHERE org_id = $1::uuid AND customer_id = $2::uuid AND status = 'sent' AND voided_at IS NULL`,
		orgID, customerID).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total, nil
}

func salesStockOnHand(ctx context.Context, tx pgx.Tx, orgID, itemID string) (int64, error) {
	var total int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances
		WHERE org_id = $1::uuid AND item_id = $2::uuid`, orgID, itemID).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total, nil
}

func salesOpenReserved(ctx context.Context, tx pgx.Tx, orgID, itemID string) (int64, error) {
	var total int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity_thousandths), 0) FROM stock_reservations
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND status = 'open'`, orgID, itemID).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total, nil
}

func salesItemKinds(ctx context.Context, tx pgx.Tx, orgID string, itemIDs []string, lock bool) (map[string]string, error) {
	kindByID := make(map[string]string, len(itemIDs))
	if len(itemIDs) == 0 {
		return kindByID, nil
	}
	query := `SELECT id::text, kind FROM items WHERE org_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id`
	if lock {
		query += ` FOR UPDATE`
	}
	rows, err := tx.Query(ctx, query, orgID, itemIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, kind string
		if err := rows.Scan(&id, &kind); err != nil {
			return nil, err
		}
		kindByID[id] = kind
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return kindByID, nil
}

func salesUniqueSortedIDs(values []*string) []string {
	seen := make(map[string]struct{}, len(values))
	ids := make([]string, 0, len(values))
	for _, value := range values {
		if value == nil {
			continue
		}
		if _, ok := seen[*value]; ok {
			continue
		}
		seen[*value] = struct{}{}
		ids = append(ids, *value)
	}
	sort.Strings(ids)
	return ids
}

func salesCreateOrder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SalesCreateOrderInput) (SalesCreateOrderOutput, error) {
	orgID := claims.OrganizationID
	var customerExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1::uuid AND org_id = $2::uuid)`,
		input.CustomerID, orgID).Scan(&customerExists); err != nil {
		return SalesCreateOrderOutput{}, err
	}
	if !customerExists {
		return SalesCreateOrderOutput{}, errors.New("customer not found")
	}
	type resolvedLine struct {
		itemID         *string
		description    string
		quantity       int64
		unitPriceMinor int64
		taxMinor       int64
	}
	resolved := make([]resolvedLine, 0, len(input.Lines))
	for _, line := range input.Lines {
		var itemID *string
		if line.SKU != nil {
			var id string
			err := tx.QueryRow(ctx, `
				SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
				orgID, *line.SKU).Scan(&id)
			if errors.Is(err, pgx.ErrNoRows) {
				return SalesCreateOrderOutput{}, fmt.Errorf("no item with sku %s", *line.SKU)
			}
			if err != nil {
				return SalesCreateOrderOutput{}, err
			}
			itemID = &id
		}
		taxMinor := int64(0)
		if line.TaxMinor != nil {
			taxMinor = *line.TaxMinor
		}
		resolved = append(resolved, resolvedLine{
			itemID: itemID, description: line.Description, quantity: line.Quantity,
			unitPriceMinor: line.UnitPriceMinor, taxMinor: taxMinor,
		})
	}
	number, err := salesNextOrderNumber(ctx, tx, orgID)
	if err != nil {
		return SalesCreateOrderOutput{}, err
	}
	var orderID string
	err = tx.QueryRow(ctx, `
		INSERT INTO sales_orders (org_id, number, customer_id, status, note, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3::uuid, 'draft', $4, $5, $6::uuid)
		RETURNING id::text`, orgID, number, input.CustomerID, input.Note, claims.ActorType, claims.ActorID).Scan(&orderID)
	if err != nil {
		return SalesCreateOrderOutput{}, err
	}
	for _, line := range resolved {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sales_order_lines (org_id, order_id, description, quantity, unit_price_minor, tax_minor, item_id)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)`,
			orgID, orderID, line.description, line.quantity, line.unitPriceMinor, line.taxMinor, line.itemID); err != nil {
			return SalesCreateOrderOutput{}, err
		}
	}
	return SalesCreateOrderOutput{OrderID: orderID, OrderNumber: number}, nil
}

func salesConfirmOrder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SalesConfirmOrderInput, now time.Time) (SalesConfirmOrderOutput, error) {
	orgID := claims.OrganizationID
	order, err := salesLoadOrder(ctx, tx, orgID, input.OrderID)
	if err != nil {
		return SalesConfirmOrderOutput{}, err
	}
	if order == nil {
		return SalesConfirmOrderOutput{}, errors.New("order not found")
	}
	if order.status != "draft" {
		return SalesConfirmOrderOutput{}, fmt.Errorf("order is %s; only draft orders confirm", order.status)
	}
	lines, err := salesLoadOrderLines(ctx, tx, order.id)
	if err != nil {
		return SalesConfirmOrderOutput{}, err
	}
	totals, err := salesComputeInvoiceTotals(lines)
	if err != nil {
		return SalesConfirmOrderOutput{}, err
	}
	var creditLimit *int64
	if err := tx.QueryRow(ctx, `
		SELECT credit_limit_minor FROM customers WHERE id = $1::uuid LIMIT 1`, order.customerID).Scan(&creditLimit); err != nil {
		return SalesConfirmOrderOutput{}, err
	}
	ar, err := salesOpenARMinor(ctx, tx, orgID, order.customerID)
	if err != nil {
		return SalesConfirmOrderOutput{}, err
	}
	if creditLimit != nil {
		headroom := *creditLimit - ar - totals.totalMinor
		if headroom < 0 {
			return SalesConfirmOrderOutput{}, fmt.Errorf(
				"credit limit exceeded: open receivables %d + this order %d exceed the %d limit by %d; record a payment or raise the limit",
				ar, totals.totalMinor, *creditLimit, -headroom)
		}
	}
	// Lock every item identity this order touches in a stable order before
	// checking availability, so concurrent confirms serialize instead of
	// double-claiming the last unit.
	itemIDs := make([]*string, 0, len(lines))
	for index := range lines {
		itemIDs = append(itemIDs, lines[index].itemID)
	}
	kindByID, err := salesItemKinds(ctx, tx, orgID, salesUniqueSortedIDs(itemIDs), true)
	if err != nil {
		return SalesConfirmOrderOutput{}, err
	}
	// One running availability budget per item: repeated lines cannot each
	// claim the same stock. Service lines stay out of the budget.
	demand := make(map[string]int64)
	for _, line := range lines {
		if line.itemID == nil || kindByID[*line.itemID] == "service" {
			continue
		}
		demand[*line.itemID] += line.quantity
	}
	budget := make(map[string]int64, len(demand))
	for itemID := range demand {
		onHand, err := salesStockOnHand(ctx, tx, orgID, itemID)
		if err != nil {
			return SalesConfirmOrderOutput{}, err
		}
		reserved, err := salesOpenReserved(ctx, tx, orgID, itemID)
		if err != nil {
			return SalesConfirmOrderOutput{}, err
		}
		budget[itemID] = onHand - reserved
	}
	type confirmPlanEntry struct {
		line salesOrderLineRow
		take int64
	}
	plan := make([]confirmPlanEntry, 0, len(lines))
	var reservedTotal, wantedTotal int64
	for _, line := range lines {
		if line.itemID == nil {
			continue
		}
		wantedTotal += line.quantity
		if kindByID[*line.itemID] == "service" {
			// A service line commits in full at confirm; delivery later just
			// marks it invoiced.
			plan = append(plan, confirmPlanEntry{line: line, take: line.quantity})
			reservedTotal += line.quantity
			continue
		}
		available := budget[*line.itemID]
		take := min(line.quantity, available)
		if take < 0 {
			take = 0
		}
		budget[*line.itemID] = available - take
		plan = append(plan, confirmPlanEntry{line: line, take: take})
		reservedTotal += take
	}
	backordered := reservedTotal < wantedTotal
	if backordered && (input.AllowBackorder == nil || !*input.AllowBackorder) {
		return SalesConfirmOrderOutput{}, fmt.Errorf(
			"insufficient stock: only %d of %d thousandths available; confirm with allowBackorder to take what exists, or wait for replenishment",
			reservedTotal, wantedTotal)
	}
	for _, entry := range plan {
		if entry.take <= 0 || entry.line.itemID == nil {
			continue
		}
		if kindByID[*entry.line.itemID] == "service" {
			if _, err := tx.Exec(ctx, `
				UPDATE sales_order_lines SET reserved_thousandths = $1 WHERE id = $2::uuid`,
				entry.take, entry.line.id); err != nil {
				return SalesConfirmOrderOutput{}, err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO stock_reservations (org_id, item_id, quantity_thousandths, reason, ref_type, ref_id, status, created_by_actor_type, created_by_actor_id)
			VALUES ($1::uuid, $2::uuid, $3, $4, 'sales_order', $5::uuid, 'open', $6, $7::uuid)`,
			orgID, *entry.line.itemID, entry.take, fmt.Sprintf("sales order #%d", order.number), order.id,
			claims.ActorType, claims.ActorID); err != nil {
			return SalesConfirmOrderOutput{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sales_order_lines SET reserved_thousandths = $1 WHERE id = $2::uuid`,
			entry.take, entry.line.id); err != nil {
			return SalesConfirmOrderOutput{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sales_orders SET status = 'confirmed', confirmed_at = $1, backordered = $2 WHERE id = $3::uuid`,
		now, backordered, order.id); err != nil {
		return SalesConfirmOrderOutput{}, err
	}
	return SalesConfirmOrderOutput{Confirmed: true, Backordered: backordered, ReservedThousandths: reservedTotal}, nil
}

type salesInvoiceLine struct {
	description    string
	quantity       int64
	unitPriceMinor int64
	taxMinor       int64
}

type salesPostedInvoice struct {
	invoiceID     string
	invoiceNumber int64
	totalMinor    int64
}

// salesInsertInvoiceWithPosting is the delivery-side port of the shared
// TypeScript revenue write path: one ordinary invoice plus its balanced
// AR/revenue/tax entry, reusing the Go posting door.
func salesInsertInvoiceWithPosting(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, now time.Time, customerID, memo string, lines []salesInvoiceLine) (salesPostedInvoice, error) {
	orgID := claims.OrganizationID
	var paymentTermDays *int64
	err := tx.QueryRow(ctx, `
		SELECT payment_term_days FROM customers WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`,
		customerID, orgID).Scan(&paymentTermDays)
	if errors.Is(err, pgx.ErrNoRows) {
		return salesPostedInvoice{}, errors.New("customer not found")
	}
	if err != nil {
		return salesPostedInvoice{}, err
	}
	type resolvedInvoiceLine struct {
		description    string
		quantity       int64
		unitPriceMinor int64
		taxMinor       int64
		netMinor       int64
	}
	resolved := make([]resolvedInvoiceLine, 0, len(lines))
	var subtotal, tax, total big.Int
	for _, line := range lines {
		net, taxMinor, gross, err := calculateInvoiceLine(line.quantity, line.unitPriceMinor, nil, false, &line.taxMinor)
		if err != nil {
			return salesPostedInvoice{}, err
		}
		resolved = append(resolved, resolvedInvoiceLine{
			description: line.description, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
			taxMinor: taxMinor, netMinor: net,
		})
		subtotal.Add(&subtotal, big.NewInt(net))
		tax.Add(&tax, big.NewInt(taxMinor))
		total.Add(&total, big.NewInt(gross))
	}
	safeMax := big.NewInt(maxSafeInteger)
	if subtotal.Cmp(safeMax) > 0 || tax.Cmp(safeMax) > 0 || total.Cmp(safeMax) > 0 {
		return salesPostedInvoice{}, errors.New("document total exceeds the supported amount range")
	}
	var baseCurrency string
	err = tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&baseCurrency)
	if errors.Is(err, pgx.ErrNoRows) {
		baseCurrency = "USD"
	} else if err != nil {
		return salesPostedInvoice{}, err
	}
	invoiceNumber, err := nextInvoiceNumber(ctx, tx, orgID)
	if err != nil {
		return salesPostedInvoice{}, err
	}
	dueAt := now
	if paymentTermDays != nil && *paymentTermDays > 0 {
		dueAt = now.Add(time.Duration(*paymentTermDays) * 24 * time.Hour)
	}
	var invoiceID string
	err = tx.QueryRow(ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, fx_rate_num, fx_rate_den, subtotal_minor, tax_minor, total_minor, memo, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, $3, 'sent', $4, NULL, NULL, $5, $6, $7, $8, $9, $10)
		RETURNING id::text`, orgID, customerID, invoiceNumber, baseCurrency,
		subtotal.Int64(), tax.Int64(), total.Int64(), memo, now, dueAt).Scan(&invoiceID)
	if err != nil {
		return salesPostedInvoice{}, err
	}
	for _, line := range resolved {
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax)
			VALUES ($1::uuid, $2, $3, $4, $5, NULL, NULL, false)`,
			invoiceID, line.description, line.quantity, line.unitPriceMinor, line.taxMinor); err != nil {
			return salesPostedInvoice{}, err
		}
	}
	postingLines := make([]JournalEntryLineInput, 0, len(resolved)+2)
	if total.Sign() > 0 {
		postingLines = append(postingLines, JournalEntryLineInput{AccountCode: "1100", DebitMinor: total.Int64()})
	}
	for _, line := range resolved {
		if line.netMinor != 0 {
			postingLines = append(postingLines, JournalEntryLineInput{AccountCode: "4000", CreditMinor: line.netMinor})
		}
	}
	var taxTotal int64
	for _, line := range resolved {
		taxTotal += line.taxMinor
	}
	if taxTotal != 0 {
		postingLines = append(postingLines, JournalEntryLineInput{AccountCode: "2100", CreditMinor: taxTotal})
	}
	entryMemo := fmt.Sprintf("Invoice %d", invoiceNumber)
	if _, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: orgID, Memo: entryMemo, SourceType: "invoice", SourceID: &invoiceID,
		Currency: baseCurrency, PostedAt: now, ActorType: claims.ActorType, ActorID: claims.ActorID,
		Lines: postingLines,
	}); err != nil {
		return salesPostedInvoice{}, err
	}
	return salesPostedInvoice{invoiceID: invoiceID, invoiceNumber: invoiceNumber, totalMinor: total.Int64()}, nil
}

// salesApplyStockDelta mirrors the shared inventory writer: lock the item,
// refuse a negative resulting balance, then append the movement. The
// stock_balances projection is maintained by the database trigger.
func salesApplyStockDelta(ctx context.Context, tx pgx.Tx, orgID, itemID string, quantityDelta int64, note, refID, actorType string, actorID *string) error {
	if _, err := tx.Exec(ctx, `
		SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, []string{itemID}); err != nil {
		return err
	}
	onHand, err := salesStockOnHand(ctx, tx, orgID, itemID)
	if err != nil {
		return err
	}
	if onHand+quantityDelta < 0 {
		return fmt.Errorf("cannot move %d thousandths of stock that is not there: only %d on hand for this item", -quantityDelta, onHand)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, ref_type, ref_id, unit_cost_minor, location_id, lot_id, actor_type, actor_id)
		VALUES ($1::uuid, $2::uuid, $3, 'sale', $4, 'sales_order', $5::uuid, NULL, NULL, NULL, $6, $7::uuid)`,
		orgID, itemID, quantityDelta, note, refID, actorType, actorID)
	return err
}

func salesDeliverOrder(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SalesDeliverOrderInput, now time.Time) (SalesDeliverOrderOutput, error) {
	orgID := claims.OrganizationID
	order, err := salesLoadOrder(ctx, tx, orgID, input.OrderID)
	if err != nil {
		return SalesDeliverOrderOutput{}, err
	}
	if order == nil {
		return SalesDeliverOrderOutput{}, errors.New("order not found")
	}
	if order.status != "confirmed" && order.status != "delivered" {
		return SalesDeliverOrderOutput{}, fmt.Errorf("order is %s; only confirmed orders deliver", order.status)
	}
	lines, err := salesLoadOrderLines(ctx, tx, order.id)
	if err != nil {
		return SalesDeliverOrderOutput{}, err
	}
	byID := make(map[string]salesOrderLineRow, len(lines))
	itemIDs := make([]*string, 0, len(lines))
	for index := range lines {
		byID[lines[index].id] = lines[index]
		itemIDs = append(itemIDs, lines[index].itemID)
	}
	kindByID, err := salesItemKinds(ctx, tx, orgID, salesUniqueSortedIDs(itemIDs), false)
	if err != nil {
		return SalesDeliverOrderOutput{}, err
	}
	type deliverRequest struct {
		lineID              string
		quantityThousandths int64
	}
	requested := make([]deliverRequest, 0, len(lines))
	if input.Lines != nil {
		for _, line := range *input.Lines {
			requested = append(requested, deliverRequest{lineID: line.LineID, quantityThousandths: line.QuantityThousandths})
		}
	} else {
		// Deliver everything still open by default, service lines included,
		// so a mixed order lands as one invoice.
		for _, line := range lines {
			requested = append(requested, deliverRequest{lineID: line.id, quantityThousandths: maxSafeInteger})
		}
	}
	invoiceLines := make([]salesInvoiceLine, 0, len(requested))
	for _, request := range requested {
		line, ok := byID[request.lineID]
		if !ok {
			return SalesDeliverOrderOutput{}, fmt.Errorf("line %s not on this order", request.lineID)
		}
		isService := line.itemID == nil || kindByID[*line.itemID] == "service"
		reserved := line.quantity
		if line.itemID != nil && !isService {
			reserved = line.reserved
		}
		undelivered := reserved - line.delivered
		if undelivered <= 0 {
			return SalesDeliverOrderOutput{}, fmt.Errorf("line %q has nothing left reserved and undelivered", line.description)
		}
		deliver := request.quantityThousandths
		if deliver == maxSafeInteger {
			deliver = undelivered
		}
		if deliver > undelivered {
			return SalesDeliverOrderOutput{}, fmt.Errorf("line %q has only %d thousandths reserved and undelivered; asked for %d", line.description, undelivered, deliver)
		}
		if !isService {
			remaining := deliver
			rows, err := tx.Query(ctx, `
				SELECT id::text, quantity_thousandths FROM stock_reservations
				WHERE org_id = $1::uuid AND item_id = $2::uuid AND ref_type = 'sales_order' AND ref_id = $3::uuid AND status = 'open'
				ORDER BY created_at`, orgID, *line.itemID, order.id)
			if err != nil {
				return SalesDeliverOrderOutput{}, err
			}
			type openReservation struct {
				id       string
				quantity int64
			}
			open := make([]openReservation, 0, 2)
			for rows.Next() {
				var reservation openReservation
				if err := rows.Scan(&reservation.id, &reservation.quantity); err != nil {
					rows.Close()
					return SalesDeliverOrderOutput{}, err
				}
				open = append(open, reservation)
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return SalesDeliverOrderOutput{}, err
			}
			rows.Close()
			// pgx cannot run the consume updates while the select rows are
			// still open, so the reservations are drained above first; the
			// oldest-first consumption order is unchanged.
			for _, reservation := range open {
				if remaining <= 0 {
					break
				}
				take := min(remaining, reservation.quantity)
				var err error
				if take == reservation.quantity {
					_, err = tx.Exec(ctx, `UPDATE stock_reservations SET status = 'consumed' WHERE id = $1::uuid`, reservation.id)
				} else {
					_, err = tx.Exec(ctx, `UPDATE stock_reservations SET quantity_thousandths = quantity_thousandths - $1 WHERE id = $2::uuid`, take, reservation.id)
				}
				if err != nil {
					return SalesDeliverOrderOutput{}, err
				}
				remaining -= take
			}
			if remaining > 0 {
				return SalesDeliverOrderOutput{}, fmt.Errorf("reservation for line %q vanished; refusing to oversell", line.description)
			}
			if err := salesApplyStockDelta(ctx, tx, orgID, *line.itemID, -deliver,
				fmt.Sprintf("sales order #%d", order.number), order.id, claims.ActorType, claims.ActorID); err != nil {
				return SalesDeliverOrderOutput{}, err
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sales_order_lines SET delivered_thousandths = $1 WHERE id = $2::uuid`,
			line.delivered+deliver, line.id); err != nil {
			return SalesDeliverOrderOutput{}, err
		}
		invoiceLines = append(invoiceLines, salesInvoiceLine{
			description:    line.description,
			quantity:       deliver,
			unitPriceMinor: line.unitPriceMinor,
			taxMinor:       int64(math.Round(float64(line.taxMinor) * float64(deliver) / float64(line.quantity))),
		})
	}
	posted, err := salesInsertInvoiceWithPosting(ctx, tx, claims, now, order.customerID,
		fmt.Sprintf("Sales order #%d", order.number), invoiceLines)
	if err != nil {
		return SalesDeliverOrderOutput{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT quantity, delivered_thousandths FROM sales_order_lines WHERE order_id = $1::uuid`, order.id)
	if err != nil {
		return SalesDeliverOrderOutput{}, err
	}
	fullyDelivered := true
	for rows.Next() {
		var quantity, delivered int64
		if err := rows.Scan(&quantity, &delivered); err != nil {
			rows.Close()
			return SalesDeliverOrderOutput{}, err
		}
		if delivered < quantity {
			fullyDelivered = false
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SalesDeliverOrderOutput{}, err
	}
	rows.Close()
	orderStatus := "confirmed"
	if fullyDelivered {
		orderStatus = "delivered"
	}
	backordered := order.backordered
	if fullyDelivered {
		backordered = false
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sales_orders SET status = $1, backordered = $2 WHERE id = $3::uuid`,
		orderStatus, backordered, order.id); err != nil {
		return SalesDeliverOrderOutput{}, err
	}
	return SalesDeliverOrderOutput{
		InvoiceID: posted.invoiceID, InvoiceNumber: posted.invoiceNumber,
		InvoiceTotalMinor: posted.totalMinor, OrderStatus: orderStatus,
	}, nil
}

func salesCancelOrder(ctx context.Context, tx pgx.Tx, orgID string, input SalesCancelOrderInput, now time.Time) (SalesCancelOrderOutput, error) {
	order, err := salesLoadOrder(ctx, tx, orgID, input.OrderID)
	if err != nil {
		return SalesCancelOrderOutput{}, err
	}
	if order == nil {
		return SalesCancelOrderOutput{}, errors.New("order not found")
	}
	if order.status == "cancelled" {
		return SalesCancelOrderOutput{}, errors.New("order is already cancelled")
	}
	if order.status == "delivered" {
		return SalesCancelOrderOutput{}, errors.New("order is fully delivered; unwind through invoice reversal instead")
	}
	if order.status == "confirmed" {
		var delivered int64
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(delivered_thousandths), 0) FROM sales_order_lines WHERE order_id = $1::uuid`,
			order.id).Scan(&delivered); err != nil {
			return SalesCancelOrderOutput{}, err
		}
		if delivered > 0 {
			return SalesCancelOrderOutput{}, errors.New("order is partially delivered; unwind through invoice reversal instead")
		}
		rows, err := tx.Query(ctx, `
			UPDATE stock_reservations SET status = 'released'
			WHERE org_id = $1::uuid AND ref_type = 'sales_order' AND ref_id = $2::uuid AND status = 'open'
			RETURNING quantity_thousandths`, orgID, order.id)
		if err != nil {
			return SalesCancelOrderOutput{}, err
		}
		var released int64
		for rows.Next() {
			var quantity int64
			if err := rows.Scan(&quantity); err != nil {
				rows.Close()
				return SalesCancelOrderOutput{}, err
			}
			released += quantity
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return SalesCancelOrderOutput{}, err
		}
		rows.Close()
		if _, err := tx.Exec(ctx, `
			UPDATE sales_orders SET status = 'cancelled', cancelled_at = $1, backordered = false WHERE id = $2::uuid`,
			now, order.id); err != nil {
			return SalesCancelOrderOutput{}, err
		}
		return SalesCancelOrderOutput{Status: "cancelled", ReleasedThousandths: released}, nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sales_orders SET status = 'cancelled', cancelled_at = $1 WHERE id = $2::uuid`,
		now, order.id); err != nil {
		return SalesCancelOrderOutput{}, err
	}
	return SalesCancelOrderOutput{Status: "cancelled", ReleasedThousandths: 0}, nil
}

func salesListOrders(ctx context.Context, tx pgx.Tx, orgID string, input SalesListOrdersInput) (SalesListOrdersOutput, error) {
	query := `
		SELECT id::text, number, customer_id::text, status, backordered, created_at
		FROM sales_orders WHERE org_id = $1::uuid`
	args := []any{orgID}
	if input.Status != nil {
		query += ` AND status = $2`
		args = append(args, *input.Status)
	}
	query += ` ORDER BY number DESC LIMIT 200`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return SalesListOrdersOutput{}, err
	}
	defer rows.Close()
	type listedOrder struct {
		item SalesListOrderItem
		id   string
	}
	collected := make([]listedOrder, 0, 8)
	for rows.Next() {
		var order listedOrder
		var createdAt time.Time
		if err := rows.Scan(&order.item.ID, &order.item.Number, &order.item.CustomerID, &order.item.Status, &order.item.Backordered, &createdAt); err != nil {
			return SalesListOrdersOutput{}, err
		}
		order.id = order.item.ID
		order.item.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		collected = append(collected, order)
	}
	if err := rows.Err(); err != nil {
		return SalesListOrdersOutput{}, err
	}
	rows.Close()
	// Line totals are fetched after the order scan is drained: pgx cannot
	// run a second query while the first result set is still open.
	orders := make([]SalesListOrderItem, 0, len(collected))
	for _, listed := range collected {
		lineRows, err := tx.Query(ctx, `
			SELECT quantity, unit_price_minor, tax_minor FROM sales_order_lines WHERE order_id = $1::uuid`, listed.id)
		if err != nil {
			return SalesListOrdersOutput{}, err
		}
		var total int64
		for lineRows.Next() {
			var quantity, unitPriceMinor, taxMinor int64
			if err := lineRows.Scan(&quantity, &unitPriceMinor, &taxMinor); err != nil {
				lineRows.Close()
				return SalesListOrdersOutput{}, err
			}
			total += int64(math.Round(float64(quantity)*float64(unitPriceMinor)/1000)) + taxMinor
		}
		if err := lineRows.Err(); err != nil {
			lineRows.Close()
			return SalesListOrdersOutput{}, err
		}
		lineRows.Close()
		listed.item.TotalMinor = total
		orders = append(orders, listed.item)
	}
	return SalesListOrdersOutput{Orders: orders}, nil
}
