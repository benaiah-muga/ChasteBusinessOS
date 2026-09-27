package capability

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestGoLegacyFxPaymentReversalMatchesBothCurrencies(t *testing.T) {
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
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash and cash equivalents', 'asset'),
		($1::uuid, '1305', 'FX Clearing', 'asset')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'accounting.post', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	const invoiceNumber int64 = 8127
	const amount int64 = 50_000
	var invoiceID, paymentID, baseEntryID, foreignEntryID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, issued_at)
		VALUES ($1::uuid, $2::uuid, $3, 'paid', 'EUR', $4, 0, $4, $4, now())
		RETURNING id::text`, fx.orgID, customerID, invoiceNumber, amount).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	tx, err := fx.owner.Begin(fx.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	if err := tx.QueryRow(fx.ctx, `
		INSERT INTO journal_entries (org_id, memo, source_type, currency, entry_kind, posted_at, posted_by_actor_type, posted_by_actor_id)
		VALUES ($1::uuid, 'FX cash and clearing', 'payment', 'USD', 'operational', now(), 'human', $2::uuid)
		RETURNING id::text`, fx.orgID, fx.userID).Scan(&baseEntryID); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(fx.ctx, `
		INSERT INTO journal_entries (org_id, memo, source_type, source_id, currency, entry_kind, posted_at, posted_by_actor_type, posted_by_actor_id)
		VALUES ($1::uuid, 'FX clearing of invoice', 'payment', $2::uuid, 'EUR', 'operational', now(), 'human', $3::uuid)
		RETURNING id::text`, fx.orgID, invoiceID, fx.userID).Scan(&foreignEntryID); err != nil {
		t.Fatal(err)
	}
	for _, line := range []struct {
		entryID string
		code    string
		debit   int64
		credit  int64
	}{
		{entryID: baseEntryID, code: "1000", debit: amount},
		{entryID: baseEntryID, code: "1305", credit: amount},
		{entryID: foreignEntryID, code: "1305", debit: amount},
		{entryID: foreignEntryID, code: "1100", credit: amount},
	} {
		if _, err := tx.Exec(fx.ctx, `
			INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
			SELECT $1::uuid, id, $3, $4 FROM accounts WHERE org_id = $5::uuid AND code = $2`,
			line.entryID, line.code, line.debit, line.credit, fx.orgID); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.QueryRow(fx.ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, method, entry_id)
		VALUES ($1::uuid, $2::uuid, $3, 'bank_transfer', $4::uuid)
		RETURNING id::text`, fx.orgID, invoiceID, amount, baseEntryID).Scan(&paymentID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(fx.ctx, `
		INSERT INTO fx_settlements (org_id, payment_id, invoice_id, currency, settled_foreign_minor, base_settled_minor, gain_loss_minor, settle_rate_num, settle_rate_den, base_entry_id, foreign_entry_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'EUR', $4, $4, 0, 2, 1, $5::uuid, $6::uuid)`,
		fx.orgID, paymentID, invoiceID, amount, baseEntryID, foreignEntryID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(fx.ctx); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(fmt.Sprintf(`{"paymentId":%q,"reason":"settled at the wrong rate"}`, paymentID))
	claims := paymentClaims(fx, reversePaymentCapabilityID, input, []string{"accounting.post"})
	result, err := fx.executor.Execute(fx.ctx, claims, reversePaymentCapabilityID, input)
	if err != nil {
		t.Fatalf("reverse legacy FX payment through Executor: %v", err)
	}
	if !result.OK {
		t.Fatalf("reverse legacy FX payment result = %+v, want success", result)
	}
	var reversal ReversePaymentOutput
	if err := json.Unmarshal(result.Data, &reversal); err != nil {
		t.Fatalf("decode reverse payment result: %v", err)
	}
	if len(reversal.ReversalEntryIDs) != 2 || reversal.RefundedMinor != amount || reversal.InvoiceNumber != invoiceNumber || reversal.OutstandingMinor != amount {
		t.Fatalf("FX reversal result = %+v, want two mirrors and full outstanding amount", reversal)
	}
	for index, expected := range []struct{ originalID, currency string }{{baseEntryID, "USD"}, {foreignEntryID, "EUR"}} {
		var reversalOfID, currency string
		if err := fx.owner.QueryRow(fx.ctx, `SELECT reversal_of_id::text, currency FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, reversal.ReversalEntryIDs[index], fx.orgID).Scan(&reversalOfID, &currency); err != nil {
			t.Fatal(err)
		}
		if reversalOfID != expected.originalID || currency != expected.currency {
			t.Fatalf("FX reversal %d points to %q in %q, want %q in %q", index, reversalOfID, currency, expected.originalID, expected.currency)
		}
		var originalLineCount, mismatchCount int
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT count(*), count(*) FILTER (WHERE mirror.id IS NULL OR mirror.debit_minor <> original.credit_minor OR mirror.credit_minor <> original.debit_minor)
			FROM journal_lines original
			LEFT JOIN journal_lines mirror ON mirror.entry_id = $2::uuid AND mirror.account_id = original.account_id
			WHERE original.entry_id = $1::uuid`, expected.originalID, reversal.ReversalEntryIDs[index]).Scan(&originalLineCount, &mismatchCount); err != nil {
			t.Fatal(err)
		}
		if originalLineCount != 2 || mismatchCount != 0 {
			t.Fatalf("FX reversal %d has %d original lines and %d mismatches, want two exact debit/credit mirrors", index, originalLineCount, mismatchCount)
		}
	}
	assertPaymentInvoice(t, fx, invoiceID, "sent", 0, amount, "EUR")
	assertCapabilityAudit(t, fx, reversePaymentCapabilityID, 1)
	if _, err := fx.executor.Execute(fx.ctx, claims, reversePaymentCapabilityID, input); err == nil || err.Error() != "payment has already been reversed" {
		t.Fatalf("duplicate FX reversal error = %v, want already-reversed error", err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND reversal_of_id IN ($2::uuid, $3::uuid)`, fx.orgID, baseEntryID, foreignEntryID); got != 2 {
		t.Fatalf("FX reversal entry count = %d, want one mirror per original entry", got)
	}
	assertCapabilityAudit(t, fx, reversePaymentCapabilityID, 1)
}
