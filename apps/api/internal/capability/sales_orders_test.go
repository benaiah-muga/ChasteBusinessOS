package capability

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestSalesOrdersParserContracts(t *testing.T) {
	customerID := "11111111-1111-4111-8111-111111111111"
	orderID := "22222222-2222-4222-8222-222222222222"
	lineID := "33333333-3333-4333-8333-333333333333"
	cases := []struct {
		name     string
		parse    func(json.RawMessage) (any, error)
		raw      string
		wantJSON string
		output   any
		outputJS string
	}{
		{
			name:     "createOrder",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesCreateOrderInput(raw) },
			raw:      `{"customerId":"` + customerID + `","note":"rush","lines":[{"description":"Probe Chair","quantity":30000,"unitPriceMinor":20000,"taxMinor":60000,"sku":"SO-CHAIR"},{"description":"Consulting","quantity":1000,"unitPriceMinor":10000}],"unknown":true}`,
			wantJSON: `{"customerId":"` + customerID + `","note":"rush","lines":[{"description":"Probe Chair","quantity":30000,"unitPriceMinor":20000,"taxMinor":60000,"sku":"SO-CHAIR"},{"description":"Consulting","quantity":1000,"unitPriceMinor":10000}]}`,
			output:   SalesCreateOrderOutput{OrderID: orderID, OrderNumber: 7},
			outputJS: `{"orderId":"` + orderID + `","orderNumber":7}`,
		},
		{
			name:     "createOrderMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesCreateOrderInput(raw) },
			raw:      `{"customerId":"` + customerID + `","lines":[{"description":"Bare","quantity":1000,"unitPriceMinor":500}]}`,
			wantJSON: `{"customerId":"` + customerID + `","lines":[{"description":"Bare","quantity":1000,"unitPriceMinor":500}]}`,
		},
		{
			name:     "confirmOrder",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesConfirmOrderInput(raw) },
			raw:      `{"orderId":"` + orderID + `","allowBackorder":true,"extra":1}`,
			wantJSON: `{"orderId":"` + orderID + `","allowBackorder":true}`,
			output:   SalesConfirmOrderOutput{Confirmed: true, Backordered: false, ReservedThousandths: 30000},
			outputJS: `{"confirmed":true,"backordered":false,"reservedThousandths":30000}`,
		},
		{
			name:     "confirmOrderMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesConfirmOrderInput(raw) },
			raw:      `{"orderId":"` + orderID + `"}`,
			wantJSON: `{"orderId":"` + orderID + `"}`,
		},
		{
			name:     "deliverOrder",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesDeliverOrderInput(raw) },
			raw:      `{"orderId":"` + orderID + `","lines":[{"lineId":"` + lineID + `","quantityThousandths":18000}]}`,
			wantJSON: `{"orderId":"` + orderID + `","lines":[{"lineId":"` + lineID + `","quantityThousandths":18000}]}`,
			output:   SalesDeliverOrderOutput{InvoiceID: customerID, InvoiceNumber: 2, InvoiceTotalMinor: 396000, OrderStatus: "confirmed"},
			outputJS: `{"invoiceId":"` + customerID + `","invoiceNumber":2,"invoiceTotalMinor":396000,"orderStatus":"confirmed"}`,
		},
		{
			name:     "deliverOrderMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesDeliverOrderInput(raw) },
			raw:      `{"orderId":"` + orderID + `"}`,
			wantJSON: `{"orderId":"` + orderID + `"}`,
		},
		{
			name:     "cancelOrder",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesCancelOrderInput(raw) },
			raw:      `{"orderId":"` + orderID + `"}`,
			wantJSON: `{"orderId":"` + orderID + `"}`,
			output:   SalesCancelOrderOutput{Status: "cancelled", ReleasedThousandths: 30000},
			outputJS: `{"status":"cancelled","releasedThousandths":30000}`,
		},
		{
			name:     "listOrders",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesListOrdersInput(raw) },
			raw:      `{"status":"delivered","unknown":2}`,
			wantJSON: `{"status":"delivered"}`,
			output: SalesListOrdersOutput{Orders: []SalesListOrderItem{{
				ID: orderID, Number: 3, CustomerID: customerID, Status: "draft", Backordered: false,
				TotalMinor: 660000, CreatedAt: "2026-09-27T10:00:00.000Z",
			}}},
			outputJS: `{"orders":[{"id":"` + orderID + `","number":3,"customerId":"` + customerID + `","status":"draft","backordered":false,"totalMinor":660000,"createdAt":"2026-09-27T10:00:00.000Z"}]}`,
		},
		{
			name:     "listOrdersMinimal",
			parse:    func(raw json.RawMessage) (any, error) { return ParseSalesListOrdersInput(raw) },
			raw:      `{}`,
			wantJSON: `{}`,
			output:   SalesListOrdersOutput{Orders: []SalesListOrderItem{}},
			outputJS: `{"orders":[]}`,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := test.parse(json.RawMessage(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			got, err := marshalJS(parsed)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.wantJSON {
				t.Fatalf("parsed input = %s, want %s", got, test.wantJSON)
			}
			hash, err := canonicalHash(parsed)
			if err != nil || hash == "" {
				t.Fatalf("canonicalHash() = %q, %v", hash, err)
			}
			if test.output != nil {
				encoded, err := marshalJS(test.output)
				if err != nil {
					t.Fatal(err)
				}
				if string(encoded) != test.outputJS {
					t.Fatalf("output = %s, want %s", encoded, test.outputJS)
				}
			}
		})
	}
	if _, err := parseSalesInput(salesCreateOrderCapabilityID, json.RawMessage(`{"customerId":"`+customerID+`","lines":[{"description":"Bare","quantity":1000,"unitPriceMinor":500}]}`)); err != nil {
		t.Fatalf("parseSalesInput dispatch error = %v", err)
	}
	if _, err := parseSalesInput("sales.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseSalesInput accepted an unsupported capability")
	}
}

func TestSalesOrdersParserRejections(t *testing.T) {
	customerID := "11111111-1111-4111-8111-111111111111"
	orderID := "22222222-2222-4222-8222-222222222222"
	for _, raw := range []string{
		`{}`,
		`{"customerId":null,"lines":[{"description":"x","quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"not-a-uuid","lines":[{"description":"x","quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `"}`,
		`{"customerId":"` + customerID + `","lines":[]}`,
		`{"customerId":"` + customerID + `","lines":null}`,
		`{"customerId":"` + customerID + `","lines":{"description":"x"}}`,
		`{"customerId":"` + customerID + `","lines":[null]}`,
		`{"customerId":"` + customerID + `","note":null,"lines":[{"description":"x","quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"","quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":null,"quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":0,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":-1000,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":1.5,"unitPriceMinor":1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":1000}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":1000,"unitPriceMinor":-1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":1000,"unitPriceMinor":1,"taxMinor":-1}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":1000,"unitPriceMinor":1,"taxMinor":null}]}`,
		`{"customerId":"` + customerID + `","lines":[{"description":"x","quantity":1000,"unitPriceMinor":1,"sku":null}]}`,
	} {
		if _, err := ParseSalesCreateOrderInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseSalesCreateOrderInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"orderId":"nope"}`,
		`{"orderId":null}`,
		`{"orderId":"` + orderID + `","allowBackorder":null}`,
		`{"orderId":"` + orderID + `","allowBackorder":"yes"}`,
	} {
		if _, err := ParseSalesConfirmOrderInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseSalesConfirmOrderInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"orderId":"nope"}`,
		`{"orderId":"` + orderID + `","lines":null}`,
		`{"orderId":"` + orderID + `","lines":"all"}`,
		`{"orderId":"` + orderID + `","lines":[null]}`,
		`{"orderId":"` + orderID + `","lines":[{"quantityThousandths":1000}]}`,
		`{"orderId":"` + orderID + `","lines":[{"lineId":"nope","quantityThousandths":1000}]}`,
		`{"orderId":"` + orderID + `","lines":[{"lineId":"` + orderID + `"}]}`,
		`{"orderId":"` + orderID + `","lines":[{"lineId":"` + orderID + `","quantityThousandths":0}]}`,
		`{"orderId":"` + orderID + `","lines":[{"lineId":"` + orderID + `","quantityThousandths":-5}]}`,
		`{"orderId":"` + orderID + `","lines":[{"lineId":"` + orderID + `","quantityThousandths":1.5}]}`,
	} {
		if _, err := ParseSalesDeliverOrderInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseSalesDeliverOrderInput accepted %s", raw)
		}
	}
	if _, err := ParseSalesCancelOrderInput(json.RawMessage(`{}`)); err == nil {
		t.Error("ParseSalesCancelOrderInput accepted a missing orderId")
	}
	if _, err := ParseSalesCancelOrderInput(json.RawMessage(`{"orderId":"nope"}`)); err == nil {
		t.Error("ParseSalesCancelOrderInput accepted a non-UUID orderId")
	}
	for _, raw := range []string{
		`{"status":"bogus"}`,
		`{"status":null}`,
		`{"status":7}`,
	} {
		if _, err := ParseSalesListOrdersInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseSalesListOrdersInput accepted %s", raw)
		}
	}
}

func seedSalesItem(t *testing.T, fx *executorFixture, orgID, sku, kind string) string {
	t.Helper()
	var itemID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`,
		orgID, sku, sku+" name", kind).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func seedSalesStock(t *testing.T, fx *executorFixture, orgID, itemID string, quantityThousandths int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, actor_type, actor_id)
		VALUES ($1::uuid, $2::uuid, $3, 'adjustment', 'opening count', 'system', NULL)`,
		orgID, itemID, quantityThousandths); err != nil {
		t.Fatal(err)
	}
}

func seedSalesAccounts(t *testing.T, fx *executorFixture, orgID string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1100', 'Accounts Receivable', 'asset'),
		($1::uuid, '2100', 'Sales Tax Payable', 'liability'),
		($1::uuid, '4000', 'Sales Revenue', 'income')`, orgID); err != nil {
		t.Fatal(err)
	}
}

func salesTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func salesInOrgTx[T any](t *testing.T, fx *executorFixture, orgID string, action func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, action)
	if err != nil {
		t.Fatal(err)
	}
	return output
}

func salesErrInOrgTx(t *testing.T, fx *executorFixture, orgID string, action func(tx pgx.Tx) error) error {
	t.Helper()
	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, action(tx)
	})
	return err
}

func salesCreateDraft(t *testing.T, fx *executorFixture, claims authbridge.CapabilityClaims, customerID string, lines []SalesOrderLineInput) SalesCreateOrderOutput {
	t.Helper()
	return salesInOrgTx(t, fx, claims.OrganizationID, func(tx pgx.Tx) (SalesCreateOrderOutput, error) {
		return salesCreateOrder(fx.ctx, tx, claims, SalesCreateOrderInput{CustomerID: customerID, Lines: lines})
	})
}

func salesConfirmDraft(t *testing.T, fx *executorFixture, claims authbridge.CapabilityClaims, orderID string, allowBackorder *bool, now time.Time) SalesConfirmOrderOutput {
	t.Helper()
	return salesInOrgTx(t, fx, claims.OrganizationID, func(tx pgx.Tx) (SalesConfirmOrderOutput, error) {
		return salesConfirmOrder(fx.ctx, tx, claims, SalesConfirmOrderInput{OrderID: orderID, AllowBackorder: allowBackorder}, now)
	})
}

func TestSalesOrdersCreatePersistsDraftOrder(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := salesTestClaims(fx)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Local buyer")
	itemID := seedSalesItem(t, fx, fx.orgID, "SO-CHAIR", "goods")

	created := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 30000, UnitPriceMinor: 20000, TaxMinor: crmInt64Pointer(60000), SKU: crmStringPointer("SO-CHAIR")},
		{Description: "Consulting half-day", Quantity: 1000, UnitPriceMinor: 10000},
	})
	if !isUUID(created.OrderID) || created.OrderNumber != 1 {
		t.Fatalf("createOrder output = %+v, want UUID orderId and number 1", created)
	}
	var order struct {
		OrgID      string
		Number     int64
		CustomerID string
		Status     string
		Note       *string
		ActorType  *string
		ActorID    *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, number, customer_id::text, status, note, created_by_actor_type, created_by_actor_id::text
		FROM sales_orders WHERE id = $1::uuid`, created.OrderID).
		Scan(&order.OrgID, &order.Number, &order.CustomerID, &order.Status, &order.Note, &order.ActorType, &order.ActorID); err != nil {
		t.Fatal(err)
	}
	if order.OrgID != fx.orgID || order.Number != 1 || order.CustomerID != customerID || order.Status != "draft" ||
		order.Note != nil || order.ActorType == nil || *order.ActorType != "human" || order.ActorID == nil || *order.ActorID != fx.userID {
		t.Fatalf("stored order = %+v, want org-scoped draft attributed to the actor", order)
	}
	type storedLine struct {
		Description    string
		Quantity       int64
		UnitPriceMinor int64
		TaxMinor       int64
		ItemID         *string
	}
	lines := make([]storedLine, 0, 2)
	lineRows, err := fx.owner.Query(fx.ctx, `
		SELECT description, quantity, unit_price_minor, tax_minor, item_id::text
		FROM sales_order_lines WHERE order_id = $1::uuid ORDER BY id`, created.OrderID)
	if err != nil {
		t.Fatal(err)
	}
	for lineRows.Next() {
		var line storedLine
		if err := lineRows.Scan(&line.Description, &line.Quantity, &line.UnitPriceMinor, &line.TaxMinor, &line.ItemID); err != nil {
			lineRows.Close()
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	lineRows.Close()
	if len(lines) != 2 {
		t.Fatalf("stored %d lines, want 2", len(lines))
	}
	byDescription := make(map[string]storedLine, 2)
	for _, line := range lines {
		byDescription[line.Description] = line
	}
	stockLine, hasStockLine := byDescription["Probe Chair"]
	bareLine, hasBareLine := byDescription["Consulting half-day"]
	if !hasStockLine || !hasBareLine {
		t.Fatalf("stored lines = %+v, want both order lines", lines)
	}
	if stockLine.Quantity != 30000 || stockLine.UnitPriceMinor != 20000 ||
		stockLine.TaxMinor != 60000 || stockLine.ItemID == nil || *stockLine.ItemID != itemID {
		t.Fatalf("stored stock line = %+v, want sku-resolved item and money fields", stockLine)
	}
	if bareLine.Quantity != 1000 || bareLine.UnitPriceMinor != 10000 ||
		bareLine.TaxMinor != 0 || bareLine.ItemID != nil {
		t.Fatalf("stored bare line = %+v, want zero tax and null item", bareLine)
	}

	noted := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesCreateOrderOutput, error) {
		return salesCreateOrder(fx.ctx, tx, claims, SalesCreateOrderInput{
			CustomerID: customerID,
			Note:       crmStringPointer("rush before quarter end"),
			Lines:      []SalesOrderLineInput{{Description: "Noted", Quantity: 1000, UnitPriceMinor: 100}},
		})
	})
	if err := fx.owner.QueryRow(fx.ctx, `SELECT note FROM sales_orders WHERE id=$1::uuid`, noted.OrderID).Scan(&order.Note); err != nil {
		t.Fatal(err)
	}
	if order.Note == nil || *order.Note != "rush before quarter end" {
		t.Fatalf("stored note = %v, want the create note", order.Note)
	}

	unknownCustomer := executorUUID(t)
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesCreateOrder(fx.ctx, tx, claims, SalesCreateOrderInput{
			CustomerID: unknownCustomer,
			Lines:      []SalesOrderLineInput{{Description: "x", Quantity: 1000, UnitPriceMinor: 1}},
		})
		return err
	})
	if err == nil || err.Error() != "customer not found" {
		t.Fatalf("unknown customer error = %v, want customer not found", err)
	}
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesCreateOrder(fx.ctx, tx, claims, SalesCreateOrderInput{
			CustomerID: customerID,
			Lines:      []SalesOrderLineInput{{Description: "x", Quantity: 1000, UnitPriceMinor: 1, SKU: crmStringPointer("NOPE-SKU")}},
		})
		return err
	})
	if err == nil || err.Error() != "no item with sku NOPE-SKU" {
		t.Fatalf("unknown sku error = %v, want no item with sku NOPE-SKU", err)
	}
	foreignCustomer := seedCRMDealCustomer(t, fx, fx.otherOrgID, "Foreign buyer")
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesCreateOrder(fx.ctx, tx, claims, SalesCreateOrderInput{
			CustomerID: foreignCustomer,
			Lines:      []SalesOrderLineInput{{Description: "x", Quantity: 1000, UnitPriceMinor: 1}},
		})
		return err
	})
	if err == nil || err.Error() != "customer not found" {
		t.Fatalf("foreign customer error = %v, want customer not found", err)
	}
	if got := fx.count(`SELECT count(*) FROM sales_orders WHERE org_id=$1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("stored sales orders = %d, want the two successful creates", got)
	}
}

func TestSalesOrdersConfirmReservesGuardsAndBackorder(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := salesTestClaims(fx)
	now := time.Now().UTC().Truncate(time.Millisecond)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Credit buyer")
	itemID := seedSalesItem(t, fx, fx.orgID, "SO-CHAIR", "goods")
	seedSalesStock(t, fx, fx.orgID, itemID, 100000)

	first := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 30000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	confirmed := salesConfirmDraft(t, fx, claims, first.OrderID, nil, now)
	if confirmed != (SalesConfirmOrderOutput{Confirmed: true, Backordered: false, ReservedThousandths: 30000}) {
		t.Fatalf("confirm output = %+v", confirmed)
	}
	var reservation struct {
		Quantity  int64
		Status    string
		Reason    string
		RefType   string
		RefID     string
		ActorType string
		ActorID   *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quantity_thousandths, status, reason, ref_type, ref_id::text, created_by_actor_type, created_by_actor_id::text
		FROM stock_reservations WHERE org_id=$1::uuid AND ref_id=$2::uuid`, fx.orgID, first.OrderID).
		Scan(&reservation.Quantity, &reservation.Status, &reservation.Reason, &reservation.RefType, &reservation.RefID,
			&reservation.ActorType, &reservation.ActorID); err != nil {
		t.Fatal(err)
	}
	if reservation.Quantity != 30000 || reservation.Status != "open" || reservation.Reason != "sales order #1" ||
		reservation.RefType != "sales_order" || reservation.RefID != first.OrderID ||
		reservation.ActorType != "human" || reservation.ActorID == nil || *reservation.ActorID != fx.userID {
		t.Fatalf("stored reservation = %+v, want attributed open reservation for the order", reservation)
	}
	var orderStatus string
	var orderBackordered bool
	var confirmedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, backordered, confirmed_at FROM sales_orders WHERE id=$1::uuid`, first.OrderID).
		Scan(&orderStatus, &orderBackordered, &confirmedAt); err != nil {
		t.Fatal(err)
	}
	if orderStatus != "confirmed" || orderBackordered || confirmedAt == nil || !confirmedAt.Equal(now) {
		t.Fatalf("confirmed order = %s/%t/%v, want confirmed at the passed now", orderStatus, orderBackordered, confirmedAt)
	}
	var reservedThousandths int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT reserved_thousandths FROM sales_order_lines WHERE order_id=$1::uuid`, first.OrderID).Scan(&reservedThousandths); err != nil {
		t.Fatal(err)
	}
	if reservedThousandths != 30000 {
		t.Fatalf("line reserved = %d, want 30000", reservedThousandths)
	}

	err := salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesConfirmOrder(fx.ctx, tx, claims, SalesConfirmOrderInput{OrderID: first.OrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order is confirmed; only draft orders confirm" {
		t.Fatalf("double confirm error = %v", err)
	}

	cancelled := salesInOrgTx(t, fx, claims.OrganizationID, func(tx pgx.Tx) (SalesCancelOrderOutput, error) {
		return salesCancelOrder(fx.ctx, tx, claims.OrganizationID, SalesCancelOrderInput{OrderID: first.OrderID}, now)
	})
	if cancelled.ReleasedThousandths != 30000 {
		t.Fatalf("cancel released = %d, want 30000", cancelled.ReleasedThousandths)
	}

	short := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 200000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesConfirmOrder(fx.ctx, tx, claims, SalesConfirmOrderInput{OrderID: short.OrderID}, now)
		return err
	})
	want := "insufficient stock: only 100000 of 200000 thousandths available; confirm with allowBackorder to take what exists, or wait for replenishment"
	if err == nil || err.Error() != want {
		t.Fatalf("insufficient stock error = %v, want %q", err, want)
	}
	if got := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid AND ref_id=$2::uuid`, fx.orgID, short.OrderID); got != 0 {
		t.Fatalf("refused confirm left %d reservations", got)
	}
	backordered := salesConfirmDraft(t, fx, claims, short.OrderID, boolPointer(true), now)
	if backordered != (SalesConfirmOrderOutput{Confirmed: true, Backordered: true, ReservedThousandths: 100000}) {
		t.Fatalf("backordered confirm = %+v", backordered)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT backordered FROM sales_orders WHERE id=$1::uuid`, short.OrderID).Scan(&orderBackordered); err != nil {
		t.Fatal(err)
	}
	if !orderBackordered {
		t.Fatal("backordered flag not stored")
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE sales_orders SET status='cancelled' WHERE id=$1::uuid`, short.OrderID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE stock_reservations SET status='released' WHERE org_id=$1::uuid AND ref_id=$2::uuid`, fx.orgID, short.OrderID); err != nil {
		t.Fatal(err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE customers SET credit_limit_minor = 500000 WHERE id = $1::uuid`, customerID); err != nil {
		t.Fatal(err)
	}
	over := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 40000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesConfirmOrder(fx.ctx, tx, claims, SalesConfirmOrderInput{OrderID: over.OrderID}, now)
		return err
	})
	want = "credit limit exceeded: open receivables 0 + this order 800000 exceed the 500000 limit by 300000; record a payment or raise the limit"
	if err == nil || err.Error() != want {
		t.Fatalf("credit guard error = %v, want %q", err, want)
	}
	if got := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid AND ref_id=$2::uuid`, fx.orgID, over.OrderID); got != 0 {
		t.Fatalf("credit refusal left %d reservations", got)
	}
	if got := fx.count(`SELECT count(*) FROM sales_orders WHERE id=$1::uuid AND status='draft'`, over.OrderID); got != 1 {
		t.Fatal("credit refusal changed the order status")
	}

	zero := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Free advice", Quantity: 1000, UnitPriceMinor: 0},
	})
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesConfirmOrder(fx.ctx, tx, claims, SalesConfirmOrderInput{OrderID: zero.OrderID}, now)
		return err
	})
	if err == nil || err.Error() != "invoice must have a non-zero total" {
		t.Fatalf("zero total confirm error = %v", err)
	}
}

func TestSalesOrdersDeliverInvoicesAndBalancesBooks(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	claims := salesTestClaims(fx)
	now := time.Now().UTC().Truncate(time.Millisecond)
	seedSalesAccounts(t, fx, fx.orgID)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Delivery buyer")
	itemID := seedSalesItem(t, fx, fx.orgID, "SO-CHAIR", "goods")
	seedSalesStock(t, fx, fx.orgID, itemID, 100000)

	created := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 30000, UnitPriceMinor: 20000, TaxMinor: crmInt64Pointer(60000), SKU: crmStringPointer("SO-CHAIR")},
	})
	salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesConfirmOrderOutput, error) {
		return salesConfirmOrder(fx.ctx, tx, claims, SalesConfirmOrderInput{OrderID: created.OrderID}, now)
	})
	var lineID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM sales_order_lines WHERE order_id=$1::uuid`, created.OrderID).Scan(&lineID); err != nil {
		t.Fatal(err)
	}

	first := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesDeliverOrderOutput, error) {
		lines := []SalesDeliverOrderLineInput{{LineID: lineID, QuantityThousandths: 18000}}
		return salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: created.OrderID, Lines: &lines}, now)
	})
	if !isUUID(first.InvoiceID) || first.InvoiceNumber != 1 || first.InvoiceTotalMinor != 396000 || first.OrderStatus != "confirmed" {
		t.Fatalf("partial deliver = %+v, want invoice 1 total 396000 order still confirmed", first)
	}
	var invoice struct {
		Number   int64
		Status   string
		Currency string
		Subtotal int64
		Tax      int64
		Total    int64
		Memo     string
		IssuedAt time.Time
		DueAt    time.Time
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT number, status, currency, subtotal_minor, tax_minor, total_minor, memo, issued_at, due_at
		FROM invoices WHERE id=$1::uuid`, first.InvoiceID).
		Scan(&invoice.Number, &invoice.Status, &invoice.Currency, &invoice.Subtotal, &invoice.Tax, &invoice.Total,
			&invoice.Memo, &invoice.IssuedAt, &invoice.DueAt); err != nil {
		t.Fatal(err)
	}
	if invoice.Number != 1 || invoice.Status != "sent" || invoice.Currency != "USD" || invoice.Subtotal != 360000 ||
		invoice.Tax != 36000 || invoice.Total != 396000 || invoice.Memo != "Sales order #1" ||
		!invoice.IssuedAt.Equal(now) || !invoice.DueAt.Equal(now) {
		t.Fatalf("stored invoice = %+v, want sent 396000 with sales order memo", invoice)
	}
	var invoiceLine struct {
		Description    string
		Quantity       int64
		UnitPriceMinor int64
		TaxMinor       int64
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT description, quantity, unit_price_minor, tax_minor FROM invoice_lines WHERE invoice_id=$1::uuid`, first.InvoiceID).
		Scan(&invoiceLine.Description, &invoiceLine.Quantity, &invoiceLine.UnitPriceMinor, &invoiceLine.TaxMinor); err != nil {
		t.Fatal(err)
	}
	if invoiceLine.Description != "Probe Chair" || invoiceLine.Quantity != 18000 || invoiceLine.UnitPriceMinor != 20000 || invoiceLine.TaxMinor != 36000 {
		t.Fatalf("invoice line = %+v, want prorated tax of 36000", invoiceLine)
	}
	var entryMemo, entrySource, entryCurrency string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, currency FROM journal_entries WHERE source_id=$1::uuid`, first.InvoiceID).
		Scan(&entryMemo, &entrySource, &entryCurrency); err != nil {
		t.Fatal(err)
	}
	if entryMemo != "Invoice 1" || entrySource != "invoice" || entryCurrency != "USD" {
		t.Fatalf("journal entry = %s/%s/%s, want Invoice 1 invoice USD", entryMemo, entrySource, entryCurrency)
	}
	var movement struct {
		Delta     int64
		Reason    string
		Note      string
		RefType   string
		RefID     string
		ActorType string
		ActorID   *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quantity_delta, reason, note, ref_type, ref_id::text, actor_type, actor_id::text
		FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid AND reason='sale'`, fx.orgID, itemID).
		Scan(&movement.Delta, &movement.Reason, &movement.Note, &movement.RefType, &movement.RefID, &movement.ActorType, &movement.ActorID); err != nil {
		t.Fatal(err)
	}
	if movement.Delta != -18000 || movement.Reason != "sale" || movement.Note != "sales order #1" ||
		movement.RefType != "sales_order" || movement.RefID != created.OrderID ||
		movement.ActorType != "human" || movement.ActorID == nil || *movement.ActorID != fx.userID {
		t.Fatalf("stock movement = %+v, want attributed sale leg", movement)
	}
	var onHand int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity),0) FROM stock_balances WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, itemID).Scan(&onHand); err != nil {
		t.Fatal(err)
	}
	if onHand != 82000 {
		t.Fatalf("on hand = %d, want 82000", onHand)
	}
	var openQuantity int64
	var openCount int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity_thousandths),0), count(*) FROM stock_reservations
		WHERE org_id=$1::uuid AND ref_id=$2::uuid AND status='open'`, fx.orgID, created.OrderID).Scan(&openQuantity, &openCount); err != nil {
		t.Fatal(err)
	}
	if openCount != 1 || openQuantity != 12000 {
		t.Fatalf("open reservation = %d/%d, want one row of 12000", openCount, openQuantity)
	}

	rest := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesDeliverOrderOutput, error) {
		return salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: created.OrderID}, now)
	})
	if rest.InvoiceNumber != 2 || rest.InvoiceTotalMinor != 264000 || rest.OrderStatus != "delivered" {
		t.Fatalf("rest deliver = %+v, want invoice 2 total 264000 delivered", rest)
	}
	if got := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid AND ref_id=$2::uuid AND status='open'`, fx.orgID, created.OrderID); got != 0 {
		t.Fatalf("open reservations after full delivery = %d", got)
	}
	var orderStatus string
	var orderBackordered bool
	var deliveredThousandths int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, backordered FROM sales_orders WHERE id=$1::uuid`, created.OrderID).Scan(&orderStatus, &orderBackordered); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT delivered_thousandths FROM sales_order_lines WHERE id=$1::uuid`, lineID).Scan(&deliveredThousandths); err != nil {
		t.Fatal(err)
	}
	if orderStatus != "delivered" || orderBackordered || deliveredThousandths != 30000 {
		t.Fatalf("delivered state = %s/%t/%d", orderStatus, orderBackordered, deliveredThousandths)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift = %d, want balanced books", drift)
	}

	err := salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: created.OrderID}, now)
		return err
	})
	if err == nil || err.Error() != `line "Probe Chair" has nothing left reserved and undelivered` {
		t.Fatalf("exhausted deliver error = %v", err)
	}

	draft := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 1000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: draft.OrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order is draft; only confirmed orders deliver" {
		t.Fatalf("draft deliver error = %v", err)
	}

	asked := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 30000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	salesConfirmDraft(t, fx, claims, asked.OrderID, nil, now)
	bogusLineID := executorUUID(t)
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		lines := []SalesDeliverOrderLineInput{{LineID: bogusLineID, QuantityThousandths: 1000}}
		_, err := salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: asked.OrderID, Lines: &lines}, now)
		return err
	})
	if err == nil || err.Error() != fmt.Sprintf("line %s not on this order", bogusLineID) {
		t.Fatalf("foreign line deliver error = %v", err)
	}
	var askedLineID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM sales_order_lines WHERE order_id=$1::uuid`, asked.OrderID).Scan(&askedLineID); err != nil {
		t.Fatal(err)
	}
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		lines := []SalesDeliverOrderLineInput{{LineID: askedLineID, QuantityThousandths: 50000}}
		_, err := salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: asked.OrderID, Lines: &lines}, now)
		return err
	})
	if err == nil || err.Error() != `line "Probe Chair" has only 30000 thousandths reserved and undelivered; asked for 50000` {
		t.Fatalf("oversell deliver error = %v", err)
	}
}

func TestSalesOrdersServiceLinesDeliverWithoutStock(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	claims := salesTestClaims(fx)
	now := time.Now().UTC().Truncate(time.Millisecond)
	seedSalesAccounts(t, fx, fx.orgID)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Mixed buyer")
	chairID := seedSalesItem(t, fx, fx.orgID, "SO-CHAIR", "goods")
	serviceID := seedSalesItem(t, fx, fx.orgID, "SO-INSTALL", "service")
	seedSalesStock(t, fx, fx.orgID, chairID, 100000)

	created := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 10000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
		{Description: "Installation", Quantity: 1000, UnitPriceMinor: 5000, SKU: crmStringPointer("SO-INSTALL")},
		{Description: "Consulting half-day", Quantity: 1000, UnitPriceMinor: 10000},
	})
	confirmed := salesConfirmDraft(t, fx, claims, created.OrderID, nil, now)
	if confirmed != (SalesConfirmOrderOutput{Confirmed: true, Backordered: false, ReservedThousandths: 11000}) {
		t.Fatalf("mixed confirm = %+v, want 11000 reserved", confirmed)
	}
	if got := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, serviceID); got != 0 {
		t.Fatalf("service item reservations = %d, want none", got)
	}
	var serviceReserved int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT reserved_thousandths FROM sales_order_lines WHERE order_id=$1::uuid AND description='Installation'`, created.OrderID).Scan(&serviceReserved); err != nil {
		t.Fatal(err)
	}
	if serviceReserved != 1000 {
		t.Fatalf("service line reserved = %d, want 1000", serviceReserved)
	}

	delivered := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesDeliverOrderOutput, error) {
		return salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: created.OrderID}, now)
	})
	if delivered.OrderStatus != "delivered" || delivered.InvoiceTotalMinor != 215000 {
		t.Fatalf("mixed deliver = %+v, want delivered with 215000 invoice", delivered)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE org_id=$1::uuid AND item_id=$2::uuid`, fx.orgID, serviceID); got != 0 {
		t.Fatalf("service item movements = %d, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM invoice_lines WHERE invoice_id=$1::uuid`, delivered.InvoiceID); got != 3 {
		t.Fatalf("invoice lines = %d, want all three order lines", got)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift = %d, want balanced books", drift)
	}
}

func TestSalesOrdersCancelReleasesReservations(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	claims := salesTestClaims(fx)
	now := time.Now().UTC().Truncate(time.Millisecond)
	seedSalesAccounts(t, fx, fx.orgID)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Cancel buyer")
	itemID := seedSalesItem(t, fx, fx.orgID, "SO-CHAIR", "goods")
	seedSalesStock(t, fx, fx.orgID, itemID, 100000)

	confirmedOrder := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 30000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	salesConfirmDraft(t, fx, claims, confirmedOrder.OrderID, nil, now)
	cancelled := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesCancelOrderOutput, error) {
		return salesCancelOrder(fx.ctx, tx, fx.orgID, SalesCancelOrderInput{OrderID: confirmedOrder.OrderID}, now)
	})
	if cancelled != (SalesCancelOrderOutput{Status: "cancelled", ReleasedThousandths: 30000}) {
		t.Fatalf("confirmed cancel = %+v", cancelled)
	}
	if got := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid AND ref_id=$2::uuid AND status='released'`, fx.orgID, confirmedOrder.OrderID); got != 1 {
		t.Fatalf("released reservations = %d, want one", got)
	}
	var orderStatus string
	var orderBackordered bool
	var cancelledAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, backordered, cancelled_at FROM sales_orders WHERE id=$1::uuid`, confirmedOrder.OrderID).
		Scan(&orderStatus, &orderBackordered, &cancelledAt); err != nil {
		t.Fatal(err)
	}
	if orderStatus != "cancelled" || orderBackordered || cancelledAt == nil || !cancelledAt.Equal(now) {
		t.Fatalf("cancelled order = %s/%t/%v", orderStatus, orderBackordered, cancelledAt)
	}

	err := salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesCancelOrder(fx.ctx, tx, fx.orgID, SalesCancelOrderInput{OrderID: confirmedOrder.OrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order is already cancelled" {
		t.Fatalf("double cancel error = %v", err)
	}

	draftOrder := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 1000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	draftCancelled := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesCancelOrderOutput, error) {
		return salesCancelOrder(fx.ctx, tx, fx.orgID, SalesCancelOrderInput{OrderID: draftOrder.OrderID}, now)
	})
	if draftCancelled != (SalesCancelOrderOutput{Status: "cancelled", ReleasedThousandths: 0}) {
		t.Fatalf("draft cancel = %+v, want zero released", draftCancelled)
	}

	partialOrder := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 30000, UnitPriceMinor: 20000, SKU: crmStringPointer("SO-CHAIR")},
	})
	salesConfirmDraft(t, fx, claims, partialOrder.OrderID, nil, now)
	var partialLineID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM sales_order_lines WHERE order_id=$1::uuid`, partialOrder.OrderID).Scan(&partialLineID); err != nil {
		t.Fatal(err)
	}
	salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesDeliverOrderOutput, error) {
		lines := []SalesDeliverOrderLineInput{{LineID: partialLineID, QuantityThousandths: 18000}}
		return salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: partialOrder.OrderID, Lines: &lines}, now)
	})
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesCancelOrder(fx.ctx, tx, fx.orgID, SalesCancelOrderInput{OrderID: partialOrder.OrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order is partially delivered; unwind through invoice reversal instead" {
		t.Fatalf("partial cancel error = %v", err)
	}
	salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesDeliverOrderOutput, error) {
		return salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: partialOrder.OrderID}, now)
	})
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesCancelOrder(fx.ctx, tx, fx.orgID, SalesCancelOrderInput{OrderID: partialOrder.OrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order is fully delivered; unwind through invoice reversal instead" {
		t.Fatalf("delivered cancel error = %v", err)
	}
}

func TestSalesOrdersListScopeStatusAndTenantIsolation(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := salesTestClaims(fx)
	now := time.Now().UTC().Truncate(time.Millisecond)
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Local buyer")
	foreignCustomer := seedCRMDealCustomer(t, fx, fx.otherOrgID, "Foreign buyer")
	var foreignOrderID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO sales_orders (org_id, number, customer_id, status)
		VALUES ($1::uuid, 5, $2::uuid, 'draft') RETURNING id::text`, fx.otherOrgID, foreignCustomer).Scan(&foreignOrderID); err != nil {
		t.Fatal(err)
	}

	first := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Probe Chair", Quantity: 30000, UnitPriceMinor: 20000, TaxMinor: crmInt64Pointer(60000)},
	})
	second := salesCreateDraft(t, fx, claims, customerID, []SalesOrderLineInput{
		{Description: "Consulting half-day", Quantity: 1000, UnitPriceMinor: 10000},
	})
	salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesCancelOrderOutput, error) {
		return salesCancelOrder(fx.ctx, tx, fx.orgID, SalesCancelOrderInput{OrderID: second.OrderID}, now)
	})

	listed := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesListOrdersOutput, error) {
		return salesListOrders(fx.ctx, tx, fx.orgID, SalesListOrdersInput{})
	})
	if len(listed.Orders) != 2 {
		t.Fatalf("listed %d orders, want 2 own-org orders", len(listed.Orders))
	}
	if listed.Orders[0].ID != second.OrderID || listed.Orders[0].Number != 2 || listed.Orders[0].Status != "cancelled" ||
		listed.Orders[0].CustomerID != customerID || listed.Orders[0].Backordered || listed.Orders[0].TotalMinor != 10000 {
		t.Fatalf("newest order = %+v, want cancelled number 2 with 10000 total", listed.Orders[0])
	}
	if listed.Orders[1].ID != first.OrderID || listed.Orders[1].Number != 1 || listed.Orders[1].Status != "draft" || listed.Orders[1].TotalMinor != 660000 {
		t.Fatalf("oldest order = %+v, want draft number 1 with 660000 total", listed.Orders[1])
	}
	if listed.Orders[1].CreatedAt == "" || listed.Orders[1].CreatedAt[len(listed.Orders[1].CreatedAt)-1] != 'Z' {
		t.Fatalf("createdAt = %q, want ISO millisecond string", listed.Orders[1].CreatedAt)
	}

	draftOnly := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesListOrdersOutput, error) {
		return salesListOrders(fx.ctx, tx, fx.orgID, SalesListOrdersInput{Status: crmStringPointer("draft")})
	})
	if len(draftOnly.Orders) != 1 || draftOnly.Orders[0].ID != first.OrderID {
		t.Fatalf("draft filter = %+v, want only the draft order", draftOnly.Orders)
	}
	cancelledOnly := salesInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (SalesListOrdersOutput, error) {
		return salesListOrders(fx.ctx, tx, fx.orgID, SalesListOrdersInput{Status: crmStringPointer("cancelled")})
	})
	if len(cancelledOnly.Orders) != 1 || cancelledOnly.Orders[0].ID != second.OrderID {
		t.Fatalf("cancelled filter = %+v, want only the cancelled order", cancelledOnly.Orders)
	}

	err := salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesConfirmOrder(fx.ctx, tx, claims, SalesConfirmOrderInput{OrderID: foreignOrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order not found" {
		t.Fatalf("foreign confirm error = %v, want order not found", err)
	}
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesCancelOrder(fx.ctx, tx, fx.orgID, SalesCancelOrderInput{OrderID: foreignOrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order not found" {
		t.Fatalf("foreign cancel error = %v, want order not found", err)
	}
	err = salesErrInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) error {
		_, err := salesDeliverOrder(fx.ctx, tx, claims, SalesDeliverOrderInput{OrderID: foreignOrderID}, now)
		return err
	})
	if err == nil || err.Error() != "order not found" {
		t.Fatalf("foreign deliver error = %v, want order not found", err)
	}
	if got := fx.count(`SELECT count(*) FROM sales_orders WHERE id=$1::uuid AND status='draft'`, foreignOrderID); got != 1 {
		t.Fatalf("foreign order changed by cross-tenant call, rows=%d", got)
	}
	if got := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid AND ref_id=$2::uuid`, fx.otherOrgID, foreignOrderID); got != 0 {
		t.Fatalf("foreign order reservations = %d, want none", got)
	}
}
