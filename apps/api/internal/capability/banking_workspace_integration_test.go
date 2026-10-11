package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestBankingWorkspaceRuntimeRoleProjectionAndIsolation(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBankingFixture(t, fx)
	grantWavePermission(t, fx, "accounting.read")

	olderAccount := seedBankAccount(t, fx, fx.orgID, "Older account", "EUR", 1000)
	newerAccount := seedBankAccount(t, fx, fx.orgID, "Newer account", "USD", 2500)
	foreignAccount := seedBankAccount(t, fx, fx.otherOrgID, "Foreign account", "GBP", 9000)
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE bank_accounts SET created_at = CASE id
			WHEN $1::uuid THEN '2026-01-01T00:00:00Z'::timestamptz
			WHEN $2::uuid THEN '2026-02-01T00:00:00Z'::timestamptz
			WHEN $3::uuid THEN '2026-03-01T00:00:00Z'::timestamptz END
		WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`, olderAccount, newerAccount, foreignAccount); err != nil {
		t.Fatal(err)
	}

	base := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	for _, group := range []struct {
		status string
		count  int
	}{
		{status: "unmatched", count: 205},
		{status: "matched", count: 105},
		{status: "excluded", count: 105},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO bank_transactions (org_id, bank_account_id, posted_at, amount_minor, description, status)
			SELECT $1::uuid, $2::uuid, $3::timestamptz + (n * interval '1 second'), n, $4 || n::text, $5
			FROM generate_series(1, $6) AS n`, fx.orgID, newerAccount, base, group.status+"-", group.status, group.count); err != nil {
			t.Fatalf("seed %s transactions: %v", group.status, err)
		}
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO bank_transactions (org_id, bank_account_id, posted_at, amount_minor, description, status)
		VALUES ($1::uuid, $2::uuid, $3::timestamptz, 999, 'foreign-only', 'unmatched')`, fx.otherOrgID, foreignAccount, base); err != nil {
		t.Fatal(err)
	}

	customerID := seedQuoteCustomer(t, fx, fx.orgID, nil)
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor)
		VALUES ($1::uuid, $2::uuid, 771, 'sent', 'USD', 100000, 0, 100000)
		RETURNING id::text`, fx.orgID, customerID).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, received_at)
		SELECT $1::uuid, $2::uuid, n, $3::timestamptz + (n * interval '1 second')
		FROM generate_series(1, 55) AS n`, fx.orgID, invoiceID, base); err != nil {
		t.Fatal(err)
	}
	foreignCustomer := seedQuoteCustomer(t, fx, fx.otherOrgID, nil)
	var foreignInvoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor)
		VALUES ($1::uuid, $2::uuid, 772, 'sent', 'GBP', 99999, 0, 99999)
		RETURNING id::text`, fx.otherOrgID, foreignCustomer).Scan(&foreignInvoiceID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, 99999, $3::timestamptz + interval '1 hour')`, fx.otherOrgID, foreignInvoiceID, base); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{}`)
	denied, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, listBankingWorkspaceCapabilityID, "crm.read", input, "human", "", "banking-workspace-denied"),
		listBankingWorkspaceCapabilityID, input)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("missing accounting.read result=%+v err=%v", denied, err)
	}

	result, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, listBankingWorkspaceCapabilityID, "accounting.read", input, "human", "", "banking-workspace-read"),
		listBankingWorkspaceCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("listBankingWorkspace result=%+v err=%v", result, err)
	}
	var got ListBankingWorkspaceOutput
	if err := json.Unmarshal(result.Data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Accounts) != 2 || got.Accounts[0].ID != newerAccount || got.Accounts[1].ID != olderAccount {
		t.Fatalf("workspace accounts=%+v, want current-org accounts newest first", got.Accounts)
	}
	if got.Accounts[0].CurrencyCode != "USD" || got.Accounts[0].BalanceMinor != 2500 || got.Accounts[1].Last4 != nil {
		t.Fatalf("account projection=%+v, want currency/balance/null last4 fields", got.Accounts)
	}
	if len(got.Unmatched) != 200 || len(got.Matched) != 100 || len(got.Excluded) != 100 || len(got.Payments) != 50 {
		t.Fatalf("workspace limits unmatched=%d matched=%d excluded=%d payments=%d", len(got.Unmatched), len(got.Matched), len(got.Excluded), len(got.Payments))
	}
	for _, rows := range [][]BankingWorkspaceTransaction{got.Unmatched, got.Matched, got.Excluded} {
		if rows[0].PostedAt.Before(rows[len(rows)-1].PostedAt) || rows[0].BankAccountID != newerAccount || rows[0].CurrencyCode != "USD" {
			t.Fatalf("transaction order/projection starts=%+v ends=%+v", rows[0], rows[len(rows)-1])
		}
		for _, row := range rows {
			if strings.HasPrefix(row.Description, "foreign") {
				t.Fatalf("foreign transaction leaked: %+v", row)
			}
		}
	}
	if got.Unmatched[0].Description != fmt.Sprintf("unmatched-%d", 205) || got.Matched[0].Description != "matched-105" || got.Excluded[0].Description != "excluded-105" {
		t.Fatalf("top rows unmatched=%+v matched=%+v excluded=%+v", got.Unmatched[0], got.Matched[0], got.Excluded[0])
	}
	if got.Payments[0].AmountMinor != 55 || got.Payments[0].InvoiceNumber == nil || *got.Payments[0].InvoiceNumber != 771 || got.Payments[0].CustomerName == "" || got.Payments[0].CurrencyCode != "USD" {
		t.Fatalf("payment projection=%+v, want newest joined invoice/customer fields", got.Payments[0])
	}
	for _, payment := range got.Payments {
		if payment.AmountMinor == 99999 || (payment.InvoiceNumber != nil && *payment.InvoiceNumber == 772) {
			t.Fatalf("foreign payment leaked into workspace: %+v", payment)
		}
	}
	if got.Summary.UnmatchedCount != 205 || len(got.Summary.Accounts) != 2 || got.Summary.Accounts[0].BankAccountID != olderAccount || got.Summary.Accounts[0].Count != 0 || got.Summary.Accounts[1].Count != 415 {
		t.Fatalf("summary=%+v, want bankSummary contract and matching transaction stats", got.Summary)
	}
	if got.Summary.Accounts[1].MoneyInMinor != int64(205*206/2+105*106/2+105*106/2) {
		t.Fatalf("summary money in=%d, want all signed positive transaction amounts", got.Summary.Accounts[1].MoneyInMinor)
	}
	standaloneSummary, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, bankSummaryCapabilityID, "accounting.read", input, "human", "", "banking-workspace-summary-parity"),
		bankSummaryCapabilityID, input)
	if err != nil || !standaloneSummary.OK {
		t.Fatalf("bankSummary result=%+v err=%v", standaloneSummary, err)
	}
	var expectedSummary BankSummaryOutput
	if err := json.Unmarshal(standaloneSummary.Data, &expectedSummary); err != nil {
		t.Fatal(err)
	}
	gotSummary, err := json.Marshal(got.Summary)
	if err != nil {
		t.Fatal(err)
	}
	wantSummary, err := json.Marshal(expectedSummary)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotSummary) != string(wantSummary) {
		t.Fatalf("workspace summary=%s, standalone bankSummary=%s", gotSummary, wantSummary)
	}
}
