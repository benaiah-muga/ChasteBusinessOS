package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func TestGoPaymentAndReversalMatchLegacyAndBalance(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM payments WHERE org_id = $1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete payment fixture payments: %v", err)
		}
	})
	const invoiceNumber = 7041
	const invoiceTotal int64 = 25_000
	invoiceID := seedPaymentInvoice(t, fx, invoiceNumber, invoiceTotal)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES
		($1::uuid, 'accounting.post', $2::uuid),
		($1::uuid, 'accounting.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	paymentInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, invoiceNumber, invoiceTotal))
	withoutPost := paymentClaims(fx, recordPaymentCapabilityID, paymentInput, []string{"crm.write"})
	denied, err := fx.executor.Execute(fx.ctx, withoutPost, recordPaymentCapabilityID, paymentInput)
	if err != nil {
		t.Fatalf("payment without accounting.post claim returned error: %v", err)
	}
	if denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.post") {
		t.Fatalf("payment without accounting.post = %+v, want a permission denial", denied)
	}
	if countPaymentsForInvoice(fx, invoiceID) != 0 {
		t.Fatal("permission-denied payment wrote a payment row")
	}

	signedPaymentClaims := paymentClaims(fx, recordPaymentCapabilityID, paymentInput, []string{"accounting.post"})
	paymentResult, err := fx.executor.Execute(fx.ctx, signedPaymentClaims, recordPaymentCapabilityID, paymentInput)
	if err != nil {
		t.Fatalf("recordPayment through Executor: %v", err)
	}
	if !paymentResult.OK || paymentResult.PendingApproval {
		t.Fatalf("recordPayment result = %+v, want a completed human payment", paymentResult)
	}
	var payment RecordPaymentOutput
	if err := json.Unmarshal(paymentResult.Data, &payment); err != nil {
		t.Fatalf("decode recordPayment output %s: %v", paymentResult.Data, err)
	}
	if payment.PaymentID == "" || payment.EntryID == "" || !payment.FullyPaid {
		t.Fatalf("recordPayment output = %+v, want ids and fullyPaid=true", payment)
	}
	expectedPaymentJSON, err := marshalJS(payment)
	if err != nil {
		t.Fatal(err)
	}
	if string(paymentResult.Data) != string(expectedPaymentJSON) {
		t.Fatalf("recordPayment JSON = %s, want canonical output %s", paymentResult.Data, expectedPaymentJSON)
	}

	var storedInvoiceID, paymentEntryID, method string
	var amount int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT invoice_id::text, entry_id::text, method, amount_minor
		FROM payments WHERE id = $1::uuid AND org_id = $2::uuid`, payment.PaymentID, fx.orgID).
		Scan(&storedInvoiceID, &paymentEntryID, &method, &amount); err != nil {
		t.Fatal(err)
	}
	if storedInvoiceID != invoiceID || paymentEntryID != payment.EntryID || method != "bank_transfer" || amount != invoiceTotal {
		t.Fatalf("stored payment = invoice %q entry %q method %q amount %d", storedInvoiceID, paymentEntryID, method, amount)
	}
	assertPaymentInvoice(t, fx, invoiceID, "paid", invoiceTotal, invoiceTotal, "USD")
	assertCapabilityAudit(t, fx, recordPaymentCapabilityID, 1)
	assertPaymentTrialBalance(t, fx, map[string][2]int64{
		"1000": {invoiceTotal, 0},
		"1100": {invoiceTotal, invoiceTotal},
		"4000": {0, invoiceTotal},
	})

	reversalInput := json.RawMessage(`{"paymentId":"` + payment.PaymentID + `","reason":"Duplicate settlement"}`)
	reversalClaims := paymentClaims(fx, reversePaymentCapabilityID, reversalInput, []string{"accounting.post"})
	reversalResult, err := fx.executor.Execute(fx.ctx, reversalClaims, reversePaymentCapabilityID, reversalInput)
	if err != nil {
		t.Fatalf("reversePayment through Executor: %v", err)
	}
	if !reversalResult.OK || reversalResult.PendingApproval {
		t.Fatalf("reversePayment result = %+v, want a completed reversal", reversalResult)
	}
	var reversal ReversePaymentOutput
	if err := json.Unmarshal(reversalResult.Data, &reversal); err != nil {
		t.Fatalf("decode reversePayment output %s: %v", reversalResult.Data, err)
	}
	if len(reversal.ReversalEntryIDs) != 1 || reversal.ReversalEntryIDs[0] == "" ||
		reversal.RefundedMinor != invoiceTotal || reversal.InvoiceNumber != invoiceNumber || reversal.OutstandingMinor != invoiceTotal {
		t.Fatalf("reversePayment output = %+v, want one reversal, full refund, and full outstanding balance", reversal)
	}
	expectedReversalJSON, err := marshalJS(reversal)
	if err != nil {
		t.Fatal(err)
	}
	if string(reversalResult.Data) != string(expectedReversalJSON) {
		t.Fatalf("reversePayment JSON = %s, want canonical output %s", reversalResult.Data, expectedReversalJSON)
	}
	assertPaymentInvoice(t, fx, invoiceID, "sent", 0, invoiceTotal, "USD")
	assertPaymentReversalRows(t, fx, payment.EntryID, reversal.ReversalEntryIDs[0], invoiceID, invoiceTotal)
	assertCapabilityAudit(t, fx, reversePaymentCapabilityID, 1)
	assertPaymentTrialBalance(t, fx, map[string][2]int64{
		"1000": {invoiceTotal, invoiceTotal},
		"1100": {2 * invoiceTotal, invoiceTotal},
		"4000": {0, invoiceTotal},
	})

	if _, err := fx.executor.Execute(fx.ctx, reversalClaims, reversePaymentCapabilityID, reversalInput); err == nil || !strings.Contains(err.Error(), "payment has already been reversed") {
		t.Fatalf("duplicate reversal error = %v, want already-reversed error", err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid`, fx.orgID, payment.EntryID); got != 1 {
		t.Fatalf("reversal entries = %d, want one after duplicate attempt", got)
	}
	assertCapabilityAudit(t, fx, recordPaymentCapabilityID, 1)
	assertCapabilityAudit(t, fx, reversePaymentCapabilityID, 1)
	assertPaymentThresholdPolicy(t, fx)
}

func TestGoFxInvoiceAndPaymentMatchLegacy(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM fx_settlements WHERE org_id = $1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete FX fixture settlements: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM payments WHERE org_id = $1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete FX fixture payments: %v", err)
		}
	})
	customerID := seedAccountingInvoiceFixture(t, fx)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, '1000', 'Cash and cash equivalents', 'asset')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES
		($1::uuid, 'accounting.write', $2::uuid),
		($1::uuid, 'accounting.post', $2::uuid),
		($1::uuid, 'accounting.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO fx_rates (org_id, base, quote, rate_num, rate_den, effective_at, source, recorded_by_actor_type, recorded_by_actor_id)
		VALUES ($1::uuid, 'USD', 'EUR', 5, 4, $2, 'manual', 'human', $3::uuid),
		       ($1::uuid, 'USD', 'EUR', 9, 4, $4, 'manual', 'human', $3::uuid)`, fx.orgID, now.Add(-time.Hour), fx.userID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	decimalRate, err := parseFXRateDecimal(" 1.2500 ")
	if err != nil || decimalRate.Num != 5 || decimalRate.Den != 4 {
		t.Fatalf("parseFXRateDecimal(1.2500) = %+v, %v, want 5/4", decimalRate, err)
	}
	for _, invalid := range []string{"0", "1e2", "-1.25", "1.1234567890123"} {
		if _, err := parseFXRateDecimal(invalid); err == nil {
			t.Errorf("parseFXRateDecimal(%q) succeeded, want rejection", invalid)
		}
	}

	invoiceInput := json.RawMessage(fmt.Sprintf(`{"customerId":%q,"currency":"EUR","lines":[{"description":"Foreign service","quantity":1000,"unitPriceMinor":10000,"taxMinor":0}]}`, customerID))
	invoiceResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, createInvoiceCapabilityID, invoiceInput, []string{"accounting.write"}), createInvoiceCapabilityID, invoiceInput)
	if err != nil {
		t.Fatalf("create foreign invoice through Executor: %v", err)
	}
	if !invoiceResult.OK || invoiceResult.PendingApproval {
		t.Fatalf("foreign invoice result = %+v, want a completed invoice", invoiceResult)
	}
	var invoice CreateInvoiceOutput
	if err := json.Unmarshal(invoiceResult.Data, &invoice); err != nil {
		t.Fatalf("decode invoice output %s: %v", invoiceResult.Data, err)
	}
	var invoiceRateNum, invoiceRateDen int64
	var invoiceCurrency string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT currency, fx_rate_num, fx_rate_den FROM invoices WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, invoice.InvoiceID).Scan(&invoiceCurrency, &invoiceRateNum, &invoiceRateDen); err != nil {
		t.Fatal(err)
	}
	if invoiceCurrency != "EUR" || invoice.TotalMinor != 10_000 || invoiceRateNum != 5 || invoiceRateDen != 4 {
		t.Fatalf("invoice snapshot currency=%s amount=%d rate=%d/%d, want EUR 10000 at 5/4 (future rate excluded)", invoiceCurrency, invoice.TotalMinor, invoiceRateNum, invoiceRateDen)
	}

	paymentInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":4000,"method":"bank_transfer","settleFxRate":"1.3000"}`, invoice.InvoiceNumber))
	paymentResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, recordPaymentCapabilityID, paymentInput, []string{"accounting.post"}), recordPaymentCapabilityID, paymentInput)
	if err != nil {
		t.Fatalf("record FX payment through Executor: %v", err)
	}
	if !paymentResult.OK || paymentResult.PendingApproval {
		t.Fatalf("FX payment result = %+v, want a completed settlement", paymentResult)
	}
	var payment RecordPaymentOutput
	if err := json.Unmarshal(paymentResult.Data, &payment); err != nil {
		t.Fatalf("decode payment output %s: %v", paymentResult.Data, err)
	}
	if payment.PaymentID == "" || payment.EntryID == "" || payment.BaseEntryID == nil || payment.ForeignEntryID == nil || payment.GainLossMinor == nil || *payment.GainLossMinor != 200 || payment.EntryID != *payment.BaseEntryID || payment.FullyPaid {
		t.Fatalf("FX payment output = %+v, want paired IDs, +200 realized gain, partial payment", payment)
	}
	var settledCurrency string
	var settledForeign, baseSettled, gainLoss, settleNum, settleDen int64
	var storedBaseEntry, storedForeignEntry string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT currency, settled_foreign_minor, base_settled_minor, gain_loss_minor, settle_rate_num, settle_rate_den, base_entry_id::text, foreign_entry_id::text
		FROM fx_settlements WHERE org_id=$1::uuid AND payment_id=$2::uuid`, fx.orgID, payment.PaymentID).
		Scan(&settledCurrency, &settledForeign, &baseSettled, &gainLoss, &settleNum, &settleDen, &storedBaseEntry, &storedForeignEntry); err != nil {
		t.Fatal(err)
	}
	if settledCurrency != "EUR" || settledForeign != 4_000 || baseSettled != 5_200 || gainLoss != 200 || settleNum != 13 || settleDen != 10 || storedBaseEntry != *payment.BaseEntryID || storedForeignEntry != *payment.ForeignEntryID {
		t.Fatalf("FX settlement = %s foreign=%d base=%d gain=%d rate=%d/%d pair=%s/%s", settledCurrency, settledForeign, baseSettled, gainLoss, settleNum, settleDen, storedBaseEntry, storedForeignEntry)
	}
	assertFXJournalEntry(t, fx, *payment.BaseEntryID, "USD", "payment", "", map[string][2]int64{
		"1000": {5_200, 0},
		"1305": {0, 5_000},
		"7900": {0, 200},
	})
	assertFXJournalEntry(t, fx, *payment.ForeignEntryID, "EUR", "payment", invoice.InvoiceID, map[string][2]int64{
		"1100": {0, 4_000},
		"1305": {4_000, 0},
	})
	assertPaymentInvoice(t, fx, invoice.InvoiceID, "sent", 4_000, 10_000, "EUR")

	reversalInput := json.RawMessage(`{"paymentId":"` + payment.PaymentID + `","reason":"Correct FX settlement"}`)
	reversalResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, reversePaymentCapabilityID, reversalInput, []string{"accounting.post"}), reversePaymentCapabilityID, reversalInput)
	if err != nil {
		t.Fatalf("reverse paired FX payment through Executor: %v", err)
	}
	if !reversalResult.OK || reversalResult.PendingApproval {
		t.Fatalf("FX reversal result = %+v, want a completed pair reversal", reversalResult)
	}
	var reversal ReversePaymentOutput
	if err := json.Unmarshal(reversalResult.Data, &reversal); err != nil {
		t.Fatalf("decode FX reversal output %s: %v", reversalResult.Data, err)
	}
	if len(reversal.ReversalEntryIDs) != 2 || reversal.RefundedMinor != 4_000 || reversal.InvoiceNumber != invoice.InvoiceNumber || reversal.OutstandingMinor != 10_000 {
		t.Fatalf("FX reversal = %+v, want both mirrored entries and restored AR", reversal)
	}
	assertFXReversalCurrency(t, fx, reversal.ReversalEntryIDs[0])
	assertFXReversalCurrency(t, fx, reversal.ReversalEntryIDs[1])
	assertPaymentInvoice(t, fx, invoice.InvoiceID, "sent", 0, 10_000, "EUR")

	lossInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":4000,"method":"bank_transfer","settleFxRate":"1.2000"}`, invoice.InvoiceNumber))
	lossResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, recordPaymentCapabilityID, lossInput, []string{"accounting.post"}), recordPaymentCapabilityID, lossInput)
	if err != nil || !lossResult.OK || lossResult.PendingApproval {
		t.Fatalf("record FX loss payment = %+v err=%v, want a completed settlement", lossResult, err)
	}
	var lossPayment RecordPaymentOutput
	if err := json.Unmarshal(lossResult.Data, &lossPayment); err != nil {
		t.Fatal(err)
	}
	if lossPayment.GainLossMinor == nil || *lossPayment.GainLossMinor != -200 || lossPayment.BaseEntryID == nil || lossPayment.ForeignEntryID == nil {
		t.Fatalf("FX loss payment output = %+v, want paired entries and -200 realized loss", lossPayment)
	}
	assertFXJournalEntry(t, fx, *lossPayment.BaseEntryID, "USD", "payment", "", map[string][2]int64{
		"1000": {4_800, 0},
		"1305": {0, 5_000},
		"7900": {200, 0},
	})
	assertFXJournalEntry(t, fx, *lossPayment.ForeignEntryID, "EUR", "payment", invoice.InvoiceID, map[string][2]int64{
		"1100": {0, 4_000},
		"1305": {4_000, 0},
	})
	var lossSettlement int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT gain_loss_minor FROM fx_settlements WHERE org_id=$1::uuid AND payment_id=$2::uuid`, fx.orgID, lossPayment.PaymentID).Scan(&lossSettlement); err != nil {
		t.Fatal(err)
	}
	if lossSettlement != -200 {
		t.Fatalf("FX loss settlement=%d, want -200", lossSettlement)
	}
	lossReversalInput := json.RawMessage(`{"paymentId":"` + lossPayment.PaymentID + `","reason":"Correct FX loss settlement"}`)
	lossReversalResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, reversePaymentCapabilityID, lossReversalInput, []string{"accounting.post"}), reversePaymentCapabilityID, lossReversalInput)
	if err != nil || !lossReversalResult.OK || lossReversalResult.PendingApproval {
		t.Fatalf("reverse paired FX loss payment = %+v err=%v", lossReversalResult, err)
	}
	assertPaymentInvoice(t, fx, invoice.InvoiceID, "sent", 0, 10_000, "EUR")

	latestInvoiceInput := json.RawMessage(fmt.Sprintf(`{"customerId":%q,"currency":"EUR","lines":[{"description":"Latest-rate service","quantity":1000,"unitPriceMinor":10000,"taxMinor":0}]}`, customerID))
	latestInvoiceResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, createInvoiceCapabilityID, latestInvoiceInput, []string{"accounting.write"}), createInvoiceCapabilityID, latestInvoiceInput)
	if err != nil || !latestInvoiceResult.OK || latestInvoiceResult.PendingApproval {
		t.Fatalf("create second FX invoice = %+v err=%v", latestInvoiceResult, err)
	}
	var latestInvoice CreateInvoiceOutput
	if err := json.Unmarshal(latestInvoiceResult.Data, &latestInvoice); err != nil {
		t.Fatal(err)
	}
	latestPaymentInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":4000,"method":"bank_transfer"}`, latestInvoice.InvoiceNumber))
	latestPaymentResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, recordPaymentCapabilityID, latestPaymentInput, []string{"accounting.post"}), recordPaymentCapabilityID, latestPaymentInput)
	if err != nil || !latestPaymentResult.OK || latestPaymentResult.PendingApproval {
		t.Fatalf("record FX payment at latest stored rate = %+v err=%v", latestPaymentResult, err)
	}
	var latestPayment RecordPaymentOutput
	if err := json.Unmarshal(latestPaymentResult.Data, &latestPayment); err != nil {
		t.Fatal(err)
	}
	var latestBaseSettled, latestGainLoss, latestRateNum, latestRateDen int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT base_settled_minor, gain_loss_minor, settle_rate_num, settle_rate_den FROM fx_settlements WHERE org_id=$1::uuid AND payment_id=$2::uuid`, fx.orgID, latestPayment.PaymentID).Scan(&latestBaseSettled, &latestGainLoss, &latestRateNum, &latestRateDen); err != nil {
		t.Fatal(err)
	}
	if latestBaseSettled != 5_000 || latestGainLoss != 0 || latestRateNum != 5 || latestRateDen != 4 {
		t.Fatalf("latest-rate settlement base=%d gain=%d rate=%d/%d, want 5000 base, no gain, and 5/4 (future rate excluded)", latestBaseSettled, latestGainLoss, latestRateNum, latestRateDen)
	}
	latestReversalInput := json.RawMessage(`{"paymentId":"` + latestPayment.PaymentID + `","reason":"Correct latest-rate settlement"}`)
	latestReversalResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, reversePaymentCapabilityID, latestReversalInput, []string{"accounting.post"}), reversePaymentCapabilityID, latestReversalInput)
	if err != nil || !latestReversalResult.OK || latestReversalResult.PendingApproval {
		t.Fatalf("reverse latest-rate FX payment = %+v err=%v", latestReversalResult, err)
	}
	trialInput := json.RawMessage(`{}`)
	trialResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, trialBalanceCapabilityID, trialInput, []string{"accounting.read"}), trialBalanceCapabilityID, trialInput)
	if err != nil {
		t.Fatalf("trial balance after paired FX reversal: %v", err)
	}
	var trial TrialBalanceOutput
	if err := json.Unmarshal(trialResult.Data, &trial); err != nil {
		t.Fatal(err)
	}
	if !trialResult.OK || !trial.Balanced {
		t.Fatalf("post-reversal trial balance = %+v result=%+v, want balanced books", trial, trialResult)
	}
}

func assertFXJournalEntry(t *testing.T, fx *executorFixture, entryID, currency, sourceType, sourceID string, want map[string][2]int64) {
	t.Helper()
	var gotCurrency, gotSourceType string
	var gotSourceID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT currency, source_type, source_id::text FROM journal_entries WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, entryID).Scan(&gotCurrency, &gotSourceType, &gotSourceID); err != nil {
		t.Fatal(err)
	}
	if gotCurrency != currency || gotSourceType != sourceType || sourceID == "" && gotSourceID != nil || sourceID != "" && (gotSourceID == nil || *gotSourceID != sourceID) {
		t.Fatalf("FX entry %s attribution currency=%s source=%s/%v, want %s %s/%s", entryID, gotCurrency, gotSourceType, gotSourceID, currency, sourceType, sourceID)
	}
	rows, err := fx.owner.Query(fx.ctx, `SELECT a.code, jl.debit_minor, jl.credit_minor FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.entry_id=$1::uuid ORDER BY a.code`, entryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	actual := make(map[string][2]int64)
	for rows.Next() {
		var code string
		var debit, credit int64
		if err := rows.Scan(&code, &debit, &credit); err != nil {
			t.Fatal(err)
		}
		actual[code] = [2]int64{debit, credit}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(actual) != len(want) {
		t.Fatalf("FX entry %s lines=%v, want %v", entryID, actual, want)
	}
	for code, amounts := range want {
		if actual[code] != amounts {
			t.Fatalf("FX entry %s account %s amounts=%v, want %v", entryID, code, actual[code], amounts)
		}
	}
}

func assertFXReversalCurrency(t *testing.T, fx *executorFixture, entryID string) {
	t.Helper()
	var sourceType, currency string
	var reversalOf string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT source_type, currency, reversal_of_id::text FROM journal_entries WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, entryID).Scan(&sourceType, &currency, &reversalOf); err != nil {
		t.Fatal(err)
	}
	if sourceType != "payment-reversal" || reversalOf == "" || currency != "USD" && currency != "EUR" {
		t.Fatalf("FX reversal entry=%s source=%s currency=%s reversalOf=%s", entryID, sourceType, currency, reversalOf)
	}
}

func assertPaymentThresholdPolicy(t *testing.T, fx *executorFixture) {
	t.Helper()
	fx.addAgentSession()

	const defaultThreshold int64 = 50_000
	exactInvoiceNumber := int64(7042)
	exactInvoiceID := seedAdditionalPaymentInvoice(t, fx, exactInvoiceNumber, defaultThreshold)
	exactInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, exactInvoiceNumber, defaultThreshold))
	exactResult, err := fx.executor.Execute(fx.ctx, agentPaymentClaims(fx, exactInput), recordPaymentCapabilityID, exactInput)
	if err != nil || !exactResult.OK || exactResult.PendingApproval {
		t.Fatalf("agent payment exactly at default threshold = %+v err=%v, want direct execution", exactResult, err)
	}
	assertPaymentInvoice(t, fx, exactInvoiceID, "paid", defaultThreshold, defaultThreshold, "USD")
	if got := countPaymentsForInvoice(fx, exactInvoiceID); got != 1 {
		t.Fatalf("threshold-equal agent payment rows = %d, want one", got)
	}
	assertPaymentExecutionAuditForInvoice(t, fx, exactInvoiceNumber, 1)

	const justOver int64 = defaultThreshold + 1
	overInvoiceNumber := int64(7043)
	overInvoiceID := seedAdditionalPaymentInvoice(t, fx, overInvoiceNumber, justOver)
	overInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, overInvoiceNumber, justOver))
	overResult, err := fx.executor.Execute(fx.ctx, agentPaymentClaims(fx, overInput), recordPaymentCapabilityID, overInput)
	if err != nil || overResult.OK || !overResult.PendingApproval || overResult.ApprovalID == "" {
		t.Fatalf("agent payment one minor above threshold = %+v err=%v, want identified pending approval", overResult, err)
	}
	var riskClass, rationale, status string
	var storedPayload []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT risk_class, rationale, status, payload
		FROM approvals WHERE id = $1::uuid AND org_id = $2::uuid`, overResult.ApprovalID, fx.orgID).
		Scan(&riskClass, &rationale, &status, &storedPayload); err != nil {
		t.Fatal(err)
	}
	wantRationale := fmt.Sprintf("amount %d exceeds autonomous threshold %d", justOver, defaultThreshold)
	if riskClass != "money" || rationale != wantRationale || status != "pending" {
		t.Fatalf("threshold approval risk=%q rationale=%q status=%q, want money, %q, pending", riskClass, rationale, status, wantRationale)
	}
	var approvedPayload RecordPaymentInput
	if err := json.Unmarshal(storedPayload, &approvedPayload); err != nil {
		t.Fatalf("decode threshold approval payload %s: %v", storedPayload, err)
	}
	if approvedPayload.InvoiceNumber != overInvoiceNumber || approvedPayload.AmountMinor != justOver || approvedPayload.Method != "bank_transfer" {
		t.Fatalf("stored threshold approval payload = %+v", approvedPayload)
	}
	assertPaymentInvoice(t, fx, overInvoiceID, "sent", 0, justOver, "USD")
	if got := countPaymentsForInvoice(fx, overInvoiceID); got != 0 {
		t.Fatalf("over-threshold agent payment wrote %d payment rows, want none", got)
	}
	assertPaymentExecutionAuditForInvoice(t, fx, overInvoiceNumber, 0)

	defaultHumanInvoiceNumber := int64(7044)
	defaultHumanAmount := int64(55_000)
	defaultHumanInvoiceID := seedAdditionalPaymentInvoice(t, fx, defaultHumanInvoiceNumber, defaultHumanAmount)
	defaultHumanInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, defaultHumanInvoiceNumber, defaultHumanAmount))
	defaultHumanResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, recordPaymentCapabilityID, defaultHumanInput, []string{"accounting.post"}), recordPaymentCapabilityID, defaultHumanInput)
	if err != nil || !defaultHumanResult.OK || defaultHumanResult.PendingApproval {
		t.Fatalf("human payment above default threshold = %+v err=%v, want direct legacy behavior", defaultHumanResult, err)
	}
	assertPaymentInvoice(t, fx, defaultHumanInvoiceID, "paid", defaultHumanAmount, defaultHumanAmount, "USD")
	assertPaymentExecutionAuditForInvoice(t, fx, defaultHumanInvoiceNumber, 1)

	const overrideThreshold int64 = 60_000
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for)
		VALUES ($1::uuid, 'accounting.recordPayment', 'write', $2, '[]'::jsonb)`, fx.orgID, overrideThreshold); err != nil {
		t.Fatal(err)
	}
	const overrideAmount int64 = 55_000
	overrideInvoiceNumber := int64(7045)
	overrideInvoiceID := seedAdditionalPaymentInvoice(t, fx, overrideInvoiceNumber, overrideAmount)
	overrideInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, overrideInvoiceNumber, overrideAmount))
	overrideResult, err := fx.executor.Execute(fx.ctx, agentPaymentClaims(fx, overrideInput), recordPaymentCapabilityID, overrideInput)
	if err != nil || !overrideResult.OK || overrideResult.PendingApproval {
		t.Fatalf("agent payment under DB-specific threshold = %+v err=%v, want direct execution", overrideResult, err)
	}
	assertPaymentInvoice(t, fx, overrideInvoiceID, "paid", overrideAmount, overrideAmount, "USD")
	if got := countPaymentsForInvoice(fx, overrideInvoiceID); got != 1 {
		t.Fatalf("DB-threshold agent payment rows = %d, want one", got)
	}
	assertPaymentExecutionAuditForInvoice(t, fx, overrideInvoiceNumber, 1)

	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE policies SET requires_approval_for = '["money"]'::jsonb, money_threshold_minor = $2
		WHERE org_id = $1::uuid AND capability_pattern = 'accounting.recordPayment'`, fx.orgID, defaultThreshold); err != nil {
		t.Fatal(err)
	}
	strictBelowAmount := defaultThreshold - 1
	strictBelowNumber := int64(7046)
	strictBelowInvoiceID := seedAdditionalPaymentInvoice(t, fx, strictBelowNumber, strictBelowAmount)
	strictBelowInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, strictBelowNumber, strictBelowAmount))
	strictBelowResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, recordPaymentCapabilityID, strictBelowInput, []string{"accounting.post"}), recordPaymentCapabilityID, strictBelowInput)
	if err != nil || !strictBelowResult.OK || strictBelowResult.PendingApproval {
		t.Fatalf("human payment below strict money threshold = %+v err=%v, want direct execution", strictBelowResult, err)
	}
	assertPaymentInvoice(t, fx, strictBelowInvoiceID, "paid", strictBelowAmount, strictBelowAmount, "USD")
	assertPaymentExecutionAuditForInvoice(t, fx, strictBelowNumber, 1)

	strictOverAmount := defaultThreshold + 1
	strictOverNumber := int64(7047)
	strictOverInvoiceID := seedAdditionalPaymentInvoice(t, fx, strictOverNumber, strictOverAmount)
	strictOverInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, strictOverNumber, strictOverAmount))
	strictOverResult, err := fx.executor.Execute(fx.ctx, paymentClaims(fx, recordPaymentCapabilityID, strictOverInput, []string{"accounting.post"}), recordPaymentCapabilityID, strictOverInput)
	if err != nil || strictOverResult.OK || !strictOverResult.PendingApproval || strictOverResult.ApprovalID == "" {
		t.Fatalf("human payment above strict money threshold = %+v err=%v, want pending approval", strictOverResult, err)
	}
	var strictRisk, strictRationale string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT risk_class, rationale FROM approvals WHERE id = $1::uuid AND org_id = $2::uuid`, strictOverResult.ApprovalID, fx.orgID).
		Scan(&strictRisk, &strictRationale); err != nil {
		t.Fatal(err)
	}
	if strictRisk != "money" || strictRationale != fmt.Sprintf("amount %d exceeds autonomous threshold %d", strictOverAmount, defaultThreshold) {
		t.Fatalf("strict human approval risk=%q rationale=%q", strictRisk, strictRationale)
	}
	assertPaymentInvoice(t, fx, strictOverInvoiceID, "sent", 0, strictOverAmount, "USD")
	if got := countPaymentsForInvoice(fx, strictOverInvoiceID); got != 0 {
		t.Fatalf("strict over-threshold human payment wrote %d payment rows, want none", got)
	}
	assertPaymentExecutionAuditForInvoice(t, fx, strictOverNumber, 0)
}

func TestGoMoneyApprovalDecisionReexecutesExactPayloadOnce(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM payments WHERE org_id = $1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete payment fixture payments: %v", err)
		}
	})
	const invoiceNumber = 7051
	const paymentAmount int64 = 75_000
	invoiceID := seedPaymentInvoice(t, fx, invoiceNumber, paymentAmount)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES
		($1::uuid, 'accounting.post', $2::uuid),
		($1::uuid, 'accounting.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	fx.addAgentSession()

	agentInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, invoiceNumber, paymentAmount))
	agentResult, err := fx.executor.Execute(fx.ctx, agentPaymentClaims(fx, agentInput), recordPaymentCapabilityID, agentInput)
	if err != nil || agentResult.OK || !agentResult.PendingApproval || agentResult.ApprovalID == "" {
		t.Fatalf("over-threshold agent payment = %+v err=%v, want pending approval id", agentResult, err)
	}
	var approvalID, riskClass, rationale, status string
	var storedPayload []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, risk_class, rationale, status, payload
		FROM approvals WHERE id = $1::uuid AND org_id = $2::uuid`, agentResult.ApprovalID, fx.orgID).
		Scan(&approvalID, &riskClass, &rationale, &status, &storedPayload); err != nil {
		t.Fatal(err)
	}
	wantRationale := "amount 75000 exceeds autonomous threshold 50000"
	if approvalID != agentResult.ApprovalID || riskClass != "money" || rationale != wantRationale || status != "pending" {
		t.Fatalf("approval id=%q risk=%q rationale=%q status=%q", approvalID, riskClass, rationale, status)
	}
	var storedInput RecordPaymentInput
	if err := json.Unmarshal(storedPayload, &storedInput); err != nil {
		t.Fatalf("decode stored approval payload %s: %v", storedPayload, err)
	}
	if storedInput.InvoiceNumber != invoiceNumber || storedInput.AmountMinor != paymentAmount || storedInput.Method != "bank_transfer" {
		t.Fatalf("stored approval payload = %+v, want exact requested payment", storedInput)
	}
	assertPaymentInvoice(t, fx, invoiceID, "sent", 0, paymentAmount, "USD")
	if got := countPaymentsForInvoice(fx, invoiceID); got != 0 {
		t.Fatalf("pending payment created %d payment rows, want none", got)
	}
	assertPaymentExecutionAuditForInvoice(t, fx, invoiceNumber, 0)

	claims := paymentClaims(fx, recordPaymentCapabilityID, json.RawMessage(storedPayload), []string{"accounting.post"})
	storedDigest, err := InputHash(json.RawMessage(storedPayload))
	if err != nil || claims.InputSHA256 != storedDigest {
		t.Fatalf("human approval digest = %q, stored payload digest = %q, error = %v", claims.InputSHA256, storedDigest, err)
	}
	comment := "Verified the stored payment request."
	blocking := &blockingApprovalExecutor{inner: fx.executor, started: make(chan struct{}), release: make(chan struct{})}
	firstDecider := NewApprovalDecider(fx.runtime, blocking)
	secondDecider := NewApprovalDecider(fx.runtime, fx.executor)
	var releaseOnce sync.Once
	releaseExecution := func() { releaseOnce.Do(func() { close(blocking.release) }) }
	t.Cleanup(releaseExecution)
	type decisionCompletion struct {
		result ApprovalDecisionResult
		err    error
	}
	firstDone := make(chan decisionCompletion, 1)
	go func() {
		result, err := firstDecider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve", Comment: &comment})
		firstDone <- decisionCompletion{result: result, err: err}
	}()
	select {
	case <-blocking.started:
	case <-time.After(5 * time.Second):
		t.Fatal("approval decision did not reach execution after claiming its pending row")
	}
	second, secondErr := secondDecider.Decide(fx.ctx, claims, ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve", Comment: &comment})
	releaseExecution()
	if secondErr != nil || second.HTTPStatus != 409 || !strings.Contains(second.Error, "being executed elsewhere") {
		t.Fatalf("concurrent duplicate decision = %+v err=%v, want executing conflict", second, secondErr)
	}
	first := <-firstDone
	if first.err != nil || !first.result.OK || first.result.Status != "executed" || first.result.Result == nil || !first.result.Result.OK {
		t.Fatalf("first approval decision = %+v err=%v, want one successful execution", first.result, first.err)
	}
	var paymentOutput RecordPaymentOutput
	if err := json.Unmarshal(first.result.Result.Data, &paymentOutput); err != nil {
		t.Fatalf("decode approved payment result %s: %v", first.result.Result.Data, err)
	}
	if paymentOutput.PaymentID == "" || paymentOutput.EntryID == "" || !paymentOutput.FullyPaid {
		t.Fatalf("approved payment result = %+v, want a fully paid invoice", paymentOutput)
	}
	if got := countPaymentsForInvoice(fx, invoiceID); got != 1 {
		t.Fatalf("approved payments = %d, want one", got)
	}
	assertPaymentInvoice(t, fx, invoiceID, "paid", paymentAmount, paymentAmount, "USD")
	assertPaymentExecutionAuditForInvoice(t, fx, invoiceNumber, 1)
	assertCapabilityAudit(t, fx, recordPaymentCapabilityID, 1)
	if got := fx.count(`SELECT count(*) FROM approvals WHERE id = $1::uuid AND status = 'executed' AND decided_by_user_id = $2::uuid AND decision_comment = $3`, approvalID, fx.userID, comment); got != 1 {
		t.Fatalf("executed approval rows = %d, want one human-attributed decision", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.requested' AND capability_id = $2`, fx.orgID, recordPaymentCapabilityID); got != 1 {
		t.Fatalf("approval request audit events = %d, want one", got)
	}
	assertPaymentTrialBalance(t, fx, map[string][2]int64{
		"1000": {paymentAmount, 0},
		"1100": {paymentAmount, paymentAmount},
		"4000": {0, paymentAmount},
	})
}

func paymentClaims(fx *executorFixture, capabilityID string, input json.RawMessage, permissions []string) authbridge.CapabilityClaims {
	fx.t.Helper()
	digest, err := InputHash(input)
	if err != nil {
		fx.t.Fatal(err)
	}
	actorID := fx.userID
	return authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        fx.userID,
		OrganizationID: fx.orgID,
		CapabilityID:   capabilityID,
		InputSHA256:    digest,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    permissions,
		AuthSessionID:  fx.authSessionID,
	}
}

func agentPaymentClaims(fx *executorFixture, input json.RawMessage) authbridge.CapabilityClaims {
	claims := paymentClaims(fx, recordPaymentCapabilityID, input, []string{"accounting.post"})
	claims.ActorType = "agent"
	claims.AgentSessionID = fx.agentSession
	return claims
}

func seedPaymentInvoice(t *testing.T, fx *executorFixture, invoiceNumber int64, totalMinor int64) string {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash and cash equivalents', 'asset'),
		($1::uuid, '1100', 'Accounts receivable', 'asset'),
		($1::uuid, '4000', 'Sales revenue', 'income')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	return seedAdditionalPaymentInvoice(t, fx, invoiceNumber, totalMinor)
}

func seedAdditionalPaymentInvoice(t *testing.T, fx *executorFixture, invoiceNumber int64, totalMinor int64) string {
	t.Helper()
	customerID := seedInvoiceCustomerID(t, fx)
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, issued_at)
		VALUES ($1::uuid, $2::uuid, $3, 'sent', 'USD', $4, 0, $4, now())
		RETURNING id::text`, fx.orgID, customerID, invoiceNumber, totalMinor).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	tx, err := fx.owner.Begin(fx.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var entryID string
	if err := tx.QueryRow(fx.ctx, `
		INSERT INTO journal_entries (org_id, memo, source_type, source_id, currency, entry_kind, posted_at, posted_by_actor_type, posted_by_actor_id)
		VALUES ($1::uuid, $2, 'invoice', $3::uuid, 'USD', 'operational', now(), 'human', $4::uuid)
		RETURNING id::text`, fx.orgID, fmt.Sprintf("Invoice %d", invoiceNumber), invoiceID, fx.userID).Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	for _, line := range []struct {
		code   string
		debit  int64
		credit int64
	}{
		{code: "1100", debit: totalMinor},
		{code: "4000", credit: totalMinor},
	} {
		var accountID string
		if err := tx.QueryRow(fx.ctx, `SELECT id::text FROM accounts WHERE org_id = $1::uuid AND code = $2`, fx.orgID, line.code).Scan(&accountID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(fx.ctx, `INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor) VALUES ($1::uuid, $2::uuid, $3, $4)`, entryID, accountID, line.debit, line.credit); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(fx.ctx); err != nil {
		t.Fatal(err)
	}
	return invoiceID
}

func countPaymentsForInvoice(fx *executorFixture, invoiceID string) int {
	fx.t.Helper()
	return fx.count(`SELECT count(*) FROM payments WHERE org_id = $1::uuid AND invoice_id = $2::uuid`, fx.orgID, invoiceID)
}

func assertPaymentInvoice(t *testing.T, fx *executorFixture, invoiceID, wantStatus string, wantPaid, wantTotal int64, wantCurrency string) {
	t.Helper()
	var status, currency string
	var paid, total int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, currency, paid_minor, total_minor FROM invoices WHERE id = $1::uuid AND org_id = $2::uuid`, invoiceID, fx.orgID).
		Scan(&status, &currency, &paid, &total); err != nil {
		t.Fatal(err)
	}
	if status != wantStatus || currency != wantCurrency || paid != wantPaid || total != wantTotal {
		t.Fatalf("invoice status=%q currency=%q paid=%d total=%d, want status=%q currency=%q paid=%d total=%d", status, currency, paid, total, wantStatus, wantCurrency, wantPaid, wantTotal)
	}
}

func assertPaymentReversalRows(t *testing.T, fx *executorFixture, paymentEntryID, reversalEntryID, invoiceID string, amount int64) {
	t.Helper()
	var sourceType, sourceID, reversalOfID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT source_type, source_id::text, reversal_of_id::text
		FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, reversalEntryID, fx.orgID).
		Scan(&sourceType, &sourceID, &reversalOfID); err != nil {
		t.Fatal(err)
	}
	if sourceType != "payment-reversal" || sourceID != invoiceID || reversalOfID != paymentEntryID {
		t.Fatalf("reversal entry source=%q sourceID=%q reversalOf=%q", sourceType, sourceID, reversalOfID)
	}
	type journalPair struct {
		debit  int64
		credit int64
	}
	original := map[string]journalPair{}
	reversed := map[string]journalPair{}
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT a.code, original.debit_minor, original.credit_minor, reverse.debit_minor, reverse.credit_minor
		FROM journal_lines original
		JOIN accounts a ON a.id = original.account_id AND a.org_id = $3::uuid
		JOIN journal_lines reverse ON reverse.entry_id = $2::uuid AND reverse.account_id = original.account_id
		WHERE original.entry_id = $1::uuid
		ORDER BY a.code`, paymentEntryID, reversalEntryID, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var code string
		var originalLine, reversedLine journalPair
		if err := rows.Scan(&code, &originalLine.debit, &originalLine.credit, &reversedLine.debit, &reversedLine.credit); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		original[code] = originalLine
		reversed[code] = reversedLine
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	if len(original) != 2 || original["1000"] != (journalPair{debit: amount}) || original["1100"] != (journalPair{credit: amount}) ||
		reversed["1000"] != (journalPair{credit: amount}) || reversed["1100"] != (journalPair{debit: amount}) {
		t.Fatalf("payment journal rows=%+v reversal rows=%+v, want exact debit/credit mirrors", original, reversed)
	}
}

func assertCapabilityAudit(t *testing.T, fx *executorFixture, capabilityID string, want int) {
	t.Helper()
	var count int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*) FROM ledger_events
		WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2`, fx.orgID, capabilityID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("audit events for %s = %d, want %d", capabilityID, count, want)
	}
	var actorType, actorID string
	if count > 0 {
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT actor_type, actor_id::text FROM ledger_events
			WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2
			ORDER BY seq DESC LIMIT 1`, fx.orgID, capabilityID).Scan(&actorType, &actorID); err != nil {
			t.Fatal(err)
		}
		if actorType != "human" || actorID != fx.userID {
			t.Fatalf("audit attribution for %s = actor %q/%q, want human/%s", capabilityID, actorType, actorID, fx.userID)
		}
	}
}

func assertPaymentExecutionAuditForInvoice(t *testing.T, fx *executorFixture, invoiceNumber int64, want int) {
	t.Helper()
	var count int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT count(*) FROM ledger_events
		WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2
		  AND payload->'input'->>'invoiceNumber' = $3`, fx.orgID, recordPaymentCapabilityID, fmt.Sprint(invoiceNumber)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("payment execution audit for invoice %d = %d, want %d", invoiceNumber, count, want)
	}
}

func assertPaymentTrialBalance(t *testing.T, fx *executorFixture, want map[string][2]int64) {
	t.Helper()
	raw := json.RawMessage(`{}`)
	claims := paymentClaims(fx, trialBalanceCapabilityID, raw, []string{"accounting.read"})
	result, err := fx.executor.Execute(fx.ctx, claims, trialBalanceCapabilityID, raw)
	if err != nil {
		t.Fatalf("trialBalance through Executor: %v", err)
	}
	if !result.OK {
		t.Fatalf("trialBalance result = %+v", result)
	}
	var output TrialBalanceOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode trial balance %s: %v", result.Data, err)
	}
	if !output.Balanced || len(output.Lines) != len(want) {
		t.Fatalf("trial balance = %+v, want balanced lines for %v", output, want)
	}
	for _, line := range output.Lines {
		amounts, ok := want[line.Code]
		if !ok || line.Currency != "USD" || line.DebitMinor != amounts[0] || line.CreditMinor != amounts[1] {
			t.Fatalf("trial balance line = %+v, want code amounts %v in USD", line, amounts)
		}
		delete(want, line.Code)
	}
	if len(want) != 0 {
		t.Fatalf("trial balance omitted accounts %v", want)
	}
}
