package capability

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func lifecycleInOrgTx[T any](t *testing.T, fx *executorFixture, orgID string, run func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, run)
	if err != nil {
		t.Fatalf("purchasing lifecycle transaction: %v", err)
	}
	return output
}

func lifecycleExpectError(t *testing.T, fx *executorFixture, orgID, wantErr string, run func(tx pgx.Tx) error) {
	t.Helper()
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, run(tx)
	}); err == nil || err.Error() != wantErr {
		t.Fatalf("purchasing lifecycle error = %v, want %q", err, wantErr)
	}
}

func cleanupPurchasingLifecycleFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin lifecycle fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable lifecycle fixture ledger cleanup: %v", err)
			return
		}
		for orgID := range map[string]struct{}{fx.orgID: {}, fx.otherOrgID: {}} {
			steps := []string{
				`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = $1::uuid)`,
				`DELETE FROM journal_entries WHERE org_id = $1::uuid`,
				`DELETE FROM vendor_bill_lines WHERE bill_id IN (SELECT id FROM vendor_bills WHERE org_id = $1::uuid)`,
				`DELETE FROM vendor_bills WHERE org_id = $1::uuid`,
				`DELETE FROM goods_receipt_lines WHERE org_id = $1::uuid`,
				`DELETE FROM goods_receipts WHERE org_id = $1::uuid`,
				`DELETE FROM po_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE org_id = $1::uuid)`,
				`DELETE FROM purchase_orders WHERE org_id = $1::uuid`,
				`DELETE FROM stock_movements WHERE org_id = $1::uuid`,
				`DELETE FROM stock_balances WHERE org_id = $1::uuid`,
				`DELETE FROM items WHERE org_id = $1::uuid`,
				`DELETE FROM tax_codes WHERE org_id = $1::uuid`,
				`DELETE FROM tax_profiles WHERE org_id = $1::uuid`,
				`DELETE FROM doc_counters WHERE org_id = $1::uuid`,
				`DELETE FROM vendors WHERE org_id = $1::uuid`,
				`DELETE FROM accounts WHERE org_id = $1::uuid`,
			}
			for _, step := range steps {
				if _, err := tx.Exec(fx.ctx, step, orgID); err != nil {
					t.Errorf("lifecycle fixture cleanup step failed: %v", err)
					return
				}
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit lifecycle fixture cleanup: %v", err)
		}
	})
}

func seedLifecycleBill(t *testing.T, fx *executorFixture, orgID, vendorID string, number int64, status string, totalMinor, paidMinor, creditedMinor int64, entryID *string) string {
	t.Helper()
	var billID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, paid_minor, credited_minor, entry_id, bill_date)
		VALUES ($1::uuid, $2::uuid, $3, $4, 'USD', $5, $6, $7, $8::uuid, $9)
		RETURNING id::text`, orgID, vendorID, number, status, totalMinor, paidMinor, creditedMinor, entryID,
		time.Date(2026, 9, 21, 8, 0, 0, 0, time.UTC)).Scan(&billID); err != nil {
		t.Fatal(err)
	}
	return billID
}

func seedLifecycleBillLine(t *testing.T, fx *executorFixture, billID, description string, quantity, unitPriceMinor, taxMinor int64, taxCodeID *string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bill_lines (bill_id, description, quantity, unit_price_minor, tax_minor, tax_code_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)`, billID, description, quantity, unitPriceMinor, taxMinor, taxCodeID); err != nil {
		t.Fatal(err)
	}
}

func seedLifecyclePO(t *testing.T, fx *executorFixture, orgID, vendorID, status string, number int64) string {
	t.Helper()
	var poID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, ordered_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text`, orgID, vendorID, number, status, time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)).Scan(&poID); err != nil {
		t.Fatal(err)
	}
	return poID
}

func seedLifecyclePOLine(t *testing.T, fx *executorFixture, poID, description string, position, quantity, unitPriceMinor int64, itemID *string, serviceAccepted *int64) string {
	t.Helper()
	var poLineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, position, item_id, service_accepted_thousandths)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7)
		RETURNING id::text`, poID, description, quantity, unitPriceMinor, position, itemID, serviceAccepted).Scan(&poLineID); err != nil {
		t.Fatal(err)
	}
	return poLineID
}

func seedLifecycleReceipt(t *testing.T, fx *executorFixture, orgID, poID string, number int64, receivedAt time.Time, note *string) string {
	t.Helper()
	var receiptID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO goods_receipts (org_id, po_id, number, received_at, received_by_actor_type, note)
		VALUES ($1::uuid, $2::uuid, $3, $4, 'human', $5)
		RETURNING id::text`, orgID, poID, number, receivedAt, note).Scan(&receiptID); err != nil {
		t.Fatal(err)
	}
	return receiptID
}

func seedLifecycleReceiptLine(t *testing.T, fx *executorFixture, orgID, receiptID, poLineID string, position, accepted, rejected, returned int64, rejectionNote *string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, rejected_thousandths, returned_thousandths, rejection_note)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
		orgID, receiptID, poLineID, position, accepted, rejected, returned, rejectionNote); err != nil {
		t.Fatal(err)
	}
}

func seedLifecycleLegacyMovement(t *testing.T, fx *executorFixture, orgID, itemID string, delta int64, refID *string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, ref_type, ref_id, actor_type)
		VALUES ($1::uuid, $2::uuid, $3, 'purchase', 'po_line', $4::uuid, 'human')`, orgID, itemID, delta, refID); err != nil {
		t.Fatal(err)
	}
}

func TestPurchasingLifecycleParsersMirrorZodContracts(t *testing.T) {
	billUUID := "22222222-2222-4222-8222-222222222222"

	credited, err := ParseBillCreditNoteInput(json.RawMessage(`{"billId":"` + billUUID + `","amountMinor":2500,"reason":"Duplicate charge","unknown":true}`))
	if err != nil {
		t.Fatal(err)
	}
	wantCredit := BillCreditNoteInput{BillID: billUUID, AmountMinor: 2500, Reason: "Duplicate charge"}
	if credited != wantCredit {
		t.Fatalf("ParseBillCreditNoteInput() = %+v, want %+v", credited, wantCredit)
	}
	if encoded, err := marshalJS(credited); err != nil || string(encoded) != `{"billId":"`+billUUID+`","amountMinor":2500,"reason":"Duplicate charge"}` {
		t.Fatalf("ParseBillCreditNoteInput() JSON = %s, %v", encoded, err)
	}
	longReason := strings.Repeat("r", 500)
	if _, err := ParseBillCreditNoteInput(json.RawMessage(`{"billId":"` + billUUID + `","amountMinor":1,"reason":"` + longReason + `"}`)); err != nil {
		t.Fatalf("ParseBillCreditNoteInput(500 char reason) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"amountMinor":1,"reason":"valid reason"}`,
		`{"billId":null,"amountMinor":1,"reason":"valid reason"}`,
		`{"billId":"nope","amountMinor":1,"reason":"valid reason"}`,
		`{"billId":"` + billUUID + `","reason":"valid reason"}`,
		`{"billId":"` + billUUID + `","amountMinor":0,"reason":"valid reason"}`,
		`{"billId":"` + billUUID + `","amountMinor":-5,"reason":"valid reason"}`,
		`{"billId":"` + billUUID + `","amountMinor":1.5,"reason":"valid reason"}`,
		`{"billId":"` + billUUID + `","amountMinor":null,"reason":"valid reason"}`,
		`{"billId":"` + billUUID + `","amountMinor":1}`,
		`{"billId":"` + billUUID + `","amountMinor":1,"reason":"ab"}`,
		`{"billId":"` + billUUID + `","amountMinor":1,"reason":null}`,
		`{"billId":"` + billUUID + `","amountMinor":1,"reason":"` + strings.Repeat("r", 501) + `"}`,
	} {
		if _, err := ParseBillCreditNoteInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseBillCreditNoteInput accepted %s", raw)
		}
	}

	if share := billCreditNoteTaxShare(1000, 500, 0); share != 0 {
		t.Fatalf("billCreditNoteTaxShare(zero total) = %d, want 0", share)
	}
	if share := billCreditNoteTaxShare(3000, 1900, 10_000); share != 570 {
		t.Fatalf("billCreditNoteTaxShare(3000, 1900, 10000) = %d, want 570 (half up)", share)
	}

	closed, err := ParseClosePurchaseOrderInput(json.RawMessage(`{"poNumber":7,"unknown":0}`))
	if err != nil || closed.PONumber != 7 {
		t.Fatalf("ParseClosePurchaseOrderInput() = %+v, %v, want poNumber 7", closed, err)
	}
	listed, err := ParseListReceiptsInput(json.RawMessage(`{"poNumber":2147483647}`))
	if err != nil || listed.PONumber != math.MaxInt32 {
		t.Fatalf("ParseListReceiptsInput() = %+v, %v, want poNumber MaxInt32", listed, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"poNumber":0}`,
		`{"poNumber":-1}`,
		`{"poNumber":1.5}`,
		`{"poNumber":null}`,
		`{"poNumber":2147483648}`,
	} {
		if _, err := ParseClosePurchaseOrderInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseClosePurchaseOrderInput accepted %s", raw)
		}
		if _, err := ParseListReceiptsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseListReceiptsInput accepted %s", raw)
		}
	}

	if _, err := parsePurchasingLifecycleInput("purchasing.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported purchasing lifecycle capability" {
		t.Fatalf("parsePurchasingLifecycleInput(unknown) err = %v, want dispatcher refusal", err)
	}
	for capabilityID, raw := range map[string]string{
		billCreditNoteCapabilityID:     `{"billId":"` + billUUID + `","amountMinor":1,"reason":"abc"}`,
		closePurchaseOrderCapabilityID: `{"poNumber":3}`,
		listReceiptsCapabilityID:       `{"poNumber":4}`,
	} {
		if _, err := parsePurchasingLifecycleInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parsePurchasingLifecycleInput(%s) err = %v", capabilityID, err)
		}
	}
}

func TestPurchasingLifecycleBillCreditNotePostsMirrorAndCreditsBill(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingLifecycleFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	seedPurchasingTaxProfile(t, fx, fx.orgID, "DE")
	recoverableTaxCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "DE", "VAT19", "input", 1900, false, true, true)
	nonRecoverableTaxCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "DE", "VAT7", "input", 700, false, false, true)

	billEntryID := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Vendor bill 1", SourceType: "vendor_bill",
			Currency: "USD", PostedAt: now, ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "6000", DebitMinor: 10_000},
				{AccountCode: "2000", CreditMinor: 10_000},
			},
		})
	})

	taxBillID := seedLifecycleBill(t, fx, fx.orgID, vendorID, 1, "open", 10_000, 0, 0, &billEntryID)
	seedLifecycleBillLine(t, fx, taxBillID, "Parts", 1000, 8100, 1900, &recoverableTaxCodeID)
	seedLifecycleBillLine(t, fx, taxBillID, "Deposit", 1000, 1900, 0, nil)
	voidBillID := seedLifecycleBill(t, fx, fx.orgID, vendorID, 2, "void", 6_000, 0, 0, nil)
	foreignBillID := seedLifecycleBill(t, fx, fx.otherOrgID, foreignVendorID, 90, "open", 9_000, 0, 0, nil)

	for _, bad := range []struct {
		billID  string
		amount  int64
		wantErr string
	}{
		{executorUUID(t), 100, "bill not found"},
		{foreignBillID, 100, "bill not found"},
		{voidBillID, 100, "bill is void; nothing to credit"},
		{taxBillID, 10_001, "credit 10001 exceeds the open balance 10000 (total 10000 − paid 0 − credited 0)"},
	} {
		lifecycleExpectError(t, fx, fx.orgID, bad.wantErr, func(tx pgx.Tx) error {
			_, err := purchasingBillCreditNote(fx.ctx, tx, claims, BillCreditNoteInput{BillID: bad.billID, AmountMinor: bad.amount, Reason: "Attempted credit"}, now)
			return err
		})
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND source_type = 'vendor_credit_note'`, fx.orgID); got != 0 {
		t.Fatalf("refused credit notes stored %d entries, want 0", got)
	}

	first := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (BillCreditNoteOutput, error) {
		return purchasingBillCreditNote(fx.ctx, tx, claims, BillCreditNoteInput{BillID: taxBillID, AmountMinor: 3_000, Reason: "Damaged shipment"}, now)
	})
	if !isUUID(first.EntryID) || first.CreditedMinor != 3_000 || first.BillBalanceMinor != 7_000 {
		t.Fatalf("first credit output = %+v, want credited 3000 and balance 7000", first)
	}
	if encoded, err := marshalJS(first); err != nil {
		t.Fatal(err)
	} else if string(encoded) != fmt.Sprintf(`{"entryId":%q,"creditedMinor":3000,"billBalanceMinor":7000}`, first.EntryID) {
		t.Fatalf("first credit JSON = %s", encoded)
	}
	var memo, sourceType, currency string
	var sourceID, reversalOfID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, reversal_of_id::text, currency
		FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, first.EntryID, fx.orgID).
		Scan(&memo, &sourceType, &sourceID, &reversalOfID, &currency); err != nil {
		t.Fatal(err)
	}
	if memo != "Supplier credit on bill 1: Damaged shipment" || sourceType != "vendor_credit_note" ||
		sourceID == nil || *sourceID != taxBillID || reversalOfID == nil || *reversalOfID != billEntryID || currency != "USD" {
		t.Fatalf("credit entry = memo=%q source=%s/%v reversalOf=%v currency=%s", memo, sourceType, sourceID, reversalOfID, currency)
	}
	lines := purchasingJournalLines(t, fx, first.EntryID)
	wantLines := []JournalEntryLineInput{
		{AccountCode: "2000", DebitMinor: 3_000},
		{AccountCode: "6000", CreditMinor: 2_430},
		{AccountCode: "1205", CreditMinor: 570},
	}
	assertPurchasingJournalLines(t, lines, wantLines)

	second := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (BillCreditNoteOutput, error) {
		return purchasingBillCreditNote(fx.ctx, tx, claims, BillCreditNoteInput{BillID: taxBillID, AmountMinor: 7_000, Reason: "Goodwill concession"}, now)
	})
	if !isUUID(second.EntryID) || second.CreditedMinor != 10_000 || second.BillBalanceMinor != 0 {
		t.Fatalf("second credit output = %+v, want credited 10000 and balance 0", second)
	}
	var secondReversalOfID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT reversal_of_id::text FROM journal_entries WHERE id = $1::uuid`, second.EntryID).Scan(&secondReversalOfID); err != nil {
		t.Fatal(err)
	}
	if secondReversalOfID != nil {
		t.Fatalf("second credit reversal_of_id = %v, want null after the first credit consumed the reversal link", *secondReversalOfID)
	}
	lines = purchasingJournalLines(t, fx, second.EntryID)
	wantLines = []JournalEntryLineInput{
		{AccountCode: "2000", DebitMinor: 7_000},
		{AccountCode: "6000", CreditMinor: 5_670},
		{AccountCode: "1205", CreditMinor: 1_330},
	}
	assertPurchasingJournalLines(t, lines, wantLines)

	var creditedMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT credited_minor FROM vendor_bills WHERE id = $1::uuid`, taxBillID).Scan(&creditedMinor); err != nil {
		t.Fatal(err)
	}
	if creditedMinor != 10_000 {
		t.Fatalf("credited_minor = %d, want 10000", creditedMinor)
	}
	lifecycleExpectError(t, fx, fx.orgID, "credit 100 exceeds the open balance 0 (total 10000 − paid 0 − credited 10000)", func(tx pgx.Tx) error {
		_, err := purchasingBillCreditNote(fx.ctx, tx, claims, BillCreditNoteInput{BillID: taxBillID, AmountMinor: 100, Reason: "One too many"}, now)
		return err
	})

	nonRecoverableBillID := seedLifecycleBill(t, fx, fx.orgID, vendorID, 3, "open", 5_000, 0, 0, nil)
	seedLifecycleBillLine(t, fx, nonRecoverableBillID, "Services", 1000, 4650, 350, &nonRecoverableTaxCodeID)
	nonRecoverable := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (BillCreditNoteOutput, error) {
		return purchasingBillCreditNote(fx.ctx, tx, claims, BillCreditNoteInput{BillID: nonRecoverableBillID, AmountMinor: 5_000, Reason: "Full concession"}, now)
	})
	lines = purchasingJournalLines(t, fx, nonRecoverable.EntryID)
	assertPurchasingJournalLines(t, lines, []JournalEntryLineInput{
		{AccountCode: "2000", DebitMinor: 5_000},
		{AccountCode: "6000", CreditMinor: 5_000},
	})

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

func TestPurchasingLifecycleCloseGuardsAndBackorderShortfall(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingLifecycleFixture(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	claims := purchasingBillsClaims(fx)

	itemID := seedSalesItem(t, fx, fx.orgID, "LIFECYCLE-PART", "goods")
	shortPOID := seedLifecyclePO(t, fx, fx.orgID, vendorID, "partial", 1)
	itemLineID := seedLifecyclePOLine(t, fx, shortPOID, "Steel part", 1, 10_000, 1450, &itemID, nil)
	seedLifecyclePOLine(t, fx, shortPOID, "Assembly service", 2, 5_000, 900, nil, lifecycleInt64(2_000))
	receiptID := seedLifecycleReceipt(t, fx, fx.orgID, shortPOID, 1, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), nil)
	seedLifecycleReceiptLine(t, fx, fx.orgID, receiptID, itemLineID, 1, 4_000, 500, 1_500, lifecycleString("damaged cartons"))
	seedLifecycleLegacyMovement(t, fx, fx.orgID, itemID, 1_000, &itemLineID)

	fullPOID := seedLifecyclePO(t, fx, fx.orgID, vendorID, "received", 2)
	seedLifecyclePOLine(t, fx, fullPOID, "Complete set", 1, 4_000, 700, nil, lifecycleInt64(4_000))

	seedLifecyclePO(t, fx, fx.orgID, vendorID, "void", 3)
	seedLifecyclePO(t, fx, fx.otherOrgID, foreignVendorID, "ordered", 50)

	lifecycleExpectError(t, fx, fx.orgID, "purchase order not found", func(tx pgx.Tx) error {
		_, err := closePurchaseOrder(fx.ctx, tx, claims, ClosePurchaseOrderInput{PONumber: 99})
		return err
	})
	lifecycleExpectError(t, fx, fx.otherOrgID, "purchase order not found", func(tx pgx.Tx) error {
		_, err := closePurchaseOrder(fx.ctx, tx, claims, ClosePurchaseOrderInput{PONumber: 50})
		return err
	})
	lifecycleExpectError(t, fx, fx.orgID, "order is void", func(tx pgx.Tx) error {
		_, err := closePurchaseOrder(fx.ctx, tx, claims, ClosePurchaseOrderInput{PONumber: 3})
		return err
	})

	closed := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ClosePurchaseOrderOutput, error) {
		return closePurchaseOrder(fx.ctx, tx, claims, ClosePurchaseOrderInput{PONumber: 1})
	})
	if !closed.Closed || !closed.Backordered || closed.ShortThousandths != 9_000 {
		t.Fatalf("close output = %+v, want closed with 9000 thousandths short", closed)
	}
	if encoded, err := marshalJS(closed); err != nil || string(encoded) != `{"closed":true,"backordered":true,"shortThousandths":9000}` {
		t.Fatalf("close output JSON = %s, %v", encoded, err)
	}
	var status string
	var backordered bool
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, backordered FROM purchase_orders WHERE id = $1::uuid`, shortPOID).Scan(&status, &backordered); err != nil {
		t.Fatal(err)
	}
	if status != "closed" || !backordered {
		t.Fatalf("short order after close = %s backordered=%v, want closed backordered", status, backordered)
	}
	lifecycleExpectError(t, fx, fx.orgID, "order is already closed", func(tx pgx.Tx) error {
		_, err := closePurchaseOrder(fx.ctx, tx, claims, ClosePurchaseOrderInput{PONumber: 1})
		return err
	})

	fully := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ClosePurchaseOrderOutput, error) {
		return closePurchaseOrder(fx.ctx, tx, claims, ClosePurchaseOrderInput{PONumber: 2})
	})
	if !fully.Closed || fully.Backordered || fully.ShortThousandths != 0 {
		t.Fatalf("full close output = %+v, want closed without backorder", fully)
	}
	if encoded, err := marshalJS(fully); err != nil || string(encoded) != `{"closed":true,"backordered":false,"shortThousandths":0}` {
		t.Fatalf("full close output JSON = %s, %v", encoded, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, backordered FROM purchase_orders WHERE id = $1::uuid`, fullPOID).Scan(&status, &backordered); err != nil {
		t.Fatal(err)
	}
	if status != "closed" || backordered {
		t.Fatalf("full order after close = %s backordered=%v, want closed not backordered", status, backordered)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id = $1::uuid AND status = 'closed'`, fx.orgID); got != 2 {
		t.Fatalf("closed orders = %d, want 2", got)
	}
}

func TestPurchasingLifecycleListReceiptsShapesReceiptHistory(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingLifecycleFixture(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	seedPurchasingVendor(t, fx, fx.otherOrgID, nil)

	itemID := seedSalesItem(t, fx, fx.orgID, "LIFECYCLE-ROD", "goods")
	receiptPOID := seedLifecyclePO(t, fx, fx.orgID, vendorID, "partial", 1)
	rodLineID := seedLifecyclePOLine(t, fx, receiptPOID, "Steel rod", 1, 10_000, 1450, &itemID, nil)
	serviceLineID := seedLifecyclePOLine(t, fx, receiptPOID, "Assembly service", 2, 5_000, 900, nil, nil)

	firstReceiptID := seedLifecycleReceipt(t, fx, fx.orgID, receiptPOID, 1, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), lifecycleString("First delivery"))
	seedLifecycleReceiptLine(t, fx, fx.orgID, firstReceiptID, rodLineID, 1, 4_000, 1_000, 0, lifecycleString("damaged cartons"))
	secondReceiptID := seedLifecycleReceipt(t, fx, fx.orgID, receiptPOID, 2, time.Date(2026, 9, 23, 10, 30, 0, 0, time.UTC), nil)
	seedLifecycleReceiptLine(t, fx, fx.orgID, secondReceiptID, rodLineID, 1, 3_000, 0, 500, nil)
	seedLifecycleReceiptLine(t, fx, fx.orgID, secondReceiptID, serviceLineID, 2, 2_000, 0, 0, nil)

	lifecycleExpectError(t, fx, fx.orgID, "purchase order not found", func(tx pgx.Tx) error {
		_, err := listReceipts(fx.ctx, tx, fx.orgID, ListReceiptsInput{PONumber: 42})
		return err
	})
	lifecycleExpectError(t, fx, fx.otherOrgID, "purchase order not found", func(tx pgx.Tx) error {
		_, err := listReceipts(fx.ctx, tx, fx.otherOrgID, ListReceiptsInput{PONumber: 1})
		return err
	})

	shown := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ListReceiptsOutput, error) {
		return listReceipts(fx.ctx, tx, fx.orgID, ListReceiptsInput{PONumber: 1})
	})
	if encoded, err := marshalJS(shown); err != nil {
		t.Fatal(err)
	} else if want := `{"receipts":[{"number":1,"receivedAt":"2026-09-22T09:00:00.000Z","note":"First delivery","lines":[{"position":1,"description":"Steel rod","acceptedThousandths":4000,"rejectedThousandths":1000,"returnedThousandths":0,"rejectionNote":"damaged cartons"}]},{"number":2,"receivedAt":"2026-09-23T10:30:00.000Z","note":null,"lines":[{"position":1,"description":"Steel rod","acceptedThousandths":3000,"rejectedThousandths":0,"returnedThousandths":500,"rejectionNote":null},{"position":2,"description":"Assembly service","acceptedThousandths":2000,"rejectedThousandths":0,"returnedThousandths":0,"rejectionNote":null}]}],"orderLines":[{"position":1,"description":"Steel rod","orderedThousandths":10000,"acceptedThousandths":7000,"rejectedThousandths":1000,"returnedThousandths":500,"remainingThousandths":2000},{"position":2,"description":"Assembly service","orderedThousandths":5000,"acceptedThousandths":2000,"rejectedThousandths":0,"returnedThousandths":0,"remainingThousandths":3000}]}`; string(encoded) != want {
		t.Fatalf("receipt history JSON = %s, want %s", encoded, want)
	}

	emptyPOID := seedLifecyclePO(t, fx, fx.orgID, vendorID, "ordered", 3)
	seedLifecyclePOLine(t, fx, emptyPOID, "Setup", 1, 4_000, 500, nil, nil)
	empty := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ListReceiptsOutput, error) {
		return listReceipts(fx.ctx, tx, fx.orgID, ListReceiptsInput{PONumber: 3})
	})
	if encoded, err := marshalJS(empty); err != nil {
		t.Fatal(err)
	} else if want := `{"receipts":[],"orderLines":[{"position":1,"description":"Setup","orderedThousandths":4000,"acceptedThousandths":0,"rejectedThousandths":0,"returnedThousandths":0,"remainingThousandths":4000}]}`; string(encoded) != want {
		t.Fatalf("empty receipt history JSON = %s, want %s", encoded, want)
	}
}

func lifecycleInt64(value int64) *int64 { return &value }

func lifecycleString(value string) *string { return &value }
