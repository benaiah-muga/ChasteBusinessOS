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

func TestAccountingInvoiceOpsParsersMirrorZodContracts(t *testing.T) {
	invoiceID := "44444444-4444-4444-8444-444444444444"

	credited, err := ParseCreditNoteInput(json.RawMessage(`{"invoiceId":"` + invoiceID + `","amountMinor":2500,"reason":"Duplicate charge","extra":true}`))
	if err != nil {
		t.Fatal(err)
	}
	wantCredit := CreditNoteInput{InvoiceID: invoiceID, AmountMinor: 2500, Reason: "Duplicate charge"}
	if credited != wantCredit {
		t.Fatalf("ParseCreditNoteInput() = %+v, want %+v", credited, wantCredit)
	}
	encoded, err := marshalJS(credited)
	if err != nil || string(encoded) != `{"invoiceId":"`+invoiceID+`","amountMinor":2500,"reason":"Duplicate charge"}` {
		t.Fatalf("ParseCreditNoteInput() JSON = %s, %v", encoded, err)
	}
	longReason := strings.Repeat("r", 501)
	for _, raw := range []string{
		`[]`,
		`"x"`,
		`{}`,
		`{"amountMinor":100,"reason":"abc"}`,
		`{"invoiceId":null,"amountMinor":100,"reason":"abc"}`,
		`{"invoiceId":"nope","amountMinor":100,"reason":"abc"}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":null,"reason":"abc"}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":1.5,"reason":"abc"}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":0,"reason":"abc"}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":-5,"reason":"abc"}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":100}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":100,"reason":null}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":100,"reason":"ab"}`,
		`{"invoiceId":"` + invoiceID + `","amountMinor":100,"reason":"` + longReason + `"}`,
	} {
		if _, err := ParseCreditNoteInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreditNoteInput accepted %s", raw)
		}
	}

	shared, err := ParseShareInvoiceInput(json.RawMessage(`{"invoiceNumber":7,"revoke":true,"token":"tok","extra":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if shared.InvoiceNumber != 7 || !shared.Revoke || shared.Token == nil || *shared.Token != "tok" {
		t.Fatalf("ParseShareInvoiceInput() = %+v, want invoice 7 with revoke and token", shared)
	}
	defaulted, err := ParseShareInvoiceInput(json.RawMessage(`{"invoiceNumber":7}`))
	if err != nil || defaulted.Revoke || defaulted.Token != nil {
		t.Fatalf("ParseShareInvoiceInput(defaults) = %+v, %v, want revoke false and no token", defaulted, err)
	}
	if encoded, err = marshalJS(defaulted); err != nil || string(encoded) != `{"invoiceNumber":7,"revoke":false}` {
		t.Fatalf("defaulted share JSON = %s, %v", encoded, err)
	}
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"invoiceNumber":null}`,
		`{"invoiceNumber":1.5}`,
		`{"invoiceNumber":0}`,
		`{"invoiceNumber":-2}`,
		`{"invoiceNumber":7,"revoke":"yes"}`,
		`{"invoiceNumber":7,"revoke":null}`,
		`{"invoiceNumber":7,"token":5}`,
		`{"invoiceNumber":7,"token":null}`,
	} {
		if _, err := ParseShareInvoiceInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseShareInvoiceInput accepted %s", raw)
		}
	}

	if _, err := ParseGenerateDueInvoicesInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ParseGenerateDueInvoicesInput({}) = %v", err)
	}
	if _, err := ParseGenerateDueInvoicesInput(json.RawMessage(`{"unknownMember":1}`)); err != nil {
		t.Fatalf("ParseGenerateDueInvoicesInput must strip unknown members: %v", err)
	}
	for _, raw := range []string{`[]`, `"x"`, `null`, `5`} {
		if _, err := ParseGenerateDueInvoicesInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseGenerateDueInvoicesInput accepted %s", raw)
		}
	}

	reversal, err := ParseReverseEntryInput(json.RawMessage(`{"entryId":"plain-id","extra":2}`))
	if err != nil || reversal.EntryID != "plain-id" {
		t.Fatalf("ParseReverseEntryInput() = %+v, %v", reversal, err)
	}
	for _, raw := range []string{`[]`, `{}`, `{"entryId":null}`, `{"entryId":5}`, `{"memo":"x"}`} {
		if _, err := ParseReverseEntryInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseReverseEntryInput accepted %s", raw)
		}
	}

	validByCapability := map[string]string{
		creditNoteCapabilityID:          `{"invoiceId":"` + invoiceID + `","amountMinor":1,"reason":"abc"}`,
		shareInvoiceCapabilityID:        `{"invoiceNumber":3}`,
		generateDueInvoicesCapabilityID: `{}`,
		reverseEntryCapabilityID:        `{"entryId":"abc"}`,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingInvoiceOpsInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingInvoiceOpsInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingInvoiceOpsInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingInvoiceOpsInput accepted an unsupported capability")
	}
}

func TestAccountingInvoiceOpsNextRunAfterScheduleMath(t *testing.T) {
	at := func(value string) time.Time {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatal(err)
		}
		return parsed
	}
	for _, tc := range []struct {
		frequency string
		from      time.Time
		want      time.Time
	}{
		{"weekly", at("2026-01-05T00:05:00Z"), at("2026-01-12T00:05:00Z")},
		{"weekly", at("2026-12-28T23:59:59Z"), at("2027-01-04T23:59:59Z")},
		{"monthly", at("2026-01-31T10:15:30Z"), at("2026-02-28T10:15:30Z")},
		{"monthly", at("2027-01-31T10:15:30Z"), at("2027-02-28T10:15:30Z")},
		{"monthly", at("2028-01-31T10:15:30Z"), at("2028-02-29T10:15:30Z")},
		{"monthly", at("2026-10-31T09:00:00Z"), at("2026-11-30T09:00:00Z")},
		{"monthly", at("2026-02-28T00:00:00Z"), at("2026-03-28T00:00:00Z")},
		{"monthly", at("2026-04-30T12:00:00Z"), at("2026-05-30T12:00:00Z")},
		{"quarterly", at("2026-11-30T06:00:00Z"), at("2027-02-28T06:00:00Z")},
		{"quarterly", at("2026-08-31T06:00:00Z"), at("2026-11-30T06:00:00Z")},
	} {
		got, err := nextRunAfter(tc.frequency, tc.from)
		if err != nil {
			t.Fatalf("nextRunAfter(%s, %s): %v", tc.frequency, tc.from, err)
		}
		if !got.Equal(tc.want) {
			t.Errorf("nextRunAfter(%s, %s) = %s, want %s", tc.frequency, tc.from, got, tc.want)
		}
	}
	if _, err := nextRunAfter("yearly", at("2026-01-01T00:00:00Z")); err == nil {
		t.Error("nextRunAfter accepted an unknown frequency")
	}
}

func invoiceOpsTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func invoiceOpsForeignClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: "human", ActorID: &actorID}
}

func invoiceOpsSeedAccounts(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash', 'asset'),
		($1::uuid, '1100', 'Accounts Receivable', 'asset'),
		($1::uuid, '2100', 'Sales Tax Payable', 'liability'),
		($1::uuid, '4000', 'Sales Revenue', 'income')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func invoiceOpsSeedCustomer(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, payment_term_days)
		VALUES ($1::uuid, 'Invoice ops Go fixture customer', NULL)
		RETURNING id::text`, orgID).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

type invoiceOpsInvoiceSeed struct {
	Number        int64
	Status        string
	Currency      string
	SubtotalMinor int64
	TaxMinor      int64
	TotalMinor    int64
	PaidMinor     int64
	CreditedMinor int64
	Memo          *string
	IssuedAt      time.Time
}

func invoiceOpsSeedInvoice(t *testing.T, fx *executorFixture, orgID, customerID string, seed invoiceOpsInvoiceSeed) string {
	t.Helper()
	if seed.Status == "" {
		seed.Status = "sent"
	}
	if seed.Currency == "" {
		seed.Currency = "USD"
	}
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, memo, issued_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		RETURNING id::text`, orgID, customerID, seed.Number, seed.Status, seed.Currency,
		seed.SubtotalMinor, seed.TaxMinor, seed.TotalMinor, seed.PaidMinor, seed.CreditedMinor, seed.Memo, seed.IssuedAt).
		Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	return invoiceID
}

func invoiceOpsCleanupLedger(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin invoice ops fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable invoice ops fixture ledger cleanup: %v", err)
			return
		}
		for _, statement := range []string{
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM recurring_invoice_runs WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM invoice_shares WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM recurring_invoices WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM doc_counters WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`,
		} {
			if _, err := tx.Exec(fx.ctx, statement, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("invoice ops fixture cleanup step failed: %v", err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit invoice ops fixture cleanup: %v", err)
		}
	})
}

func TestAccountingInvoiceOpsCreditNoteMirrorsLedgerAndBalance(t *testing.T) {
	fx := newExecutorFixture(t)
	invoiceOpsCleanupLedger(t, fx)
	invoiceOpsSeedAccounts(t, fx)
	claims := invoiceOpsTestClaims(fx)
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	customerID := invoiceOpsSeedCustomer(t, fx, fx.orgID)
	invoiceID := invoiceOpsSeedInvoice(t, fx, fx.orgID, customerID, invoiceOpsInvoiceSeed{
		Number: 1, SubtotalMinor: 10_000, TaxMinor: 500, TotalMinor: 10_500, IssuedAt: now.Add(-24 * time.Hour),
	})
	foreignInvoiceID := invoiceOpsSeedInvoice(t, fx, fx.otherOrgID, invoiceOpsSeedCustomer(t, fx, fx.otherOrgID), invoiceOpsInvoiceSeed{
		Number: 1, SubtotalMinor: 10_000, TaxMinor: 500, TotalMinor: 10_500, IssuedAt: now.Add(-24 * time.Hour),
	})
	voidInvoiceID := invoiceOpsSeedInvoice(t, fx, fx.orgID, customerID, invoiceOpsInvoiceSeed{
		Number: 2, Status: "void", SubtotalMinor: 4_000, TaxMinor: 0, TotalMinor: 4_000, IssuedAt: now.Add(-24 * time.Hour),
	})
	saleEntryID, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Invoice 1", SourceType: "invoice", SourceID: &invoiceID,
			Currency: "USD", PostedAt: now.Add(-24 * time.Hour), ActorType: claims.ActorType, ActorID: claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "1100", DebitMinor: 10_500},
				{AccountCode: "4000", CreditMinor: 10_000},
				{AccountCode: "2100", CreditMinor: 500},
			},
		})
	})
	if err != nil {
		t.Fatalf("seed invoice sale entry: %v", err)
	}

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreditNoteOutput, error) {
		return executeCreditNote(fx.ctx, tx, claims, CreditNoteInput{InvoiceID: invoiceID, AmountMinor: 3_000, Reason: "Damaged goods concession"}, now)
	})
	if err != nil {
		t.Fatalf("executeCreditNote: %v", err)
	}
	if !isUUID(first.EntryID) || first.CreditedMinor != 3_000 || first.InvoiceBalanceMinor != 7_500 {
		t.Fatalf("first credit output = %+v, want credited 3000 and balance 7500", first)
	}
	encoded, err := marshalJS(first)
	if err != nil || string(encoded) != fmt.Sprintf(`{"entryId":%q,"creditedMinor":3000,"invoiceBalanceMinor":7500}`, first.EntryID) {
		t.Fatalf("first credit JSON = %s, %v", encoded, err)
	}
	var memo, sourceType, currency string
	var sourceID, reversalOfID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, reversal_of_id::text, currency
		FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, first.EntryID, fx.orgID).
		Scan(&memo, &sourceType, &sourceID, &reversalOfID, &currency); err != nil {
		t.Fatal(err)
	}
	if memo != "Credit note on invoice 1: Damaged goods concession" || sourceType != "invoice_credit_note" ||
		sourceID == nil || *sourceID != invoiceID || reversalOfID == nil || *reversalOfID != saleEntryID || currency != "USD" {
		t.Fatalf("credit entry = memo=%q source=%s/%v reversalOf=%v currency=%s", memo, sourceType, sourceID, reversalOfID, currency)
	}
	if lines := expenseEntryLines(t, fx, first.EntryID); len(lines) != 3 ||
		lines[0] != (expenseJournalLineSummary{code: "1100", debit: 0, credit: 3_000}) ||
		lines[1] != (expenseJournalLineSummary{code: "2100", debit: 143, credit: 0}) ||
		lines[2] != (expenseJournalLineSummary{code: "4000", debit: 2_857, credit: 0}) {
		t.Fatalf("first credit lines = %+v, want 4000 debit 2857, 2100 debit 143, 1100 credit 3000", expenseEntryLines(t, fx, first.EntryID))
	}
	if got := fx.count(`SELECT credited_minor FROM invoices WHERE id = $1::uuid`, invoiceID); got != 3_000 {
		t.Fatalf("credited_minor = %d, want 3000", got)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreditNoteOutput, error) {
		return executeCreditNote(fx.ctx, tx, claims, CreditNoteInput{InvoiceID: invoiceID, AmountMinor: 2_000, Reason: "Goodwill credit"}, now)
	})
	if err != nil {
		t.Fatalf("second credit: %v", err)
	}
	if second.CreditedMinor != 5_000 || second.InvoiceBalanceMinor != 5_500 {
		t.Fatalf("second credit output = %+v, want credited 5000 and balance 5500", second)
	}
	if lines := expenseEntryLines(t, fx, second.EntryID); len(lines) != 3 ||
		lines[1] != (expenseJournalLineSummary{code: "2100", debit: 95, credit: 0}) ||
		lines[2] != (expenseJournalLineSummary{code: "4000", debit: 1_905, credit: 0}) {
		t.Fatalf("second credit lines = %+v, want 4000 debit 1905 and 2100 debit 95", expenseEntryLines(t, fx, second.EntryID))
	}
	var secondReversalOf *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT reversal_of_id::text FROM journal_entries WHERE id = $1::uuid`, second.EntryID).Scan(&secondReversalOf); err != nil {
		t.Fatal(err)
	}
	if secondReversalOf != nil {
		t.Fatalf("second credit reversal_of_id = %s, want null: the posting door allows one reversal reference per entry, later partial credits carry provenance via sourceType and sourceId", *secondReversalOf)
	}

	for _, bad := range []struct {
		invoiceID string
		amount    int64
		wantErr   string
	}{
		{invoiceID, 6_000, "credit 6000 exceeds the open balance 5500 (total 10500 - paid 0 - credited 5000)"},
		{voidInvoiceID, 100, "invoice is void; nothing to credit"},
		{executorUUID(t), 100, "invoice not found"},
		{foreignInvoiceID, 100, "invoice not found"},
	} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreditNoteOutput, error) {
			return executeCreditNote(fx.ctx, tx, claims, CreditNoteInput{InvoiceID: bad.invoiceID, AmountMinor: bad.amount, Reason: "Attempted credit"}, now)
		})
		if err == nil || err.Error() != bad.wantErr {
			t.Fatalf("executeCreditNote(%s, %d) error = %v, want %q", bad.invoiceID, bad.amount, err, bad.wantErr)
		}
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after credit notes = %d, want balanced books", drift)
	}
}

func TestAccountingInvoiceOpsShareInvoiceCreatesAndRevokes(t *testing.T) {
	fx := newExecutorFixture(t)
	invoiceOpsCleanupLedger(t, fx)
	claims := invoiceOpsTestClaims(fx)
	foreignClaims := invoiceOpsForeignClaims(fx)
	now := time.Date(2026, 9, 26, 9, 0, 0, 0, time.UTC)
	customerID := invoiceOpsSeedCustomer(t, fx, fx.orgID)
	invoiceID := invoiceOpsSeedInvoice(t, fx, fx.orgID, customerID, invoiceOpsInvoiceSeed{
		Number: 7, SubtotalMinor: 1_000, TaxMinor: 0, TotalMinor: 1_000, IssuedAt: now,
	})
	invoiceOpsSeedInvoice(t, fx, fx.otherOrgID, invoiceOpsSeedCustomer(t, fx, fx.otherOrgID), invoiceOpsInvoiceSeed{
		Number: 7, SubtotalMinor: 1_000, TaxMinor: 0, TotalMinor: 1_000, IssuedAt: now,
	})

	shared, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ShareInvoiceOutput, error) {
		return executeShareInvoice(fx.ctx, tx, claims, ShareInvoiceInput{InvoiceNumber: 7}, now)
	})
	if err != nil {
		t.Fatalf("executeShareInvoice: %v", err)
	}
	if shared.Token == nil || len(*shared.Token) != 32 || shared.URLPath == nil || *shared.URLPath != "/portal/"+*shared.Token || shared.Revoked != nil {
		t.Fatalf("share output = %+v, want a 32 character base64url token with its portal path", shared)
	}
	encoded, err := marshalJS(shared)
	if err != nil || string(encoded) != fmt.Sprintf(`{"token":%q,"urlPath":"/portal/%s"}`, *shared.Token, *shared.Token) {
		t.Fatalf("share JSON = %s, %v", encoded, err)
	}
	var storedInvoiceID, actorType string
	var actorID *string
	var revokedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT invoice_id::text, created_by_actor_type, created_by_actor_id::text, revoked_at
		FROM invoice_shares WHERE token = $1 AND org_id = $2::uuid`, *shared.Token, fx.orgID).
		Scan(&storedInvoiceID, &actorType, &actorID, &revokedAt); err != nil {
		t.Fatal(err)
	}
	if storedInvoiceID != invoiceID || actorType != "human" || actorID == nil || *actorID != fx.userID || revokedAt != nil {
		t.Fatalf("stored share = invoice=%s actor=%s/%v revoked=%v", storedInvoiceID, actorType, actorID, revokedAt)
	}

	again, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ShareInvoiceOutput, error) {
		return executeShareInvoice(fx.ctx, tx, claims, ShareInvoiceInput{InvoiceNumber: 7}, now)
	})
	if err != nil || again.Token == nil || *again.Token == *shared.Token {
		t.Fatalf("second share = %+v, %v, want a fresh distinct token", again, err)
	}

	revoked, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ShareInvoiceOutput, error) {
		return executeShareInvoice(fx.ctx, tx, claims, ShareInvoiceInput{InvoiceNumber: 7, Revoke: true, Token: shared.Token}, now)
	})
	if err != nil || revoked.Revoked == nil || !*revoked.Revoked || revoked.Token != nil || revoked.URLPath != nil {
		t.Fatalf("revoke output = %+v, %v, want only revoked true", revoked, err)
	}
	if encoded, err = marshalJS(revoked); err != nil || string(encoded) != `{"revoked":true}` {
		t.Fatalf("revoke JSON = %s, %v", encoded, err)
	}
	if got := fx.count(`SELECT count(*) FROM invoice_shares WHERE token = $1 AND revoked_at IS NOT NULL`, *shared.Token); got != 1 {
		t.Fatalf("revoked share rows = %d, want the token marked revoked", got)
	}
	if got := fx.count(`SELECT count(*) FROM invoice_shares WHERE token = $1 AND revoked_at IS NULL`, *again.Token); got != 1 {
		t.Fatalf("sibling share rows = %d, want the second token untouched", got)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ShareInvoiceOutput, error) {
		return executeShareInvoice(fx.ctx, tx, foreignClaims, ShareInvoiceInput{InvoiceNumber: 7}, now)
	}); err == nil || err.Error() != "invoice not found" {
		t.Fatalf("cross-tenant share error = %v, want invoice not found", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ShareInvoiceOutput, error) {
		return executeShareInvoice(fx.ctx, tx, foreignClaims, ShareInvoiceInput{InvoiceNumber: 7, Revoke: true, Token: shared.Token}, now)
	}); err != nil {
		t.Fatalf("cross-tenant revoke refused outright: %v", err)
	}
	if got := fx.count(`SELECT count(*) FROM invoice_shares WHERE token = $1 AND revoked_at IS NOT NULL`, *shared.Token); got != 1 {
		t.Fatal("cross-tenant revoke mutated a foreign org share")
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ShareInvoiceOutput, error) {
		return executeShareInvoice(fx.ctx, tx, claims, ShareInvoiceInput{InvoiceNumber: 7, Revoke: true}, now)
	}); err == nil || err.Error() != "revoke requires the token to revoke" {
		t.Fatalf("tokenless revoke error = %v, want explicit refusal", err)
	}
}

func TestAccountingInvoiceOpsGenerateDueInvoicesExpandsDueTemplatesOnce(t *testing.T) {
	fx := newExecutorFixture(t)
	invoiceOpsCleanupLedger(t, fx)
	invoiceOpsSeedAccounts(t, fx)
	claims := invoiceOpsTestClaims(fx)
	now := time.Date(2026, 2, 5, 10, 0, 0, 0, time.UTC)
	customerID := invoiceOpsSeedCustomer(t, fx, fx.orgID)
	foreignCustomerID := invoiceOpsSeedCustomer(t, fx, fx.otherOrgID)
	dueScheduled := time.Date(2026, 1, 31, 10, 0, 0, 0, time.UTC)
	weeklyScheduled := time.Date(2026, 2, 3, 8, 30, 0, 0, time.UTC)
	seedTemplate := func(t *testing.T, fx *executorFixture, orgID, customerID, frequency, memo string, lines string, active bool, nextRunAt time.Time) string {
		t.Helper()
		var templateID string
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO recurring_invoices (org_id, customer_id, frequency, lines, memo, active, next_run_at, created_by_actor_type)
			VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, 'human')
			RETURNING id::text`, orgID, customerID, frequency, lines, memo, active, nextRunAt).Scan(&templateID); err != nil {
			t.Fatal(err)
		}
		return templateID
	}
	dueTemplateID := seedTemplate(t, fx, fx.orgID, customerID, "monthly", "Managed hosting",
		`[{"description":"Managed hosting","quantity":1000,"unitPriceMinor":500000,"taxMinor":50000}]`, true, dueScheduled)
	weeklyTemplateID := seedTemplate(t, fx, fx.orgID, customerID, "weekly", "",
		`[{"description":"Support retainer","quantity":2000,"unitPriceMinor":150000}]`, true, weeklyScheduled)
	seedTemplate(t, fx, fx.orgID, customerID, "monthly", "Not due yet",
		`[{"description":"Future","quantity":1000,"unitPriceMinor":1000}]`, true, now.Add(24*time.Hour))
	seedTemplate(t, fx, fx.orgID, customerID, "monthly", "Paused",
		`[{"description":"Paused line","quantity":1000,"unitPriceMinor":1000}]`, false, dueScheduled)
	seedTemplate(t, fx, fx.otherOrgID, foreignCustomerID, "monthly", "Foreign template",
		`[{"description":"Foreign","quantity":1000,"unitPriceMinor":1000}]`, true, dueScheduled)

	expanded, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (GenerateDueInvoicesOutput, error) {
		return executeGenerateDueInvoices(fx.ctx, tx, claims, GenerateDueInvoicesInput{}, now)
	})
	if err != nil {
		t.Fatalf("executeGenerateDueInvoices: %v", err)
	}
	if expanded.Generated != 2 {
		t.Fatalf("generated = %d, want exactly the two due active templates", expanded.Generated)
	}
	if encoded, err := marshalJS(expanded); err != nil || string(encoded) != `{"generated":2}` {
		t.Fatalf("generate output JSON = %s, %v", encoded, err)
	}

	var invoiceID string
	var number, totalMinor, taxMinor int64
	var memo, status string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, number, total_minor, tax_minor, memo, status
		FROM invoices WHERE org_id = $1::uuid AND customer_id = $2::uuid
		ORDER BY number`, fx.orgID, customerID).Scan(&invoiceID, &number, &totalMinor, &taxMinor, &memo, &status); err != nil {
		t.Fatalf("first expanded invoice: %v", err)
	}
	if number != 1 || totalMinor != 550_000 || taxMinor != 50_000 || memo != "Managed hosting" || status != "sent" {
		t.Fatalf("expanded invoice = number=%d total=%d tax=%d memo=%q status=%s, want invoice 1 totaling 550000", number, totalMinor, taxMinor, memo, status)
	}
	if got := fx.count(`SELECT count(*) FROM invoice_lines WHERE invoice_id = $1::uuid AND description = 'Managed hosting' AND quantity = 1000 AND unit_price_minor = 500000 AND tax_minor = 50000`, invoiceID); got != 1 {
		t.Fatalf("expanded invoice lines = %d, want the frozen template line", got)
	}
	if got := fx.count(`SELECT count(*) FROM doc_counters WHERE org_id = $1::uuid AND kind = 'invoice' AND "next" = 2`, fx.orgID); got != 1 {
		t.Fatalf("doc counter rows = %d, want the invoice sequence parked at 2", got)
	}

	var nextRunAt, lastRunAt, completedAt time.Time
	var scheduledFor time.Time
	var runInvoiceID *string
	var runStatus string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT next_run_at, last_run_at FROM recurring_invoices WHERE id = $1::uuid`, dueTemplateID).
		Scan(&nextRunAt, &lastRunAt); err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 2, 28, 10, 0, 0, 0, time.UTC); !nextRunAt.Equal(want) {
		t.Fatalf("monthly template next_run_at = %s, want clamped to %s", nextRunAt, want)
	}
	if !lastRunAt.Equal(now) {
		t.Fatalf("monthly template last_run_at = %s, want %s", lastRunAt, now)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT scheduled_for, invoice_id::text, status, completed_at
		FROM recurring_invoice_runs WHERE recurring_invoice_id = $1::uuid`, dueTemplateID).
		Scan(&scheduledFor, &runInvoiceID, &runStatus, &completedAt); err != nil {
		t.Fatal(err)
	}
	if !scheduledFor.Equal(dueScheduled) || runInvoiceID == nil || *runInvoiceID != invoiceID || runStatus != "completed" || !completedAt.Equal(now) {
		t.Fatalf("run row = scheduled=%s invoice=%v status=%s completed=%s", scheduledFor, runInvoiceID, runStatus, completedAt)
	}
	var weeklyMemo string
	var weeklyNextRun time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT i.memo, t.next_run_at
		FROM recurring_invoices t
		JOIN recurring_invoice_runs r ON r.recurring_invoice_id = t.id
		JOIN invoices i ON i.id = r.invoice_id
		WHERE t.id = $1::uuid`, weeklyTemplateID).Scan(&weeklyMemo, &weeklyNextRun); err != nil {
		t.Fatal(err)
	}
	if weeklyMemo != "Recurring (weekly)" {
		t.Fatalf("defaulted recurring memo = %q, want Recurring (weekly)", weeklyMemo)
	}
	if want := time.Date(2026, 2, 10, 8, 30, 0, 0, time.UTC); !weeklyNextRun.Equal(want) {
		t.Fatalf("weekly template next_run_at = %s, want %s", weeklyNextRun, want)
	}
	if got := fx.count(`SELECT count(*) FROM invoices WHERE org_id = $1::uuid`, fx.otherOrgID); got != 0 {
		t.Fatalf("foreign org invoices = %d, want none generated from this org's run", got)
	}

	replay, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (GenerateDueInvoicesOutput, error) {
		return executeGenerateDueInvoices(fx.ctx, tx, claims, GenerateDueInvoicesInput{}, now)
	})
	if err != nil || replay.Generated != 0 {
		t.Fatalf("replay generated = %+v, %v, want zero double-billing", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM invoices WHERE org_id = $1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("invoices after replay = %d, want exactly the two generated ones", got)
	}
	if got := fx.count(`SELECT count(*) FROM recurring_invoice_runs WHERE org_id = $1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("run rows after replay = %d, want one occurrence per template", got)
	}
}

func TestAccountingInvoiceOpsReverseEntryMirrorsAndRoutes(t *testing.T) {
	fx := newExecutorFixture(t)
	invoiceOpsCleanupLedger(t, fx)
	invoiceOpsSeedAccounts(t, fx)
	claims := invoiceOpsTestClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	postedAt := now.Add(-24 * time.Hour)
	entryID, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Manual adjustment", SourceType: "manual",
			Currency: "USD", PostedAt: postedAt, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "1000", DebitMinor: 2_500},
				{AccountCode: "4000", CreditMinor: 2_500},
			},
		})
	})
	if err != nil {
		t.Fatalf("seed manual entry: %v", err)
	}

	reversed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseEntryOutput, error) {
		return executeReverseEntry(fx.ctx, tx, claims, ReverseEntryInput{EntryID: entryID}, now)
	})
	if err != nil {
		t.Fatalf("executeReverseEntry: %v", err)
	}
	if !isUUID(reversed.ReversalEntryID) {
		t.Fatalf("reverse output = %+v, want a reversal entry id", reversed)
	}
	encoded, err := marshalJS(reversed)
	if err != nil || string(encoded) != fmt.Sprintf(`{"reversalEntryId":%q}`, reversed.ReversalEntryID) {
		t.Fatalf("reverse JSON = %s, %v", encoded, err)
	}
	var memo, sourceType, entryKind, currency string
	var reversalOfID *string
	var businessAt, postedAtStored time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, entry_kind, reversal_of_id::text, currency, business_at, posted_at
		FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, reversed.ReversalEntryID, fx.orgID).
		Scan(&memo, &sourceType, &entryKind, &reversalOfID, &currency, &businessAt, &postedAtStored); err != nil {
		t.Fatal(err)
	}
	if memo != "Reversal of: Manual adjustment" || sourceType != "reversal" || entryKind != "correction" ||
		reversalOfID == nil || *reversalOfID != entryID || currency != "USD" || !businessAt.Equal(postedAt) || !postedAtStored.Equal(now) {
		t.Fatalf("reversal entry = memo=%q source=%s kind=%s reversalOf=%v currency=%s business=%s posted=%s",
			memo, sourceType, entryKind, reversalOfID, currency, businessAt, postedAtStored)
	}
	if lines := expenseEntryLines(t, fx, reversed.ReversalEntryID); len(lines) != 2 ||
		lines[0] != (expenseJournalLineSummary{code: "1000", debit: 0, credit: 2_500}) ||
		lines[1] != (expenseJournalLineSummary{code: "4000", debit: 2_500, credit: 0}) {
		t.Fatalf("reversal lines = %+v, want the exact mirror of the original", expenseEntryLines(t, fx, reversed.ReversalEntryID))
	}

	routedInvoiceID := executorUUID(t)
	invoiceEntryID, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Invoice 9", SourceType: "invoice", SourceID: &routedInvoiceID,
			Currency: "USD", PostedAt: postedAt, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "1100", DebitMinor: 900},
				{AccountCode: "4000", CreditMinor: 900},
			},
		})
	})
	if err != nil {
		t.Fatalf("seed invoice entry: %v", err)
	}
	paymentEntryID, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Payment for invoice 9", SourceType: "payment",
			Currency: "USD", PostedAt: postedAt, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "1000", DebitMinor: 300},
				{AccountCode: "1100", CreditMinor: 300},
			},
		})
	})
	if err != nil {
		t.Fatalf("seed payment entry: %v", err)
	}
	yearEndEntryID, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Year end roll", SourceType: "manual", EntryKind: "year_end_close",
			Currency: "USD", PostedAt: postedAt, ActorType: claims.ActorType, ActorID: claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "4000", DebitMinor: 700},
				{AccountCode: "1000", CreditMinor: 700},
			},
		})
	})
	if err != nil {
		t.Fatalf("seed year end entry: %v", err)
	}

	for _, bad := range []struct {
		entryID string
		wantErr string
	}{
		{reversed.ReversalEntryID, "cannot reverse a reversal"},
		{entryID, "journal entry has already been reversed"},
		{invoiceEntryID, "a invoice entry is undone by its domain workflow: use accounting.creditNote against the invoice"},
		{paymentEntryID, "a payment entry is undone by its domain workflow: use accounting.reversePayment on the payment"},
		{yearEndEntryID, "a year-end closing entry is replaced by accounting.closeYear (reopen December first), not mirrored"},
		{executorUUID(t), "entry not found"},
	} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseEntryOutput, error) {
			return executeReverseEntry(fx.ctx, tx, claims, ReverseEntryInput{EntryID: bad.entryID}, now)
		})
		if err == nil || err.Error() != bad.wantErr {
			t.Fatalf("executeReverseEntry(%s) error = %v, want %q", bad.entryID, err, bad.wantErr)
		}
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after reversal = %d, want balanced books", drift)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND source_type = 'reversal'`, fx.orgID); got != 1 {
		t.Fatalf("reversal entries = %d, want exactly one posted mirror", got)
	}
}
