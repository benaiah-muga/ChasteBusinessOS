package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPurchasingListWorkspacePermissionIsolationAndProjection(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET base_currency='UGX' WHERE id=$1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}

	alphaID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	zuluID := seedPurchasingVendor(t, fx, fx.orgID, int64Ptr(30))
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE vendors SET name='Alpha', email=NULL WHERE id=$1::uuid`, alphaID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE vendors SET name='Zulu', email='zulu@example.test', deactivated_at=$2 WHERE id=$1::uuid`, zuluID, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, memo, created_at)
		SELECT $1::uuid, $2::uuid, n, CASE WHEN n=101 THEN 'partial' ELSE 'ordered' END,
		       CASE WHEN n=101 THEN 'newest order' ELSE NULL END,
		       now() - (101-n) * interval '1 minute'
		FROM generate_series(1,101) AS n`, fx.orgID, alphaID); err != nil {
		t.Fatal(err)
	}
	var newestPOID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM purchase_orders WHERE org_id=$1::uuid AND number=101`, fx.orgID).Scan(&newestPOID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO po_lines (po_id, position, description, quantity, unit_price_minor)
		VALUES ($1::uuid, 2, 'half minor', 500, 1), ($1::uuid, 1, 'four and a half', 1500, 3)`, newestPOID); err != nil {
		t.Fatal(err)
	}
	var receiptID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO goods_receipts (org_id, po_id, number, received_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 1, 'human') RETURNING id::text`, fx.orgID, newestPOID).Scan(&receiptID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, rejected_thousandths, returned_thousandths)
		SELECT $1::uuid, $2::uuid, id, position, CASE WHEN position=1 THEN 500 ELSE 0 END,
		       CASE WHEN position=1 THEN 250 ELSE 0 END, CASE WHEN position=1 THEN 100 ELSE 0 END
		FROM po_lines WHERE po_id=$3::uuid`, fx.orgID, receiptID, newestPOID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, created_at)
		VALUES ($1::uuid, $2::uuid, 999, 'foreign', now())`, fx.otherOrgID, foreignVendorID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, paid_minor, credited_minor, bill_date, created_at)
		SELECT $1::uuid, $2::uuid, n, CASE WHEN n=101 THEN 'void' ELSE 'open' END, 'UGX',
		       CASE WHEN n=101 THEN 1000 ELSE 900 END,
		       CASE WHEN n=101 THEN 300 ELSE 0 END,
		       CASE WHEN n=101 THEN 200 ELSE 0 END,
		       CASE WHEN n=101 THEN now() - interval '40 days' ELSE NULL END,
		       now() - (101-n) * interval '1 minute'
		FROM generate_series(1,101) AS n`, fx.orgID, alphaID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor)
		VALUES ($1::uuid, $2::uuid, 999, 'foreign', 'USD', 100)`, fx.otherOrgID, foreignVendorID); err != nil {
		t.Fatal(err)
	}
	var standalonePaymentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_payments (org_id, bill_id, amount_minor, status, paid_at)
		SELECT $1::uuid, id, 100, 'settled', now() FROM vendor_bills WHERE org_id=$1::uuid AND number=101
		RETURNING id::text`, fx.orgID).Scan(&standalonePaymentID); err != nil {
		t.Fatal(err)
	}
	var requestID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_requests (org_id, title, justification, estimated_amount_minor, status)
		VALUES ($1::uuid, 'Office chairs', 'Replace damaged chairs', 250000, 'approved') RETURNING id::text`, fx.orgID).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO rfqs (org_id, request_id, vendor_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, fx.orgID, requestID, alphaID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{}`)
	claims := waveModuleClaims(fx, purchasingListWorkspaceCapabilityID, "purchasing.read", input, "human", "", "workspace-denied")
	denied, err := fx.executor.Execute(fx.ctx, claims, purchasingListWorkspaceCapabilityID, input)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.read") {
		t.Fatalf("listWorkspace denial result=%+v err=%v", denied, err)
	}
	grantWavePermission(t, fx, "purchasing.read")
	result, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, purchasingListWorkspaceCapabilityID, "purchasing.read", input, "human", "", "workspace-read"), purchasingListWorkspaceCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("listWorkspace result=%+v err=%v", result, err)
	}
	var output PurchasingListWorkspaceOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if output.BaseCurrency != "UGX" {
		t.Fatalf("baseCurrency=%q, want UGX", output.BaseCurrency)
	}
	if len(output.Vendors) != 2 || output.Vendors[0].Name != "Alpha" || output.Vendors[1].Name != "Zulu" {
		t.Fatalf("vendors=%+v, want this org sorted by name", output.Vendors)
	}
	if output.Vendors[0].Email != nil || output.Vendors[0].PaymentTermDays != nil || output.Vendors[0].DeactivatedAt != nil {
		t.Fatalf("nullable vendor fields=%+v, want nulls preserved", output.Vendors[0])
	}
	if output.Vendors[1].PaymentTermDays == nil || *output.Vendors[1].PaymentTermDays != 30 || output.Vendors[1].DeactivatedAt == nil {
		t.Fatalf("nullable vendor fields=%+v, want persisted values", output.Vendors[1])
	}
	if len(output.Orders) != 100 || output.Orders[0].Number != 101 || output.Orders[0].Status != "partial" || output.Orders[0].Memo == nil || *output.Orders[0].Memo != "newest order" {
		t.Fatalf("orders[0]=%+v (total %d), want newest local order and 100-row limit", output.Orders[0], len(output.Orders))
	}
	newestOrder := output.Orders[0]
	if newestOrder.VendorName != "Alpha" || newestOrder.OrderedMinor != 6 || len(newestOrder.Lines) != 2 || newestOrder.Lines[0].LineNumber != 1 || newestOrder.Lines[1].LineNumber != 2 {
		t.Fatalf("newest order projection=%+v, want sorted lines and JS Math.round total 6", newestOrder)
	}
	if newestOrder.Lines[0].AcceptedThousandths != 500 || newestOrder.Lines[0].RejectedThousandths != 250 || newestOrder.Lines[0].ReturnedThousandths != 100 || newestOrder.Lines[0].RemainingThousandths != 750 {
		t.Fatalf("first order line receiving projection=%+v, want accepted 500, rejected 250, returned 100, remaining 750", newestOrder.Lines[0])
	}
	if newestOrder.Lines[1].AcceptedThousandths != 0 || newestOrder.Lines[1].RejectedThousandths != 0 || newestOrder.Lines[1].ReturnedThousandths != 0 || newestOrder.Lines[1].RemainingThousandths != 500 {
		t.Fatalf("second order line receiving projection=%+v, want untouched 500 remaining", newestOrder.Lines[1])
	}
	if len(output.Bills) != 100 || output.Bills[0].Number != 101 || output.Bills[0].Status != "void" || output.Bills[0].DueMinor != 500 || output.Bills[0].VendorName != "Alpha" {
		t.Fatalf("bills[0]=%+v (total %d), want newest local bill and due amount 500", output.Bills[0], len(output.Bills))
	}
	if output.Orders[0].ID == "" || output.Bills[0].ID == "" || output.Bills[0].Currency != "UGX" || output.Bills[0].VendorRef != nil || output.Bills[0].Memo != nil {
		t.Fatalf("required IDs/currency/nullables missing: order=%+v bill=%+v", output.Orders[0], output.Bills[0])
	}
	if len(output.Bills[0].Payments) != 1 || output.Bills[0].Payments[0].ID != standalonePaymentID || output.Bills[0].Payments[0].AmountMinor != 100 || output.Bills[0].Payments[0].Status != "settled" || output.Bills[0].Payments[0].PaymentRunID != nil || output.Bills[0].Payments[0].ReversalEntryID != nil {
		t.Fatalf("newest bill payment projection=%+v, want the standalone payment and nullable run ID", output.Bills[0].Payments)
	}
	if output.APAging.Buckets.TotalOutstanding != 700 {
		t.Fatalf("apAging=%+v, want total outstanding from all bills using legacy paid-only aging", output.APAging)
	}
	if len(output.PriceHistory.Rows) != 2 || len(output.SupplierPerformance.Vendors) != 2 || len(output.Requests) != 1 {
		t.Fatalf("optional workspace sections priceHistory=%d supplierPerformance=%d requests=%d, want populated history/performance and one request", len(output.PriceHistory.Rows), len(output.SupplierPerformance.Vendors), len(output.Requests))
	}
	request := output.Requests[0]
	if request.Title != "Office chairs" || request.Status != "approved" || request.EstimatedAmountMinor == nil || *request.EstimatedAmountMinor != 250000 || len(request.RFQs) != 1 || request.RFQs[0].VendorName != "Alpha" || request.RFQs[0].QuoteAmountMinor != nil {
		t.Fatalf("workspace request projection=%+v, want request and vendor RFQ without unset quote values", request)
	}
}
