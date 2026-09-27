package capability

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestGoCustomerTimelineReadMatchesLegacy(t *testing.T) {
	fx := newExecutorFixture(t)
	ownedCustomerID := seedCRMReadCustomer(t, fx, fx.orgID, "Timeline customer", "timeline@fixture.test", nil, nil)
	mergedCustomerID := seedCRMReadCustomer(t, fx, fx.orgID, "Merged timeline customer", "merged-timeline@fixture.test", nil, &ownedCustomerID)
	foreignMergedID := seedCRMReadCustomer(t, fx, fx.otherOrgID, "Foreign merged alias", "foreign-merged@fixture.test", nil, &ownedCustomerID)
	foreignCustomerID := seedCRMReadCustomer(t, fx, fx.otherOrgID, "Foreign timeline customer", "foreign@fixture.test", nil, nil)
	input := json.RawMessage(`{"customerId":"` + ownedCustomerID + `"}`)

	deniedClaims := crmReadClaims(fx, customerTimelineCapabilityID, input)
	deniedClaims.Permissions = []string{"crm.write"}
	denied, err := fx.executor.Execute(fx.ctx, deniedClaims, customerTimelineCapabilityID, input)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: crm.read" {
		t.Fatalf("customerTimeline without crm.read result=%+v err=%v, want exact permission denial", denied, err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'crm.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	when := time.Date(2025, 1, 10, 12, 30, 15, 250_000_000, time.UTC)
	older := when.Add(-24 * time.Hour)
	primaryInvoiceID := seedTimelineInvoice(t, fx, fx.orgID, ownedCustomerID, 100, 12345, &older)
	mergedInvoiceID := seedTimelineInvoice(t, fx, fx.orgID, mergedCustomerID, 101, 12345, &when)
	paymentID := seedTimelinePayment(t, fx, fx.orgID, mergedInvoiceID, 6789, "cash", when)
	quoteID := seedTimelineQuote(t, fx, fx.orgID, mergedCustomerID, 201, "accepted", 23456, &when, when.Add(-time.Hour))
	dealID := seedTimelineDeal(t, fx, fx.orgID, ownedCustomerID, "Expansion", "proposal", 34567, when)
	taskID := seedTimelineTask(t, fx, fx.orgID, "Call buyer", ownedCustomerID, &when, &when, when.Add(-time.Hour))
	documentID := seedTimelineDocument(t, fx, fx.orgID, ownedCustomerID, "Signed order", "parsed", when)

	// These rows deliberately point at the owned customer while carrying the
	// other organization's ID. Each source must retain its own tenant filter.
	foreignInvoiceID := seedTimelineInvoice(t, fx, fx.otherOrgID, ownedCustomerID, 100, 99999, &when)
	seedTimelinePayment(t, fx, fx.otherOrgID, foreignInvoiceID, 8888, "card", when)
	seedTimelineQuote(t, fx, fx.otherOrgID, ownedCustomerID, 202, "declined", 99999, &when, when)
	seedTimelineDeal(t, fx, fx.otherOrgID, ownedCustomerID, "Foreign deal", "won", 99999, when)
	seedTimelineTask(t, fx, fx.otherOrgID, "Foreign task", ownedCustomerID, &when, &when, when)
	seedTimelineDocument(t, fx, fx.otherOrgID, ownedCustomerID, "Foreign document", "failed", when)
	// A foreign merged alias must not join otherwise tenant-owned activity.
	seedTimelineInvoice(t, fx, fx.orgID, foreignMergedID, 102, 77777, ptrTime(when.Add(time.Hour)))
	_ = foreignCustomerID

	result, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, customerTimelineCapabilityID, input), customerTimelineCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("customerTimeline result=%+v err=%v", result, err)
	}
	var timeline CustomerTimelineOutput
	if err := json.Unmarshal(result.Data, &timeline); err != nil {
		t.Fatalf("decode customerTimeline output %s: %v", result.Data, err)
	}
	want := []CustomerTimelineEntry{
		{Kind: "invoice", Date: "2025-01-10T12:30:15.250Z", RefID: mergedInvoiceID, Summary: "Invoice #101 (draft, 123.45)"},
		{Kind: "payment", Date: "2025-01-10T12:30:15.250Z", RefID: paymentID, Summary: "Payment 67.89 via cash"},
		{Kind: "quote", Date: "2025-01-10T12:30:15.250Z", RefID: quoteID, Summary: "Quote #201 (accepted, 234.56)"},
		{Kind: "deal", Date: "2025-01-10T12:30:15.250Z", RefID: dealID, Summary: "Deal \"Expansion\" (proposal, 345.67)"},
		{Kind: "task", Date: "2025-01-10T12:30:15.250Z", RefID: taskID, Summary: "Task \"Call buyer\" (done)"},
		{Kind: "document", Date: "2025-01-10T12:30:15.250Z", RefID: documentID, Summary: "Document \"Signed order\" (parsed)"},
		{Kind: "invoice", Date: "2025-01-09T12:30:15.250Z", RefID: primaryInvoiceID, Summary: "Invoice #100 (draft, 123.45)"},
	}
	if !reflect.DeepEqual(timeline.Entries, want) {
		t.Fatalf("customerTimeline entries=%+v, want legacy source-order ties, summaries, dates, and merged-customer rows %+v", timeline.Entries, want)
	}

	foreignInput := json.RawMessage(`{"customerId":"` + foreignCustomerID + `"}`)
	if _, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, customerTimelineCapabilityID, foreignInput), customerTimelineCapabilityID, foreignInput); err == nil || err.Error() != "customer not found in this organization" {
		t.Fatalf("cross-organization customer lookup error=%v, want not found in this organization", err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at)
		SELECT $1::uuid, $2::uuid, 1000 + n, 'sent', 100, 0, 100, TIMESTAMPTZ '2025-02-01 00:00:00+00' + n * INTERVAL '1 day'
		FROM generate_series(0, 204) AS n`, fx.orgID, ownedCustomerID); err != nil {
		t.Fatal(err)
	}
	defaultResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, customerTimelineCapabilityID, input), customerTimelineCapabilityID, input)
	if err != nil || !defaultResult.OK {
		t.Fatalf("customerTimeline default limit result=%+v err=%v", defaultResult, err)
	}
	if err := json.Unmarshal(defaultResult.Data, &timeline); err != nil {
		t.Fatal(err)
	}
	if len(timeline.Entries) != 50 || timeline.Entries[0].Kind != "invoice" || timeline.Entries[0].Date != "2025-08-24T00:00:00.000Z" {
		t.Fatalf("customerTimeline default limit returned count=%d first=%+v, want 50 with newest invoice first", len(timeline.Entries), firstTimelineEntry(timeline.Entries))
	}

	limit200Input := json.RawMessage(`{"customerId":"` + ownedCustomerID + `","limit":200}`)
	limit200Result, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, customerTimelineCapabilityID, limit200Input), customerTimelineCapabilityID, limit200Input)
	if err != nil || !limit200Result.OK {
		t.Fatalf("customerTimeline limit 200 result=%+v err=%v", limit200Result, err)
	}
	if err := json.Unmarshal(limit200Result.Data, &timeline); err != nil {
		t.Fatal(err)
	}
	if len(timeline.Entries) != 200 {
		t.Fatalf("customerTimeline limit 200 returned %d entries, want 200", len(timeline.Entries))
	}
	var newestInvoiceID, oldestIncludedInvoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM invoices WHERE org_id=$1::uuid AND customer_id=$2::uuid AND number=1204`, fx.orgID, ownedCustomerID).Scan(&newestInvoiceID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM invoices WHERE org_id=$1::uuid AND customer_id=$2::uuid AND number=1005`, fx.orgID, ownedCustomerID).Scan(&oldestIncludedInvoiceID); err != nil {
		t.Fatal(err)
	}
	if timeline.Entries[0].RefID != newestInvoiceID || timeline.Entries[len(timeline.Entries)-1].RefID != oldestIncludedInvoiceID {
		t.Fatalf("customerTimeline max-limit boundary first=%+v last=%+v, want invoice 1204 then 1005", timeline.Entries[0], timeline.Entries[len(timeline.Entries)-1])
	}

	limitOneInput := json.RawMessage(`{"customerId":"` + ownedCustomerID + `","limit":1}`)
	limitOneResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, customerTimelineCapabilityID, limitOneInput), customerTimelineCapabilityID, limitOneInput)
	if err != nil || !limitOneResult.OK {
		t.Fatalf("customerTimeline limit 1 result=%+v err=%v", limitOneResult, err)
	}
	if err := json.Unmarshal(limitOneResult.Data, &timeline); err != nil {
		t.Fatal(err)
	}
	if len(timeline.Entries) != 1 || timeline.Entries[0].RefID != newestInvoiceID {
		t.Fatalf("customerTimeline limit 1 entries=%+v, want only newest invoice", timeline.Entries)
	}

	for _, invalid := range []string{
		`{"customerId":"` + ownedCustomerID + `","limit":0}`,
		`{"customerId":"` + ownedCustomerID + `","limit":201}`,
	} {
		invalidResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, customerTimelineCapabilityID, json.RawMessage(invalid)), customerTimelineCapabilityID, json.RawMessage(invalid))
		if err != nil || invalidResult.OK || invalidResult.Error != "invalid input: limit must be a positive integer at most 200" {
			t.Fatalf("customerTimeline invalid limit %s result=%+v err=%v", invalid, invalidResult, err)
		}
	}
}

func firstTimelineEntry(entries []CustomerTimelineEntry) any {
	if len(entries) == 0 {
		return nil
	}
	return entries[0]
}

func seedTimelineInvoice(t *testing.T, fx *executorFixture, orgID, customerID string, number int, totalMinor int64, issuedAt *time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at)
		VALUES ($1::uuid, $2::uuid, $3, 'draft', $4, 0, $4, $5)
		RETURNING id::text`, orgID, customerID, number, totalMinor, issuedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTimelinePayment(t *testing.T, fx *executorFixture, orgID, invoiceID string, amountMinor int64, method string, receivedAt time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, method, received_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text`, orgID, invoiceID, amountMinor, method, receivedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTimelineQuote(t *testing.T, fx *executorFixture, orgID, customerID string, number int, status string, totalMinor int64, decidedAt *time.Time, createdAt time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO quotes (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, decided_at, created_by_actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, 0, $5, $6, 'human', $7)
		RETURNING id::text`, orgID, customerID, number, status, totalMinor, decidedAt, createdAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTimelineDeal(t *testing.T, fx *executorFixture, orgID, customerID, title, stage string, valueMinor int64, updatedAt time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO deals (org_id, customer_id, title, stage, value_minor, updated_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
		RETURNING id::text`, orgID, customerID, title, stage, valueMinor, updatedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTimelineTask(t *testing.T, fx *executorFixture, orgID, title, customerID string, dueAt, doneAt *time.Time, createdAt time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tasks (org_id, title, due_at, done_at, ref_type, ref_id, created_at)
		VALUES ($1::uuid, $2, $3, $4, 'customer', $5::uuid, $6)
		RETURNING id::text`, orgID, title, dueAt, doneAt, customerID, createdAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTimelineDocument(t *testing.T, fx *executorFixture, orgID, customerID, title, status string, updatedAt time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO documents (org_id, title, source_type, status, created_by_actor_type, ref_type, ref_id, updated_at)
		VALUES ($1::uuid, $2, 'text', $3, 'human', 'customer', $4::uuid, $5)
		RETURNING id::text`, orgID, title, status, customerID, updatedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
