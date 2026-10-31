package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestBankingReconciliationParsersMirrorZodContracts(t *testing.T) {
	transactionID := "22222222-2222-4222-8222-222222222222"
	paymentID := "33333333-3333-4333-8333-333333333333"
	entryID := "44444444-4444-4444-8444-444444444444"
	accountID := "55555555-5555-4555-8555-555555555555"

	added, err := ParseAddBankAccountInput(json.RawMessage(`{"name":"Operations","currencyCode":"eur","last4":"1234","balanceMinor":-500,"unknown":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if added.Name != "Operations" || added.CurrencyCode == nil || *added.CurrencyCode != "EUR" ||
		added.Last4 == nil || *added.Last4 != "1234" || added.BalanceMinor != -500 {
		t.Fatalf("ParseAddBankAccountInput() = %+v, want uppercased EUR currency", added)
	}
	bareAdd, err := ParseAddBankAccountInput(json.RawMessage(`{"name":"Operations"}`))
	if err != nil || bareAdd.CurrencyCode != nil || bareAdd.Last4 != nil || bareAdd.BalanceMinor != 0 {
		t.Fatalf("bare add input = %+v, %v, want default balance 0 and absent optionals", bareAdd, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"name":""}`,
		`{"name":null}`,
		`{"name":42}`,
		`{"name":"Operations","currencyCode":"E"}`,
		`{"name":"Operations","currencyCode":"EURO"}`,
		`{"name":"Operations","currencyCode":null}`,
		`{"name":"Operations","last4":"12a4"}`,
		`{"name":"Operations","last4":"123"}`,
		`{"name":"Operations","balanceMinor":1.5}`,
		`{"name":"Operations","balanceMinor":"5"}`,
		`{"name":"Operations","balanceMinor":true}`,
	} {
		if _, err := ParseAddBankAccountInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseAddBankAccountInput accepted %s", raw)
		}
	}
	// zod validates currencyCode only as a 3-letter uppercase string with
	// minor units defaulting to 2, so any 3-letter code passes the schema.
	if anyCode, err := ParseAddBankAccountInput(json.RawMessage(`{"name":"Operations","currencyCode":"XXX"}`)); err != nil || anyCode.CurrencyCode == nil || *anyCode.CurrencyCode != "XXX" {
		t.Fatalf("ParseAddBankAccountInput(XXX) = %+v, %v, want the zod default acceptance", anyCode, err)
	}

	imported, err := ParseImportBankFeedInput(json.RawMessage(`{"rows":[{"postedAt":"2026-09-01","amountMinor":-1200,"description":"Coffee"},{"postedAt":"2026-09-02","amountMinor":5,"description":"Fee"}]}`))
	if err != nil || len(imported.Rows) != 2 || imported.BankAccountID != nil {
		t.Fatalf("ParseImportBankFeedInput() = %+v, %v", imported, err)
	}
	importedWithAccount, err := ParseImportBankFeedInput(json.RawMessage(`{"bankAccountId":"` + accountID + `","rows":[{"postedAt":"2026-09-01","amountMinor":0,"description":"x"}]}`))
	if err != nil || importedWithAccount.BankAccountID == nil || *importedWithAccount.BankAccountID != accountID {
		t.Fatalf("ParseImportBankFeedInput(bankAccountId) = %+v, %v", importedWithAccount, err)
	}
	tooManyRows := []string{`{"postedAt":"2026-09-01","amountMinor":1,"description":"x"}`}
	for len(tooManyRows) <= 500 {
		tooManyRows = append(tooManyRows, tooManyRows[0])
	}
	for _, raw := range []string{
		`{}`,
		`{"rows":null}`,
		`{"rows":[]}`,
		`{"rows":{}}`,
		`{"rows":[{}]}`,
		`{"rows":[{"postedAt":"2026-9-01","amountMinor":1,"description":"x"}]}`,
		`{"rows":[{"postedAt":"2026-09-01","amountMinor":1.5,"description":"x"}]}`,
		`{"rows":[{"postedAt":"2026-09-01","amountMinor":"1","description":"x"}]}`,
		`{"rows":[{"postedAt":"2026-09-01","amountMinor":1,"description":""}]}`,
		`{"rows":[{"postedAt":"2026-09-01","amountMinor":1}]}`,
		`{"bankAccountId":"nope","rows":[{"postedAt":"2026-09-01","amountMinor":1,"description":"x"}]}`,
		`{"rows":` + fmt.Sprintf(`[%s]`, strings.Join(tooManyRows, ",")) + `}`,
	} {
		if _, err := ParseImportBankFeedInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseImportBankFeedInput accepted %.80s", raw)
		}
	}
	// The zod schema only checks the YYYY-MM-DD shape; impossible calendar
	// dates are refused when the feed execute parses each row.
	if _, err := ParseImportBankFeedInput(json.RawMessage(`{"rows":[{"postedAt":"2026-13-01","amountMinor":1,"description":"x"}]}`)); err != nil {
		t.Errorf("ParseImportBankFeedInput rejected a shape-valid date: %v", err)
	}

	for _, parse := range []func(json.RawMessage) (any, error){
		func(raw json.RawMessage) (any, error) { return ParseDeleteBankTransactionInput(raw) },
		func(raw json.RawMessage) (any, error) { return ParseUnmatchBankTransactionInput(raw) },
		func(raw json.RawMessage) (any, error) { return ParseExcludeBankTransactionInput(raw) },
		func(raw json.RawMessage) (any, error) { return ParseUnexcludeBankTransactionInput(raw) },
	} {
		name := fmt.Sprintf("%T", parse)
		if _, err := parse(json.RawMessage(`{"transactionId":"` + transactionID + `"}`)); err != nil {
			t.Errorf("%s rejected a valid transactionId: %v", name, err)
		}
		for _, raw := range []string{`{}`, `{"transactionId":null}`, `{"transactionId":"nope"}`, `{"transactionId":"11111111-1111-1111-1111-111111111111"}`} {
			if _, err := parse(json.RawMessage(raw)); err == nil {
				t.Errorf("%s accepted %s", name, raw)
			}
		}
	}

	matched, err := ParseMatchBankTransactionInput(json.RawMessage(`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","feeMinor":500,"note":"checked"}`))
	if err != nil {
		t.Fatal(err)
	}
	if matched.PaymentID == nil || matched.EntryID != nil || matched.FeeMinor == nil || *matched.FeeMinor != 500 || matched.Note == nil || *matched.Note != "checked" {
		t.Fatalf("ParseMatchBankTransactionInput() = %+v", matched)
	}
	entryMatch, err := ParseMatchBankTransactionInput(json.RawMessage(`{"transactionId":"` + transactionID + `","entryId":"` + entryID + `"}`))
	if err != nil || entryMatch.EntryID == nil || entryMatch.PaymentID != nil {
		t.Fatalf("ParseMatchBankTransactionInput(entry) = %+v, %v", entryMatch, err)
	}
	splitMatch, err := ParseMatchBankTransactionInput(json.RawMessage(`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","amountMinor":2500}`))
	if err != nil || splitMatch.AmountMinor == nil || *splitMatch.AmountMinor != 2500 {
		t.Fatalf("ParseMatchBankTransactionInput(split) = %+v, %v", splitMatch, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"transactionId":"nope"}`,
		`{"transactionId":"` + transactionID + `"}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","entryId":"` + entryID + `"}`,
		`{"transactionId":"` + transactionID + `","entryId":"` + entryID + `","feeMinor":10}`,
		`{"transactionId":"` + transactionID + `","entryId":"` + entryID + `","fxGainLossMinor":10}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","amountMinor":10,"feeMinor":10}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","amountMinor":10,"fxGainLossMinor":10}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","amountMinor":0}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","amountMinor":-5}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","feeMinor":0}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","feeMinor":-1}`,
		`{"transactionId":"` + transactionID + `","paymentId":"nope"}`,
		`{"transactionId":"` + transactionID + `","entryId":"nope"}`,
		`{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `","note":"` + strings.Repeat("n", 501) + `"}`,
	} {
		if _, err := ParseMatchBankTransactionInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseMatchBankTransactionInput accepted %.90s", raw)
		}
	}

	recon, err := ParseBankReconciliationInput(json.RawMessage(`{"bankAccountId":"` + accountID + `","from":"2026-09-01","to":"2026-09-30"}`))
	if err != nil || recon.BankAccountID != accountID || recon.From == nil || recon.To == nil {
		t.Fatalf("ParseBankReconciliationInput() = %+v, %v", recon, err)
	}
	bareRecon, err := ParseBankReconciliationInput(json.RawMessage(`{"bankAccountId":"` + accountID + `"}`))
	if err != nil || bareRecon.From != nil || bareRecon.To != nil {
		t.Fatalf("bare reconciliation input = %+v, %v", bareRecon, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"bankAccountId":"nope"}`,
		`{"bankAccountId":"` + accountID + `","from":"2026-9-1"}`,
		`{"bankAccountId":"` + accountID + `","from":null}`,
	} {
		if _, err := ParseBankReconciliationInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseBankReconciliationInput accepted %s", raw)
		}
	}
	// The zod isoDate schema checks the digit shape only; impossible calendar
	// dates are refused by the date window at execution time.
	if _, err := ParseBankReconciliationInput(json.RawMessage(`{"bankAccountId":"` + accountID + `","to":"2026-09-31"}`)); err != nil {
		t.Errorf("ParseBankReconciliationInput rejected a shape-valid date: %v", err)
	}

	if _, err := ParseBankSummaryInput(json.RawMessage(`{}`)); err != nil {
		t.Errorf("ParseBankSummaryInput({}) rejected: %v", err)
	}
	if _, err := ParseBankSummaryInput(json.RawMessage(`{"future":true}`)); err != nil {
		t.Errorf("ParseBankSummaryInput stripped unknown member, got %v", err)
	}
	for _, raw := range []string{`[]`, `"x"`, `null`} {
		if _, err := ParseBankSummaryInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseBankSummaryInput accepted %s", raw)
		}
	}

	validByCapability := map[string]string{
		addBankAccountCapabilityID:           `{"name":"Operations"}`,
		importBankFeedCapabilityID:           `{"rows":[{"postedAt":"2026-09-01","amountMinor":1,"description":"x"}]}`,
		deleteBankTransactionCapabilityID:    `{"transactionId":"` + transactionID + `"}`,
		matchBankTransactionCapabilityID:     `{"transactionId":"` + transactionID + `","paymentId":"` + paymentID + `"}`,
		unmatchBankTransactionCapabilityID:   `{"transactionId":"` + transactionID + `"}`,
		bankReconciliationCapabilityID:       `{"bankAccountId":"` + accountID + `"}`,
		excludeBankTransactionCapabilityID:   `{"transactionId":"` + transactionID + `"}`,
		unexcludeBankTransactionCapabilityID: `{"transactionId":"` + transactionID + `"}`,
		bankSummaryCapabilityID:              `{}`,
	}
	for capabilityID, raw := range validByCapability {
		parsed, err := parseBankingInput(capabilityID, json.RawMessage(raw))
		if err != nil {
			t.Errorf("parseBankingInput(%s) rejected %s: %v", capabilityID, raw, err)
			continue
		}
		switch capabilityID {
		case addBankAccountCapabilityID:
			if _, ok := parsed.(AddBankAccountInput); !ok {
				t.Errorf("parseBankingInput(%s) = %T", capabilityID, parsed)
			}
		case importBankFeedCapabilityID:
			if _, ok := parsed.(ImportBankFeedInput); !ok {
				t.Errorf("parseBankingInput(%s) = %T", capabilityID, parsed)
			}
		case matchBankTransactionCapabilityID:
			if _, ok := parsed.(MatchBankTransactionInput); !ok {
				t.Errorf("parseBankingInput(%s) = %T", capabilityID, parsed)
			}
		}
	}
	if _, err := parseBankingInput("accounting.unknownBanking", json.RawMessage(`{}`)); err == nil {
		t.Error("parseBankingInput accepted an unsupported capability")
	}
}

func TestBankingReconciliationDomainMathMirrorsBankrec(t *testing.T) {
	line := bankStatementLine{id: "line-1", amountMinor: 10000, status: "matched"}
	if got := bankLineUnexplained(line, 4000); got != 6000 {
		t.Fatalf("bankLineUnexplained = %d, want 6000", got)
	}

	proposed := []bankAllocationProposal{{kind: "payment", amountMinor: 6000}, {kind: "fee", amountMinor: 4000}}
	if _, err := planBankLineAllocations(line, 0, proposed); err != nil {
		t.Fatalf("planBankLineAllocations rejected a full split: %v", err)
	}
	if _, err := planBankLineAllocations(bankStatementLine{id: "x", amountMinor: 100, status: "excluded"}, 0, proposed); err == nil ||
		err.Error() != "an excluded statement line cannot take allocations; unexclude it first" {
		t.Fatalf("excluded line error = %v", err)
	}
	if _, err := planBankLineAllocations(line, 0, nil); err == nil || err.Error() != "at least one allocation is required" {
		t.Fatalf("empty proposal error = %v", err)
	}
	if _, err := planBankLineAllocations(line, 0, []bankAllocationProposal{{kind: "payment", amountMinor: 0}}); err == nil || err.Error() != "allocation amount must be nonzero" {
		t.Fatalf("zero amount error = %v", err)
	}
	if _, err := planBankLineAllocations(line, 0, []bankAllocationProposal{{kind: "entry", amountMinor: -1}}); err == nil ||
		err.Error() != "allocation direction mismatch: line is money in (10000), allocation is -1" {
		t.Fatalf("money-in direction error = %v", err)
	}
	outLine := bankStatementLine{id: "x", amountMinor: -5000, status: "unmatched"}
	if _, err := planBankLineAllocations(outLine, 0, []bankAllocationProposal{{kind: "payment", amountMinor: 1}}); err == nil ||
		err.Error() != "allocation direction mismatch: line is money out (-5000), allocation is 1" {
		t.Fatalf("money-out direction error = %v", err)
	}
	if _, err := planBankLineAllocations(line, 9000, []bankAllocationProposal{{kind: "payment", amountMinor: 1001}}); err == nil ||
		err.Error() != "allocation exceeds the statement line: line is 10000, allocations would reach 10001" {
		t.Fatalf("exceed error = %v", err)
	}
	if _, err := planBankLineAllocations(bankStatementLine{id: "x", amountMinor: -5000, status: "unmatched"}, -3000, []bankAllocationProposal{{kind: "entry", amountMinor: -2000}}); err != nil {
		t.Fatalf("negative line plan rejected: %v", err)
	}

	if remaining, err := bankPaymentRemaining(9000, 4000, 5000); err != nil || remaining != 0 {
		t.Fatalf("bankPaymentRemaining = %d, %v, want 0", remaining, err)
	}
	if _, err := bankPaymentRemaining(9000, 4000, 5001); err == nil ||
		err.Error() != "payment over-allocated: payment is 9000, allocations would reach 9001" {
		t.Fatalf("over-allocation error = %v", err)
	}

	detailed, totals, err := bankReconciliationTotals(
		[]bankStatementLine{
			{id: "a", amountMinor: 10000, status: "matched"},
			{id: "b", amountMinor: 2500, status: "unmatched"},
			{id: "c", amountMinor: -1000, status: "excluded"},
		},
		map[string]int64{"a": 10000},
	)
	if err != nil {
		t.Fatal(err)
	}
	if totals.linesMinor != 12500 || totals.allocatedMinor != 10000 || totals.unexplainedMinor != 2500 || totals.reconciled {
		t.Fatalf("totals = %+v, want open period", totals)
	}
	if detailed[2].allocatedMinor != 0 || detailed[2].unexplainedMinor != 0 {
		t.Fatalf("excluded detail = %+v, want zeroed allocation", detailed[2])
	}
	_, reconciledTotals, err := bankReconciliationTotals([]bankStatementLine{{id: "a", amountMinor: 7000, status: "matched"}}, map[string]int64{"a": 7000})
	if err != nil || !reconciledTotals.reconciled || reconciledTotals.unexplainedMinor != 0 {
		t.Fatalf("reconciled totals = %+v, %v", reconciledTotals, err)
	}
	if _, _, err := bankReconciliationTotals([]bankStatementLine{{id: "a", amountMinor: 1000, status: "matched"}}, map[string]int64{"a": 2000}); err == nil ||
		err.Error() != "line a is over-allocated: 2000 against 1000" {
		t.Fatalf("over-allocated totals error = %v", err)
	}

	start, end, err := bankDateWindow("2026-09-01", "2026-09-30")
	if err != nil {
		t.Fatal(err)
	}
	if !start.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) || !end.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("bankDateWindow = %v..%v, want September inclusive of the 30th", start, end)
	}
	if _, _, err := bankDateWindow("2026-09-30", "2026-09-01"); err == nil || err.Error() != "`to` is before `from`" {
		t.Fatalf("inverted window error = %v", err)
	}
	if _, _, err := bankDateWindow("2026-02-30", "2026-09-30"); err == nil {
		t.Fatal("bankDateWindow accepted an impossible date")
	}
}

// cleanupBankingFixture removes banking rows and their payment/ledger
// dependencies in reverse dependency order. Posted journal rows refuse
// DELETE unless the transaction enables app.ledger_maintenance first.
func cleanupBankingFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin banking fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable banking fixture ledger cleanup: %v", err)
			return
		}
		statements := []string{
			`DELETE FROM bank_allocations WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM bank_transactions WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM bank_accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM vendor_payments WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM payment_runs WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM payments WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM vendor_bills WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM vendors WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, statement := range statements {
			if _, err := tx.Exec(fx.ctx, statement, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("banking fixture cleanup %q: %v", statement, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit banking fixture cleanup: %v", err)
		}
	})
}

func seedBankAccount(t *testing.T, fx *executorFixture, orgID, name, currency string, balanceMinor int64) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO bank_accounts (org_id, name, currency_code, balance_minor)
		VALUES ($1::uuid, $2, $3, $4)
		RETURNING id::text`, orgID, name, currency, balanceMinor).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedBankTransaction(t *testing.T, fx *executorFixture, orgID, accountID string, postedAt time.Time, amountMinor int64, description, status string) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO bank_transactions (org_id, bank_account_id, posted_at, amount_minor, description, status)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
		RETURNING id::text`, orgID, accountID, postedAt, amountMinor, description, status).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedBankAllocation(t *testing.T, fx *executorFixture, orgID, transactionID, kind string, paymentID, entryID *string, amountMinor int64, note *string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO bank_allocations (org_id, transaction_id, kind, payment_id, entry_id, amount_minor, note)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7)`,
		orgID, transactionID, kind, paymentID, entryID, amountMinor, note); err != nil {
		t.Fatal(err)
	}
}

func seedBankingInvoiceAndPayment(t *testing.T, fx *executorFixture, orgID, currency string, paymentAmountMinor int64) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Banking fixture customer')
		RETURNING id::text`, orgID).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, issued_at)
		VALUES ($1::uuid, $2::uuid, (SELECT coalesce(max(number), 0) + 1 FROM invoices WHERE org_id = $1::uuid), 'sent', $3, 100000, 0, 100000, now())
		RETURNING id::text`, orgID, customerID, currency).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	var paymentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, method, received_at)
		VALUES ($1::uuid, $2::uuid, $3, 'bank_transfer', now())
		RETURNING id::text`, orgID, invoiceID, paymentAmountMinor).Scan(&paymentID); err != nil {
		t.Fatal(err)
	}
	return paymentID
}

type bankingJournalLine struct {
	accountCode string
	debitMinor  int64
	creditMinor int64
}

func seedBankingAccounts(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash', 'asset'),
		($1::uuid, '4000', 'Sales Revenue', 'income')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func seedBankingJournalEntry(t *testing.T, fx *executorFixture, currency string, lines []bankingJournalLine) string {
	t.Helper()
	tx, err := fx.owner.Begin(fx.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var entryID string
	if err := tx.QueryRow(fx.ctx, `
		INSERT INTO journal_entries (org_id, memo, source_type, currency, posted_at, posted_by_actor_type)
		VALUES ($1::uuid, 'Banking fixture entry', 'banking_fixture', $2, now(), 'system')
		RETURNING id::text`, fx.orgID, currency).Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		if _, err := tx.Exec(fx.ctx, `
			INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
			VALUES ($1::uuid, (SELECT id FROM accounts WHERE org_id = $2::uuid AND code = $3), $4, $5)`,
			entryID, fx.orgID, line.accountCode, line.debitMinor, line.creditMinor); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(fx.ctx); err != nil {
		t.Fatal(err)
	}
	return entryID
}

func seedBankingVendorPaymentRun(t *testing.T, fx *executorFixture, entryID string, totalMinor int64) (string, string) {
	t.Helper()
	var vendorID, billID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Banking fixture vendor') RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor)
		VALUES ($1::uuid, $2::uuid, (SELECT coalesce(max(number), 0) + 1 FROM vendor_bills WHERE org_id = $1::uuid), 'open', 'USD', $3)
		RETURNING id::text`, fx.orgID, vendorID, totalMinor).Scan(&billID); err != nil {
		t.Fatal(err)
	}
	var runID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payment_runs (org_id, reference, currency, total_minor, status, journal_entry_id, memo, created_by_actor_type, instructed_at)
		VALUES ($1::uuid, $2, 'USD', $3, 'instructed', $4::uuid, 'Banking fixture run', 'system', now())
		RETURNING id::text`, fx.orgID, "run-"+executorUUID(t), totalMinor, entryID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	var vendorPaymentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_payments (org_id, bill_id, amount_minor, method, status, payment_run_id, paid_at)
		VALUES ($1::uuid, $2::uuid, $3, 'bank_transfer', 'instructed', $4::uuid, now())
		RETURNING id::text`, fx.orgID, billID, totalMinor, runID).Scan(&vendorPaymentID); err != nil {
		t.Fatal(err)
	}
	return runID, vendorPaymentID
}

func bankingInOrgTx[T any](t *testing.T, fx *executorFixture, run func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, run)
	if err != nil {
		t.Fatalf("banking transaction: %v", err)
	}
	return output
}

func bankingExpectError(t *testing.T, fx *executorFixture, wantErr string, run func(tx pgx.Tx) error) {
	t.Helper()
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, run(tx)
	}); err == nil || err.Error() != wantErr {
		t.Fatalf("banking error = %v, want %q", err, wantErr)
	}
}

func TestBankingReconciliationAddImportDeleteLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBankingFixture(t, fx)

	added := bankingInOrgTx(t, fx, func(tx pgx.Tx) (AddBankAccountOutput, error) {
		return addBankAccount(fx.ctx, tx, fx.orgID, AddBankAccountInput{Name: "Operations"})
	})
	if !isUUID(added.BankAccountID) {
		t.Fatalf("addBankAccount output = %+v, want a bank account id", added)
	}
	var currency, last4 *string
	var balanceMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT currency_code, last4, balance_minor FROM bank_accounts WHERE id = $1::uuid AND org_id = $2::uuid`,
		added.BankAccountID, fx.orgID).Scan(&currency, &last4, &balanceMinor); err != nil {
		t.Fatal(err)
	}
	if currency == nil || *currency != "USD" || last4 != nil || balanceMinor != 0 {
		t.Fatalf("stored account = currency=%v last4=%v balance=%d, want USD default with zero balance", currency, last4, balanceMinor)
	}

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (ImportBankFeedOutput, error) {
		return importBankFeed(fx.ctx, tx, fx.otherOrgID, ImportBankFeedInput{Rows: []BankFeedRow{{PostedAt: "2026-09-01", AmountMinor: 1, Description: "x"}}})
	})
	if err == nil || err.Error() != "no bank account yet; add one first" {
		t.Fatalf("import without accounts = %+v, %v, want the no-account refusal", first, err)
	}

	firstImport := bankingInOrgTx(t, fx, func(tx pgx.Tx) (ImportBankFeedOutput, error) {
		return importBankFeed(fx.ctx, tx, fx.orgID, ImportBankFeedInput{Rows: []BankFeedRow{
			{PostedAt: "2026-09-01", AmountMinor: 5000, Description: "Deposit"},
			{PostedAt: "2026-09-02", AmountMinor: -1200, Description: "Coffee"},
		}})
	})
	if firstImport.Inserted != 2 || firstImport.Skipped != 0 {
		t.Fatalf("first import = %+v, want two inserted rows", firstImport)
	}
	var postedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT posted_at FROM bank_transactions
		WHERE org_id = $1::uuid AND bank_account_id = $2::uuid AND description = 'Deposit'`,
		fx.orgID, added.BankAccountID).Scan(&postedAt); err != nil {
		t.Fatal(err)
	}
	if !postedAt.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("posted_at = %v, want UTC midnight 2026-09-01", postedAt)
	}

	reImport := bankingInOrgTx(t, fx, func(tx pgx.Tx) (ImportBankFeedOutput, error) {
		return importBankFeed(fx.ctx, tx, fx.orgID, ImportBankFeedInput{Rows: []BankFeedRow{
			{PostedAt: "2026-09-01", AmountMinor: 5000, Description: "Deposit"},
			{PostedAt: "2026-09-02", AmountMinor: -1200, Description: "Coffee"},
			{PostedAt: "2026-09-03", AmountMinor: 300, Description: "Refund"},
		}})
	})
	if reImport.Inserted != 1 || reImport.Skipped != 2 {
		t.Fatalf("re-import = %+v, want one inserted and two idempotent skips", reImport)
	}
	batchDuplicate := bankingInOrgTx(t, fx, func(tx pgx.Tx) (ImportBankFeedOutput, error) {
		return importBankFeed(fx.ctx, tx, fx.orgID, ImportBankFeedInput{Rows: []BankFeedRow{
			{PostedAt: "2026-09-04", AmountMinor: 700, Description: "Duplicate"},
			{PostedAt: "2026-09-04", AmountMinor: 700, Description: "Duplicate"},
		}})
	})
	if batchDuplicate.Inserted != 1 || batchDuplicate.Skipped != 1 {
		t.Fatalf("in-batch duplicate import = %+v, want one inserted and one skip", batchDuplicate)
	}

	euroAccount := bankingInOrgTx(t, fx, func(tx pgx.Tx) (AddBankAccountOutput, error) {
		parsed, err := ParseAddBankAccountInput(json.RawMessage(`{"name":"Euro account","currencyCode":"eur","last4":"9876","balanceMinor":2500}`))
		if err != nil {
			return AddBankAccountOutput{}, err
		}
		return addBankAccount(fx.ctx, tx, fx.orgID, parsed)
	})
	var euroCurrency string
	var euroLast4 *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT currency_code, last4 FROM bank_accounts WHERE id = $1::uuid`, euroAccount.BankAccountID).Scan(&euroCurrency, &euroLast4); err != nil {
		t.Fatal(err)
	}
	if euroCurrency != "EUR" || euroLast4 == nil || *euroLast4 != "9876" {
		t.Fatalf("euro account = currency=%s last4=%v, want EUR with last4 9876", euroCurrency, euroLast4)
	}

	ambiguous, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ImportBankFeedOutput, error) {
		return importBankFeed(fx.ctx, tx, fx.orgID, ImportBankFeedInput{Rows: []BankFeedRow{{PostedAt: "2026-09-05", AmountMinor: 1, Description: "x"}}})
	})
	if err == nil || err.Error() != "several bank accounts exist; pass bankAccountId" {
		t.Fatalf("ambiguous import = %+v, %v, want the multi-account refusal", ambiguous, err)
	}
	euroImport := bankingInOrgTx(t, fx, func(tx pgx.Tx) (ImportBankFeedOutput, error) {
		return importBankFeed(fx.ctx, tx, fx.orgID, ImportBankFeedInput{
			BankAccountID: &euroAccount.BankAccountID,
			Rows:          []BankFeedRow{{PostedAt: "2026-09-06", AmountMinor: -900, Description: "EUR spend"}},
		})
	})
	if euroImport.Inserted != 1 {
		t.Fatalf("euro import = %+v, want one row in the euro account", euroImport)
	}
	var euroRowCount int
	if got := fx.count(`SELECT count(*) FROM bank_transactions WHERE bank_account_id = $1::uuid`, euroAccount.BankAccountID); got != 1 {
		t.Fatalf("euro account rows = %d", got)
	}
	if euroRowCount != 0 {
		t.Fatalf("euro account rows = %d", euroRowCount)
	}
	bankingExpectError(t, fx, "bank account not found", func(tx pgx.Tx) error {
		_, err := importBankFeed(fx.ctx, tx, fx.orgID, ImportBankFeedInput{
			BankAccountID: crmStringPointer(executorUUID(t)),
			Rows:          []BankFeedRow{{PostedAt: "2026-09-05", AmountMinor: 1, Description: "x"}},
		})
		return err
	})
	bankingExpectError(t, fx, "invalid date: 2026-13-01", func(tx pgx.Tx) error {
		_, err := importBankFeed(fx.ctx, tx, fx.orgID, ImportBankFeedInput{
			BankAccountID: &added.BankAccountID,
			Rows:          []BankFeedRow{{PostedAt: "2026-13-01", AmountMinor: 1, Description: "x"}},
		})
		return err
	})

	unmatched := bankingInOrgTx(t, fx, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(fx.ctx, `SELECT id::text FROM bank_transactions WHERE bank_account_id = $1::uuid AND description = 'Deposit'`, added.BankAccountID).Scan(&id)
		return id, err
	})
	deleted := bankingInOrgTx(t, fx, func(tx pgx.Tx) (DeleteBankTransactionOutput, error) {
		return deleteBankTransaction(fx.ctx, tx, fx.orgID, DeleteBankTransactionInput{TransactionID: unmatched})
	})
	if !deleted.Deleted {
		t.Fatalf("delete output = %+v, want deleted", deleted)
	}
	if got := fx.count(`SELECT count(*) FROM bank_transactions WHERE id = $1::uuid`, unmatched); got != 0 {
		t.Fatalf("deleted row still present, rows=%d", got)
	}

	matched := seedBankTransaction(t, fx, fx.orgID, added.BankAccountID, time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC), 800, "Already matched", "matched")
	excluded := seedBankTransaction(t, fx, fx.orgID, added.BankAccountID, time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC), 900, "Already excluded", "excluded")
	foreign := seedBankTransaction(t, fx, fx.otherOrgID, seedBankAccount(t, fx, fx.otherOrgID, "Foreign", "USD", 0), time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC), 1000, "Foreign line", "unmatched")
	for _, bad := range []struct {
		transactionID string
		wantErr       string
	}{
		{matched, "transaction not found or already matched/excluded"},
		{excluded, "transaction not found or already matched/excluded"},
		{foreign, "transaction not found or already matched/excluded"},
		{executorUUID(t), "transaction not found or already matched/excluded"},
	} {
		bankingExpectError(t, fx, bad.wantErr, func(tx pgx.Tx) error {
			_, err := deleteBankTransaction(fx.ctx, tx, fx.orgID, DeleteBankTransactionInput{TransactionID: bad.transactionID})
			return err
		})
	}
	if got := fx.count(`SELECT count(*) FROM bank_transactions WHERE id = ANY($1::uuid[])`, []string{matched, excluded, foreign}); got != 3 {
		t.Fatalf("guarded rows deleted, rows=%d", got)
	}
}

func TestBankingReconciliationMatchPaymentFeeFxAndSplits(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBankingFixture(t, fx)
	account := seedBankAccount(t, fx, fx.orgID, "Operations", "USD", 0)

	paymentA := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 9500)
	feeLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), 10000, "Customer receipt", "unmatched")
	feeMatch := bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{
			TransactionID: feeLine, PaymentID: &paymentA, FeeMinor: crmInt64Pointer(500),
		}, time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC))
	})
	if feeMatch.Status != "matched" || feeMatch.AllocatedMinor != 10000 || feeMatch.LineUnexplainedMinor != 0 {
		t.Fatalf("fee match = %+v, want a fully explained 10000 line", feeMatch)
	}
	encoded, err := marshalJS(feeMatch)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"status":"matched","allocatedMinor":10000,"lineUnexplainedMinor":0}`
	if string(encoded) != wantJSON {
		t.Fatalf("fee match JSON = %s, want %s", encoded, wantJSON)
	}
	var feeKind string
	var feeNote *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT kind, note FROM bank_allocations
		WHERE org_id = $1::uuid AND transaction_id = $2::uuid AND kind = 'fee'`,
		fx.orgID, feeLine).Scan(&feeKind, &feeNote); err != nil {
		t.Fatal(err)
	}
	if feeNote == nil || *feeNote != "reviewed bank fee" {
		t.Fatalf("fee allocation note = %v, want the reviewed default", feeNote)
	}
	var lineStatus string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM bank_transactions WHERE id = $1::uuid`, feeLine).Scan(&lineStatus); err != nil {
		t.Fatal(err)
	}
	if lineStatus != "matched" {
		t.Fatalf("line status = %s, want matched", lineStatus)
	}

	paymentB := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 9000)
	fxLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC), 9500, "Customer receipt fx", "unmatched")
	fxMatch := bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{
			TransactionID: fxLine, PaymentID: &paymentB, FxGainLossMinor: crmInt64Pointer(500), Note: crmStringPointer("checked statement"),
		}, time.Date(2026, 9, 28, 10, 5, 0, 0, time.UTC))
	})
	if fxMatch.AllocatedMinor != 9500 || fxMatch.LineUnexplainedMinor != 0 {
		t.Fatalf("fx match = %+v, want the fx difference absorbed", fxMatch)
	}
	var paymentNote, fxNote *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT note FROM bank_allocations WHERE org_id = $1::uuid AND transaction_id = $2::uuid AND kind = 'payment'`, fx.orgID, fxLine).Scan(&paymentNote); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT note FROM bank_allocations WHERE org_id = $1::uuid AND transaction_id = $2::uuid AND kind = 'fx_difference'`, fx.orgID, fxLine).Scan(&fxNote); err != nil {
		t.Fatal(err)
	}
	if paymentNote == nil || fxNote == nil || *paymentNote != "checked statement" || *fxNote != "checked statement" {
		t.Fatalf("fx match notes = payment %v fx %v, want the caller note on both", paymentNote, fxNote)
	}

	paymentC := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 4000)
	paymentD := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 6000)
	splitLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC), 10000, "Split receipt", "unmatched")
	splitOne := bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{
			TransactionID: splitLine, PaymentID: &paymentC, AmountMinor: crmInt64Pointer(4000),
		}, time.Date(2026, 9, 28, 10, 10, 0, 0, time.UTC))
	})
	if splitOne.AllocatedMinor != 4000 || splitOne.LineUnexplainedMinor != 6000 {
		t.Fatalf("first split = %+v, want 4000 allocated and 6000 unexplained", splitOne)
	}
	splitTwo := bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{
			TransactionID: splitLine, PaymentID: &paymentD,
		}, time.Date(2026, 9, 28, 10, 11, 0, 0, time.UTC))
	})
	if splitTwo.AllocatedMinor != 10000 || splitTwo.LineUnexplainedMinor != 0 {
		t.Fatalf("second split = %+v, want the remainder claimed", splitTwo)
	}
	if got := fx.count(`SELECT count(*) FROM bank_allocations WHERE org_id = $1::uuid AND transaction_id = $2::uuid`, fx.orgID, splitLine); got != 2 {
		t.Fatalf("split allocation rows = %d, want two payment slices", got)
	}

	paymentE := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 9500)
	claimA := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC), 5000, "Claim A", "unmatched")
	claimB := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC), 4000, "Claim B", "unmatched")
	claimC := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 6, 0, 0, 0, 0, time.UTC), 600, "Claim C", "unmatched")
	bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: claimA, PaymentID: &paymentE, AmountMinor: crmInt64Pointer(5000)}, time.Time{})
	})
	bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: claimB, PaymentID: &paymentE, AmountMinor: crmInt64Pointer(4000)}, time.Time{})
	})
	bankingExpectError(t, fx, "payment over-allocated: payment is 9500, allocations would reach 9600", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: claimC, PaymentID: &paymentE, AmountMinor: crmInt64Pointer(600)}, time.Time{})
		return err
	})

	paymentF := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 12000)
	bigLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC), 10000, "Too small line", "unmatched")
	bankingExpectError(t, fx, "amount mismatch: line has 10000 unexplained, payment is 12000; pass feeMinor, fxGainLossMinor or a partial amountMinor to review the difference explicitly", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: bigLine, PaymentID: &paymentF}, time.Time{})
		return err
	})

	euroPayment := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "EUR", 2000)
	currencyLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC), 2000, "Currency guard", "unmatched")
	bankingExpectError(t, fx, "currency mismatch: statement account is USD, payment is EUR", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: currencyLine, PaymentID: &euroPayment}, time.Time{})
		return err
	})

	outLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC), -5000, "Money out", "unmatched")
	bankingExpectError(t, fx, "direction mismatch: a customer payment is money in, but this statement line is money out (-5000)", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: outLine, PaymentID: &paymentA}, time.Time{})
		return err
	})

	excludedLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC), 4000, "Excluded", "excluded")
	bankingExpectError(t, fx, "transaction is excluded; unexclude it before matching", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: excludedLine, PaymentID: &paymentA}, time.Time{})
		return err
	})

	tinyLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC), 1000, "Tiny", "unmatched")
	bankingExpectError(t, fx, "allocation exceeds the statement line: line is 1000, allocations would reach 2000", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: tinyLine, PaymentID: &paymentA, AmountMinor: crmInt64Pointer(2000)}, time.Time{})
		return err
	})

	bankingExpectError(t, fx, "payment not found", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: tinyLine, PaymentID: crmStringPointer(executorUUID(t))}, time.Time{})
		return err
	})
	bankingExpectError(t, fx, "bank transaction not found", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: executorUUID(t), PaymentID: &paymentA}, time.Time{})
		return err
	})
	if got := fx.count(`SELECT count(*) FROM bank_allocations WHERE org_id = $1::uuid AND transaction_id = $2::uuid`, fx.orgID, tinyLine); got != 0 {
		t.Fatalf("refused matches left allocation rows, rows=%d", got)
	}
	if got := fx.count(`SELECT count(*) FROM bank_transactions WHERE id = $1::uuid AND status = 'unmatched'`, tinyLine); got != 1 {
		t.Fatalf("refused matches mutated line status, rows=%d", got)
	}
}

func TestBankingReconciliationMatchEntryConfirmsInstructedVendorPayments(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBankingFixture(t, fx)
	seedBankingAccounts(t, fx)
	account := seedBankAccount(t, fx, fx.orgID, "Operations", "USD", 0)
	now := time.Date(2026, 9, 28, 11, 0, 0, 0, time.UTC)

	settlement := seedBankingJournalEntry(t, fx, "USD", []bankingJournalLine{
		{accountCode: "4000", debitMinor: 5000},
		{accountCode: "1000", creditMinor: 5000},
	})
	runID, vendorPaymentID := seedBankingVendorPaymentRun(t, fx, settlement, 5000)
	outLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), -5000, "Vendor settlement", "unmatched")
	entryMatch := bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{
			TransactionID: outLine, EntryID: &settlement, Note: crmStringPointer("transfer seen"),
		}, now)
	})
	if entryMatch.Status != "matched" || entryMatch.AllocatedMinor != -5000 || entryMatch.LineUnexplainedMinor != 0 {
		t.Fatalf("entry match = %+v, want the -5000 line explained", entryMatch)
	}
	encoded, err := marshalJS(entryMatch)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"status":"matched","allocatedMinor":-5000,"lineUnexplainedMinor":0}`
	if string(encoded) != wantJSON {
		t.Fatalf("entry match JSON = %s, want %s", encoded, wantJSON)
	}
	var allocationKind, allocationEntry string
	var allocationNote *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT kind, entry_id::text, note FROM bank_allocations
		WHERE org_id = $1::uuid AND transaction_id = $2::uuid`, fx.orgID, outLine).Scan(&allocationKind, &allocationEntry, &allocationNote); err != nil {
		t.Fatal(err)
	}
	if allocationKind != "entry" || allocationEntry != settlement || allocationNote == nil || *allocationNote != "transfer seen" {
		t.Fatalf("entry allocation = kind=%s entry=%s note=%v", allocationKind, allocationEntry, allocationNote)
	}
	var runStatus string
	var confirmedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, confirmed_at FROM payment_runs WHERE id = $1::uuid`, runID).Scan(&runStatus, &confirmedAt); err != nil {
		t.Fatal(err)
	}
	if runStatus != "confirmed" || confirmedAt == nil || !confirmedAt.Equal(now) {
		t.Fatalf("payment run = status=%s confirmed_at=%v, want confirmed at the capability instant", runStatus, confirmedAt)
	}
	var vendorStatus string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM vendor_payments WHERE id = $1::uuid`, vendorPaymentID).Scan(&vendorStatus); err != nil {
		t.Fatal(err)
	}
	if vendorStatus != "settled" {
		t.Fatalf("vendor payment status = %s, want settled", vendorStatus)
	}

	receipt := seedBankingJournalEntry(t, fx, "USD", []bankingJournalLine{
		{accountCode: "1000", debitMinor: 8000},
		{accountCode: "4000", creditMinor: 8000},
	})
	receiptLineA := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC), 8000, "Receipt A", "unmatched")
	receiptLineB := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), 8000, "Receipt B", "unmatched")
	bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: receiptLineA, EntryID: &receipt}, now)
	})
	bankingExpectError(t, fx, "entry over-allocated: entry nets 8000 on account 1000, allocations already explain 8000", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: receiptLineB, EntryID: &receipt}, now)
		return err
	})

	partial := seedBankingJournalEntry(t, fx, "USD", []bankingJournalLine{
		{accountCode: "4000", debitMinor: 4999},
		{accountCode: "1000", creditMinor: 4999},
	})
	mismatchLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC), -5000, "Cash mismatch", "unmatched")
	bankingExpectError(t, fx, "cash effect mismatch: entry nets -4999 on account 1000, statement line has -5000 unexplained", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: mismatchLine, EntryID: &partial}, now)
		return err
	})

	euroEntry := seedBankingJournalEntry(t, fx, "EUR", []bankingJournalLine{
		{accountCode: "4000", debitMinor: 10},
		{accountCode: "1000", creditMinor: 10},
	})
	euroLine := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC), -10, "Euro entry", "unmatched")
	bankingExpectError(t, fx, "currency mismatch: statement account is USD, entry is EUR", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: euroLine, EntryID: &euroEntry}, now)
		return err
	})
	bankingExpectError(t, fx, "journal entry not found", func(tx pgx.Tx) error {
		_, err := matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: euroLine, EntryID: crmStringPointer(executorUUID(t))}, now)
		return err
	})
	if got := fx.count(`SELECT count(*) FROM bank_transactions WHERE id = $1::uuid AND status = 'unmatched'`, mismatchLine); got != 1 {
		t.Fatalf("refused entry match mutated line status, rows=%d", got)
	}
}

func TestBankingReconciliationUnmatchExcludeGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBankingFixture(t, fx)
	account := seedBankAccount(t, fx, fx.orgID, "Operations", "USD", 0)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	payment := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 7000)
	line := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 17, 0, 0, 0, 0, time.UTC), 7000, "To unmatch", "unmatched")
	bankingInOrgTx(t, fx, func(tx pgx.Tx) (MatchBankTransactionOutput, error) {
		return matchBankTransaction(fx.ctx, tx, fx.orgID, MatchBankTransactionInput{TransactionID: line, PaymentID: &payment}, now)
	})
	unmatched := bankingInOrgTx(t, fx, func(tx pgx.Tx) (UnmatchBankTransactionOutput, error) {
		return unmatchBankTransaction(fx.ctx, tx, fx.orgID, UnmatchBankTransactionInput{TransactionID: line})
	})
	if unmatched.Status != "unmatched" || unmatched.ReleasedMinor != 7000 {
		t.Fatalf("unmatch output = %+v, want 7000 released", unmatched)
	}
	encoded, err := marshalJS(unmatched)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != fmt.Sprintf(`{"status":"unmatched","releasedMinor":7000}`) {
		t.Fatalf("unmatch JSON = %s", encoded)
	}
	if got := fx.count(`SELECT count(*) FROM bank_allocations WHERE org_id = $1::uuid AND transaction_id = $2::uuid`, fx.orgID, line); got != 0 {
		t.Fatalf("unmatch left allocation rows, rows=%d", got)
	}
	if got := fx.count(`SELECT count(*) FROM bank_transactions WHERE id = $1::uuid AND status = 'unmatched'`, line); got != 1 {
		t.Fatalf("unmatched line status wrong, rows=%d", got)
	}
	bankingExpectError(t, fx, "transaction not found or not matched", func(tx pgx.Tx) error {
		_, err := unmatchBankTransaction(fx.ctx, tx, fx.orgID, UnmatchBankTransactionInput{TransactionID: line})
		return err
	})

	toExclude := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC), 300, "Personal transfer", "unmatched")
	excluded := bankingInOrgTx(t, fx, func(tx pgx.Tx) (ExcludeBankTransactionOutput, error) {
		return excludeBankTransaction(fx.ctx, tx, fx.orgID, ExcludeBankTransactionInput{TransactionID: toExclude})
	})
	if excluded.Status != "excluded" {
		t.Fatalf("exclude output = %+v, want excluded", excluded)
	}
	bankingExpectError(t, fx, "transaction not found or not unmatched", func(tx pgx.Tx) error {
		_, err := excludeBankTransaction(fx.ctx, tx, fx.orgID, ExcludeBankTransactionInput{TransactionID: toExclude})
		return err
	})
	broughtBack := bankingInOrgTx(t, fx, func(tx pgx.Tx) (UnexcludeBankTransactionOutput, error) {
		return unexcludeBankTransaction(fx.ctx, tx, fx.orgID, UnexcludeBankTransactionInput{TransactionID: toExclude})
	})
	if broughtBack.Status != "unmatched" {
		t.Fatalf("unexclude output = %+v, want unmatched", broughtBack)
	}
	bankingExpectError(t, fx, "transaction not found or not excluded", func(tx pgx.Tx) error {
		_, err := unexcludeBankTransaction(fx.ctx, tx, fx.orgID, UnexcludeBankTransactionInput{TransactionID: toExclude})
		return err
	})

	matchedAgain := seedBankTransaction(t, fx, fx.orgID, account, time.Date(2026, 9, 19, 0, 0, 0, 0, time.UTC), 500, "Still matched", "matched")
	bankingExpectError(t, fx, "transaction not found or not unmatched", func(tx pgx.Tx) error {
		_, err := excludeBankTransaction(fx.ctx, tx, fx.orgID, ExcludeBankTransactionInput{TransactionID: matchedAgain})
		return err
	})
	foreign := seedBankTransaction(t, fx, fx.otherOrgID, seedBankAccount(t, fx, fx.otherOrgID, "Foreign", "USD", 0), time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC), 400, "Foreign line", "unmatched")
	for _, bad := range []struct {
		run     func(tx pgx.Tx) error
		wantErr string
	}{
		{func(tx pgx.Tx) error {
			_, err := excludeBankTransaction(fx.ctx, tx, fx.orgID, ExcludeBankTransactionInput{TransactionID: foreign})
			return err
		}, "transaction not found or not unmatched"},
		{func(tx pgx.Tx) error {
			_, err := unmatchBankTransaction(fx.ctx, tx, fx.orgID, UnmatchBankTransactionInput{TransactionID: foreign})
			return err
		}, "transaction not found or not matched"},
		{func(tx pgx.Tx) error {
			_, err := unexcludeBankTransaction(fx.ctx, tx, fx.orgID, UnexcludeBankTransactionInput{TransactionID: foreign})
			return err
		}, "transaction not found or not excluded"},
	} {
		bankingExpectError(t, fx, bad.wantErr, bad.run)
	}
}

func TestBankingReconciliationReadsAggregateAndScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBankingFixture(t, fx)
	accountA := seedBankAccount(t, fx, fx.orgID, "Operations", "USD", 0)
	accountB := seedBankAccount(t, fx, fx.orgID, "Savings", "EUR", 40000)

	payment := seedBankingInvoiceAndPayment(t, fx, fx.orgID, "USD", 10000)
	lineA := seedBankTransaction(t, fx, fx.orgID, accountA, time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC), 10000, "Matched receipt", "matched")
	lineB := seedBankTransaction(t, fx, fx.orgID, accountA, time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC), 2500, "Open receipt", "unmatched")
	lineC := seedBankTransaction(t, fx, fx.orgID, accountA, time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC), -1000, "Personal transfer", "excluded")
	seedBankAllocation(t, fx, fx.orgID, lineA, "payment", &payment, nil, 10000, nil)
	lineD := seedBankTransaction(t, fx, fx.orgID, accountB, time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC), 7000, "Euro receipt", "matched")
	seedBankAllocation(t, fx, fx.orgID, lineD, "entry", nil, crmStringPointer(executorUUID(t)), 7000, nil)
	foreignAccount := seedBankAccount(t, fx, fx.otherOrgID, "Foreign", "USD", 0)
	seedBankTransaction(t, fx, fx.otherOrgID, foreignAccount, time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC), 99000, "Foreign open line", "unmatched")

	open := bankingInOrgTx(t, fx, func(tx pgx.Tx) (BankReconciliationOutput, error) {
		return bankReconciliation(fx.ctx, tx, fx.orgID, BankReconciliationInput{BankAccountID: accountA})
	})
	if open.Totals != (BankReconciliationTotals{LinesMinor: 12500, AllocatedMinor: 10000, UnexplainedMinor: 2500, Reconciled: false}) {
		t.Fatalf("open totals = %+v, want the 2500 difference", open.Totals)
	}
	if len(open.Lines) != 3 {
		t.Fatalf("open lines = %+v, want three statement lines", open.Lines)
	}
	if open.Lines[0].ID != lineB || open.Lines[1].ID != lineA || open.Lines[2].ID != lineC {
		t.Fatalf("open line order = %+v, want posted_at order", open.Lines)
	}
	if open.Lines[0].PostedAt != "2026-09-02T00:00:00.000Z" {
		t.Fatalf("postedAt format = %q, want the JavaScript ISO millisecond form", open.Lines[0].PostedAt)
	}
	if open.Lines[2].AllocatedMinor != 0 || open.Lines[2].UnexplainedMinor != 0 {
		t.Fatalf("excluded line detail = %+v, want zeroed allocation", open.Lines[2])
	}
	encoded, err := marshalJS(open.Totals)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"linesMinor":12500,"allocatedMinor":10000,"unexplainedMinor":2500,"reconciled":false}` {
		t.Fatalf("totals JSON = %s", encoded)
	}

	windowed := bankingInOrgTx(t, fx, func(tx pgx.Tx) (BankReconciliationOutput, error) {
		return bankReconciliation(fx.ctx, tx, fx.orgID, BankReconciliationInput{
			BankAccountID: accountA, From: crmStringPointer("2026-09-03"), To: crmStringPointer("2026-09-30"),
		})
	})
	if len(windowed.Lines) != 2 || windowed.Totals.LinesMinor != 10000 || !windowed.Totals.Reconciled {
		t.Fatalf("windowed reconciliation = %+v, want the two September lines fully reconciled", windowed.Lines)
	}
	bankingExpectError(t, fx, "`to` is before `from`", func(tx pgx.Tx) error {
		_, err := bankReconciliation(fx.ctx, tx, fx.orgID, BankReconciliationInput{
			BankAccountID: accountA, From: crmStringPointer("2026-09-30"), To: crmStringPointer("2026-09-01"),
		})
		return err
	})

	reconciled := bankingInOrgTx(t, fx, func(tx pgx.Tx) (BankReconciliationOutput, error) {
		return bankReconciliation(fx.ctx, tx, fx.orgID, BankReconciliationInput{BankAccountID: accountB})
	})
	if !reconciled.Totals.Reconciled || reconciled.Totals.UnexplainedMinor != 0 || reconciled.Totals.LinesMinor != 7000 {
		t.Fatalf("savings totals = %+v, want a reconciled period", reconciled.Totals)
	}

	overAllocated := seedBankTransaction(t, fx, fx.orgID, accountA, time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC), 1000, "Over-allocated", "matched")
	seedBankAllocation(t, fx, fx.orgID, overAllocated, "fee", nil, nil, 2000, nil)
	bankingExpectError(t, fx, fmt.Sprintf("line %s is over-allocated: 2000 against 1000", overAllocated), func(tx pgx.Tx) error {
		_, err := bankReconciliation(fx.ctx, tx, fx.orgID, BankReconciliationInput{BankAccountID: accountA})
		return err
	})

	summary := bankingInOrgTx(t, fx, func(tx pgx.Tx) (BankSummaryOutput, error) {
		return bankSummary(fx.ctx, tx, fx.orgID)
	})
	if len(summary.Accounts) != 2 {
		t.Fatalf("summary accounts = %+v, want the two org accounts", summary.Accounts)
	}
	if summary.Accounts[0].BankAccountID != accountA || summary.Accounts[1].BankAccountID != accountB {
		t.Fatalf("summary order = %+v, want created_at order", summary.Accounts)
	}
	first := summary.Accounts[0]
	if first.Name != "Operations" || first.CurrencyCode != "USD" || first.Last4 != nil || first.BalanceMinor != 0 ||
		first.Count != 4 || first.MoneyInMinor != 13500 || first.MoneyOutMinor != 1000 {
		t.Fatalf("operations summary = %+v", first)
	}
	second := summary.Accounts[1]
	if second.CurrencyCode != "EUR" || second.BalanceMinor != 40000 || second.Count != 1 || second.MoneyInMinor != 7000 || second.MoneyOutMinor != 0 {
		t.Fatalf("savings summary = %+v", second)
	}
	if summary.UnmatchedCount != 1 {
		t.Fatalf("unmatched count = %d, want only the org's open line", summary.UnmatchedCount)
	}
	summaryJSON, err := marshalJS(summary)
	if err != nil {
		t.Fatal(err)
	}
	wantSummary := fmt.Sprintf(`{"accounts":[{"bankAccountId":%q,"name":"Operations","currencyCode":"USD","last4":null,"balanceMinor":0,"count":4,"moneyInMinor":13500,"moneyOutMinor":1000},`+
		`{"bankAccountId":%q,"name":"Savings","currencyCode":"EUR","last4":null,"balanceMinor":40000,"count":1,"moneyInMinor":7000,"moneyOutMinor":0}],"unmatchedCount":1}`,
		accountA, accountB)
	if string(summaryJSON) != wantSummary {
		t.Fatalf("summary JSON = %s, want %s", summaryJSON, wantSummary)
	}
}
