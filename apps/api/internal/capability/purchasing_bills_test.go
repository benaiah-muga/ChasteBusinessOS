package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestPurchasingBillsParsersMirrorZodContracts(t *testing.T) {
	vendorUUID := "11111111-1111-4111-8111-111111111111"
	line := `{"description":"Freight","quantity":1000,"unitPriceMinor":2500}`
	created, err := ParseCreateVendorInput(json.RawMessage(`{"name":"Acme Parts","email":"ap@acme.test","paymentTermDays":30,"unknown":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "Acme Parts" || created.Email == nil || *created.Email != "ap@acme.test" || created.PaymentTermDays == nil || *created.PaymentTermDays != 30 {
		t.Fatalf("ParseCreateVendorInput() = %+v, want name, email, and 30 day terms", created)
	}
	if encoded, err := marshalJS(created); err != nil || string(encoded) != `{"name":"Acme Parts","email":"ap@acme.test","paymentTermDays":30}` {
		t.Fatalf("ParseCreateVendorInput() JSON = %s, %v", encoded, err)
	}
	minimal, err := ParseCreateVendorInput(json.RawMessage(`{"name":"Bare vendor"}`))
	if err != nil || minimal.Email != nil || minimal.PaymentTermDays != nil {
		t.Fatalf("minimal createVendor input=%+v err=%v, want absent optionals", minimal, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"name":""}`,
		`{"name":null}`,
		`{"name":5}`,
		`{"name":"V","email":"not-an-email"}`,
		`{"name":"V","email":null}`,
		`{"name":"V","paymentTermDays":0}`,
		`{"name":"V","paymentTermDays":-5}`,
		`{"name":"V","paymentTermDays":366}`,
		`{"name":"V","paymentTermDays":1.5}`,
		`{"name":"V","paymentTermDays":null}`,
	} {
		if _, err := ParseCreateVendorInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateVendorInput accepted %s", raw)
		}
	}

	billRaw := `{"vendorId":"` + vendorUUID + `","vendorRef":"SUP-77","memo":"August invoice","poNumber":3,"lines":[{"description":"Freight","quantity":1000,"unitPriceMinor":2500,"expenseAccountCode":"6100","taxMinor":100,"poLineNumber":2}]}`
	bill, err := ParseCreateBillInput(json.RawMessage(billRaw))
	if err != nil {
		t.Fatal(err)
	}
	wantLine := CreateBillLineInput{Description: "Freight", Quantity: 1000, UnitPriceMinor: 2500, ExpenseAccountCode: "6100", TaxMinor: crmInt64Pointer(100), POLineNumber: crmInt64Pointer(2)}
	if bill.VendorID != vendorUUID || bill.VendorRef == nil || *bill.VendorRef != "SUP-77" || bill.Memo == nil || *bill.Memo != "August invoice" ||
		bill.PONumber == nil || *bill.PONumber != 3 || len(bill.Lines) != 1 ||
		bill.Lines[0].Description != wantLine.Description || bill.Lines[0].Quantity != wantLine.Quantity ||
		bill.Lines[0].UnitPriceMinor != wantLine.UnitPriceMinor || bill.Lines[0].ExpenseAccountCode != wantLine.ExpenseAccountCode ||
		bill.Lines[0].TaxMinor == nil || *bill.Lines[0].TaxMinor != *wantLine.TaxMinor ||
		bill.Lines[0].POLineNumber == nil || *bill.Lines[0].POLineNumber != *wantLine.POLineNumber {
		t.Fatalf("ParseCreateBillInput() = %+v, want full bill payload", bill)
	}
	defaulted, err := ParseCreateBillInput(json.RawMessage(`{"vendorId":"` + vendorUUID + `","lines":[{"description":"Desk","quantity":2000,"unitPriceMinor":1}]}`))
	if err != nil || defaulted.VendorRef != nil || defaulted.Memo != nil || defaulted.PONumber != nil ||
		defaulted.Lines[0].ExpenseAccountCode != "6000" || defaulted.Lines[0].TaxMinor != nil || defaulted.Lines[0].TaxCodeID != nil || defaulted.Lines[0].POLineNumber != nil {
		t.Fatalf("defaulted createBill input=%+v err=%v, want expense 6000 default and absent optionals", defaulted, err)
	}
	stringVendorID, err := ParseCreateBillInput(json.RawMessage(`{"vendorId":"vendor-key","lines":[{"description":"Desk","quantity":2000,"unitPriceMinor":1}]}`))
	if err != nil || stringVendorID.VendorID != "vendor-key" {
		t.Fatalf("ParseCreateBillInput vendorId = %+v, %v, want the legacy z.string() contract", stringVendorID, err)
	}
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"vendorId":null,"lines":[` + line + `]}`,
		`{"vendorId":"` + vendorUUID + `"}`,
		`{"vendorId":"` + vendorUUID + `","lines":[]}`,
		`{"vendorId":"` + vendorUUID + `","lines":null}`,
		`{"vendorId":"` + vendorUUID + `","lines":["x"]}`,
		`{"vendorId":"` + vendorUUID + `","poNumber":0,"lines":[` + line + `]}`,
		`{"vendorId":"` + vendorUUID + `","poNumber":2.5,"lines":[` + line + `]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"quantity":1000,"unitPriceMinor":1}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"","quantity":1000,"unitPriceMinor":1}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":0,"unitPriceMinor":1}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000.5,"unitPriceMinor":1}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":-1}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"expenseAccountCode":"600"}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"expenseAccountCode":"60000"}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"expenseAccountCode":"abcd"}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"expenseAccountCode":null}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxMinor":-5}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxCodeId":"nope"}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxCodeId":"` + vendorUUID + `","taxMinor":5}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"poLineNumber":0}]}`,
		`{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"poLineNumber":-3}]}`,
	} {
		if _, err := ParseCreateBillInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateBillInput accepted %s", raw)
		}
	}

	paid, err := ParsePayBillInput(json.RawMessage(`{"billNumber":4,"amountMinor":900,"method":"cash","unknown":1}`))
	if err != nil || paid.BillNumber != 4 || paid.AmountMinor != 900 || paid.Method != "cash" {
		t.Fatalf("ParsePayBillInput() = %+v, %v", paid, err)
	}
	defaultedPay, err := ParsePayBillInput(json.RawMessage(`{"billNumber":4,"amountMinor":900}`))
	if err != nil || defaultedPay.Method != "bank_transfer" {
		t.Fatalf("ParsePayBillInput default method = %+v, %v, want bank_transfer", defaultedPay, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"billNumber":0,"amountMinor":1}`,
		`{"billNumber":-2,"amountMinor":1}`,
		`{"billNumber":1.5,"amountMinor":1}`,
		`{"billNumber":1}`,
		`{"billNumber":1,"amountMinor":0}`,
		`{"billNumber":1,"amountMinor":-9}`,
		`{"billNumber":1,"amountMinor":2.5}`,
		`{"billNumber":1,"amountMinor":1,"method":"wire"}`,
		`{"billNumber":1,"amountMinor":1,"method":null}`,
		`{"billNumber":1,"amountMinor":1,"method":"CASH"}`,
	} {
		if _, err := ParsePayBillInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePayBillInput accepted %s", raw)
		}
	}

	astral := "a\U0001F600"
	if utf16.RuneLen('\U0001F600') != 2 {
		t.Fatalf("test setup: astral rune must be two UTF-16 units")
	}
	reversed, err := ParseReverseVendorPaymentInput(json.RawMessage(`{"vendorPaymentId":"` + vendorUUID + `","reason":"` + astral + `","unknown":true}`))
	if err != nil || reversed.VendorPaymentID != vendorUUID || reversed.Reason != astral {
		t.Fatalf("ParseReverseVendorPaymentInput() = %+v, %v, want utf16 length 3 accepted", reversed, err)
	}
	if _, err := ParseReverseVendorPaymentInput(json.RawMessage(`{"vendorPaymentId":"` + vendorUUID + `","reason":"` + strings.Repeat("x", 500) + `"` + `}`)); err != nil {
		t.Fatalf("ParseReverseVendorPaymentInput(500 chars) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`{}`,
		`{"vendorPaymentId":"nope","reason":"valid reason"}`,
		`{"vendorPaymentId":"` + vendorUUID + `"}`,
		`{"vendorPaymentId":"` + vendorUUID + `","reason":"ab"}`,
		`{"vendorPaymentId":"` + vendorUUID + `","reason":"` + strings.Repeat("x", 501) + `"}`,
		`{"vendorPaymentId":"` + vendorUUID + `","reason":null}`,
		`{"vendorPaymentId":null,"reason":"valid reason"}`,
	} {
		if _, err := ParseReverseVendorPaymentInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseReverseVendorPaymentInput accepted %s", raw)
		}
	}
	if _, err := parsePurchasingBillInput("purchasing.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported purchasing bill capability" {
		t.Fatalf("parsePurchasingBillInput(unknown) err = %v, want dispatcher refusal", err)
	}
	for capabilityID, raw := range map[string]string{
		createVendorCapabilityID:         `{"name":"Dispatcher vendor"}`,
		createBillCapabilityID:           `{"vendorId":"` + vendorUUID + `","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1}]}`,
		payBillCapabilityID:              `{"billNumber":1,"amountMinor":5}`,
		reverseVendorPaymentCapabilityID: `{"vendorPaymentId":"` + vendorUUID + `","reason":"undo it"}`,
	} {
		if _, err := parsePurchasingBillInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parsePurchasingBillInput(%s) err = %v", capabilityID, err)
		}
	}
}

func purchasingBillsClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func seedPurchasingVendor(t *testing.T, fx *executorFixture, orgID string, paymentTermDays *int64) string {
	t.Helper()
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name, payment_term_days)
		VALUES ($1::uuid, 'Purchasing fixture vendor', $2)
		RETURNING id::text`, orgID, paymentTermDays).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	return vendorID
}

func seedPurchasingAccounts(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash', 'asset'),
		($1::uuid, '1205', 'Input Tax Recoverable', 'asset'),
		($1::uuid, '2000', 'Accounts Payable', 'liability'),
		($1::uuid, '6000', 'Operating Expenses', 'expense')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func seedPurchasingTaxProfile(t *testing.T, fx *executorFixture, orgID, jurisdiction string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO tax_profiles (org_id, jurisdiction_code) VALUES ($1::uuid, $2)`, orgID, jurisdiction); err != nil {
		t.Fatal(err)
	}
}

func seedPurchasingTaxCode(t *testing.T, fx *executorFixture, orgID, jurisdiction, code, direction string, rateBasisPoints int64, priceIncludesTax, recoverable, active bool) string {
	t.Helper()
	var taxCodeID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tax_codes (org_id, jurisdiction_code, code, name, direction, rate_basis_points, price_includes_tax, recoverable, asset_account_code, active)
		VALUES ($1::uuid, $2, $3, $3, $4, $5, $6, $7, '1205', $8)
		RETURNING id::text`, orgID, jurisdiction, code, direction, rateBasisPoints, priceIncludesTax, recoverable, active).Scan(&taxCodeID); err != nil {
		t.Fatal(err)
	}
	return taxCodeID
}

func seedPurchasingPO(t *testing.T, fx *executorFixture, orgID, vendorID string, number int64) string {
	t.Helper()
	var poID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, ordered_at)
		VALUES ($1::uuid, $2::uuid, $3, 'ordered', $4)
		RETURNING id::text`, orgID, vendorID, number, time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)).Scan(&poID); err != nil {
		t.Fatal(err)
	}
	return poID
}

func seedPurchasingPOLine(t *testing.T, fx *executorFixture, poID, description string, position, quantity, unitPriceMinor int64) string {
	t.Helper()
	var poLineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, position)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING id::text`, poID, description, quantity, unitPriceMinor, position).Scan(&poLineID); err != nil {
		t.Fatal(err)
	}
	return poLineID
}

func seedPurchasingReceiptLine(t *testing.T, fx *executorFixture, orgID, poID, poLineID string, accepted, returned int64) {
	t.Helper()
	var receiptID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO goods_receipts (org_id, po_id, number, received_at, received_by_actor_type)
		VALUES ($1::uuid, $2::uuid, (SELECT COALESCE(MAX(number), 0) + 1 FROM goods_receipts WHERE org_id = $1::uuid), $3, 'human')
		RETURNING id::text`, orgID, poID, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC)).Scan(&receiptID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, returned_thousandths)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, $5)`, orgID, receiptID, poLineID, accepted, returned); err != nil {
		t.Fatal(err)
	}
}

func seedPurchasingBill(t *testing.T, fx *executorFixture, orgID, vendorID string, number int64, status string, totalMinor, paidMinor, creditedMinor int64) string {
	t.Helper()
	var billID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, paid_minor, credited_minor, bill_date)
		VALUES ($1::uuid, $2::uuid, $3, $4, 'USD', $5, $6, $7, $8)
		RETURNING id::text`, orgID, vendorID, number, status, totalMinor, paidMinor, creditedMinor,
		time.Date(2026, 9, 21, 8, 0, 0, 0, time.UTC)).Scan(&billID); err != nil {
		t.Fatal(err)
	}
	return billID
}

func seedPurchasingBillLine(t *testing.T, fx *executorFixture, billID, description string, quantity, unitPriceMinor int64, poLineID *string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bill_lines (bill_id, description, quantity, unit_price_minor, po_line_id)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid)`, billID, description, quantity, unitPriceMinor, poLineID); err != nil {
		t.Fatal(err)
	}
}

func seedPurchasingPayment(t *testing.T, fx *executorFixture, orgID, billID string, amountMinor int64, status string, entryID, paymentRunID *string) string {
	t.Helper()
	var paymentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_payments (org_id, bill_id, amount_minor, method, entry_id, payment_run_id, status, paid_at)
		VALUES ($1::uuid, $2::uuid, $3, 'bank_transfer', $4::uuid, $5::uuid, $6, $7)
		RETURNING id::text`, orgID, billID, amountMinor, entryID, paymentRunID, status,
		time.Date(2026, 9, 23, 8, 0, 0, 0, time.UTC)).Scan(&paymentID); err != nil {
		t.Fatal(err)
	}
	return paymentID
}

func seedPurchasingPaymentRun(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var runID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payment_runs (org_id, reference, currency, total_minor, created_by_actor_type)
		VALUES ($1::uuid, $2, 'USD', 1000, 'human')
		RETURNING id::text`, orgID, "PR-FIXTURE-"+orgID[:8]).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	return runID
}

func purchasingJournalLines(t *testing.T, fx *executorFixture, entryID string) []JournalEntryLineInput {
	t.Helper()
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl
		JOIN accounts a ON a.id = jl.account_id
		WHERE jl.entry_id = $1::uuid
		ORDER BY jl.id`, entryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	lines := make([]JournalEntryLineInput, 0, 4)
	for rows.Next() {
		var line JournalEntryLineInput
		if err := rows.Scan(&line.AccountCode, &line.DebitMinor, &line.CreditMinor); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

func assertPurchasingJournalLines(t *testing.T, got, want []JournalEntryLineInput) {
	t.Helper()
	counts := make(map[JournalEntryLineInput]int, len(got))
	for _, line := range got {
		counts[line]++
	}
	for _, line := range want {
		if counts[line] == 0 {
			t.Fatalf("journal lines %v are missing %+v", got, line)
		}
		counts[line]--
	}
	for line, count := range counts {
		if count != 0 {
			t.Fatalf("journal lines contain unexpected entry %+v", line)
		}
	}
}

func cleanupPurchasingBillsFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin purchasing fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable purchasing fixture ledger cleanup: %v", err)
			return
		}
		for orgID := range map[string]struct{}{fx.orgID: {}, fx.otherOrgID: {}} {
			steps := []string{
				`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = $1::uuid)`,
				`DELETE FROM journal_entries WHERE org_id = $1::uuid`,
				`DELETE FROM vendor_payments WHERE org_id = $1::uuid`,
				`DELETE FROM payment_runs WHERE org_id = $1::uuid`,
				`DELETE FROM vendor_bill_lines WHERE bill_id IN (SELECT id FROM vendor_bills WHERE org_id = $1::uuid)`,
				`DELETE FROM vendor_bills WHERE org_id = $1::uuid`,
				`DELETE FROM goods_receipt_lines WHERE org_id = $1::uuid`,
				`DELETE FROM goods_receipts WHERE org_id = $1::uuid`,
				`DELETE FROM po_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE org_id = $1::uuid)`,
				`DELETE FROM purchase_orders WHERE org_id = $1::uuid`,
				`DELETE FROM tax_codes WHERE org_id = $1::uuid`,
				`DELETE FROM tax_profiles WHERE org_id = $1::uuid`,
				`DELETE FROM doc_counters WHERE org_id = $1::uuid`,
				`DELETE FROM vendors WHERE org_id = $1::uuid`,
			}
			for _, step := range steps {
				if _, err := tx.Exec(fx.ctx, step, orgID); err != nil {
					t.Errorf("purchasing fixture cleanup step failed: %v", err)
					return
				}
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit purchasing fixture cleanup: %v", err)
		}
	})
}

func TestPurchasingBillsCreateVendorPersistsDefaultsAndTerms(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateVendorOutput, error) {
		return createVendor(fx.ctx, tx, fx.orgID, CreateVendorInput{Name: "Acme Parts"})
	})
	if err != nil {
		t.Fatalf("createVendor: %v", err)
	}
	if !isUUID(created.VendorID) {
		t.Fatalf("createVendor output = %+v, want a vendor id", created)
	}
	encoded, err := marshalJS(created)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != fmt.Sprintf(`{"vendorId":%q}`, created.VendorID) {
		t.Fatalf("createVendor output JSON = %s", encoded)
	}
	var name string
	var email *string
	var term *int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT name, email, payment_term_days FROM vendors WHERE id = $1::uuid AND org_id = $2::uuid`,
		created.VendorID, fx.orgID).Scan(&name, &email, &term); err != nil {
		t.Fatal(err)
	}
	if name != "Acme Parts" || email != nil || term != nil {
		t.Fatalf("stored vendor = %q email=%v term=%v, want defaults", name, email, term)
	}

	detailed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateVendorOutput, error) {
		return createVendor(fx.ctx, tx, fx.orgID, CreateVendorInput{Name: "Detailed Supplier", Email: crmStringPointer("ap@detailed.test"), PaymentTermDays: crmInt64Pointer(30)})
	})
	if err != nil {
		t.Fatalf("createVendor detailed: %v", err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name, email, payment_term_days FROM vendors WHERE id = $1::uuid`, detailed.VendorID).Scan(&name, &email, &term); err != nil {
		t.Fatal(err)
	}
	if name != "Detailed Supplier" || email == nil || *email != "ap@detailed.test" || term == nil || *term != 30 {
		t.Fatalf("stored detailed vendor = %q email=%v term=%v", name, email, term)
	}
}

func TestPurchasingBillsCreateBillPostsPayableEntryAndLines(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, crmInt64Pointer(15))
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: foreignVendorID,
			Lines:    []CreateBillLineInput{{Description: "Nope", Quantity: 1000, UnitPriceMinor: 100}},
		}, now)
	}); err == nil || err.Error() != "vendor not found" {
		t.Fatalf("createBill for foreign vendor error = %v, want vendor not found", err)
	}

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID:  vendorID,
			VendorRef: crmStringPointer("SUP-77"),
			Lines: []CreateBillLineInput{
				{Description: "Manual tax goods", Quantity: 1_000, UnitPriceMinor: 500_000, TaxMinor: crmInt64Pointer(25_000)},
				{Description: "Rounded goods", Quantity: 1_500, UnitPriceMinor: 999},
			},
		}, now)
	})
	if err != nil {
		t.Fatalf("createBill: %v", err)
	}
	if created.BillNumber != 1 || created.TotalMinor != 526_499 || !isUUID(created.EntryID) {
		t.Fatalf("createBill output = %+v, want bill 1 totaling 526499", created)
	}
	var status, currency, memo, vendorRef, entryID string
	var number, total int64
	var dueAt, billDate time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT number, status, currency, total_minor, COALESCE(memo, ''), vendor_ref, due_at, bill_date, entry_id::text
		FROM vendor_bills WHERE id IN (SELECT id FROM vendor_bills WHERE org_id = $1::uuid AND number = $2)`,
		fx.orgID, created.BillNumber).Scan(&number, &status, &currency, &total, &memo, &vendorRef, &dueAt, &billDate, &entryID); err != nil {
		t.Fatal(err)
	}
	if number != 1 || status != "open" || currency != "USD" || total != 526_499 ||
		memo != "" || vendorRef != "SUP-77" ||
		!dueAt.Equal(now.AddDate(0, 0, 15)) || !billDate.Equal(now) || entryID != created.EntryID {
		t.Fatalf("stored bill = #%d %s %s total=%d memo=%q ref=%q due=%v date=%v entry=%s",
			number, status, currency, total, memo, vendorRef, dueAt, billDate, entryID)
	}
	var journalMemo string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT memo FROM journal_entries WHERE id = $1::uuid`, created.EntryID).Scan(&journalMemo); err != nil {
		t.Fatal(err)
	}
	if journalMemo != "Vendor bill 1 (SUP-77)" {
		t.Fatalf("bill journal memo = %q, want vendor reference in posting memo", journalMemo)
	}
	lines := purchasingJournalLines(t, fx, created.EntryID)
	wantLines := []JournalEntryLineInput{
		{AccountCode: "6000", DebitMinor: 500_000},
		{AccountCode: "6000", DebitMinor: 1_499},
		{AccountCode: "1205", DebitMinor: 25_000},
		{AccountCode: "2000", CreditMinor: 526_499},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("bill journal lines = %+v, want %+v", lines, wantLines)
	}
	for _, want := range wantLines {
		found := false
		for i, got := range lines {
			if got == want {
				lines = append(lines[:i], lines[i+1:]...)
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("bill journal lines are missing %+v", want)
		}
	}
	type storedLine struct {
		description string
		quantity    int64
		unitPrice   int64
		tax         int64
		poLineID    *string
		taxCodeID   *string
		rate        *int64
		includes    bool
	}
	lineRows, err := fx.owner.Query(fx.ctx, `
		SELECT description, quantity, unit_price_minor, tax_minor, po_line_id::text, tax_code_id::text, tax_rate_basis_points, price_includes_tax
		FROM vendor_bill_lines WHERE bill_id IN (SELECT id FROM vendor_bills WHERE org_id = $1::uuid AND number = 1)
		ORDER BY description`, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	stored := make([]storedLine, 0, 2)
	for lineRows.Next() {
		var line storedLine
		if err := lineRows.Scan(&line.description, &line.quantity, &line.unitPrice, &line.tax, &line.poLineID, &line.taxCodeID, &line.rate, &line.includes); err != nil {
			lineRows.Close()
			t.Fatal(err)
		}
		stored = append(stored, line)
	}
	if err := lineRows.Err(); err != nil {
		lineRows.Close()
		t.Fatal(err)
	}
	lineRows.Close()
	if len(stored) != 2 ||
		stored[0] != (storedLine{"Manual tax goods", 1_000, 500_000, 25_000, nil, nil, nil, false}) ||
		stored[1] != (storedLine{"Rounded goods", 1_500, 999, 0, nil, nil, nil, false}) {
		t.Fatalf("stored bill lines = %+v, want manual tax and rounded lines", stored)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: vendorID,
			Lines:    []CreateBillLineInput{{Description: "Bare goods", Quantity: 2_000, UnitPriceMinor: 100_000}},
		}, now)
	})
	if err != nil {
		t.Fatalf("second createBill: %v", err)
	}
	if second.BillNumber != 2 || second.TotalMinor != 200_000 {
		t.Fatalf("second createBill output = %+v, want bill 2 totaling 200000", second)
	}
	var secondMemo *string
	var secondRef *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT memo, vendor_ref FROM vendor_bills WHERE number = 2 AND org_id = $1::uuid`, fx.orgID).Scan(&secondMemo, &secondRef); err != nil {
		t.Fatal(err)
	}
	if secondMemo != nil || secondRef != nil {
		t.Fatalf("second bill memo=%v ref=%v, want null defaults", secondMemo, secondRef)
	}
	if got := fx.count(`SELECT "next" FROM doc_counters WHERE org_id = $1::uuid AND kind = 'vendor_bill'`, fx.orgID); got != 2 {
		t.Fatalf("vendor_bill counter = %d, want sequence resting at 2", got)
	}
}

func TestPurchasingBillsCreateBillResolvesTaxCodes(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	unknownTaxCodeID := executorUUID(t)

	noProfileInput := CreateBillInput{
		VendorID: vendorID,
		Lines:    []CreateBillLineInput{{Description: "Taxed", Quantity: 1_000, UnitPriceMinor: 100_000, TaxCodeID: &unknownTaxCodeID}},
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, noProfileInput, now)
	}); err == nil || err.Error() != "set the organization tax jurisdiction before using tax codes" {
		t.Fatalf("createBill without tax profile error = %v, want jurisdiction prerequisite", err)
	}

	seedPurchasingTaxProfile(t, fx, fx.orgID, "US")
	outputCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "US", "OUTPUT1", "output", 850, false, true, true)
	foreignCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "DE", "FOREIGN1", "input", 1_900, false, true, true)
	inactiveCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "US", "OLD1", "input", 850, false, true, false)
	inputCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "US", "VATIN", "input", 850, false, true, true)
	inclusiveCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "US", "VATINC", "input", 850, true, true, true)
	grossCodeID := seedPurchasingTaxCode(t, fx, fx.orgID, "US", "PENAL", "input", 850, false, false, true)

	cases := []struct {
		name    string
		taxCode string
		wantErr string
	}{
		{name: "unknown code", taxCode: unknownTaxCodeID, wantErr: "tax code not found or inactive"},
		{name: "inactive code", taxCode: inactiveCodeID, wantErr: "tax code not found or inactive"},
		{name: "foreign jurisdiction", taxCode: foreignCodeID, wantErr: "tax code jurisdiction does not match the organization tax profile"},
		{name: "output direction", taxCode: outputCodeID, wantErr: "tax code OUTPUT1 is configured for output tax"},
	}
	for _, testCase := range cases {
		taxCodeID := testCase.taxCode
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
			return createBill(fx.ctx, tx, claims, CreateBillInput{
				VendorID: vendorID,
				Lines:    []CreateBillLineInput{{Description: "Taxed", Quantity: 1_000, UnitPriceMinor: 100_000, TaxCodeID: &taxCodeID}},
			}, now)
		})
		if err == nil || err.Error() != testCase.wantErr {
			t.Fatalf("createBill %s error = %v, want %q", testCase.name, err, testCase.wantErr)
		}
	}
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("rejected tax bills stored %d rows, want 0", got)
	}

	taxed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: vendorID,
			Lines:    []CreateBillLineInput{{Description: "Taxed", Quantity: 1_000, UnitPriceMinor: 100_000, TaxCodeID: &inputCodeID}},
		}, now)
	})
	if err != nil {
		t.Fatalf("createBill with input tax code: %v", err)
	}
	if taxed.BillNumber != 1 || taxed.TotalMinor != 108_500 {
		t.Fatalf("taxed createBill output = %+v, want bill 1 totaling 108500", taxed)
	}
	lines := purchasingJournalLines(t, fx, taxed.EntryID)
	wantLines := []JournalEntryLineInput{
		{AccountCode: "6000", DebitMinor: 100_000},
		{AccountCode: "1205", DebitMinor: 8_500},
		{AccountCode: "2000", CreditMinor: 108_500},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("taxed bill journal lines = %+v, want %+v", lines, wantLines)
	}
	assertPurchasingJournalLines(t, lines, wantLines)
	var storedCodeID *string
	var storedRate *int64
	var storedIncludes bool
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT tax_code_id::text, tax_rate_basis_points, price_includes_tax
		FROM vendor_bill_lines WHERE bill_id IN (SELECT id FROM vendor_bills WHERE org_id = $1::uuid AND number = 1)`,
		fx.orgID).Scan(&storedCodeID, &storedRate, &storedIncludes); err != nil {
		t.Fatal(err)
	}
	if storedCodeID == nil || *storedCodeID != inputCodeID || storedRate == nil || *storedRate != 850 || storedIncludes {
		t.Fatalf("taxed bill line snapshot = code=%v rate=%v includes=%v", storedCodeID, storedRate, storedIncludes)
	}

	inclusive, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: vendorID,
			Lines:    []CreateBillLineInput{{Description: "Inclusive", Quantity: 1_000, UnitPriceMinor: 108_500, TaxCodeID: &inclusiveCodeID}},
		}, now)
	})
	if err != nil {
		t.Fatalf("createBill with inclusive tax code: %v", err)
	}
	if inclusive.TotalMinor != 108_500 {
		t.Fatalf("inclusive bill total = %d, want 108500", inclusive.TotalMinor)
	}
	lines = purchasingJournalLines(t, fx, inclusive.EntryID)
	wantLines = []JournalEntryLineInput{
		{AccountCode: "6000", DebitMinor: 100_000},
		{AccountCode: "1205", DebitMinor: 8_500},
		{AccountCode: "2000", CreditMinor: 108_500},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("inclusive bill journal lines = %+v, want %+v", lines, wantLines)
	}
	assertPurchasingJournalLines(t, lines, wantLines)
	var inclusiveIncludes bool
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT price_includes_tax FROM vendor_bill_lines
		WHERE bill_id IN (SELECT id FROM vendor_bills WHERE org_id = $1::uuid AND number = 2)`,
		fx.orgID).Scan(&inclusiveIncludes); err != nil {
		t.Fatal(err)
	}
	if !inclusiveIncludes {
		t.Fatalf("inclusive bill line price_includes_tax = false, want true")
	}

	grossed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: vendorID,
			Lines:    []CreateBillLineInput{{Description: "Nonrecoverable", Quantity: 1_000, UnitPriceMinor: 100_000, TaxCodeID: &grossCodeID}},
		}, now)
	})
	if err != nil {
		t.Fatalf("createBill with nonrecoverable tax code: %v", err)
	}
	lines = purchasingJournalLines(t, fx, grossed.EntryID)
	wantLines = []JournalEntryLineInput{
		{AccountCode: "6000", DebitMinor: 108_500},
		{AccountCode: "2000", CreditMinor: 108_500},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("nonrecoverable bill journal lines = %+v, want expense at gross and no input tax asset", lines)
	}
	assertPurchasingJournalLines(t, lines, wantLines)
	if got := fx.count(`SELECT "next" FROM doc_counters WHERE org_id = $1::uuid AND kind = 'vendor_bill'`, fx.orgID); got != 3 {
		t.Fatalf("vendor_bill counter = %d, want sequence resting at 3", got)
	}
}

func TestPurchasingBillsCreateBillThreeWayMatchGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	otherVendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

	poID := seedPurchasingPO(t, fx, fx.orgID, vendorID, 1)
	goodsLineID := seedPurchasingPOLine(t, fx, poID, "Goods", 1, 5_000, 100_000)
	heavyLineID := seedPurchasingPOLine(t, fx, poID, "Heavy goods", 2, 4_000, 200_000)
	seedPurchasingReceiptLine(t, fx, fx.orgID, poID, goodsLineID, 2_000, 500)
	seedPurchasingReceiptLine(t, fx, fx.orgID, poID, heavyLineID, 3_000, 0)

	billWith := func(lines []CreateBillLineInput, vendorID string, poNumber *int64) (CreateBillOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
			return createBill(fx.ctx, tx, claims, CreateBillInput{VendorID: vendorID, PONumber: poNumber, Lines: lines}, now)
		})
	}
	poOne := int64(1)
	poMissing := int64(999)

	if _, err := billWith([]CreateBillLineInput{{Description: "Mystery goods", Quantity: 1_000, UnitPriceMinor: 100_000}}, vendorID, &poOne); err == nil || err.Error() != `line "Mystery goods" must reference a purchase-order line number` {
		t.Fatalf("bill without poLineNumber error = %v", err)
	}
	if _, err := billWith([]CreateBillLineInput{{Description: "Ghost line", Quantity: 1_000, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(9)}}, vendorID, &poOne); err == nil || err.Error() != "no line 9 on order 1" {
		t.Fatalf("unknown poLineNumber error = %v", err)
	}
	if _, err := billWith([]CreateBillLineInput{{Description: "Orphan", Quantity: 1_000, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}}, vendorID, &poMissing); err == nil || err.Error() != "purchase order 999 not found" {
		t.Fatalf("missing order error = %v", err)
	}
	if _, err := billWith([]CreateBillLineInput{{Description: "Wrong vendor", Quantity: 1_000, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}}, otherVendorID, &poOne); err == nil || err.Error() != "vendor mismatch: order 1 belongs to a different vendor" {
		t.Fatalf("vendor mismatch error = %v", err)
	}
	if _, err := billWith([]CreateBillLineInput{{Description: "Too many goods", Quantity: 1_600, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}}, vendorID, &poOne); err == nil || err.Error() != "three-way match failed on line 1 (Too many goods): unreceived_bill (billed 1600 exceeds received 1500)" {
		t.Fatalf("unreceived bill error = %v", err)
	}
	if _, err := billWith([]CreateBillLineInput{{Description: "Over ordered", Quantity: 5_010, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}}, vendorID, &poOne); err == nil || err.Error() != "three-way match failed on line 1 (Over ordered): unreceived_bill (billed 5010 exceeds received 1500); overbilled_qty (billed 5010 exceeds ordered 5000)" {
		t.Fatalf("overbilled bill error = %v", err)
	}
	if _, err := billWith([]CreateBillLineInput{{Description: "Cheap goods", Quantity: 1_000, UnitPriceMinor: 103_000, POLineNumber: crmInt64Pointer(2)}}, vendorID, &poOne); err == nil || err.Error() != "three-way match failed on line 2 (Cheap goods): price_mismatch (bill price 103000 outside 2% of ordered 200000)" {
		t.Fatalf("price mismatch error = %v", err)
	}
	if _, err := billWith([]CreateBillLineInput{{Description: "Repeated", Quantity: 1_000, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}, {Description: "Second helping", Quantity: 600, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}}, vendorID, &poOne); err == nil || err.Error() != "three-way match failed on line 1 (Second helping): unreceived_bill (billed 600 exceeds received 500)" {
		t.Fatalf("consumed allowance error = %v", err)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("refused matched bills stored %d rows, want 0", got)
	}

	accepted, err := billWith([]CreateBillLineInput{
		{Description: "First delivery", Quantity: 1_000, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)},
		{Description: "Second delivery", Quantity: 500, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)},
	}, vendorID, &poOne)
	if err != nil {
		t.Fatalf("createBill within match: %v", err)
	}
	if accepted.BillNumber != 1 || accepted.TotalMinor != 150_000 {
		t.Fatalf("matched createBill output = %+v, want bill 1 totaling 150000", accepted)
	}
	poLinked := fx.count(`SELECT count(*) FROM vendor_bill_lines WHERE po_line_id = $1::uuid AND quantity IN (1000, 500)`, goodsLineID)
	if poLinked != 2 {
		t.Fatalf("matched bill lines linked to the order line = %d, want 2", poLinked)
	}

	// Earlier bills consume the line allowance: only 0 received remains, so
	// even one more thousandth fails the aggregate.
	if _, err := billWith([]CreateBillLineInput{{Description: "One more", Quantity: 1, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}}, vendorID, &poOne); err == nil || err.Error() != "three-way match failed on line 1 (One more): unreceived_bill (billed 1 exceeds received 0)" {
		t.Fatalf("prior billed error = %v", err)
	}

	// Returns net out of acceptance: 500 returned goods are owed again, so
	// only 1500 of the ordered 5000 are billable after the earlier bill.
	seededBillID := seedPurchasingBill(t, fx, fx.orgID, vendorID, 90, "open", 1_000, 0, 0)
	seedPurchasingBillLine(t, fx, seededBillID, "Legacy row", 2_000, 100_000, &goodsLineID)
	if _, err := billWith([]CreateBillLineInput{{Description: "After returns", Quantity: 1, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1)}}, vendorID, &poOne); err == nil || err.Error() != "three-way match failed on line 1 (After returns): unreceived_bill (billed 1 exceeds received -2000)" {
		t.Fatalf("prior billed after seeded line error = %v", err)
	}

	toleranceInput := CreateBillLineInput{Description: "Edge price", Quantity: 1_000, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(2)}
	belowTolerance := toleranceInput
	belowTolerance.UnitPriceMinor = 196_000
	aboveTolerance := toleranceInput
	aboveTolerance.UnitPriceMinor = 204_000
	outsideTolerance := toleranceInput
	outsideTolerance.UnitPriceMinor = 195_999
	for name, line := range map[string]CreateBillLineInput{"below": belowTolerance, "above": aboveTolerance} {
		if _, err := billWith([]CreateBillLineInput{line}, vendorID, &poOne); err != nil {
			t.Fatalf("tolerance %s price %d refused: %v", name, line.UnitPriceMinor, err)
		}
	}
	if _, err := billWith([]CreateBillLineInput{outsideTolerance}, vendorID, &poOne); err == nil || !strings.Contains(err.Error(), "price_mismatch (bill price 195999 outside 2% of ordered 200000)") {
		t.Fatalf("outside tolerance price error = %v", err)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after matched bills = %d, want balanced books", drift)
	}
}

func TestPurchasingBillsConcurrentThreeWayMatchIsSerialized(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	poID := seedPurchasingPO(t, fx, fx.orgID, vendorID, 1)
	poLineID := seedPurchasingPOLine(t, fx, poID, "Concurrent goods", 1, 2_000, 100_000)
	seedPurchasingReceiptLine(t, fx, fx.orgID, poID, poLineID, 1_000, 0)
	claims := purchasingBillsClaims(fx)
	poNumber := int64(1)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	start := make(chan struct{})
	type result struct {
		created CreateBillOutput
		err     error
	}
	results := make(chan result, 2)
	for _, description := range []string{"Concurrent bill A", "Concurrent bill B"} {
		description := description
		go func() {
			<-start
			created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
				return createBill(fx.ctx, tx, claims, CreateBillInput{
					VendorID: vendorID,
					PONumber: &poNumber,
					Lines: []CreateBillLineInput{{
						Description: description, Quantity: 1_000, UnitPriceMinor: 100_000, POLineNumber: crmInt64Pointer(1),
					}},
				}, now)
			})
			results <- result{created: created, err: err}
		}()
	}
	close(start)
	var succeeded int
	var rejected int
	for range 2 {
		outcome := <-results
		if outcome.err == nil {
			succeeded++
			if outcome.created.TotalMinor != 100_000 {
				t.Errorf("successful concurrent bill = %+v, want total 100000", outcome.created)
			}
			continue
		}
		if !strings.Contains(outcome.err.Error(), "three-way match failed") || !strings.Contains(outcome.err.Error(), "unreceived_bill") {
			t.Errorf("losing concurrent bill error = %v, want unreceived three-way match failure", outcome.err)
		}
		rejected++
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent bills: succeeded=%d rejected=%d, want exactly one of each", succeeded, rejected)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id = $1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("stored bills = %d, want one accepted bill", got)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND source_type = 'vendor_bill'`, fx.orgID); got != 1 {
		t.Fatalf("vendor bill journals = %d, want one accepted journal", got)
	}
	if got := fx.count(`SELECT COALESCE(SUM(quantity), 0) FROM vendor_bill_lines WHERE po_line_id = $1::uuid`, poLineID); got != 1_000 {
		t.Fatalf("billed quantity = %d, want the accepted 1000 thousandths", got)
	}
}

func TestPurchasingBillsPayBillSettlesOutstandingAndGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: vendorID,
			Lines:    []CreateBillLineInput{{Description: "Consulting", Quantity: 1_000, UnitPriceMinor: 100_000}},
		}, now)
	})
	if err != nil {
		t.Fatalf("createBill: %v", err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: 999, AmountMinor: 100}, now)
	}); err == nil || err.Error() != "bill not found" {
		t.Fatalf("payBill unknown bill error = %v, want bill not found", err)
	}

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: created.BillNumber, AmountMinor: 40_000, Method: "cash"}, now)
	})
	if err != nil {
		t.Fatalf("payBill partial: %v", err)
	}
	if !isUUID(first.PaymentID) || !isUUID(first.EntryID) || first.FullyPaid {
		t.Fatalf("partial payBill output = %+v, want open payment", first)
	}
	encoded, err := marshalJS(first)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != fmt.Sprintf(`{"paymentId":%q,"entryId":%q,"fullyPaid":false}`, first.PaymentID, first.EntryID) {
		t.Fatalf("payBill output JSON = %s", encoded)
	}
	var method string
	var paidAt time.Time
	var paymentBillID, paymentEntryID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT method, paid_at, bill_id::text, entry_id::text FROM vendor_payments WHERE id = $1::uuid`, first.PaymentID).
		Scan(&method, &paidAt, &paymentBillID, &paymentEntryID); err != nil {
		t.Fatal(err)
	}
	if method != "cash" || !paidAt.Equal(now) || paymentEntryID != first.EntryID {
		t.Fatalf("stored payment = method %q paid %v entry %s", method, paidAt, paymentEntryID)
	}
	if paymentBillID == "" {
		t.Fatalf("stored payment lost its bill link")
	}
	lines := purchasingJournalLines(t, fx, first.EntryID)
	wantLines := []JournalEntryLineInput{
		{AccountCode: "2000", DebitMinor: 40_000},
		{AccountCode: "1000", CreditMinor: 40_000},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("payment journal lines = %+v, want %+v", lines, wantLines)
	}
	assertPurchasingJournalLines(t, lines, wantLines)
	var billStatus string
	var paidMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, paid_minor FROM vendor_bills WHERE number = 1 AND org_id = $1::uuid`, fx.orgID).Scan(&billStatus, &paidMinor); err != nil {
		t.Fatal(err)
	}
	if billStatus != "open" || paidMinor != 40_000 {
		t.Fatalf("bill after partial payment = %s paid %d, want open at 40000", billStatus, paidMinor)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: created.BillNumber, AmountMinor: 60_000}, now)
	})
	if err != nil || !second.FullyPaid {
		t.Fatalf("settle payBill = %+v, %v, want fullyPaid", second, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, paid_minor FROM vendor_bills WHERE number = 1 AND org_id = $1::uuid`, fx.orgID).Scan(&billStatus, &paidMinor); err != nil {
		t.Fatal(err)
	}
	if billStatus != "paid" || paidMinor != 100_000 {
		t.Fatalf("bill after settle = %s paid %d, want paid at 100000", billStatus, paidMinor)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: created.BillNumber, AmountMinor: 1}, now)
	}); err == nil || err.Error() != "overpayment: outstanding is 0 minor (total 100000, credited 0, paid 100000)" {
		t.Fatalf("overpayment error = %v, want credit-adjusted refusal", err)
	}

	voidBillID := seedPurchasingBill(t, fx, fx.orgID, vendorID, 2, "void", 5_000, 0, 0)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: 2, AmountMinor: 1_000}, now)
	}); err == nil || err.Error() != "document is void and cannot receive money" {
		t.Fatalf("void bill payBill error = %v, want ineligible refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: 2, AmountMinor: 5_000}, now)
	}); err == nil || err.Error() != "document is void and cannot receive money" {
		t.Fatalf("void bill full payBill error = %v, want refusal at any amount", err)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_payments WHERE bill_id = $1::uuid`, voidBillID); got != 0 {
		t.Fatalf("void bill stored %d payments, want 0", got)
	}

	creditedBillID := seedPurchasingBill(t, fx, fx.orgID, vendorID, 3, "open", 8_000, 0, 3_000)
	_ = creditedBillID
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: 3, AmountMinor: 5_001}, now)
	}); err == nil || err.Error() != "overpayment: outstanding is 5000 minor (total 8000, credited 3000, paid 0)" {
		t.Fatalf("credited overpayment error = %v, want credited outstanding verdict", err)
	}
	credited, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: 3, AmountMinor: 5_000}, now)
	})
	if err != nil || !credited.FullyPaid {
		t.Fatalf("credited settle payBill = %+v, %v, want fullyPaid through the balance contract", credited, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, paid_minor FROM vendor_bills WHERE number = 3 AND org_id = $1::uuid`, fx.orgID).Scan(&billStatus, &paidMinor); err != nil {
		t.Fatal(err)
	}
	if billStatus != "paid" || paidMinor != 5_000 {
		t.Fatalf("credited bill after payment = %s paid %d, want paid at 5000", billStatus, paidMinor)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after payments = %d, want balanced books", drift)
	}
}

func TestPurchasingBillsReverseVendorPaymentMirrorsAndRestores(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: vendorID,
			Lines:    []CreateBillLineInput{{Description: "Goods", Quantity: 1_000, UnitPriceMinor: 100_000}},
		}, now)
	})
	if err != nil {
		t.Fatalf("createBill: %v", err)
	}
	paid, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: created.BillNumber, AmountMinor: 100_000}, now)
	})
	if err != nil {
		t.Fatalf("payBill: %v", err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: executorUUID(t), Reason: "unknown payment"}, now)
	}); err == nil || err.Error() != "vendor payment not found" {
		t.Fatalf("reverse unknown payment error = %v, want vendor payment not found", err)
	}

	reversed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: paid.PaymentID, Reason: "duplicate payment"}, now)
	})
	if err != nil {
		t.Fatalf("reverseVendorPayment: %v", err)
	}
	if reversed.RefundedMinor != 100_000 || reversed.BillNumber != 1 || reversed.OutstandingMinor != 100_000 || !isUUID(reversed.ReversalEntryID) {
		t.Fatalf("reverseVendorPayment output = %+v, want full refund restored", reversed)
	}
	encoded, err := marshalJS(reversed)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != fmt.Sprintf(`{"reversalEntryId":%q,"refundedMinor":100000,"billNumber":1,"outstandingMinor":100000}`, reversed.ReversalEntryID) {
		t.Fatalf("reverseVendorPayment output JSON = %s", encoded)
	}
	var sourceType, currency string
	var sourceID, reversalOf *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT source_type, currency, source_id::text, reversal_of_id::text
		FROM journal_entries WHERE id = $1::uuid`, reversed.ReversalEntryID).Scan(&sourceType, &currency, &sourceID, &reversalOf); err != nil {
		t.Fatal(err)
	}
	if sourceType != "vendor-payment-reversal" || currency != "USD" || sourceID == nil || reversalOf == nil || *reversalOf != paid.EntryID {
		t.Fatalf("reversal entry = %s %s source=%v reversalOf=%v", sourceType, currency, sourceID, reversalOf)
	}
	lines := purchasingJournalLines(t, fx, reversed.ReversalEntryID)
	wantLines := []JournalEntryLineInput{
		{AccountCode: "2000", CreditMinor: 100_000},
		{AccountCode: "1000", DebitMinor: 100_000},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("reversal journal lines = %+v, want mirrored %+v", lines, wantLines)
	}
	assertPurchasingJournalLines(t, lines, wantLines)
	var billStatus string
	var paidMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, paid_minor FROM vendor_bills WHERE number = 1 AND org_id = $1::uuid`, fx.orgID).Scan(&billStatus, &paidMinor); err != nil {
		t.Fatal(err)
	}
	if billStatus != "open" || paidMinor != 0 {
		t.Fatalf("bill after reversal = %s paid %d, want demoted to open at 0", billStatus, paidMinor)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: paid.PaymentID, Reason: "double reverse"}, now)
	}); err == nil || err.Error() != "vendor payment has already been reversed" {
		t.Fatalf("second reversal error = %v, want idempotent refusal", err)
	}
	var paymentStatus string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM vendor_payments WHERE id = $1::uuid`, paid.PaymentID).Scan(&paymentStatus); err != nil {
		t.Fatal(err)
	}
	if paymentStatus != "settled" {
		t.Fatalf("standalone payment status after reversal = %s, want untouched settled row (reversal evidence lives in the journal)", paymentStatus)
	}

	// A bill can receive a corrected payment after the reversal.
	retry, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: created.BillNumber, AmountMinor: 90_000}, now)
	})
	if err != nil || retry.FullyPaid {
		t.Fatalf("corrected payBill = %+v, %v, want accepted partial payment", retry, err)
	}

	voidTarget := seedPurchasingBill(t, fx, fx.orgID, vendorID, 91, "open", 5_000, 0, 0)
	reversedStatusPayment := seedPurchasingPayment(t, fx, fx.orgID, voidTarget, 1_000, "reversed", nil, nil)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: reversedStatusPayment, Reason: "again"}, now)
	}); err == nil || err.Error() != "vendor payment has already been reversed" {
		t.Fatalf("reversed status payment error = %v, want status refusal", err)
	}

	runID := seedPurchasingPaymentRun(t, fx, fx.orgID)
	runPayment := seedPurchasingPayment(t, fx, fx.orgID, voidTarget, 1_500, "instructed", nil, &runID)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: runPayment, Reason: "run member"}, now)
	}); err == nil || err.Error() != "this payment belongs to a supplier payment run; reverse the complete run instead" {
		t.Fatalf("payment run member error = %v, want run routing refusal", err)
	}

	entrylessPayment := seedPurchasingPayment(t, fx, fx.orgID, voidTarget, 2_000, "settled", nil, nil)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: entrylessPayment, Reason: "no ledger row"}, now)
	}); err == nil || err.Error() != "vendor payment has no journal entry to reverse" {
		t.Fatalf("entryless payment error = %v, want journal prerequisite refusal", err)
	}

	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	foreignBillID := seedPurchasingBill(t, fx, fx.otherOrgID, foreignVendorID, 1, "open", 9_000, 0, 0)
	foreignPayment := seedPurchasingPayment(t, fx, fx.otherOrgID, foreignBillID, 3_000, "settled", nil, nil)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: foreignPayment, Reason: "tenant probe"}, now)
	}); err == nil || err.Error() != "vendor payment not found" {
		t.Fatalf("foreign payment reverse error = %v, want tenant refusal", err)
	}

	partialBill, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateBillOutput, error) {
		return createBill(fx.ctx, tx, claims, CreateBillInput{
			VendorID: vendorID,
			Lines:    []CreateBillLineInput{{Description: "Partial", Quantity: 1_000, UnitPriceMinor: 50_000}},
		}, now)
	})
	if err != nil {
		t.Fatalf("partial createBill: %v", err)
	}
	partialPaid, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayBillOutput, error) {
		return payBill(fx.ctx, tx, claims, PayBillInput{BillNumber: partialBill.BillNumber, AmountMinor: 20_000}, now)
	})
	if err != nil {
		t.Fatalf("partial payBill: %v", err)
	}
	partialReversed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ReverseVendorPaymentOutput, error) {
		return reverseVendorPayment(fx.ctx, tx, claims, ReverseVendorPaymentInput{VendorPaymentID: partialPaid.PaymentID, Reason: "wrong amount"}, now)
	})
	if err != nil {
		t.Fatalf("partial reverse: %v", err)
	}
	if partialReversed.RefundedMinor != 20_000 || partialReversed.BillNumber != partialBill.BillNumber || partialReversed.OutstandingMinor != 50_000 {
		t.Fatalf("partial reverse output = %+v, want 20000 refunded and 50000 outstanding", partialReversed)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after reversals = %d, want balanced books", drift)
	}
}
