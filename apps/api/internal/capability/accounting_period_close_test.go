package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func periodCloseTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func periodCloseOrgClaims(fx *executorFixture, orgID string) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: orgID, ActorType: "human", ActorID: &actorID}
}

// cleanupPeriodCloseFixtureLedger removes posted ledger rows and every
// period-close fixture row in reverse dependency order: FX revaluations
// before the entries they reference, journal lines before entries, invoices
// before customers. Posted rows refuse DELETE unless the transaction enables
// app.ledger_maintenance first.
func cleanupPeriodCloseFixtureLedger(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin period close fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable period close fixture ledger cleanup: %v", err)
			return
		}
		statements := []string{
			`DELETE FROM period_fx_revaluations WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM period_close_checks WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM periods WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM bank_allocations WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM bank_transactions WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM bank_accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM payments WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, statement := range statements {
			if _, err := tx.Exec(fx.ctx, statement, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("period close fixture cleanup %q: %v", statement, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit period close fixture cleanup: %v", err)
		}
	})
}

type periodCloseAccountRow struct {
	Code string
	Name string
	Type string
}

func seedPeriodCloseAccounts(t *testing.T, fx *executorFixture, orgID string, rows []periodCloseAccountRow) {
	t.Helper()
	for _, row := range rows {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)
			ON CONFLICT (org_id, code) DO NOTHING`,
			orgID, row.Code, row.Name, row.Type); err != nil {
			t.Fatal(err)
		}
	}
}

func seedPeriodCloseCustomer(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Period close fixture customer')
		RETURNING id::text`, orgID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedPeriodCloseInvoice(t *testing.T, fx *executorFixture, orgID, customerID, currency, status string, totalMinor, paidMinor, creditedMinor int64, issuedAt *time.Time, voidedAt *time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, issued_at, voided_at)
		VALUES ($1::uuid, $2::uuid, (SELECT coalesce(max(number), 0) + 1 FROM invoices WHERE org_id = $1::uuid), $3, $4, $5, 0, $5, $6, $7, $8, $9)
		RETURNING id::text`, orgID, customerID, status, currency, totalMinor, paidMinor, creditedMinor, issuedAt, voidedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedPeriodCloseCheck(t *testing.T, fx *executorFixture, orgID string, year, month int64, taskKey string, completed bool, note *string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO period_close_checks (org_id, year, month, task_key, completed, note, updated_by_actor_type, updated_by_actor_id, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, 'human', $7::uuid, now())
		ON CONFLICT (org_id, year, month, task_key) DO UPDATE SET completed = EXCLUDED.completed, note = EXCLUDED.note`,
		orgID, year, month, taskKey, completed, note, fx.userID); err != nil {
		t.Fatal(err)
	}
}

func seedPeriodCloseFxRevaluation(t *testing.T, fx *executorFixture, orgID string, year, month int64, entryID *string, reversedAt *time.Time) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO period_fx_revaluations (org_id, year, month, entry_id, reversed_at)
		VALUES ($1::uuid, $2, $3, $4::uuid, $5)`, orgID, year, month, entryID, reversedAt); err != nil {
		t.Fatal(err)
	}
}

// seedPeriodCloseReversalPair posts an operational entry and a second entry
// reversing it through the posting door, so the workbench can observe a
// revaluation whose entry already has a reversal on the books.
func seedPeriodCloseReversalPair(t *testing.T, fx *executorFixture, orgID string, postedAt time.Time) string {
	t.Helper()
	seedPeriodCloseAccounts(t, fx, orgID, []periodCloseAccountRow{
		{Code: "1000", Name: "Cash", Type: "asset"},
		{Code: "4000", Name: "Sales", Type: "income"},
	})
	var originalID string
	originalID, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (string, error) {
		id, err := postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: orgID, Memo: "Fixture FX revaluation", SourceType: "manual", Currency: "USD", PostedAt: postedAt,
			ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "1000", DebitMinor: 4_000}, {AccountCode: "4000", CreditMinor: 4_000}},
		})
		if err != nil {
			return "", err
		}
		_, err = postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: orgID, Memo: "Fixture FX reversal", SourceType: "reversal", ReversalOfID: &id,
			EntryKind: "operational", Currency: "USD", PostedAt: postedAt,
			ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "4000", DebitMinor: 4_000}, {AccountCode: "1000", CreditMinor: 4_000}},
		})
		return id, err
	})
	if err != nil {
		t.Fatal(err)
	}
	return originalID
}

func TestAccountingPeriodCloseParsersMirrorZodContracts(t *testing.T) {
	period, err := ParsePeriodCloseWorkbenchInput(json.RawMessage(`{"year":2026,"month":8,"unexpected":1}`))
	if err != nil || period != (ClosePeriodInput{Year: 2026, Month: 8}) {
		t.Fatalf("ParsePeriodCloseWorkbenchInput() = %+v, %v", period, err)
	}
	encoded, err := marshalJS(period)
	if err != nil || string(encoded) != `{"year":2026,"month":8}` {
		t.Fatalf("workbench input JSON = %s, %v", encoded, err)
	}
	if boundary, err := ParseClosePeriodInput(json.RawMessage(`{"year":2000,"month":12}`)); err != nil || boundary != (ClosePeriodInput{Year: 2000, Month: 12}) {
		t.Fatalf("ParseClosePeriodInput(2000-12) = %+v, %v", boundary, err)
	}
	if boundary, err := ParseReopenPeriodInput(json.RawMessage(`{"year":2100,"month":1}`)); err != nil || boundary != (ClosePeriodInput{Year: 2100, Month: 1}) {
		t.Fatalf("ParseReopenPeriodInput(2100-01) = %+v, %v", boundary, err)
	}
	for _, raw := range []string{
		`[]`,
		`"x"`,
		`{}`,
		`{"year":1999,"month":1}`,
		`{"year":2101,"month":1}`,
		`{"year":2026.5,"month":1}`,
		`{"year":null,"month":1}`,
		`{"year":2026}`,
		`{"year":2026,"month":0}`,
		`{"year":2026,"month":13}`,
		`{"year":2026,"month":1.5}`,
		`{"year":2026,"month":null}`,
		// Zod z.number() refuses every quoted spelling, so a numeric string is
		// not an acceptable substitute for a number.
		`{"year":"2026","month":8}`,
		`{"year":"2026","month":"8"}`,
	} {
		if _, err := ParseClosePeriodInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseClosePeriodInput accepted %s", raw)
		}
	}
	if stringYear, err := ParseClosePeriodInput(json.RawMessage(`{"year":2026,"month":8}`)); err != nil || stringYear.Year != 2026 || stringYear.Month != 8 {
		t.Fatalf("ParseClosePeriodInput(numbers) = %+v, %v, want accepted", stringYear, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"year":2000.5}`,
		`{"year":2101}`,
		`{"year":null}`,
		`[]`,
		`{"year":"2026"}`,
	} {
		if _, err := ParseCloseYearInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCloseYearInput accepted %s", raw)
		}
	}
	if yearEnd, err := ParseCloseYearInput(json.RawMessage(`{"year":2026}`)); err != nil || yearEnd != (CloseYearInput{Year: 2026}) {
		t.Fatalf("ParseCloseYearInput() = %+v, %v", yearEnd, err)
	}

	fullCheck := `{"year":2026,"month":8,"taskKey":"review_tax","completed":true,"note":" taxes reviewed ","unknown":true}`
	updated, err := ParseUpdatePeriodCloseCheckInput(json.RawMessage(fullCheck))
	if err != nil {
		t.Fatal(err)
	}
	restored, err := ParseRestorePeriodCloseCheckInput(json.RawMessage(fullCheck))
	if err != nil {
		t.Fatal(err)
	}
	updatedJSON, err := marshalJS(updated)
	if err != nil {
		t.Fatal(err)
	}
	restoredJSON, err := marshalJS(restored)
	if err != nil {
		t.Fatal(err)
	}
	if string(updatedJSON) != string(restoredJSON) {
		t.Fatalf("restore parser diverged from update parser: %s vs %s", updatedJSON, restoredJSON)
	}
	if updated.Year != 2026 || updated.Month != 8 || updated.TaskKey != "review_tax" || !updated.Completed || updated.Note == nil || *updated.Note != " taxes reviewed " {
		t.Fatalf("ParseUpdatePeriodCloseCheckInput() = %+v", updated)
	}
	if encoded, err = marshalJS(updated); err != nil || string(encoded) != `{"year":2026,"month":8,"taskKey":"review_tax","completed":true,"note":" taxes reviewed "}` {
		t.Fatalf("check input JSON = %s, %v", encoded, err)
	}
	bareCheck, err := ParseUpdatePeriodCloseCheckInput(json.RawMessage(`{"year":2026,"month":8,"taskKey":"review_journal","completed":false}`))
	if err != nil || bareCheck.Note != nil {
		t.Fatalf("bare check input = %+v, %v, want absent note", bareCheck, err)
	}
	if encoded, err = marshalJS(bareCheck); err != nil || string(encoded) != `{"year":2026,"month":8,"taskKey":"review_journal","completed":false}` {
		t.Fatalf("bare check JSON = %s, %v", encoded, err)
	}
	longNote := strings.Repeat("n", 501)
	for _, raw := range []string{
		`{}`,
		`{"year":2026,"month":8}`,
		`{"year":2026,"month":8,"taskKey":"review_bank","completed":true}`,
		`{"year":2026,"month":8,"taskKey":null,"completed":true}`,
		`{"year":2026,"month":8,"taskKey":"review_journal"}`,
		`{"year":2026,"month":8,"taskKey":"review_journal","completed":null}`,
		`{"year":2026,"month":8,"taskKey":"review_journal","completed":1}`,
		`{"year":2026,"month":8,"taskKey":"review_journal","completed":"true"}`,
		`{"year":2026,"month":8,"taskKey":"review_journal","completed":true,"note":null}`,
		`{"year":2026,"month":8,"taskKey":"review_journal","completed":true,"note":5}`,
		`{"year":2026,"month":8,"taskKey":"review_journal","completed":true,"note":"` + longNote + `"}`,
	} {
		if _, err := ParseUpdatePeriodCloseCheckInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseUpdatePeriodCloseCheckInput accepted %s", raw)
		}
	}

	validByCapability := map[string]string{
		periodCloseWorkbenchCapabilityID:    `{"year":2026,"month":8}`,
		updatePeriodCloseCheckCapabilityID:  `{"year":2026,"month":8,"taskKey":"review_journal","completed":true}`,
		restorePeriodCloseCheckCapabilityID: `{"year":2026,"month":8,"taskKey":"review_journal","completed":true}`,
		closePeriodCapabilityID:             `{"year":2026,"month":8}`,
		reopenPeriodCapabilityID:            `{"year":2026,"month":8}`,
		closeYearCapabilityID:               `{"year":2026}`,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingPeriodCloseInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingPeriodCloseInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingPeriodCloseInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingPeriodCloseInput accepted an unsupported capability")
	}
}

func TestAccountingPeriodCloseYearEndMath(t *testing.T) {
	mixed := computeYearEndClose([]periodCloseAccountBalance{
		{Code: "1000", Name: "Cash", Type: "asset", DebitMinor: 500_000},
		{Code: "2100", Name: "Payables", Type: "liability", CreditMinor: 70_000},
		{Code: "3100", Name: "Retained Earnings", Type: "equity", CreditMinor: 40_000},
		{Code: "4000", Name: "Sales", Type: "income", DebitMinor: 10_000, CreditMinor: 250_000},
		{Code: "4100", Name: "Other Income", Type: "income"},
		{Code: "6000", Name: "Wages", Type: "expense", DebitMinor: 90_000},
	}, "3100")
	if mixed.NetIncomeMinor != 150_000 || len(mixed.ClosingLines) != 2 ||
		mixed.ClosingLines[0] != (yearEndClosingLine{AccountCode: "4000", DebitMinor: 240_000}) ||
		mixed.ClosingLines[1] != (yearEndClosingLine{AccountCode: "6000", CreditMinor: 90_000}) ||
		mixed.RetainedEarningsLine != (yearEndClosingLine{AccountCode: "3100", CreditMinor: 150_000}) {
		t.Fatalf("computeYearEndClose(mixed) = %+v, want 150000 net rolled to retained earnings", mixed)
	}
	if mixed.TotalDebitMinor != 240_000 || mixed.TotalCreditMinor != 240_000 || mixed.TotalDebitMinor != mixed.TotalCreditMinor {
		t.Fatalf("computeYearEndClose(mixed) totals = %d/%d, want balanced", mixed.TotalDebitMinor, mixed.TotalCreditMinor)
	}

	loss := computeYearEndClose([]periodCloseAccountBalance{
		{Code: "6000", Name: "Wages", Type: "expense", DebitMinor: 90_000},
	}, "3100")
	if loss.NetIncomeMinor != -90_000 || len(loss.ClosingLines) != 1 ||
		loss.ClosingLines[0] != (yearEndClosingLine{AccountCode: "6000", CreditMinor: 90_000}) ||
		loss.RetainedEarningsLine != (yearEndClosingLine{AccountCode: "3100", DebitMinor: 90_000}) ||
		loss.TotalDebitMinor != 90_000 || loss.TotalCreditMinor != 90_000 {
		t.Fatalf("computeYearEndClose(loss) = %+v, want 90000 loss debited to retained earnings", loss)
	}

	empty := computeYearEndClose(nil, "3100")
	if len(empty.ClosingLines) != 0 || empty.NetIncomeMinor != 0 || empty.TotalDebitMinor != 0 || empty.TotalCreditMinor != 0 ||
		empty.RetainedEarningsLine != (yearEndClosingLine{AccountCode: "3100"}) {
		t.Fatalf("computeYearEndClose(empty) = %+v, want a zero plan", empty)
	}
	if encoded, err := marshalJS(PeriodCloseCheckOutput{}); err != nil || string(encoded) != `{"updated":false,"previousCompleted":false,"previousNote":null}` {
		t.Fatalf("check output zero JSON = %s, %v", encoded, err)
	}
	if got := formatPeriodCloseMinor(160_000); got != "1600.00" {
		t.Fatalf("formatPeriodCloseMinor(160000) = %q, want 1600.00", got)
	}
	if got := formatPeriodCloseMinor(-5); got != "-0.05" {
		t.Fatalf("formatPeriodCloseMinor(-5) = %q, want -0.05", got)
	}
	if got := formatPeriodCloseMinor(0); got != "0.00" {
		t.Fatalf("formatPeriodCloseMinor(0) = %q, want 0.00", got)
	}
}

func TestAccountingPeriodCloseWorkbenchReportsReadinessBlockers(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPeriodCloseFixtureLedger(t, fx)
	august := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	seedPeriodCloseAccounts(t, fx, fx.orgID, []periodCloseAccountRow{
		{Code: "1000", Name: "Cash", Type: "asset"},
		{Code: "4000", Name: "Sales", Type: "income"},
	})
	bankAccount := seedBankAccount(t, fx, fx.orgID, "Operating", "USD", 0)
	seedBankTransaction(t, fx, fx.orgID, bankAccount, august.Add(4*24*time.Hour), -5_000, "Unmatched fee", "unmatched")
	seedBankTransaction(t, fx, fx.orgID, bankAccount, august.Add(19*24*time.Hour), 12_000, "Unmatched deposit", "unmatched")
	seedBankTransaction(t, fx, fx.orgID, bankAccount, august.Add(9*24*time.Hour), 3_000, "Matched deposit", "matched")
	seedBankTransaction(t, fx, fx.orgID, bankAccount, time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC), 7_000, "July leftover", "unmatched")
	foreignBank := seedBankAccount(t, fx, fx.otherOrgID, "Foreign operating", "USD", 0)
	seedBankTransaction(t, fx, fx.otherOrgID, foreignBank, august.Add(2*24*time.Hour), 9_000, "Foreign unmatched", "unmatched")

	customer := seedPeriodCloseCustomer(t, fx, fx.orgID)
	august5Time := august.Add(4 * 24 * time.Hour)
	august2Time := august.Add(24 * time.Hour)
	august5 := &august5Time
	august2 := &august2Time
	var nullIssued *time.Time
	seedPeriodCloseInvoice(t, fx, fx.orgID, customer, "EUR", "sent", 100_000, 40_000, 10_000, august5, nil)
	seedPeriodCloseInvoice(t, fx, fx.orgID, customer, "EUR", "sent", 80_000, 80_000, 0, august5, nil)
	seedPeriodCloseInvoice(t, fx, fx.orgID, customer, "USD", "sent", 70_000, 0, 0, august5, nil)
	seedPeriodCloseInvoice(t, fx, fx.orgID, customer, "EUR", "void", 90_000, 0, 0, august2, august2)
	seedPeriodCloseInvoice(t, fx, fx.orgID, customer, "EUR", "draft", 60_000, 0, 0, nullIssued, nil)
	foreignCustomer := seedPeriodCloseCustomer(t, fx, fx.otherOrgID)
	seedPeriodCloseInvoice(t, fx, fx.otherOrgID, foreignCustomer, "EUR", "sent", 60_000, 0, 0, august5, nil)

	reviewedNote := "gl reviewed"
	seedPeriodCloseCheck(t, fx, fx.orgID, 2026, 8, "review_journal", true, &reviewedNote)
	seedPeriodCloseCheck(t, fx, fx.orgID, 2026, 8, "review_tax", true, nil)

	workbench, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseWorkbenchOutput, error) {
		return periodCloseWorkbench(fx.ctx, tx, fx.orgID, ClosePeriodInput{Year: 2026, Month: 8})
	})
	if err != nil {
		t.Fatalf("periodCloseWorkbench: %v", err)
	}
	want := `{"year":2026,"month":8,"start":"2026-08-01T00:00:00.000Z","end":"2026-08-31T23:59:59.999Z","tasks":[` +
		`{"key":"review_journal","label":"Review journal activity","detail":"Scan unusual entries and confirm corrections are posted in the right period.","completed":true,"note":"gl reviewed","blocking":false,"status":"complete"},` +
		`{"key":"review_receivables","label":"Review receivables","detail":"Check aged invoices, credits, and expected collections.","completed":false,"note":null,"blocking":true,"status":"needs_review"},` +
		`{"key":"review_payables","label":"Review payables","detail":"Check supplier bills, purchase commitments, and payment instructions.","completed":false,"note":null,"blocking":true,"status":"needs_review"},` +
		`{"key":"review_tax","label":"Review tax position","detail":"Confirm output and recoverable input tax are complete for the period.","completed":true,"note":null,"blocking":false,"status":"complete"},` +
		`{"key":"bank_reconciliation","label":"Reconcile bank activity","detail":"2 statement line(s) remain unmatched.","completed":false,"note":null,"blocking":true,"status":"blocked"},` +
		`{"key":"fx_revaluation","label":"Revalue foreign receivables","detail":"Open foreign receivables: EUR.","completed":false,"note":null,"blocking":true,"status":"needs_revaluation"}],` +
		`"blockers":["review_receivables","review_payables","bank_reconciliation","fx_revaluation"],` +
		`"readyToClose":false,"unmatchedLineCount":2,"currenciesWithExposure":["EUR"]}`
	encoded, err := marshalJS(workbench)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != want {
		t.Fatalf("workbench JSON =\n%s\nwant\n%s", encoded, want)
	}
	if len(workbench.Tasks) != 6 || workbench.Tasks[0].Status != "complete" || workbench.Tasks[1].Status != "needs_review" ||
		workbench.Tasks[4].Status != "blocked" || workbench.Tasks[5].Status != "needs_revaluation" {
		t.Fatalf("workbench statuses = %+v", workbench.Tasks)
	}

	seedPeriodCloseFxRevaluation(t, fx, fx.orgID, 2026, 8, nil, nil)
	revaluated, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseWorkbenchOutput, error) {
		return periodCloseWorkbench(fx.ctx, tx, fx.orgID, ClosePeriodInput{Year: 2026, Month: 8})
	})
	if err != nil {
		t.Fatalf("periodCloseWorkbench(revaluated): %v", err)
	}
	if task := revaluated.Tasks[5]; !task.Completed || task.Blocking || task.Status != "complete" {
		t.Fatalf("fx task with a live revaluation = %+v, want complete and not blocking", task)
	}
	if wantBlockers := []string{"review_receivables", "review_payables", "bank_reconciliation"}; strings.Join(revaluated.Blockers, ",") != strings.Join(wantBlockers, ",") {
		t.Fatalf("blockers after revaluation = %v, want %v", revaluated.Blockers, wantBlockers)
	}

	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE period_fx_revaluations SET reversed_at = now() WHERE org_id = $1::uuid AND year = 2026 AND month = 8`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	reversed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseWorkbenchOutput, error) {
		return periodCloseWorkbench(fx.ctx, tx, fx.orgID, ClosePeriodInput{Year: 2026, Month: 8})
	})
	if err != nil {
		t.Fatalf("periodCloseWorkbench(reversed): %v", err)
	}
	if task := reversed.Tasks[5]; task.Completed || !task.Blocking || task.Status != "needs_revaluation" {
		t.Fatalf("fx task with a reversed revaluation = %+v, want blocked again", task)
	}

	revaluedEntry := seedPeriodCloseReversalPair(t, fx, fx.orgID, august.Add(5*24*time.Hour))
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE period_fx_revaluations SET reversed_at = NULL, entry_id = $2::uuid WHERE org_id = $1::uuid AND year = 2026 AND month = 8`, fx.orgID, revaluedEntry); err != nil {
		t.Fatal(err)
	}
	twiceRevaluated, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseWorkbenchOutput, error) {
		return periodCloseWorkbench(fx.ctx, tx, fx.orgID, ClosePeriodInput{Year: 2026, Month: 8})
	})
	if err != nil {
		t.Fatalf("periodCloseWorkbench(reversal pair): %v", err)
	}
	if task := twiceRevaluated.Tasks[5]; task.Completed || task.Status != "needs_revaluation" {
		t.Fatalf("fx task whose revaluation entry already has a reversal = %+v, want blocked", task)
	}

	foreign, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (PeriodCloseWorkbenchOutput, error) {
		return periodCloseWorkbench(fx.ctx, tx, fx.otherOrgID, ClosePeriodInput{Year: 2026, Month: 8})
	})
	if err != nil {
		t.Fatalf("periodCloseWorkbench(foreign): %v", err)
	}
	if foreign.UnmatchedLineCount != 1 || len(foreign.CurrenciesWithExposure) != 1 || foreign.CurrenciesWithExposure[0] != "EUR" ||
		len(foreign.Blockers) != 6 || foreign.ReadyToClose {
		t.Fatalf("foreign workbench = unmatched %d exposure %v blockers %d ready %v, want tenant-scoped blockers only",
			foreign.UnmatchedLineCount, foreign.CurrenciesWithExposure, len(foreign.Blockers), foreign.ReadyToClose)
	}
}

func TestAccountingPeriodCloseCheckUpsertPreservesPreviousState(t *testing.T) {
	fx := newExecutorFixture(t)
	claims := periodCloseTestClaims(fx)
	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	foreignNote := "foreign"
	seedPeriodCloseCheck(t, fx, fx.otherOrgID, 2026, 8, "review_journal", true, &foreignNote)

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseCheckOutput, error) {
		return persistPeriodCloseCheck(fx.ctx, tx, claims, PeriodCloseCheckInput{
			Year: 2026, Month: 8, TaskKey: "review_journal", Completed: true, Note: crmStringPointer("checked"),
		}, now)
	})
	if err != nil {
		t.Fatalf("persistPeriodCloseCheck(first): %v", err)
	}
	if encoded, err := marshalJS(first); err != nil || string(encoded) != `{"updated":true,"previousCompleted":false,"previousNote":null}` {
		t.Fatalf("first check output JSON = %s, %v", encoded, err)
	}
	var completed bool
	var note *string
	var actorType, actorID string
	var updatedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT completed, note, updated_by_actor_type, updated_by_actor_id::text, updated_at
		FROM period_close_checks WHERE org_id = $1::uuid AND year = 2026 AND month = 8 AND task_key = 'review_journal'`, fx.orgID).
		Scan(&completed, &note, &actorType, &actorID, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if !completed || note == nil || *note != "checked" || actorType != "human" || actorID != fx.userID {
		t.Fatalf("stored check = completed %v note %v actor %s/%s", completed, note, actorType, actorID)
	}
	if !updatedAt.Equal(now) {
		t.Fatalf("stored updated_at = %s, want the executed-at stamp", updatedAt)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseCheckOutput, error) {
		return persistPeriodCloseCheck(fx.ctx, tx, claims, PeriodCloseCheckInput{
			Year: 2026, Month: 8, TaskKey: "review_journal", Completed: false,
		}, now)
	})
	if err != nil {
		t.Fatalf("persistPeriodCloseCheck(second): %v", err)
	}
	if encoded, err := marshalJS(second); err != nil || string(encoded) != `{"updated":true,"previousCompleted":true,"previousNote":"checked"}` {
		t.Fatalf("second check output JSON = %s, %v", encoded, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT completed, note FROM period_close_checks
		WHERE org_id = $1::uuid AND year = 2026 AND month = 8 AND task_key = 'review_journal'`, fx.orgID).
		Scan(&completed, &note); err != nil {
		t.Fatal(err)
	}
	if completed || note != nil {
		t.Fatalf("stored check after unchecking = completed %v note %v, want unchecked with null note", completed, note)
	}

	restored, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseCheckOutput, error) {
		return persistPeriodCloseCheck(fx.ctx, tx, claims, PeriodCloseCheckInput{
			Year: 2026, Month: 8, TaskKey: "review_journal", Completed: true, Note: crmStringPointer("restored"),
		}, now)
	})
	if err != nil {
		t.Fatalf("persistPeriodCloseCheck(restore): %v", err)
	}
	if encoded, err := marshalJS(restored); err != nil || string(encoded) != `{"updated":true,"previousCompleted":false,"previousNote":null}` {
		t.Fatalf("restore check output JSON = %s, %v", encoded, err)
	}

	taxFirst, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PeriodCloseCheckOutput, error) {
		return persistPeriodCloseCheck(fx.ctx, tx, claims, PeriodCloseCheckInput{
			Year: 2026, Month: 8, TaskKey: "review_tax", Completed: true,
		}, now)
	})
	if err != nil || !taxFirst.Updated || taxFirst.PreviousCompleted {
		t.Fatalf("persistPeriodCloseCheck(tax) = %+v, %v, want independent task key", taxFirst, err)
	}
	if got := fx.count(`SELECT count(*) FROM period_close_checks WHERE org_id = $1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("stored checks = %d, want one per touched task key", got)
	}
	if got := fx.count(`SELECT count(*) FROM period_close_checks WHERE org_id = $1::uuid AND note = 'foreign' AND completed = true`, fx.otherOrgID); got != 1 {
		t.Fatalf("foreign org check rows touched, rows=%d", got)
	}
}

func TestAccountingPeriodCloseGuardsSealAndReopenComposeWithPosting(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPeriodCloseFixtureLedger(t, fx)
	seedPeriodCloseAccounts(t, fx, fx.orgID, []periodCloseAccountRow{
		{Code: "1000", Name: "Cash", Type: "asset"},
		{Code: "4000", Name: "Sales", Type: "income"},
	})
	claims := periodCloseTestClaims(fx)

	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ClosePeriodOutput, error) {
		return closePeriod(fx.ctx, tx, claims, ClosePeriodInput{Year: 2026, Month: 8})
	})
	wantGuard := "complete the close checklist first: review_journal, review_receivables, review_payables, review_tax"
	if err == nil || err.Error() != wantGuard {
		t.Fatalf("closePeriod(unready) error = %v, want %q", err, wantGuard)
	}
	for _, taskKey := range periodCloseCheckTaskKeys {
		seedPeriodCloseCheck(t, fx, fx.orgID, 2026, 8, taskKey, true, nil)
	}

	closed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ClosePeriodOutput, error) {
		return closePeriod(fx.ctx, tx, claims, ClosePeriodInput{Year: 2026, Month: 8})
	})
	if err != nil {
		t.Fatalf("closePeriod: %v", err)
	}
	if encoded, err := marshalJS(closed); err != nil || string(encoded) != `{"closed":true}` {
		t.Fatalf("closePeriod output JSON = %s, %v", encoded, err)
	}
	if got := fx.count(`SELECT count(*) FROM periods WHERE org_id = $1::uuid AND year = 2026 AND month = 8 AND closed_by_actor_id = $2::uuid`, fx.orgID, fx.userID); got != 1 {
		t.Fatalf("sealed period rows attributed to the closer = %d, want 1", got)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ClosePeriodOutput, error) {
		return closePeriod(fx.ctx, tx, claims, ClosePeriodInput{Year: 2026, Month: 8})
	}); err != nil {
		t.Fatalf("closePeriod(again): %v", err)
	}
	if got := fx.count(`SELECT count(*) FROM periods WHERE org_id = $1::uuid AND year = 2026 AND month = 8`, fx.orgID); got != 1 {
		t.Fatalf("period rows after re-close = %d, want still 1", got)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Late August posting", SourceType: "manual", Currency: "USD", PostedAt: time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC),
			ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "1000", DebitMinor: 100}, {AccountCode: "4000", CreditMinor: 100}},
		})
	})
	wantLocked := "period 2026-08 is closed; post to the current period or reopen it"
	if err == nil || err.Error() != wantLocked {
		t.Fatalf("posting into sealed August error = %v, want %q", err, wantLocked)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "July posting", SourceType: "manual", Currency: "USD", PostedAt: time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC),
			ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "1000", DebitMinor: 200}, {AccountCode: "4000", CreditMinor: 200}},
		})
	}); err != nil {
		t.Fatalf("posting into open July: %v", err)
	}

	reopened, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReopenPeriodOutput, error) {
		return reopenPeriod(fx.ctx, tx, fx.orgID, ClosePeriodInput{Year: 2026, Month: 8})
	})
	if err != nil {
		t.Fatalf("reopenPeriod: %v", err)
	}
	if encoded, err := marshalJS(reopened); err != nil || string(encoded) != `{"reopened":true}` {
		t.Fatalf("reopenPeriod output JSON = %s, %v", encoded, err)
	}
	if got := fx.count(`SELECT count(*) FROM periods WHERE org_id = $1::uuid AND year = 2026 AND month = 8`, fx.orgID); got != 0 {
		t.Fatalf("period rows after reopen = %d, want 0", got)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReopenPeriodOutput, error) {
		return reopenPeriod(fx.ctx, tx, fx.orgID, ClosePeriodInput{Year: 2026, Month: 8})
	}); err != nil {
		t.Fatalf("reopenPeriod(never closed): %v", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Corrective August posting", SourceType: "manual", Currency: "USD", PostedAt: time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC),
			ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "4000", DebitMinor: 50}, {AccountCode: "1000", CreditMinor: 50}},
		})
	}); err != nil {
		t.Fatalf("posting into reopened August: %v", err)
	}
	if drift := fx.count(`SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.org_id = $1::uuid`, fx.orgID); drift != 0 {
		t.Fatalf("journal drift = %d, want balanced books", drift)
	}
}

func TestAccountingPeriodCloseYearRollsReplacesAndReseals(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPeriodCloseFixtureLedger(t, fx)
	seedPeriodCloseAccounts(t, fx, fx.orgID, []periodCloseAccountRow{
		{Code: "1000", Name: "Cash", Type: "asset"},
		{Code: "3100", Name: "Retained Earnings", Type: "equity"},
		{Code: "4000", Name: "Sales", Type: "income"},
		{Code: "6000", Name: "Wages", Type: "expense"},
	})
	claims := periodCloseTestClaims(fx)

	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		if _, err := postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "March sale", SourceType: "manual", Currency: "USD", PostedAt: time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC),
			ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "1000", DebitMinor: 250_000}, {AccountCode: "4000", CreditMinor: 250_000}},
		}); err != nil {
			return "", err
		}
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "March wages", SourceType: "manual", Currency: "USD", PostedAt: time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC),
			ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "6000", DebitMinor: 90_000}, {AccountCode: "1000", CreditMinor: 90_000}},
		})
	})
	if err != nil {
		t.Fatalf("seed operating entries: %v", err)
	}

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CloseYearOutput, error) {
		return closeYear(fx.ctx, tx, claims, CloseYearInput{Year: 2026})
	})
	if err != nil {
		t.Fatalf("closeYear: %v", err)
	}
	if !isUUID(first.ClosingEntryID) || first.ReplacedEntryID != nil || first.NetIncomeMinor != 160_000 || first.RetainedEarningsMinor != 160_000 {
		t.Fatalf("closeYear output = %+v, want a fresh 160000 roll with no replacement", first)
	}
	encoded, err := marshalJS(first)
	if err != nil || string(encoded) != fmt.Sprintf(`{"closingEntryId":%q,"replacedEntryId":null,"netIncomeMinor":160000,"retainedEarningsMinor":160000}`, first.ClosingEntryID) {
		t.Fatalf("closeYear output JSON = %s, %v", encoded, err)
	}
	var memo, sourceType, entryKind, currency string
	var reversalOfID, businessAt, postedByActorID *string
	var postedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, entry_kind, currency, reversal_of_id::text, business_at::text, posted_at, posted_by_actor_id::text
		FROM journal_entries WHERE id = $1::uuid`, first.ClosingEntryID).
		Scan(&memo, &sourceType, &entryKind, &currency, &reversalOfID, &businessAt, &postedAt, &postedByActorID); err != nil {
		t.Fatal(err)
	}
	wantMemo := "Year-end close 2026: net income 1600.00 rolled to retained earnings"
	wantPostedAt := time.Date(2026, 12, 31, 23, 59, 59, 0, time.UTC)
	if memo != wantMemo || sourceType != "manual" || entryKind != "year_end_close" || currency != "USD" ||
		reversalOfID != nil || businessAt != nil || !postedAt.Equal(wantPostedAt) ||
		postedByActorID == nil || *postedByActorID != fx.userID {
		t.Fatalf("closing entry = memo %q source %s kind %s currency %s reversal %v business %v posted %v", memo, sourceType, entryKind, currency, reversalOfID, businessAt, postedAt)
	}
	if lines := expenseEntryLines(t, fx, first.ClosingEntryID); len(lines) != 3 ||
		lines[0] != (expenseJournalLineSummary{code: "3100", debit: 0, credit: 160_000}) ||
		lines[1] != (expenseJournalLineSummary{code: "4000", debit: 250_000, credit: 0}) ||
		lines[2] != (expenseJournalLineSummary{code: "6000", debit: 0, credit: 90_000}) {
		t.Fatalf("closing entry lines = %+v, want 4000 debited, 6000 and 3100 credited", lines)
	}
	if got := fx.count(`SELECT count(*) FROM periods WHERE org_id = $1::uuid AND year = 2026 AND month = 12 AND closed_by_actor_id = $2::uuid`, fx.orgID, fx.userID); got != 1 {
		t.Fatalf("December seals = %d, want 1", got)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CloseYearOutput, error) {
		return closeYear(fx.ctx, tx, claims, CloseYearInput{Year: 2026})
	})
	wantSealed := "period 2026-12 is closed; post to the current period or reopen it"
	if err == nil || err.Error() != wantSealed {
		t.Fatalf("closeYear(December sealed) error = %v, want %q", err, wantSealed)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND entry_kind = 'year_end_close'`, fx.orgID); got != 1 {
		t.Fatalf("year_end_close entries after refused re-close = %d, want still 1", got)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReopenPeriodOutput, error) {
		return reopenPeriod(fx.ctx, tx, fx.orgID, ClosePeriodInput{Year: 2026, Month: 12})
	}); err != nil {
		t.Fatalf("reopenPeriod(December): %v", err)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CloseYearOutput, error) {
		return closeYear(fx.ctx, tx, claims, CloseYearInput{Year: 2026})
	})
	if err != nil {
		t.Fatalf("closeYear(re-close): %v", err)
	}
	if second.ReplacedEntryID == nil || *second.ReplacedEntryID != first.ClosingEntryID ||
		second.ClosingEntryID == first.ClosingEntryID || second.NetIncomeMinor != 160_000 || second.RetainedEarningsMinor != 160_000 {
		t.Fatalf("closeYear re-close output = %+v, want the live roll replaced with an equal fresh roll", second)
	}
	var reversalEntryID, revMemo, revKind string
	var revPostedAt time.Time
	var revReversalOf string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, memo, entry_kind, posted_at, reversal_of_id::text
		FROM journal_entries WHERE reversal_of_id = $1::uuid AND org_id = $2::uuid`, first.ClosingEntryID, fx.orgID).
		Scan(&reversalEntryID, &revMemo, &revKind, &revPostedAt, &revReversalOf); err != nil {
		t.Fatal(err)
	}
	if revMemo != "Reversal of year-end close 2026 (replaced by re-close)" || revKind != "year_end_close" ||
		revReversalOf != first.ClosingEntryID || !revPostedAt.Equal(wantPostedAt) {
		t.Fatalf("replacement reversal = memo %q kind %s reversal_of %s posted %v", revMemo, revKind, revReversalOf, revPostedAt)
	}
	if lines := expenseEntryLines(t, fx, reversalEntryID); len(lines) != 3 ||
		lines[0] != (expenseJournalLineSummary{code: "3100", debit: 160_000, credit: 0}) ||
		lines[1] != (expenseJournalLineSummary{code: "4000", debit: 0, credit: 250_000}) ||
		lines[2] != (expenseJournalLineSummary{code: "6000", debit: 90_000, credit: 0}) {
		t.Fatalf("replacement reversal lines = %+v, want the original roll mirrored", lines)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND entry_kind = 'year_end_close'`, fx.orgID); got != 3 {
		t.Fatalf("year_end_close entries after re-close = %d, want roll, reversal, fresh roll", got)
	}
	if got := fx.count(`
		SELECT count(*) FROM journal_entries je
		WHERE je.org_id = $1::uuid AND je.entry_kind = 'year_end_close' AND je.reversal_of_id IS NULL
		  AND extract(year from je.posted_at) = 2026
		  AND NOT EXISTS (
			SELECT 1 FROM journal_entries prior
			WHERE prior.reversal_of_id = je.id AND prior.entry_kind = 'year_end_close'
		  )`, fx.orgID); got != 1 {
		t.Fatalf("live year-end rolls = %d, want exactly one", got)
	}
	if got := fx.count(`SELECT count(*) FROM periods WHERE org_id = $1::uuid AND year = 2026 AND month = 12`, fx.orgID); got != 1 {
		t.Fatalf("December seals after re-close = %d, want resealed", got)
	}
	var retained, salesBalance int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT
			coalesce(sum(jl.credit_minor - jl.debit_minor) FILTER (WHERE a.code = '3100'), 0),
			coalesce(sum(jl.credit_minor - jl.debit_minor) FILTER (WHERE a.code = '4000'), 0)
		FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
		WHERE a.org_id = $1::uuid`, fx.orgID).Scan(&retained, &salesBalance); err != nil {
		t.Fatal(err)
	}
	if retained != 160_000 || salesBalance != 0 {
		t.Fatalf("balances after re-close = retained %d sales %d, want retained rolled once and income zeroed", retained, salesBalance)
	}

	seedPeriodCloseAccounts(t, fx, fx.otherOrgID, []periodCloseAccountRow{
		{Code: "3100", Name: "Retained Earnings", Type: "equity"},
		{Code: "4000", Name: "Sales", Type: "income"},
		{Code: "6000", Name: "Wages", Type: "expense"},
	})
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (CloseYearOutput, error) {
		return closeYear(fx.ctx, tx, periodCloseOrgClaims(fx, fx.otherOrgID), CloseYearInput{Year: 2026})
	})
	wantIdle := "fiscal year 2026 has no income or expense activity to close"
	if err == nil || err.Error() != wantIdle {
		t.Fatalf("closeYear(idle org) error = %v, want %q", err, wantIdle)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid`, fx.otherOrgID); got != 0 {
		t.Fatalf("refused idle close left %d entries, want 0", got)
	}
}
