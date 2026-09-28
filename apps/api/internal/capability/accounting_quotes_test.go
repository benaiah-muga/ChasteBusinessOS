package capability

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestGoAccountingQuotesParsersMirrorZodContracts(t *testing.T) {
	quoteID := "11111111-1111-4111-8111-111111111111"
	createRaw := `{"customerId":"acme-corp-001","memo":"Spring offer","expiresAt":"2026-10-01T09:30:00.123Z","lines":[{"description":"Legacy migration","quantity":1500,"unitPriceMinor":999},{"description":"With tax","quantity":1000,"unitPriceMinor":50000,"taxMinor":2000}],"unknown":true}`
	created, err := ParseCreateQuoteInput(json.RawMessage(createRaw))
	if err != nil {
		t.Fatal(err)
	}
	wantCreate := CreateQuoteInput{
		CustomerID: "acme-corp-001",
		Memo:       crmStringPointer("Spring offer"),
		ExpiresAt:  crmStringPointer("2026-10-01T09:30:00.123Z"),
		Lines: []CreateInvoiceLine{
			{Description: "Legacy migration", Quantity: 1500, UnitPriceMinor: 999},
			{Description: "With tax", Quantity: 1000, UnitPriceMinor: 50000, TaxMinor: crmInt64Pointer(2000)},
		},
	}
	if created.CustomerID != wantCreate.CustomerID || created.Memo == nil || *created.Memo != *wantCreate.Memo ||
		created.ExpiresAt == nil || *created.ExpiresAt != *wantCreate.ExpiresAt || len(created.Lines) != 2 ||
		created.Lines[0] != wantCreate.Lines[0] || created.Lines[1].Description != wantCreate.Lines[1].Description ||
		created.Lines[1].Quantity != wantCreate.Lines[1].Quantity || created.Lines[1].UnitPriceMinor != wantCreate.Lines[1].UnitPriceMinor ||
		created.Lines[1].TaxMinor == nil || *created.Lines[1].TaxMinor != *wantCreate.Lines[1].TaxMinor || created.Lines[1].TaxCodeID != nil {
		t.Fatalf("ParseCreateQuoteInput() = %+v, want %+v", created, wantCreate)
	}
	encoded, err := marshalJS(created)
	if err != nil {
		t.Fatal(err)
	}
	wantCreateJSON := `{"customerId":"acme-corp-001","memo":"Spring offer","expiresAt":"2026-10-01T09:30:00.123Z","lines":[{"description":"Legacy migration","quantity":1500,"unitPriceMinor":999},{"description":"With tax","quantity":1000,"unitPriceMinor":50000,"taxMinor":2000}]}`
	if string(encoded) != wantCreateJSON {
		t.Fatalf("ParseCreateQuoteInput() JSON = %s, want %s", encoded, wantCreateJSON)
	}

	minimal, err := ParseCreateQuoteInput(json.RawMessage(`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":10}]}`))
	if err != nil || minimal.Memo != nil || minimal.ExpiresAt != nil || minimal.Lines[0].TaxMinor != nil || minimal.Lines[0].TaxCodeID != nil {
		t.Fatalf("minimal createQuote input=%+v err=%v, want absent optionals", minimal, err)
	}

	accepted, err := ParseAcceptQuoteInput(json.RawMessage(`{"quoteId":"` + quoteID + `","unknown":2}`))
	if err != nil || accepted.QuoteID != quoteID {
		t.Fatalf("ParseAcceptQuoteInput() = %+v, %v", accepted, err)
	}
	if encoded, err = marshalJS(accepted); err != nil || string(encoded) != `{"quoteId":"`+quoteID+`"}` {
		t.Fatalf("ParseAcceptQuoteInput() JSON = %s, %v", encoded, err)
	}
	declined, err := ParseDeclineQuoteInput(json.RawMessage(`{"quoteId":"` + quoteID + `"}`))
	if err != nil || declined.QuoteID != quoteID {
		t.Fatalf("ParseDeclineQuoteInput() = %+v, %v", declined, err)
	}
	if _, err = ParseExpireQuoteInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ParseExpireQuoteInput() err = %v", err)
	}
	listed, err := ParseListQuotesInput(json.RawMessage(`{"status":"sent"}`))
	if err != nil || listed.Status == nil || *listed.Status != "sent" {
		t.Fatalf("ParseListQuotesInput() = %+v, %v", listed, err)
	}
	if encoded, err = marshalJS(listed); err != nil || string(encoded) != `{"status":"sent"}` {
		t.Fatalf("ParseListQuotesInput() JSON = %s, %v", encoded, err)
	}
	if listed, err = ParseListQuotesInput(json.RawMessage(`{}`)); err != nil || listed.Status != nil {
		t.Fatalf("ParseListQuotesInput({}) = %+v, %v, want absent status", listed, err)
	}

	line := `{"description":"d","quantity":1000,"unitPriceMinor":1}`
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"customerId":null,"lines":[` + line + `]}`,
		`{"customerId":123,"lines":[` + line + `]}`,
		`{"customerId":"c"}`,
		`{"customerId":"c","lines":[]}`,
		`{"customerId":"c","lines":null}`,
		`{"customerId":"c","lines":{"description":"d"}}`,
		`{"customerId":"c","memo":null,"lines":[` + line + `]}`,
		`{"customerId":"c","expiresAt":null,"lines":[` + line + `]}`,
		`{"customerId":"c","expiresAt":"2026-10-01T09:30:00+02:00","lines":[` + line + `]}`,
		`{"customerId":"c","expiresAt":"2026-10-01 09:30:00","lines":[` + line + `]}`,
		`{"customerId":"c","expiresAt":"soon","lines":[` + line + `]}`,
		`{"customerId":"c","lines":["not-an-object"]}`,
		`{"customerId":"c","lines":[{"description":"","quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"c","lines":[{"description":null,"quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"c","lines":[{"quantity":1000,"unitPriceMinor":1}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":0,"unitPriceMinor":1}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":-1000,"unitPriceMinor":1}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000.5,"unitPriceMinor":1}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":-1}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxMinor":-5}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxMinor":null}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxMinor":0.5}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxCodeId":"nope"}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxCodeId":null}]}`,
		`{"customerId":"c","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxCodeId":"` + quoteID + `","taxMinor":5}]}`,
	} {
		if _, err := ParseCreateQuoteInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateQuoteInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"quoteId":null}`,
		`{"quoteId":123}`,
		`{"quoteId":"not-a-uuid"}`,
		`{"quoteId":"11111111-1111-1111-1111-111111111111"}`,
	} {
		if _, err := ParseAcceptQuoteInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseAcceptQuoteInput accepted %s", raw)
		}
		if _, err := ParseDeclineQuoteInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseDeclineQuoteInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{"status":"bogus"}`,
		`{"status":null}`,
		`{"status":5}`,
		`{"status":"SENT"}`,
	} {
		if _, err := ParseListQuotesInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseListQuotesInput accepted %s", raw)
		}
	}
	for _, raw := range []string{`[]`, `"x"`, `null`} {
		if _, err := ParseExpireQuoteInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseExpireQuoteInput accepted %s", raw)
		}
	}
	if _, err := ParseExpireQuoteInput(json.RawMessage(`{"unknown":true}`)); err != nil {
		t.Errorf("ParseExpireQuoteInput rejected unknown fields: %v", err)
	}
}

type seedQuoteRow struct {
	CustomerID string
	Number     int64
	Status     string
	TotalMinor int64
	ExpiresAt  *time.Time
	CreatedAt  time.Time
}

func seedQuote(t *testing.T, fx *executorFixture, orgID string, row seedQuoteRow) string {
	t.Helper()
	var quoteID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO quotes (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, expires_at, created_at, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, 0, $5, $6, $7, 'human', $8::uuid)
		RETURNING id::text`, orgID, row.CustomerID, row.Number, row.Status, row.TotalMinor, row.ExpiresAt, row.CreatedAt, fx.userID).Scan(&quoteID)
	if err != nil {
		t.Fatal(err)
	}
	return quoteID
}

func seedQuoteLine(t *testing.T, fx *executorFixture, quoteID, description string, quantity, unitPriceMinor, taxMinor int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO quote_lines (quote_id, description, quantity, unit_price_minor, tax_minor)
		VALUES ($1::uuid, $2, $3, $4, $5)`, quoteID, description, quantity, unitPriceMinor, taxMinor); err != nil {
		t.Fatal(err)
	}
}

func seedQuoteCustomer(t *testing.T, fx *executorFixture, orgID string, paymentTermDays *int64) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, payment_term_days)
		VALUES ($1::uuid, 'Quote Go fixture customer', $2)
		RETURNING id::text`, orgID, paymentTermDays).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func seedQuoteAccounts(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1100', 'Accounts Receivable', 'asset'),
		($1::uuid, '2100', 'Sales Tax Payable', 'liability'),
		($1::uuid, '4000', 'Sales Revenue', 'income')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func quoteTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func TestGoAccountingQuotesCreatePersistsLinesTotalsAndSequences(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedQuoteCustomer(t, fx, fx.orgID, nil)
	foreignCustomerID := seedQuoteCustomer(t, fx, fx.otherOrgID, nil)
	claims := quoteTestClaims(fx)
	input := CreateQuoteInput{
		CustomerID: customerID,
		Memo:       crmStringPointer("Spring offer"),
		ExpiresAt:  crmStringPointer("2026-12-01T00:00:00.000Z"),
		Lines: []CreateInvoiceLine{
			{Description: "Legacy migration", Quantity: 1_000, UnitPriceMinor: 5_000_00},
			{Description: "Rounded", Quantity: 1_500, UnitPriceMinor: 999, TaxMinor: crmInt64Pointer(1)},
		},
	}
	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateQuoteOutput, error) {
		return createQuote(fx.ctx, tx, claims, input)
	})
	if err != nil {
		t.Fatalf("createQuote: %v", err)
	}
	if created.QuoteNumber != 1 || created.TotalMinor != 501_500 || !isUUID(created.QuoteID) {
		t.Fatalf("createQuote output = %+v, want quote 1 totaling 501500", created)
	}
	encoded, err := marshalJS(created)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != fmt.Sprintf(`{"quoteId":%q,"quoteNumber":1,"totalMinor":501500}`, created.QuoteID) {
		t.Fatalf("createQuote output JSON = %s", encoded)
	}
	var status, currency, memo, actorType, actorID string
	var number, subtotal, tax, total int64
	var expiresAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT number, status, currency, subtotal_minor, tax_minor, total_minor, memo, expires_at, created_by_actor_type, created_by_actor_id::text
		FROM quotes WHERE id = $1::uuid AND org_id = $2::uuid`, created.QuoteID, fx.orgID).
		Scan(&number, &status, &currency, &subtotal, &tax, &total, &memo, &expiresAt, &actorType, &actorID); err != nil {
		t.Fatal(err)
	}
	if number != 1 || status != "sent" || currency != "USD" || subtotal != 501_499 || tax != 1 || total != 501_500 ||
		memo != "Spring offer" || expiresAt == nil || !expiresAt.Equal(time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)) ||
		actorType != "human" || actorID != fx.userID {
		t.Fatalf("stored quote = number=%d status=%s currency=%s totals=(%d,%d,%d) memo=%q expires=%v actor=%s/%s",
			number, status, currency, subtotal, tax, total, memo, expiresAt, actorType, actorID)
	}
	type storedLine struct {
		description string
		quantity    int64
		unitPrice   int64
		tax         int64
	}
	lines := make([]storedLine, 0, 2)
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT description, quantity, unit_price_minor, tax_minor FROM quote_lines WHERE quote_id = $1::uuid ORDER BY description`, created.QuoteID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var line storedLine
		if err := rows.Scan(&line.description, &line.quantity, &line.unitPrice, &line.tax); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	if len(lines) != 2 || lines[0] != (storedLine{"Legacy migration", 1000, 500000, 0}) || lines[1] != (storedLine{"Rounded", 1500, 999, 1}) {
		t.Fatalf("stored quote lines = %+v, want both lines with defaulted zero tax", lines)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateQuoteOutput, error) {
		return createQuote(fx.ctx, tx, claims, CreateQuoteInput{
			CustomerID: customerID,
			Lines:      []CreateInvoiceLine{{Description: "Bare offer", Quantity: 2_000, UnitPriceMinor: 1_000_00}},
		})
	})
	if err != nil {
		t.Fatalf("second createQuote: %v", err)
	}
	if second.QuoteNumber != 2 || second.TotalMinor != 200_000 {
		t.Fatalf("second createQuote output = %+v, want quote 2 totaling 200000", second)
	}
	var secondMemo *string
	var secondExpiresAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT memo, expires_at FROM quotes WHERE id = $1::uuid`, second.QuoteID).Scan(&secondMemo, &secondExpiresAt); err != nil {
		t.Fatal(err)
	}
	if secondMemo != nil || secondExpiresAt != nil {
		t.Fatalf("second quote memo=%v expires=%v, want null defaults", secondMemo, secondExpiresAt)
	}

	for _, badCustomer := range []string{foreignCustomerID, executorUUID(t)} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateQuoteOutput, error) {
			return createQuote(fx.ctx, tx, claims, CreateQuoteInput{
				CustomerID: badCustomer,
				Lines:      []CreateInvoiceLine{{Description: "Nope", Quantity: 1_000, UnitPriceMinor: 1}},
			})
		})
		if err == nil || err.Error() != "customer not found" {
			t.Fatalf("createQuote for customer %s error = %v, want customer not found", badCustomer, err)
		}
	}
	if got := fx.count(`SELECT count(*) FROM quotes WHERE org_id = $1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("quotes after rejected creates = %d, want two", got)
	}
	if got := fx.count(`SELECT count(*) FROM doc_counters WHERE org_id = $1::uuid AND kind = 'quote' AND "next" = 2`, fx.orgID); got != 1 {
		t.Fatalf("quote counter rows = %d, want sequence resting at 2", got)
	}
}

func TestGoAccountingQuotesAcceptConvertsThroughSharedInvoicePath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFixtureLedger(t, fx)
	seedQuoteAccounts(t, fx)
	customerID := seedQuoteCustomer(t, fx, fx.orgID, crmInt64Pointer(30))
	claims := quoteTestClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateQuoteOutput, error) {
		return createQuote(fx.ctx, tx, claims, CreateQuoteInput{
			CustomerID: customerID,
			Memo:       crmStringPointer("Verbal yes"),
			Lines:      []CreateInvoiceLine{{Description: "Fresh offer", Quantity: 1_000, UnitPriceMinor: 10_000_00, TaxMinor: crmInt64Pointer(0)}},
		})
	})
	if err != nil {
		t.Fatalf("createQuote: %v", err)
	}
	accepted, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (AcceptQuoteOutput, error) {
		return acceptQuote(fx.ctx, tx, claims, AcceptQuoteInput{QuoteID: created.QuoteID}, now)
	})
	if err != nil {
		t.Fatalf("acceptQuote: %v", err)
	}
	if accepted.InvoiceNumber != 1 || accepted.TotalMinor != 1_000_000 || !isUUID(accepted.InvoiceID) {
		t.Fatalf("acceptQuote output = %+v, want invoice 1 totaling 1000000", accepted)
	}
	encoded, err := marshalJS(accepted)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != fmt.Sprintf(`{"invoiceId":%q,"invoiceNumber":1,"totalMinor":1000000}`, accepted.InvoiceID) {
		t.Fatalf("acceptQuote output JSON = %s", encoded)
	}
	var quoteStatus string
	var decidedAt *time.Time
	var convertedInvoiceID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, decided_at, converted_invoice_id::text FROM quotes WHERE id = $1::uuid`, created.QuoteID).
		Scan(&quoteStatus, &decidedAt, &convertedInvoiceID); err != nil {
		t.Fatal(err)
	}
	if quoteStatus != "accepted" || decidedAt == nil || !decidedAt.Equal(now) || convertedInvoiceID == nil || *convertedInvoiceID != accepted.InvoiceID {
		t.Fatalf("accepted quote status=%s decided=%v invoice=%v", quoteStatus, decidedAt, convertedInvoiceID)
	}
	var invoiceStatus, currency, memo string
	var invoiceNumber, invoiceTotal int64
	var issuedAt, dueAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT number, status, currency, total_minor, memo, issued_at, due_at
		FROM invoices WHERE id = $1::uuid AND org_id = $2::uuid`, accepted.InvoiceID, fx.orgID).
		Scan(&invoiceNumber, &invoiceStatus, &currency, &invoiceTotal, &memo, &issuedAt, &dueAt); err != nil {
		t.Fatal(err)
	}
	if invoiceNumber != 1 || invoiceStatus != "sent" || currency != "USD" || invoiceTotal != 1_000_000 || memo != "Verbal yes" ||
		!issuedAt.Equal(now) || !dueAt.Equal(now.AddDate(0, 0, 30)) {
		t.Fatalf("converted invoice = #%d %s %s %d memo=%q issued=%v due=%v, want terms-shifted invoice", invoiceNumber, invoiceStatus, currency, invoiceTotal, memo, issuedAt, dueAt)
	}
	var lineDescription string
	var quantity, unitPrice, lineTax int64
	var taxCodeID *string
	var taxRateBasisPoints *int64
	var priceIncludesTax bool
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax
		FROM invoice_lines WHERE invoice_id = $1::uuid`, accepted.InvoiceID).
		Scan(&lineDescription, &quantity, &unitPrice, &lineTax, &taxCodeID, &taxRateBasisPoints, &priceIncludesTax); err != nil {
		t.Fatal(err)
	}
	if lineDescription != "Fresh offer" || quantity != 1_000 || unitPrice != 1_000_000 || lineTax != 0 ||
		taxCodeID != nil || taxRateBasisPoints != nil || priceIncludesTax {
		t.Fatalf("converted invoice line = %q (%d,%d,%d) code=%v rate=%v includes=%v", lineDescription, quantity, unitPrice, lineTax, taxCodeID, taxRateBasisPoints, priceIncludesTax)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after acceptance = %d, want balanced books", drift)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (AcceptQuoteOutput, error) {
		return acceptQuote(fx.ctx, tx, claims, AcceptQuoteInput{QuoteID: created.QuoteID}, now)
	})
	if err == nil || err.Error() != "quote is accepted; only sent quotes convert" {
		t.Fatalf("re-accept error = %v, want status guard", err)
	}

	pastQuote, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateQuoteOutput, error) {
		return createQuote(fx.ctx, tx, claims, CreateQuoteInput{
			CustomerID: customerID,
			ExpiresAt:  crmStringPointer("2026-09-26T00:00:00.000Z"),
			Lines:      []CreateInvoiceLine{{Description: "Lapsed offer", Quantity: 2_000, UnitPriceMinor: 1_000_00}},
		})
	})
	if err != nil {
		t.Fatalf("createQuote expired: %v", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (AcceptQuoteOutput, error) {
		return acceptQuote(fx.ctx, tx, claims, AcceptQuoteInput{QuoteID: pastQuote.QuoteID}, now)
	})
	if err == nil || err.Error() != "quote expired on 2026-09-26; decline it and issue a fresh quote" {
		t.Fatalf("expired accept error = %v, want honest expiry refusal", err)
	}

	boundaryQuote, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateQuoteOutput, error) {
		return createQuote(fx.ctx, tx, claims, CreateQuoteInput{
			CustomerID: customerID,
			ExpiresAt:  crmStringPointer("2026-09-27T12:00:00.000Z"),
			Lines:      []CreateInvoiceLine{{Description: "Deadline offer", Quantity: 1_000, UnitPriceMinor: 1_000_00}},
		})
	})
	if err != nil {
		t.Fatalf("createQuote boundary: %v", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (AcceptQuoteOutput, error) {
		return acceptQuote(fx.ctx, tx, claims, AcceptQuoteInput{QuoteID: boundaryQuote.QuoteID}, now)
	})
	if err == nil || err.Error() != "quote expired on 2026-09-27; decline it and issue a fresh quote" {
		t.Fatalf("boundary accept error = %v, want expiry at the exact instant", err)
	}
	if got := fx.count(`SELECT count(*) FROM quotes WHERE id = $1::uuid AND status = 'sent' AND decided_at IS NULL`, pastQuote.QuoteID); got != 1 {
		t.Fatalf("refused acceptances mutated quote state, rows=%d", got)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (AcceptQuoteOutput, error) {
		return acceptQuote(fx.ctx, tx, claims, AcceptQuoteInput{QuoteID: executorUUID(t)}, now)
	})
	if err == nil || err.Error() != "quote not found" {
		t.Fatalf("unknown accept error = %v, want quote not found", err)
	}
	foreignCustomerID := seedQuoteCustomer(t, fx, fx.otherOrgID, nil)
	foreignQuote := seedQuote(t, fx, fx.otherOrgID, seedQuoteRow{
		CustomerID: foreignCustomerID, Number: 1, Status: "sent", TotalMinor: 500,
		ExpiresAt: parseCRMTaskTime(t, "2027-01-01T00:00:00Z"), CreatedAt: now.Add(-time.Hour),
	})
	seedQuoteLine(t, fx, foreignQuote, "Foreign line", 1_000, 500, 0)
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (AcceptQuoteOutput, error) {
		return acceptQuote(fx.ctx, tx, claims, AcceptQuoteInput{QuoteID: foreignQuote}, now)
	})
	if err == nil || err.Error() != "quote not found" {
		t.Fatalf("foreign accept error = %v, want tenant refusal", err)
	}
	if got := fx.count(`SELECT count(*) FROM invoices WHERE org_id = $1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("invoices after refused acceptances = %d, want only the accepted conversion", got)
	}
	if got := fx.count(`SELECT count(*) FROM quotes WHERE org_id = $1::uuid AND status = 'accepted'`, fx.orgID); got != 1 {
		t.Fatalf("accepted quotes = %d, want one", got)
	}
}

func TestGoAccountingQuotesDeclineAndExpireGuardsAndEffects(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedQuoteCustomer(t, fx, fx.orgID, nil)
	foreignCustomerID := seedQuoteCustomer(t, fx, fx.otherOrgID, nil)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	base := now.Add(-2 * time.Hour)
	sentQuote := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 1, Status: "sent", TotalMinor: 1_000, CreatedAt: base})
	draftQuote := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 2, Status: "draft", TotalMinor: 2_000, CreatedAt: base})
	acceptedQuote := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 3, Status: "accepted", TotalMinor: 3_000, CreatedAt: base})
	foreignQuote := seedQuote(t, fx, fx.otherOrgID, seedQuoteRow{CustomerID: foreignCustomerID, Number: 1, Status: "sent", TotalMinor: 9_000, CreatedAt: base})

	declined, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DeclineQuoteOutput, error) {
		return declineQuote(fx.ctx, tx, fx.orgID, DeclineQuoteInput{QuoteID: sentQuote}, now)
	})
	if err != nil {
		t.Fatalf("declineQuote: %v", err)
	}
	encoded, err := marshalJS(declined)
	if err != nil || string(encoded) != `{"status":"declined"}` {
		t.Fatalf("declineQuote output = %s, %v", encoded, err)
	}
	var status string
	var decidedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, decided_at FROM quotes WHERE id = $1::uuid`, sentQuote).Scan(&status, &decidedAt); err != nil {
		t.Fatal(err)
	}
	if status != "declined" || decidedAt == nil || !decidedAt.Equal(now) {
		t.Fatalf("declined quote status=%s decided=%v, want declined at now", status, decidedAt)
	}

	for _, quoteID := range []string{sentQuote, acceptedQuote, foreignQuote, executorUUID(t)} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DeclineQuoteOutput, error) {
			return declineQuote(fx.ctx, tx, fx.orgID, DeclineQuoteInput{QuoteID: quoteID}, now)
		})
		if err == nil || err.Error() != "quote not found or already decided" {
			t.Fatalf("declineQuote(%s) error = %v, want guard refusal", quoteID, err)
		}
	}
	if _, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DeclineQuoteOutput, error) {
		return declineQuote(fx.ctx, tx, fx.orgID, DeclineQuoteInput{QuoteID: draftQuote}, now)
	}); err != nil {
		t.Fatalf("declineQuote(draft) error = %v, want draft declinable", err)
	}
	if got := fx.count(`SELECT count(*) FROM quotes WHERE org_id = $1::uuid AND status = 'declined'`, fx.orgID); got != 2 {
		t.Fatalf("declined quotes = %d, want sent and draft", got)
	}
	if got := fx.count(`SELECT count(*) FROM quotes WHERE id = $1::uuid AND status = 'sent'`, foreignQuote); got != 1 {
		t.Fatalf("foreign quote mutated by decline, rows=%d", got)
	}

	lapsed := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 4, Status: "sent", TotalMinor: 4_000, ExpiresAt: parseCRMTaskTime(t, "2026-09-26T00:00:00Z"), CreatedAt: base})
	future := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 5, Status: "sent", TotalMinor: 5_000, ExpiresAt: parseCRMTaskTime(t, "2027-01-01T00:00:00Z"), CreatedAt: base})
	acceptedLapsed := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 6, Status: "accepted", TotalMinor: 6_000, ExpiresAt: parseCRMTaskTime(t, "2026-09-01T00:00:00Z"), CreatedAt: base})
	foreignLapsed := seedQuote(t, fx, fx.otherOrgID, seedQuoteRow{CustomerID: foreignCustomerID, Number: 2, Status: "sent", TotalMinor: 9_500, ExpiresAt: parseCRMTaskTime(t, "2026-09-01T00:00:00Z"), CreatedAt: base})

	expired, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ExpireQuoteOutput, error) {
		return expireQuote(fx.ctx, tx, fx.orgID, now)
	})
	if err != nil {
		t.Fatalf("expireQuote: %v", err)
	}
	if expired.ExpiredCount != 1 {
		t.Fatalf("expireQuote count = %d, want exactly the lapsed sent quote", expired.ExpiredCount)
	}
	encoded, err = marshalJS(expired)
	if err != nil || string(encoded) != `{"expiredCount":1}` {
		t.Fatalf("expireQuote output = %s, %v", encoded, err)
	}
	again, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ExpireQuoteOutput, error) {
		return expireQuote(fx.ctx, tx, fx.orgID, now)
	})
	if err != nil || again.ExpiredCount != 0 {
		t.Fatalf("second expireQuote = %+v, %v, want idempotent zero", again, err)
	}
	var expiredStatus string
	var expiredDecidedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, decided_at FROM quotes WHERE id = $1::uuid`, lapsed).Scan(&expiredStatus, &expiredDecidedAt); err != nil {
		t.Fatal(err)
	}
	if expiredStatus != "expired" || expiredDecidedAt == nil || !expiredDecidedAt.Equal(now) {
		t.Fatalf("swept quote status=%s decided=%v, want expired at now", expiredStatus, expiredDecidedAt)
	}
	for quoteID, wantStatus := range map[string]string{future: "sent", acceptedLapsed: "accepted", foreignLapsed: "sent"} {
		if got := fx.count(`SELECT count(*) FROM quotes WHERE id = $1::uuid AND status = $2 AND decided_at IS NULL`, quoteID, wantStatus); got != 1 {
			t.Fatalf("quote %s swept unexpectedly, matching rows=%d", quoteID, got)
		}
	}
}

func TestGoAccountingQuotesListFiltersOrdersAndScopesTenants(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedQuoteCustomer(t, fx, fx.orgID, nil)
	foreignCustomerID := seedQuoteCustomer(t, fx, fx.otherOrgID, nil)
	base := time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)
	oldest := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 1, Status: "sent", TotalMinor: 10_000, CreatedAt: base})
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at)
		VALUES ($1::uuid, $2::uuid, 9, 'sent', 0, 0, 0, $3)
		RETURNING id::text`, fx.orgID, customerID, base).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	converted := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 2, Status: "accepted", TotalMinor: 20_000, ExpiresAt: parseCRMTaskTime(t, "2026-09-01T00:00:00Z"), CreatedAt: base.Add(time.Hour)})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE quotes SET converted_invoice_id = $2::uuid WHERE id = $1::uuid`, converted, invoiceID); err != nil {
		t.Fatal(err)
	}
	newest := seedQuote(t, fx, fx.orgID, seedQuoteRow{CustomerID: customerID, Number: 3, Status: "sent", TotalMinor: 30_000, ExpiresAt: parseCRMTaskTime(t, "2026-12-31T00:00:00Z"), CreatedAt: base.Add(2 * time.Hour)})
	seedQuote(t, fx, fx.otherOrgID, seedQuoteRow{CustomerID: foreignCustomerID, Number: 1, Status: "sent", TotalMinor: 99_000, CreatedAt: base.Add(3 * time.Hour)})

	all, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListQuotesOutput, error) {
		return listQuotes(fx.ctx, tx, fx.orgID, ListQuotesInput{})
	})
	if err != nil {
		t.Fatalf("listQuotes: %v", err)
	}
	if len(all.Quotes) != 3 || all.Quotes[0].ID != newest || all.Quotes[1].ID != converted || all.Quotes[2].ID != oldest {
		t.Fatalf("listQuotes order = %+v, want newest first tenant-scoped rows", all.Quotes)
	}
	newestEncoded, err := marshalJS(all.Quotes[0])
	if err != nil {
		t.Fatal(err)
	}
	wantNewest := fmt.Sprintf(`{"id":%q,"number":3,"status":"sent","totalMinor":30000,"customerId":%q,"createdAt":"2026-09-20T10:00:00.000Z","expiresAt":"2026-12-31T00:00:00.000Z","invoiceId":null}`, newest, customerID)
	if string(newestEncoded) != wantNewest {
		t.Fatalf("listQuotes row JSON = %s, want %s", newestEncoded, wantNewest)
	}
	convertedEncoded, err := marshalJS(all.Quotes[1])
	if err != nil {
		t.Fatal(err)
	}
	wantConverted := fmt.Sprintf(`{"id":%q,"number":2,"status":"accepted","totalMinor":20000,"customerId":%q,"createdAt":"2026-09-20T09:00:00.000Z","expiresAt":"2026-09-01T00:00:00.000Z","invoiceId":%q}`, converted, customerID, invoiceID)
	if string(convertedEncoded) != wantConverted {
		t.Fatalf("listQuotes converted row JSON = %s, want %s", convertedEncoded, wantConverted)
	}
	oldestEncoded, err := marshalJS(all.Quotes[2])
	if err != nil {
		t.Fatal(err)
	}
	wantOldest := fmt.Sprintf(`{"id":%q,"number":1,"status":"sent","totalMinor":10000,"customerId":%q,"createdAt":"2026-09-20T08:00:00.000Z","expiresAt":null,"invoiceId":null}`, oldest, customerID)
	if string(oldestEncoded) != wantOldest {
		t.Fatalf("listQuotes oldest row JSON = %s, want %s", oldestEncoded, wantOldest)
	}

	sent := crmStringPointer("sent")
	filtered, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListQuotesOutput, error) {
		return listQuotes(fx.ctx, tx, fx.orgID, ListQuotesInput{Status: sent})
	})
	if err != nil {
		t.Fatalf("listQuotes(status): %v", err)
	}
	if len(filtered.Quotes) != 2 || filtered.Quotes[0].ID != newest || filtered.Quotes[1].ID != oldest {
		t.Fatalf("listQuotes(status=sent) = %+v, want only sent rows", filtered.Quotes)
	}
	declined := crmStringPointer("declined")
	empty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListQuotesOutput, error) {
		return listQuotes(fx.ctx, tx, fx.orgID, ListQuotesInput{Status: declined})
	})
	if err != nil {
		t.Fatalf("listQuotes(declined): %v", err)
	}
	emptyEncoded, err := marshalJS(empty)
	if err != nil || string(emptyEncoded) != `{"quotes":[]}` {
		t.Fatalf("empty listQuotes JSON = %s, %v", emptyEncoded, err)
	}
}
