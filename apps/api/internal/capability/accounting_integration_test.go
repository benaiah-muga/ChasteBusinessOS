package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/jackc/pgx/v5"
)

func TestGoInvoiceCreationMatchesLegacyAndRollsBackOnAuditFailure(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	customerID := seedAccountingInvoiceFixture(t, fx)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor)
		VALUES ($1::uuid, $2::uuid, 41, 'sent', 1, 0, 1)`, fx.orgID, customerID); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"customerId":"` + customerID + `","memo":"Migration demo","currency":"","lines":[{"description":"Pendant lamp","quantity":20000,"unitPriceMinor":12000,"taxMinor":6000}]}`)
	input, err := ParseCreateInvoiceInput(raw)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 27, 10, 30, 0, 125_000_000, time.UTC)
	actorID := fx.userID
	claims := authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateInvoiceOutput, error) {
		created, err := createInvoice(fx.ctx, tx, claims, input, now)
		if err != nil {
			return CreateInvoiceOutput{}, err
		}
		payload, err := marshalJS(struct {
			Input CreateInvoiceInput `json:"input"`
		}{Input: input})
		if err != nil {
			return CreateInvoiceOutput{}, err
		}
		capabilityID := createInvoiceCapabilityID
		if _, _, err := ledger.AppendTx(fx.ctx, tx, ledger.AppendEvent{
			OrgID: fx.orgID, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Kind: "capability.executed", CapabilityID: &capabilityID, Payload: payload, OccurredAt: now,
		}); err != nil {
			return CreateInvoiceOutput{}, err
		}
		return created, nil
	})
	if err != nil {
		t.Fatalf("createInvoice: %v", err)
	}
	if created.InvoiceNumber != 42 || created.TotalMinor != 246_000 || created.Currency != "USD" || created.InvoiceID == "" || created.EntryID == "" {
		t.Fatalf("created invoice = %+v, want invoice #42, 246000 USD, and entry ids", created)
	}
	var status, memo, currency string
	var subtotal, tax, total int64
	var dueAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, memo, currency, subtotal_minor, tax_minor, total_minor, due_at FROM invoices WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, created.InvoiceID).Scan(&status, &memo, &currency, &subtotal, &tax, &total, &dueAt); err != nil {
		t.Fatal(err)
	}
	if status != "sent" || memo != "Migration demo" || currency != "USD" || subtotal != 240_000 || tax != 6_000 || total != 246_000 {
		t.Fatalf("invoice persisted status=%q memo=%q currency=%q amounts=(%d,%d,%d)", status, memo, currency, subtotal, tax, total)
	}
	if !dueAt.Equal(now) {
		t.Fatalf("dueAt = %s, want issue time %s when no customer terms are set", dueAt, now)
	}
	var sourceType, sourceID, postedActor string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT source_type, source_id::text, posted_by_actor_id::text FROM journal_entries WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, created.EntryID).Scan(&sourceType, &sourceID, &postedActor); err != nil {
		t.Fatal(err)
	}
	if sourceType != "invoice" || sourceID != created.InvoiceID || postedActor != fx.userID {
		t.Fatalf("journal attribution source=(%q,%q), actor=%q", sourceType, sourceID, postedActor)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, createInvoiceCapabilityID); got != 1 {
		t.Fatalf("invoice audit event count=%d, want 1", got)
	}
	var lines []struct {
		Code   string
		Debit  int64
		Credit int64
	}
	rows, err := fx.owner.Query(fx.ctx, `SELECT a.code, jl.debit_minor, jl.credit_minor FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.entry_id=$1::uuid ORDER BY a.code`, created.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var line struct {
			Code   string
			Debit  int64
			Credit int64
		}
		if err := rows.Scan(&line.Code, &line.Debit, &line.Credit); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	if len(lines) != 3 || lines[0].Code != "1100" || lines[0].Debit != 246_000 || lines[1].Code != "2100" || lines[1].Credit != 6_000 || lines[2].Code != "4000" || lines[2].Credit != 240_000 {
		t.Fatalf("invoice journal lines = %+v, want balanced AR/tax/revenue lines", lines)
	}
	var lineDescription string
	var quantity, unitPrice, lineTax int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT description, quantity, unit_price_minor, tax_minor FROM invoice_lines WHERE invoice_id=$1::uuid`, created.InvoiceID).Scan(&lineDescription, &quantity, &unitPrice, &lineTax); err != nil {
		t.Fatal(err)
	}
	if lineDescription != "Pendant lamp" || quantity != 20_000 || unitPrice != 12_000 || lineTax != 6_000 {
		t.Fatalf("invoice line snapshot = %q, %d, %d, %d", lineDescription, quantity, unitPrice, lineTax)
	}

	trial, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (TrialBalanceOutput, error) {
		return trialBalance(fx.ctx, tx, TrialBalanceInput{})
	})
	if err != nil {
		t.Fatalf("trialBalance: %v", err)
	}
	if !trial.Balanced || len(trial.Lines) != 3 {
		t.Fatalf("trial balance = %+v, want three balanced currency rows", trial)
	}
	for index, code := range []string{"1100", "2100", "4000"} {
		if trial.Lines[index].Code != code {
			t.Fatalf("trial balance row order = %+v, want account code order", trial.Lines)
		}
	}
	if trial.Lines[0].DebitMinor != 246_000 || trial.Lines[1].CreditMinor != 6_000 || trial.Lines[2].CreditMinor != 240_000 {
		t.Fatalf("trial balance amounts = %+v", trial.Lines)
	}

	functionName := "go_accounting_fail_ledger_" + strings.ReplaceAll(fx.orgID, "-", "")
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture accounting audit failure'; END $$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
			t.Errorf("drop accounting fixture trigger: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop accounting fixture function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW WHEN (NEW.org_id='%s'::uuid AND NEW.kind='capability.executed' AND NEW.capability_id='%s') EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, createInvoiceCapabilityID, functionName)); err != nil {
		t.Fatal(err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateInvoiceOutput, error) {
		created, err := createInvoice(fx.ctx, tx, claims, input, now.Add(time.Minute))
		if err != nil {
			return CreateInvoiceOutput{}, err
		}
		payload, err := marshalJS(struct {
			Input CreateInvoiceInput `json:"input"`
		}{Input: input})
		if err != nil {
			return CreateInvoiceOutput{}, err
		}
		capabilityID := createInvoiceCapabilityID
		if _, _, err := ledger.AppendTx(fx.ctx, tx, ledger.AppendEvent{
			OrgID: fx.orgID, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Kind: "capability.executed", CapabilityID: &capabilityID, Payload: payload, OccurredAt: now.Add(time.Minute),
		}); err != nil {
			return CreateInvoiceOutput{}, err
		}
		return created, nil
	})
	if err == nil || !strings.Contains(err.Error(), "fixture accounting audit failure") {
		t.Fatalf("audited invoice result error=%v, want injected audit failure", err)
	}
	if got := countInvoices(fx, fx.orgID); got != 2 { // preexisting fixture invoice plus successful invoice
		t.Fatalf("audit failure left invoice rows=%d, want only the fixture and successful invoice", got)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='invoice'`, fx.orgID); got != 1 {
		t.Fatalf("audit failure left invoice journal entries=%d, want only successful entry", got)
	}
}

func TestGoCreateInvoiceRequiresRateForForeignCurrency(t *testing.T) {
	fx := newExecutorFixture(t)
	currency := "EUR"
	customerID := seedAccountingInvoiceFixture(t, fx)
	input := CreateInvoiceInput{
		CustomerID: customerID,
		Currency:   &currency,
		Lines:      []CreateInvoiceLine{{Description: "Supported item", Quantity: 1_000, UnitPriceMinor: 10_000}},
	}
	actorID := fx.userID
	claims := authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateInvoiceOutput, error) {
		return createInvoice(fx.ctx, tx, claims, input, time.Now().UTC())
	})
	if err == nil || !strings.Contains(err.Error(), "no FX rate for USD/EUR") {
		t.Fatalf("createInvoice foreign currency error = %v, want missing FX rate rejection", err)
	}
	if got := countInvoices(fx, fx.orgID); got != 0 {
		t.Fatalf("rejected FX invoice created %d invoice rows", got)
	}
}

func TestGoTrialBalanceSortsRowsAndBalancesEachCurrency(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	seedAccountingInvoiceFixture(t, fx)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, '1000', 'Cash', 'asset')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 27, 10, 30, 0, 0, time.UTC)
	actorID := fx.userID
	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		for _, posting := range []PostJournalEntryInput{
			{
				OrgID: fx.orgID, Memo: "Foreign currency test", SourceType: "manual", Currency: "EUR", PostedAt: now, ActorType: "human", ActorID: &actorID,
				Lines: []JournalEntryLineInput{{AccountCode: "1000", DebitMinor: 50_000}, {AccountCode: "4000", CreditMinor: 50_000}},
			},
			{
				OrgID: fx.orgID, Memo: "Base currency test", SourceType: "manual", Currency: "USD", PostedAt: now, ActorType: "human", ActorID: &actorID,
				Lines: []JournalEntryLineInput{{AccountCode: "1100", DebitMinor: 30_000}, {AccountCode: "4000", CreditMinor: 30_000}},
			},
		} {
			if _, err := postJournalEntry(fx.ctx, tx, posting); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	})
	if err != nil {
		t.Fatalf("post multi-currency fixture entries: %v", err)
	}
	trial, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (TrialBalanceOutput, error) {
		return trialBalance(fx.ctx, tx, TrialBalanceInput{})
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		code, currency string
	}{
		{code: "1000", currency: "EUR"},
		{code: "1100", currency: "USD"},
		{code: "4000", currency: "EUR"},
		{code: "4000", currency: "USD"},
	}
	if !trial.Balanced || len(trial.Lines) != len(want) {
		t.Fatalf("multi-currency trial balance = %+v, want balanced four rows", trial)
	}
	for index, expected := range want {
		if trial.Lines[index].Code != expected.code || trial.Lines[index].Currency != expected.currency {
			t.Fatalf("trial balance rows = %+v, want sorted code/currency at index %d = %+v", trial.Lines, index, expected)
		}
	}
}

func seedAccountingInvoiceFixture(t *testing.T, fx *executorFixture) string {
	t.Helper()
	_, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1100', 'Accounts Receivable', 'asset'),
		($1::uuid, '2100', 'Sales Tax Payable', 'liability'),
		($1::uuid, '4000', 'Sales Revenue', 'income')`, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	return seedInvoiceCustomerID(t, fx)
}

func seedInvoiceCustomerID(t *testing.T, fx *executorFixture) string {
	t.Helper()
	var customerID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, payment_term_days)
		VALUES ($1::uuid, 'Accounting Go fixture customer', NULL) RETURNING id::text`, fx.orgID).Scan(&customerID)
	if err != nil {
		t.Fatal(err)
	}
	return customerID
}

func countInvoices(fx *executorFixture, orgID string) int64 {
	fx.t.Helper()
	var count int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM invoices WHERE org_id=$1::uuid`, orgID).Scan(&count); err != nil {
		fx.t.Fatal(err)
	}
	return count
}

func cleanupAccountingFixtureLedger(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin accounting fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable accounting fixture ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id=$1::uuid)`, fx.orgID); err != nil {
			t.Errorf("delete accounting fixture journal lines: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM journal_entries WHERE org_id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete accounting fixture journal entries: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM invoices WHERE org_id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete accounting fixture invoices: %v", err)
			return
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit accounting fixture ledger cleanup: %v", err)
		}
	})
}
