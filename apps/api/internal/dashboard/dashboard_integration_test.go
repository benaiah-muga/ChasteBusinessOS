package dashboard

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresDashboardReaderMatchesLegacyAndScopesOrganizations(t *testing.T) {
	ctx := context.Background()
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
			t.Fatal("DATABASE_URL is required to seed dashboard integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed dashboard fixtures")
	}
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

	orgID, otherOrgID := dashboardUUID(t), dashboardUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug, base_currency) VALUES
		($1::uuid, 'Go dashboard fixture', $2, 'UGX'),
		($3::uuid, 'Go dashboard other fixture', $4, 'UGX')`,
		orgID, "go-dashboard-"+orgID[:8], otherOrgID, "go-dashboard-other-"+otherOrgID[:8],
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := purgeDashboardFixture(context.Background(), owner, orgID, otherOrgID); err != nil {
			t.Errorf("purge dashboard fixture: %v", err)
		}
	})

	seedDashboardFixture(t, ctx, owner, orgID, otherOrgID)

	readAt := time.Date(2026, time.June, 15, 12, 0, 0, 123_000_000, time.UTC)
	got, err := NewPostgresReader(runtime).ForOrg(ctx, orgID, readAt, ReportReadAccess{
		IncomeStatement: true,
		BalanceSheet:    true,
		TrialBalance:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	assertDashboardFixture(t, got)

	visibleForeignDeals, err := dbx.WithOrgTx(ctx, runtime, orgID, func(tx pgx.Tx) (int64, error) {
		var count int64
		err := tx.QueryRow(ctx, `SELECT count(*) FROM deals WHERE org_id = $1::uuid`, otherOrgID).Scan(&count)
		return count, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if visibleForeignDeals != 0 {
		t.Fatalf("runtime role saw %d deal(s) from another organization", visibleForeignDeals)
	}
}

type dashboardFixtureIDs struct {
	accounts  map[string]string
	documents []string
}

func seedDashboardFixture(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, otherOrgID string) {
	t.Helper()
	ids := dashboardFixtureIDs{accounts: make(map[string]string)}
	accountRows := []struct {
		code     string
		name     string
		typeName string
	}{
		{code: "1000", name: "Cash", typeName: "asset"},
		{code: "2000", name: "Payable", typeName: "liability"},
		{code: "3000", name: "Retained earnings", typeName: "equity"},
		{code: "4000", name: "Sales", typeName: "income"},
		{code: "6000", name: "Operating expense", typeName: "expense"},
	}
	for _, account := range accountRows {
		var id string
		if err := owner.QueryRow(ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`, orgID, account.code, account.name, account.typeName).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids.accounts[account.code] = id
	}
	otherCash, otherIncome := insertAccount(t, ctx, owner, otherOrgID, "1000", "Other cash", "asset"), insertAccount(t, ctx, owner, otherOrgID, "4000", "Other income", "income")

	journalTx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	insertDashboardEntry(t, ctx, journalTx, orgID, "Operating income", "UGX", "operational", time.Date(2026, time.January, 10, 12, 0, 0, 0, time.UTC), []journalLineFixture{
		{accountID: ids.accounts["1000"], debit: 10_000}, {accountID: ids.accounts["4000"], credit: 10_000},
	})
	insertDashboardEntry(t, ctx, journalTx, orgID, "Operating expense", "UGX", "operational", time.Date(2026, time.January, 11, 12, 0, 0, 0, time.UTC), []journalLineFixture{
		{accountID: ids.accounts["6000"], debit: 2_000}, {accountID: ids.accounts["1000"], credit: 2_000},
	})
	insertDashboardEntry(t, ctx, journalTx, orgID, "Foreign currency income", "USD", "operational", time.Date(2026, time.May, 1, 12, 0, 0, 0, time.UTC), []journalLineFixture{
		{accountID: ids.accounts["1000"], debit: 500}, {accountID: ids.accounts["4000"], credit: 500},
	})
	insertDashboardEntry(t, ctx, journalTx, orgID, "Year-end close", "UGX", "year_end_close", time.Date(2026, time.June, 1, 12, 0, 0, 0, time.UTC), []journalLineFixture{
		{accountID: ids.accounts["4000"], debit: 10_000},
		{accountID: ids.accounts["6000"], credit: 2_000},
		{accountID: ids.accounts["3000"], credit: 8_000},
	})
	insertDashboardEntry(t, ctx, journalTx, otherOrgID, "Other organization income", "UGX", "operational", time.Date(2026, time.January, 10, 12, 0, 0, 0, time.UTC), []journalLineFixture{
		{accountID: otherCash, debit: 999_999}, {accountID: otherIncome, credit: 999_999},
	})
	if err := journalTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	customerID := insertCustomer(t, ctx, owner, orgID, "Dashboard customer")
	otherCustomerID := insertCustomer(t, ctx, owner, otherOrgID, "Other customer")
	issueAt := time.Date(2026, time.May, 1, 12, 0, 0, 0, time.UTC)
	dueAt := time.Date(2026, time.May, 1, 12, 0, 0, 0, time.UTC)
	_, err = owner.Exec(ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, issued_at, due_at) VALUES
		($1::uuid, $2::uuid, 1, 'sent', 10000, 0, 10000, 3000, 1000, $3, $4),
		($1::uuid, $2::uuid, 2, 'draft', 5000, 0, 5000, 5000, 0, $3, $4),
		($1::uuid, $2::uuid, 3, 'sent', 4000, 0, 4000, 0, 0, $3, NULL),
		($1::uuid, $2::uuid, 4, 'void', 90000, 0, 90000, 0, 0, $3, $4),
		($1::uuid, $2::uuid, 5, 'sent', 80000, 0, 80000, 0, 0, $3, $4)`,
		orgID, customerID, issueAt, dueAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `UPDATE invoices SET voided_at = $2 WHERE org_id = $1::uuid AND number = 5`, orgID, issueAt)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at) VALUES ($1::uuid, $2::uuid, 1, 'sent', 700000, 0, 700000, $3)`, otherOrgID, otherCustomerID, issueAt)
	if err != nil {
		t.Fatal(err)
	}

	var vendorID string
	if err := owner.QueryRow(ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Fixture vendor') RETURNING id::text`, orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	var otherVendorID string
	if err := owner.QueryRow(ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Other vendor') RETURNING id::text`, otherOrgID).Scan(&otherVendorID); err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, total_minor, paid_minor, credited_minor) VALUES
		($1::uuid, $2::uuid, 1, 'open', 8000, 1000, 2000),
		($1::uuid, $2::uuid, 2, 'void', 90000, 0, 0),
		($3::uuid, $4::uuid, 1, 'open', 500000, 0, 0)`, orgID, vendorID, otherOrgID, otherVendorID)
	if err != nil {
		t.Fatal(err)
	}

	for _, deal := range []struct {
		stage string
		value int64
	}{{"lead", 5}, {"qualified", 5}, {"proposal", 3}, {"negotiation", 7}, {"won", 10}, {"lost", 11}} {
		if _, err := owner.Exec(ctx, `INSERT INTO deals (org_id, title, stage, value_minor) VALUES ($1::uuid, 'Fixture deal', $2, $3)`, orgID, deal.stage, deal.value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := owner.Exec(ctx, `INSERT INTO deals (org_id, title, stage, value_minor) VALUES ($1::uuid, 'Other deal', 'lead', 999999)`, otherOrgID); err != nil {
		t.Fatal(err)
	}

	var activeEmployee, inactiveEmployee string
	if err := owner.QueryRow(ctx, `INSERT INTO employees (org_id, name, monthly_salary_minor) VALUES ($1::uuid, 'Active fixture', 1000) RETURNING id::text`, orgID).Scan(&activeEmployee); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO employees (org_id, name, monthly_salary_minor, deactivated_at) VALUES ($1::uuid, 'Inactive fixture', 1000, now()) RETURNING id::text`, orgID).Scan(&inactiveEmployee); err != nil {
		t.Fatal(err)
	}
	for _, leave := range []struct {
		employeeID string
		status     string
	}{{activeEmployee, "pending"}, {inactiveEmployee, "approved"}} {
		_, err := owner.Exec(ctx, `
			INSERT INTO leave_requests (org_id, employee_id, start_date, end_date, calendar_days, status, requested_by_actor_type)
			VALUES ($1::uuid, $2::uuid, $3, $3, 1, $4, 'human')`, orgID, leave.employeeID, issueAt, leave.status)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = owner.Exec(ctx, `INSERT INTO pos_sessions (org_id, register, status) VALUES ($1::uuid, 'Front register', 'open'), ($1::uuid, 'Back register', 'closed')`, orgID)
	if err != nil {
		t.Fatal(err)
	}

	for _, item := range []struct {
		sku     string
		name    string
		reorder int64
		stock   int64
	}{{"LOW", "Low stock", 1000, 500}, {"OK", "Adequate stock", 1000, 1500}, {"EMPTY", "No movement", 500, 0}} {
		var itemID string
		if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name, reorder_point_thousandths) VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`, orgID, item.sku, item.name, item.reorder).Scan(&itemID); err != nil {
			t.Fatal(err)
		}
		if item.stock != 0 {
			if _, err := owner.Exec(ctx, `INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, actor_type) VALUES ($1::uuid, $2::uuid, $3, 'adjustment', 'human')`, orgID, itemID, item.stock); err != nil {
				t.Fatal(err)
			}
		}
	}

	var parsedDocID string
	if err := owner.QueryRow(ctx, `INSERT INTO documents (org_id, title, source_type, status, created_by_actor_type) VALUES ($1::uuid, 'Parsed fixture', 'text', 'parsed', 'human') RETURNING id::text`, orgID).Scan(&parsedDocID); err != nil {
		t.Fatal(err)
	}
	ids.documents = append(ids.documents, parsedDocID)
	if err := owner.QueryRow(ctx, `INSERT INTO documents (org_id, title, source_type, status, created_by_actor_type) VALUES ($1::uuid, 'Failed fixture', 'text', 'failed', 'human') RETURNING id::text`, orgID).Scan(&parsedDocID); err != nil {
		t.Fatal(err)
	}
	ids.documents = append(ids.documents, parsedDocID)
	if _, err := owner.Exec(ctx, `INSERT INTO document_suggestions (org_id, document_id, description, suggested_account_code, status) VALUES ($1::uuid, $2::uuid, 'Open fixture suggestion', '6000', 'open'), ($1::uuid, $2::uuid, 'Dismissed fixture suggestion', '6000', 'dismissed')`, orgID, ids.documents[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO approvals (org_id, capability_id, risk_class, payload, status) VALUES ($1::uuid, 'accounting.postJournalEntry', 'money', '{}'::jsonb, 'pending'), ($1::uuid, 'accounting.postJournalEntry', 'money', '{}'::jsonb, 'approved')`, orgID); err != nil {
		t.Fatal(err)
	}

	for index := 1; index <= 9; index++ {
		_, err := owner.Exec(ctx, `
			INSERT INTO ledger_events (org_id, actor_type, kind, capability_id, payload, hash, occurred_at)
			VALUES ($1::uuid, 'human', $2, CASE WHEN $3 % 2 = 0 THEN 'crm.createCustomer' ELSE NULL END, '{}'::jsonb, $4, $5)`,
			orgID, fmt.Sprintf("fixture.activity.%d", index), index, fmt.Sprintf("dashboard-hash-%s-%d", orgID[:8], index), issueAt.Add(time.Duration(index)*time.Second),
		)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = owner.Exec(ctx, `
		INSERT INTO ledger_events (org_id, actor_type, kind, payload, hash, occurred_at)
		VALUES ($1::uuid, 'system', 'fixture.activity.other-org', '{}'::jsonb, $2, $3)`, otherOrgID, "dashboard-other-hash-"+otherOrgID[:8], issueAt.Add(20*time.Second))
	if err != nil {
		t.Fatal(err)
	}
}

type journalLineFixture struct {
	accountID string
	debit     int64
	credit    int64
}

func insertDashboardEntry(t *testing.T, ctx context.Context, tx pgx.Tx, orgID, memo, currency, kind string, postedAt time.Time, lines []journalLineFixture) {
	t.Helper()
	var entryID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO journal_entries (org_id, memo, currency, entry_kind, posted_at, posted_by_actor_type)
		VALUES ($1::uuid, $2, $3, $4, $5, 'human') RETURNING id::text`, orgID, memo, currency, kind, postedAt).Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		if _, err := tx.Exec(ctx, `INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor) VALUES ($1::uuid, $2::uuid, $3, $4)`, entryID, line.accountID, line.debit, line.credit); err != nil {
			t.Fatal(err)
		}
	}
}

func insertAccount(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, code, name, typeName string) string {
	t.Helper()
	var id string
	if err := owner.QueryRow(ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`, orgID, code, name, typeName).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func insertCustomer(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, name string) string {
	t.Helper()
	var id string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, $2) RETURNING id::text`, orgID, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func assertDashboardFixture(t *testing.T, payload Payload) {
	t.Helper()
	if payload.Money.RevenueMinor != 10_000 || payload.Money.ExpenseMinor != 2_000 || payload.Money.NetIncomeMinor != 8_000 || payload.Money.CashMinor == nil || *payload.Money.CashMinor != 8_500 || payload.Money.Balanced == nil || !*payload.Money.Balanced || payload.Money.AssetsMinor != 8_000 || payload.Money.LiabilitiesMinor != 0 || payload.Money.EquityMinor != 8_000 {
		t.Fatalf("money = %+v, want base-currency statements, cross-currency cash and year-close behavior", payload.Money)
	}
	if payload.WorkingCapital != (WorkingCapital{AROutstandingMinor: 10_000, OverdueCount: 2, OverdueAmountMinor: 10_000, APOutstandingMinor: 5_000}) {
		t.Fatalf("working capital = %+v, want credited balances with void filtering", payload.WorkingCapital)
	}
	wantStages := []PipelineStage{
		{Stage: "lead", Count: 1, ValueMinor: 5}, {Stage: "qualified", Count: 1, ValueMinor: 5},
		{Stage: "proposal", Count: 1, ValueMinor: 3}, {Stage: "negotiation", Count: 1, ValueMinor: 7},
		{Stage: "won", Count: 1, ValueMinor: 10}, {Stage: "lost", Count: 1, ValueMinor: 11},
	}
	if len(payload.Pipeline.Stages) != len(wantStages) || payload.Pipeline.OpenCount != 4 || payload.Pipeline.WeightedForecastMinor != 20 {
		t.Fatalf("pipeline = %+v, want fixed stages, four open deals and forecast 20", payload.Pipeline)
	}
	for i := range wantStages {
		if payload.Pipeline.Stages[i] != wantStages[i] {
			t.Fatalf("pipeline stage %d = %+v, want %+v", i, payload.Pipeline.Stages[i], wantStages[i])
		}
	}
	if payload.Ops.Headcount != 1 || payload.Ops.PendingLeave != 1 || payload.Ops.POSOpen == nil || payload.Ops.POSOpen.Register != "Front register" || payload.Ops.PendingApprovals != 1 || payload.Ops.DocsParsed != 1 || payload.Ops.DocsAwaitingCoding != 1 {
		t.Fatalf("operations = %+v, want fixture counts", payload.Ops)
	}
	lowStock := make(map[string]bool)
	for _, item := range payload.Ops.LowStock {
		lowStock[item.SKU] = true
	}
	if len(lowStock) != 2 || !lowStock["LOW"] || !lowStock["EMPTY"] || lowStock["OK"] {
		t.Fatalf("low stock = %+v, want LOW and EMPTY only", payload.Ops.LowStock)
	}
	wantTrend := []TrendMonth{
		{Month: "2026-01", IncomeMinor: 10_000, ExpenseMinor: 2_000},
		{Month: "2026-02"}, {Month: "2026-03"}, {Month: "2026-04"},
		{Month: "2026-05", IncomeMinor: 500},
		{Month: "2026-06", IncomeMinor: -10_000, ExpenseMinor: -2_000},
	}
	if len(payload.Trend) != len(wantTrend) {
		t.Fatalf("trend length = %d, want six: %+v", len(payload.Trend), payload.Trend)
	}
	for i := range wantTrend {
		if payload.Trend[i] != wantTrend[i] {
			t.Fatalf("trend month %d = %+v, want %+v", i, payload.Trend[i], wantTrend[i])
		}
	}
	if len(payload.Activity) != 8 || payload.Activity[0].Kind != "fixture.activity.9" || payload.Activity[7].Kind != "fixture.activity.2" {
		t.Fatalf("activity = %+v, want the eight latest events for the selected org", payload.Activity)
	}
	if payload.Activity[0].CapabilityID != nil || payload.Activity[1].CapabilityID == nil || *payload.Activity[1].CapabilityID != "crm.createCustomer" || payload.Activity[0].OccurredAt != "2026-05-01T12:00:09.000Z" {
		t.Fatalf("activity wire projection = %+v, want nullable capability and millisecond UTC time", payload.Activity[:2])
	}
}

func purgeDashboardFixture(ctx context.Context, owner *pgxpool.Pool, orgID, otherOrgID string) error {
	tx, err := owner.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ledger_events WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`, orgID, otherOrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vendor_bills WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM stock_movements WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func dashboardUUID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}
