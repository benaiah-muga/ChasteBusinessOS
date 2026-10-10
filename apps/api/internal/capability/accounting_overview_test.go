package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParseAccountingOverviewInputIsStrict(t *testing.T) {
	for _, raw := range []string{`{}`, " { }\n"} {
		if _, err := ParseAccountingOverviewInput(json.RawMessage(raw)); err != nil {
			t.Errorf("ParseAccountingOverviewInput(%s): %v", raw, err)
		}
	}
	for _, raw := range []string{`[]`, `null`, `{"orgId":"00000000-0000-4000-8000-000000000001"}`, `{} {}`} {
		if _, err := ParseAccountingOverviewInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseAccountingOverviewInput(%s) succeeded, want strict object rejection", raw)
		}
	}
}

func TestAccountingOverviewCapabilityPreservesShapeSemanticsAndTenantScope(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	var filingID, otherFilingID string
	t.Cleanup(func() {
		for _, id := range []string{filingID, otherFilingID} {
			if id != "" {
				if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM sales_tax_filings WHERE id=$1::uuid`, id); err != nil {
					t.Errorf("delete overview filing fixture: %v", err)
				}
			}
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM periods WHERE org_id=$1::uuid AND year=2098 AND month=7`, fx.orgID); err != nil {
			t.Errorf("delete overview period fixture: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM periods WHERE org_id=$1::uuid AND year=2098 AND month=8`, fx.otherOrgID); err != nil {
			t.Errorf("delete other overview period fixture: %v", err)
		}
	})
	grantWavePermission(t, fx, "accounting.read")
	for _, orgID := range []string{fx.orgID, fx.otherOrgID} {
		if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET base_currency='UGX' WHERE id=$1::uuid`, orgID); err != nil {
			t.Fatal(err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, '1000', 'Overview cash', 'asset')`, orgID); err != nil {
			t.Fatal(err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, '4000', 'Overview revenue', 'income')`, orgID); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	issuedAt := now.Add(-100 * 24 * time.Hour)
	dueAt := now.Add(-95 * 24 * time.Hour)
	customerID := seedReportsCustomer(t, fx, fx.orgID, "Overview Zulu")
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE customers SET payment_term_days=30 WHERE id=$1::uuid`, customerID); err != nil {
		t.Fatal(err)
	}
	secondCustomerID := seedReportsCustomer(t, fx, fx.orgID, "Overview Alpha")
	foreignCustomerID := seedReportsCustomer(t, fx, fx.otherOrgID, "Other Overview Customer")
	baseInvoiceID := seedReportsInvoice(t, fx, fx.orgID, customerID, 501, "sent", "UGX", 10_000, 0, 10_000, 1_000, 500, &issuedAt, &dueAt, nil)
	seedReportsInvoice(t, fx, fx.orgID, secondCustomerID, 502, "draft", "EUR", 5_000, 0, 5_000, 0, 0, &issuedAt, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, customerID, 503, "void", "UGX", 8_000, 0, 8_000, 0, 0, &issuedAt, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, customerID, 504, "sent", "UGX", 8_000, 0, 8_000, 0, 0, &issuedAt, nil, &now)
	seedReportsInvoice(t, fx, fx.orgID, customerID, 505, "sent", "EUR", 7_000, 0, 7_000, 0, 0, nil, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, customerID, 506, "paid", "UGX", 6_000, 0, 6_000, 6_000, 0, &issuedAt, nil, nil)
	otherInvoiceID := seedReportsInvoice(t, fx, fx.otherOrgID, foreignCustomerID, 601, "sent", "CAD", 90_000, 0, 90_000, 0, 0, &issuedAt, &dueAt, nil)

	postedAt := now.Add(-time.Hour)
	seedReportsJournalEntry(t, fx, fx.orgID, "UGX", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 1_200}, {accountCode: "4000", creditMinor: 1_200},
	})
	seedReportsJournalEntry(t, fx, fx.otherOrgID, "CAD", "operational", postedAt, nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 99_000}, {accountCode: "4000", creditMinor: 99_000},
	})
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO payments (org_id, invoice_id, amount_minor, method, received_at) VALUES ($1::uuid, $2::uuid, 1000, 'bank_transfer', $3), ($4::uuid, $5::uuid, 99000, 'cash', $3)`, fx.orgID, baseInvoiceID, postedAt, fx.otherOrgID, otherInvoiceID); err != nil {
		t.Fatal(err)
	}

	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Overview vendor') RETURNING id::text`, fx.orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	var otherVendorID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Other Overview vendor') RETURNING id::text`, fx.otherOrgID).Scan(&otherVendorID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, paid_minor, credited_minor)
		VALUES ($1::uuid, $2::uuid, 701, 'open', 'EUR', 8000, 1000, 500), ($3::uuid, $4::uuid, 801, 'open', 'CAD', 99000, 0, 0)`, fx.orgID, vendorID, fx.otherOrgID, otherVendorID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO periods (org_id, year, month) VALUES ($1::uuid, 2098, 7), ($2::uuid, 2098, 8)`, fx.orgID, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO sales_tax_filings (org_id, period_from, period_to, tax_minor, entry_id, filed_by_actor_type)
		SELECT $1::uuid, $2, $3, 1234, je.id, 'human' FROM journal_entries je WHERE je.org_id=$1::uuid ORDER BY je.posted_at DESC LIMIT 1
		RETURNING id::text`, fx.orgID, issuedAt, now).Scan(&filingID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO sales_tax_filings (org_id, period_from, period_to, tax_minor, entry_id, filed_by_actor_type)
		SELECT $1::uuid, $2, $3, 99999, je.id, 'human' FROM journal_entries je WHERE je.org_id=$1::uuid ORDER BY je.posted_at DESC LIMIT 1
		RETURNING id::text`, fx.otherOrgID, issuedAt, now).Scan(&otherFilingID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, accountingOverviewCapabilityID, "crm.read", input, "human", "", "accounting-overview-wrong-permission"),
		accountingOverviewCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("overview wrong-permission result=%+v err=%v", denied, err)
	}

	result, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, accountingOverviewCapabilityID, "accounting.read", input, "human", "", "accounting-overview-shape-scope"),
		accountingOverviewCapabilityID,
		input,
	)
	if err != nil || !result.OK {
		t.Fatalf("overview result=%+v err=%v", result, err)
	}
	var output AccountingOverviewOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode overview result: %s: %v", result.Data, err)
	}
	if output.BaseCurrency != "UGX" || len(output.Entries) != 1 || output.Entries[0].AmountMinor != 1_200 || output.Entries[0].DebitMinor != 1_200 {
		t.Fatalf("overview entries/base currency=%+v/%s", output.Entries, output.BaseCurrency)
	}
	if output.Aging != (ArAgingBucketTotals{D90Plus: 8_500, TotalOutstanding: 8_500}) {
		t.Fatalf("overview aging=%+v, want only base-currency outstanding", output.Aging)
	}
	if len(output.AgingInvoices) != 2 || output.AgingInvoices[0].Number != 502 || output.AgingInvoices[0].Currency != "EUR" || output.AgingInvoices[1].Number != 501 || output.AgingInvoices[1].Currency != "UGX" {
		t.Fatalf("overview aging invoices=%+v, want own live invoices in descending age with currencies", output.AgingInvoices)
	}
	if output.ForeignReceivablesCount != 1 || output.ForeignPayablesCount != 1 {
		t.Fatalf("overview foreign counts AR=%d AP=%d, want 1/1", output.ForeignReceivablesCount, output.ForeignPayablesCount)
	}
	if len(output.Bills) != 1 || output.Bills[0].Number != 701 || output.Bills[0].OutstandingMinor != 6_500 || output.Bills[0].VendorName != "Overview vendor" {
		t.Fatalf("overview bills=%+v", output.Bills)
	}
	if len(output.Filings) != 1 || output.Filings[0].TaxMinor != 1_234 {
		t.Fatalf("overview filings=%+v", output.Filings)
	}
	if len(output.Customers) != 2 || output.Customers[0].Name != "Overview Alpha" || output.Customers[1].PaymentTermDays == nil || *output.Customers[1].PaymentTermDays != 30 {
		t.Fatalf("overview customers=%+v", output.Customers)
	}
	if len(output.Invoices) != 6 || output.Invoices[0].Number != 506 || output.Invoices[0].OutstandingMinor != 0 {
		t.Fatalf("overview invoice list=%+v, want all own invoice statuses ordered by number", output.Invoices)
	}
	if len(output.Payments) != 1 || output.Payments[0].InvoiceNumber != 501 || output.Payments[0].Currency != "UGX" {
		t.Fatalf("overview payments=%+v", output.Payments)
	}
	if len(output.ClosedPeriods) != 1 || output.ClosedPeriods[0] != (AccountingOverviewPeriod{Year: 2098, Month: 7}) {
		t.Fatalf("overview closed periods=%+v", output.ClosedPeriods)
	}
	for _, leaked := range []string{"Other Overview Customer", "Other Overview vendor", "Other Overview"} {
		if strings.Contains(string(result.Data), leaked) {
			t.Fatalf("overview leaked another organization value %q: %s", leaked, result.Data)
		}
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, accountingOverviewCapabilityID); got != 1 {
		t.Fatalf("overview audit events=%d, want one governed execution", got)
	}
}
