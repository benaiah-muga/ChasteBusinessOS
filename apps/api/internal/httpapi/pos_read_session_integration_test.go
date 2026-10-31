package httpapi

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresPosReadReaderUsesRuntimeRLSAndMapsSaleReturns(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed the POS read integration fixture")
		}
		t.Skip("DATABASE_URL is required to seed the POS read integration fixture")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	orgID := integrationUUID(t)
	otherOrgID := integrationUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go POS read fixture', $2), ($3::uuid, 'Go POS other fixture', $4)`,
		orgID, "go-pos-read-"+orgID[:8], otherOrgID, "go-pos-read-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin POS fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable POS ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM pos_return_lines WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS return line fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM pos_returns WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS return fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM payments WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS payment fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM stock_movements WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS stock movement fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS invoice fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM pos_sessions WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS session fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS journal line fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS journal fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM items WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS item fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM accounts WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS account fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS customer fixtures: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete POS organization fixtures: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit POS fixture cleanup: %v", err)
		}
	})

	var customerID, otherCustomerID string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'POS buyer') RETURNING id::text`, orgID).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Foreign POS buyer') RETURNING id::text`, otherOrgID).Scan(&otherCustomerID); err != nil {
		t.Fatal(err)
	}
	for _, org := range []struct{ id, prefix string }{{orgID, "POS"}, {otherOrgID, "Foreign POS"}} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO accounts (org_id, code, name, type) VALUES
			($1::uuid, '1000', $2 || ' cash', 'asset'), ($1::uuid, '4000', $2 || ' sales', 'income')`, org.id, org.prefix); err != nil {
			t.Fatal(err)
		}
	}
	openedAt := time.Date(2026, 10, 5, 8, 15, 30, 0, time.UTC)
	closedAt := time.Date(2026, 10, 5, 12, 45, 0, 0, time.UTC)
	var sessionID, otherSessionID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO pos_sessions (org_id, register, status, opened_at, closed_at)
		VALUES ($1::uuid, 'Main', 'closed', $2, $3) RETURNING id::text`, orgID, openedAt, closedAt).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO pos_sessions (org_id, register) VALUES ($1::uuid, 'Foreign') RETURNING id::text`, otherOrgID).Scan(&otherSessionID); err != nil {
		t.Fatal(err)
	}

	var trackedItemID, unmatchedItemID, foreignItemID string
	for _, item := range []struct {
		orgID string
		name  string
		into  *string
	}{
		{orgID: orgID, name: "Tracked POS item", into: &trackedItemID},
		{orgID: orgID, name: "Unmatched stock item", into: &unmatchedItemID},
		{orgID: otherOrgID, name: "Foreign POS item", into: &foreignItemID},
	} {
		if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name) VALUES ($1::uuid, $2, $3) RETURNING id::text`, item.orgID, "SKU-"+integrationUUID(t)[:8], item.name).Scan(item.into); err != nil {
			t.Fatal(err)
		}
	}

	type saleSeed struct {
		orgID, customerID, sessionID, memo string
		number                             int
		creditedMinor                      int
		createdAt                          time.Time
	}
	seedSale := func(seed saleSeed) string {
		t.Helper()
		var invoiceID string
		err := owner.QueryRow(ctx, `
			INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, credited_minor, memo, pos_session_id, created_at)
			VALUES ($1::uuid, $2::uuid, $3, 'paid', 'USD', 2000, 0, 2000, $4, $5, $6::uuid, $7)
			RETURNING id::text`, seed.orgID, seed.customerID, seed.number, seed.creditedMinor, seed.memo, seed.sessionID, seed.createdAt).Scan(&invoiceID)
		if err != nil {
			t.Fatal(err)
		}
		return invoiceID
	}
	seedLine := func(invoiceID string, itemID *string, description string) string {
		t.Helper()
		var lineID string
		if err := owner.QueryRow(ctx, `
			INSERT INTO invoice_lines (invoice_id, item_id, description, quantity, unit_price_minor, tax_minor)
			VALUES ($1::uuid, $2::uuid, $3, 1000, 2000, 0) RETURNING id::text`, invoiceID, itemID, description).Scan(&lineID); err != nil {
			t.Fatal(err)
		}
		return lineID
	}
	seedReturn := func(orgID, invoiceID, lineID string, refundMinor, quantity int) {
		t.Helper()
		tx, err := owner.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		var entryID, returnID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO journal_entries (org_id, memo, source_type, source_id, posted_by_actor_type)
			VALUES ($1::uuid, 'POS return fixture', 'pos_return', $2::uuid, 'human') RETURNING id::text`, orgID, invoiceID).Scan(&entryID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
			VALUES
			($1::uuid, (SELECT id FROM accounts WHERE org_id = $2::uuid AND code = '1000'), $3, 0),
			($1::uuid, (SELECT id FROM accounts WHERE org_id = $2::uuid AND code = '4000'), 0, $3)`, entryID, orgID, refundMinor); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO pos_returns (org_id, invoice_id, entry_id, refund_method, refund_minor, reason)
			VALUES ($1::uuid, $2::uuid, $3::uuid, 'cash', $4, 'fixture return') RETURNING id::text`, orgID, invoiceID, entryID, refundMinor).Scan(&returnID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO pos_return_lines (org_id, return_id, invoice_line_id, quantity, subtotal_minor, tax_minor)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 0)`, orgID, returnID, lineID, quantity, refundMinor); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	seedPayment := func(orgID, invoiceID, method string) {
		t.Helper()
		if _, err := owner.Exec(ctx, `INSERT INTO payments (org_id, invoice_id, amount_minor, method) VALUES ($1::uuid, $2::uuid, 1000, $3)`, orgID, invoiceID, method); err != nil {
			t.Fatal(err)
		}
	}
	seedStock := func(orgID, itemID, invoiceID string) {
		t.Helper()
		if _, err := owner.Exec(ctx, `
			INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, ref_type, ref_id, actor_type)
			VALUES ($1::uuid, $2::uuid, -1000, 'sale', 'invoice', $3::uuid, 'human')`, orgID, itemID, invoiceID); err != nil {
			t.Fatal(err)
		}
	}

	baseAt := time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC)
	itemizedID := seedSale(saleSeed{orgID: orgID, customerID: customerID, sessionID: sessionID, number: 10, creditedMinor: 600, memo: "POS (cash)", createdAt: baseAt})
	itemizedLineID := seedLine(itemizedID, &trackedItemID, "Tracked line")
	seedPayment(orgID, itemizedID, "cash")
	seedPayment(orgID, itemizedID, "card")
	seedReturn(orgID, itemizedID, itemizedLineID, 600, 250)
	seedStock(orgID, trackedItemID, itemizedID)

	creditReviewID := seedSale(saleSeed{orgID: orgID, customerID: customerID, sessionID: sessionID, number: 11, creditedMinor: 900, memo: "POS (card)", createdAt: baseAt.Add(time.Minute)})
	creditReviewLineID := seedLine(creditReviewID, nil, "Credit review line")
	seedReturn(orgID, creditReviewID, creditReviewLineID, 400, 100)

	legacyFullID := seedSale(saleSeed{orgID: orgID, customerID: customerID, sessionID: sessionID, number: 12, creditedMinor: 0, memo: "POS (mobile_money)", createdAt: baseAt.Add(2 * time.Minute)})
	seedLine(legacyFullID, nil, "Legacy custom line")
	seedStock(orgID, unmatchedItemID, legacyFullID)

	foreignID := seedSale(saleSeed{orgID: otherOrgID, customerID: otherCustomerID, sessionID: otherSessionID, number: 99, creditedMinor: 0, memo: "POS (cash)", createdAt: baseAt.Add(3 * time.Minute)})
	seedLine(foreignID, &foreignItemID, "Foreign line")
	seedStock(otherOrgID, foreignItemID, foreignID)

	data, err := (postgresPosReadReader{pool: runtime}).Read(ctx, orgID)
	if err != nil {
		t.Fatalf("read POS data through runtime RLS: %v", err)
	}
	if len(data.Sessions) != 1 || data.Sessions[0].ID != sessionID || data.Sessions[0].OpenedAt != "2026-10-05T08:15:30.000Z" || data.Sessions[0].ClosedAt == nil || *data.Sessions[0].ClosedAt != "2026-10-05T12:45:00.000Z" {
		t.Fatalf("sessions = %+v, want only tenant session with normalized timestamps", data.Sessions)
	}
	if len(data.Sales) != 3 {
		t.Fatalf("sales = %+v, want three tenant sales and no foreign sale", data.Sales)
	}
	byNumber := make(map[int64]posReadSale, len(data.Sales))
	for _, sale := range data.Sales {
		byNumber[sale.Number] = sale
		if sale.ID == foreignID {
			t.Fatalf("foreign tenant sale %s leaked into POS reader result", foreignID)
		}
	}
	itemized := byNumber[10]
	if itemized.ID != itemizedID || itemized.Method != "cash + card" || itemized.ReturnMode != "itemized" ||
		itemized.CreditedMinor != 600 || itemized.UnallocatedCreditMinor != 0 || len(itemized.Lines) != 1 ||
		itemized.Lines[0].ReturnedQuantity != 250 || !itemized.Lines[0].StockTracked ||
		itemized.CreatedAt != "2026-10-05T09:00:00.000Z" {
		t.Fatalf("itemized sale = %+v, want tender, structured return, tracked line, and timestamp", itemized)
	}
	creditReview := byNumber[11]
	if creditReview.ID != creditReviewID || creditReview.ReturnMode != "credit-review" || creditReview.UnallocatedCreditMinor != 500 ||
		len(creditReview.Lines) != 1 || creditReview.Lines[0].ReturnedQuantity != 100 || creditReview.Lines[0].StockTracked {
		t.Fatalf("credit review sale = %+v, want structured plus unallocated credit without stock tracking", creditReview)
	}
	legacyFull := byNumber[12]
	if legacyFull.ID != legacyFullID || legacyFull.ReturnMode != "legacy-full" || legacyFull.Method != "mobile_money" ||
		len(legacyFull.Lines) != 1 || legacyFull.Lines[0].StockTracked {
		t.Fatalf("legacy full sale = %+v, want memo tender fallback and unmatched stock leg", legacyFull)
	}

	customers, err := (postgresPosCustomersReader{pool: runtime}).Read(ctx, orgID)
	if err != nil {
		t.Fatalf("read POS customer options through runtime RLS: %v", err)
	}
	if len(customers.Customers) != 1 || customers.Customers[0].ID != customerID ||
		customers.Customers[0].PurchaseCount != 3 || customers.Customers[0].LifetimeSpendMinor != 4500 {
		t.Fatalf("POS customers = %+v, want only the tenant customer with three sales and 4500 net spend", customers.Customers)
	}
}
