package capability

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func seedPurchasingReadsVendorWithPO(t *testing.T, fx *executorFixture, poNumber int64, orderedAt, promisedAt *time.Time) (vendorID, poID string) {
	t.Helper()
	vendorID = seedPurchasingVendor(t, fx, fx.orgID, nil)
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, memo, ordered_at, promised_at)
		VALUES ($1::uuid, $2::uuid, $3, 'ordered', 'wave8', $4, $5)
		RETURNING id::text`, fx.orgID, vendorID, poNumber, orderedAt, promisedAt).Scan(&poID); err != nil {
		t.Fatal(err)
	}
	return vendorID, poID
}

func TestPurchasingReadsParsersMirrorZodContracts(t *testing.T) {
	if _, err := ParsePurchasingSupplierPerformanceInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("performance parse err=%v", err)
	}
	history, err := ParsePurchasingPriceHistoryInput(json.RawMessage(`{"sku":"WIRE"}`))
	if err != nil || history.SKU == nil || *history.SKU != "WIRE" {
		t.Fatalf("priceHistory parse=%+v err=%v", history, err)
	}
	noFilter, err := ParsePurchasingPriceHistoryInput(json.RawMessage(`{}`))
	if err != nil || noFilter.SKU != nil {
		t.Fatalf("priceHistory unfiltered parse=%+v err=%v", noFilter, err)
	}
	if _, err := ParsePurchasingSupplierStatementInput(json.RawMessage(`{"vendorId":"nope"}`)); err == nil {
		t.Fatal("bad vendor uuid refused")
	}
	if _, err := parsePurchasingReadsInput(purchasingSupplierStatementCapabilityID, json.RawMessage(`{"vendorId":"8c1e6f4a-2b3d-4e5f-8a9b-0c1d2e3f4a5b"}`)); err != nil {
		t.Fatalf("dispatcher refused statement: %v", err)
	}
	if _, err := parsePurchasingReadsInput("purchasing.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("dispatcher refused unknown id")
	}
}

func TestPurchasingReadsSupplierAnalytics(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin reads cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable reads cleanup: %v", err)
			return
		}
		for _, stmt := range []string{
			`DELETE FROM goods_receipt_lines WHERE org_id=$1::uuid`,
			`DELETE FROM goods_receipts WHERE org_id=$1::uuid`,
			`DELETE FROM po_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE org_id=$1::uuid)`,
			`DELETE FROM purchase_orders WHERE org_id=$1::uuid`,
			`DELETE FROM vendor_payments WHERE org_id=$1::uuid`,
			`DELETE FROM vendor_bills WHERE org_id=$1::uuid`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id=$1::uuid)`,
			`DELETE FROM journal_entries WHERE org_id=$1::uuid`,
			`DELETE FROM items WHERE org_id=$1::uuid`,
			`DELETE FROM vendors WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("reads cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit reads cleanup: %v", err)
		}
	})

	orderedAt := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	promisedAt := time.Date(2026, 8, 8, 9, 0, 0, 0, time.UTC)
	receivedAt := time.Date(2026, 8, 5, 9, 0, 0, 0, time.UTC)
	vendorID, poID := seedPurchasingReadsVendorWithPO(t, fx, 1, &orderedAt, &promisedAt)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, memo, ordered_at, promised_at, backordered)
		VALUES ($1::uuid, $2::uuid, 2, 'void', 'void wave8 order', $3, $4, true)`,
		fx.orgID, vendorID, orderedAt, promisedAt); err != nil {
		t.Fatal(err)
	}
	itemID := seedManufacturingBomItem(t, fx, fx.orgID, "WIRE", "Wire")

	var poLineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO po_lines (po_id, position, item_id, description, quantity, unit_price_minor)
		VALUES ($1::uuid, 1, $2::uuid, 'Copper wire', 2000, 45000)
		RETURNING id::text`, poID, itemID).Scan(&poLineID); err != nil {
		t.Fatal(err)
	}
	var receiptID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO goods_receipts (org_id, po_id, number, received_at, received_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 1, $3, 'human') RETURNING id::text`,
		fx.orgID, poID, receivedAt).Scan(&receiptID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, rejected_thousandths, returned_thousandths)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 2000, 0, 200)`, fx.orgID, receiptID, poLineID); err != nil {
		t.Fatal(err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		performance, err := purchasingSupplierPerformance(context.Background(), tx, fx.orgID, PurchasingSupplierPerformanceInput{})
		if err != nil {
			return struct{}{}, err
		}
		if len(performance.Vendors) != 1 {
			t.Fatalf("performance vendors=%d, want one", len(performance.Vendors))
		}
		vendor := performance.Vendors[0]
		if vendor.Orders != 1 || vendor.BackorderedOrders != 0 {
			t.Fatalf("vendor summary=%+v, want one on-time order", vendor)
		}
		if vendor.AvgLeadTimeDays == nil || *vendor.AvgLeadTimeDays != 4 {
			t.Fatalf("avgLeadTimeDays=%v, want 4 days", vendor.AvgLeadTimeDays)
		}
		if vendor.OnTimeRate == nil || *vendor.OnTimeRate != 100 {
			t.Fatalf("onTimeRate=%v, want 100", vendor.OnTimeRate)
		}
		if vendor.FillRate == nil || *vendor.FillRate != 90 {
			t.Fatalf("fillRate=%v, want 90 after the 200 returned thousandths", vendor.FillRate)
		}

		history, err := purchasingPriceHistory(context.Background(), tx, fx.orgID, PurchasingPriceHistoryInput{SKU: strPtrPurchasing("WIRE")})
		if err != nil {
			return struct{}{}, err
		}
		if len(history.Rows) != 1 || history.Rows[0].UnitPriceMinor != 45000 || history.Rows[0].ItemSKU == nil || *history.Rows[0].ItemSKU != "WIRE" {
			t.Fatalf("priceHistory rows=%+v, want the WIRE line", history.Rows)
		}
		unfiltered, err := purchasingPriceHistory(context.Background(), tx, fx.orgID, PurchasingPriceHistoryInput{})
		if err != nil || len(unfiltered.Rows) != 1 {
			t.Fatalf("unfiltered priceHistory rows=%d err=%v, want one", len(unfiltered.Rows), err)
		}

		if _, err := tx.Exec(context.Background(), `
			INSERT INTO vendor_bills (org_id, vendor_id, number, status, total_minor, paid_minor, credited_minor, bill_date, currency)
			VALUES ($1::uuid, $2::uuid, 1, 'open', 90000, 0, 0, $3, 'USD')`,
			fx.orgID, vendorID, time.Date(2026, 8, 6, 9, 0, 0, 0, time.UTC)); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, '2000', 'Accounts Payable', 'liability'), ($1::uuid, '1000', 'Cash', 'asset')`, fx.orgID); err != nil {
			return struct{}{}, err
		}
		var billID, entryID string
		if err := tx.QueryRow(context.Background(), `SELECT id::text FROM vendor_bills WHERE org_id=$1::uuid AND number=1`, fx.orgID).Scan(&billID); err != nil {
			return struct{}{}, err
		}
		if err := tx.QueryRow(context.Background(), `
			INSERT INTO journal_entries (org_id, memo, source_type, source_id, currency, posted_at, posted_by_actor_type)
			VALUES ($1::uuid, 'vendor credit', 'vendor_credit_note', $2::uuid, 'USD', $3, 'human') RETURNING id::text`,
			fx.orgID, billID, time.Date(2026, 8, 7, 9, 0, 0, 0, time.UTC)).Scan(&entryID); err != nil {
			return struct{}{}, err
		}
		var accountID string
		if err := tx.QueryRow(context.Background(), `SELECT id::text FROM accounts WHERE org_id=$1::uuid AND code='2000'`, fx.orgID).Scan(&accountID); err != nil {
			return struct{}{}, err
		}
		var cashID string
		if err := tx.QueryRow(context.Background(), `SELECT id::text FROM accounts WHERE org_id=$1::uuid AND code='1000'`, fx.orgID).Scan(&cashID); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
			VALUES ($1::uuid, $2::uuid, 10000, 0), ($1::uuid, $3::uuid, 0, 10000)`, entryID, accountID, cashID); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO vendor_payments (org_id, bill_id, amount_minor, paid_at)
			VALUES ($1::uuid, $2::uuid, 40000, $3)`,
			fx.orgID, billID, time.Date(2026, 8, 9, 9, 0, 0, 0, time.UTC)); err != nil {
			return struct{}{}, err
		}

		statement, err := purchasingSupplierStatement(context.Background(), tx, fx.orgID, PurchasingSupplierStatementInput{VendorID: vendorID})
		if err != nil {
			return struct{}{}, err
		}
		if len(statement.Rows) != 3 {
			t.Fatalf("statement rows=%d, want bill, credit, payment", len(statement.Rows))
		}
		if statement.Rows[0].Kind != "bill" || statement.Rows[0].AmountMinor != 90000 || statement.Rows[0].BalanceMinor != 90000 {
			t.Fatalf("statement bill row=%+v, want gross 90000", statement.Rows[0])
		}
		if statement.Rows[1].Kind != "credit_note" || statement.Rows[1].AmountMinor != -10000 || statement.Rows[1].BalanceMinor != 80000 {
			t.Fatalf("statement credit row=%+v, want -10000 credit", statement.Rows[1])
		}
		if statement.Rows[2].Kind != "payment" || statement.Rows[2].AmountMinor != -40000 {
			t.Fatalf("statement payment row=%+v, want -40000 payment", statement.Rows[2])
		}
		if statement.ClosingBalanceMinor != 40000 {
			t.Fatalf("closing balance=%d, want 40000", statement.ClosingBalanceMinor)
		}
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
}

func strPtrPurchasing(v string) *string {
	return &v
}
