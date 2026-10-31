package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func taxReturnTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

// cleanupTaxReturnFixtures removes tax fixtures and posted ledger rows in
// reverse dependency order: filings before returns, lines before invoices and
// bills, journal lines before entries and accounts. Posted rows refuse DELETE
// unless the transaction enables app.ledger_maintenance first.
func cleanupTaxReturnFixtures(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin tax return fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable tax return fixture ledger cleanup: %v", err)
			return
		}
		statements := []string{
			`DELETE FROM sales_tax_filings WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM tax_returns WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM tax_codes WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM tax_profiles WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM vendor_bill_lines WHERE bill_id IN (SELECT id FROM vendor_bills WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM vendor_bills WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM vendors WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, statement := range statements {
			if _, err := tx.Exec(fx.ctx, statement, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("tax return fixture cleanup %q: %v", statement, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit tax return fixture cleanup: %v", err)
		}
	})
}

func seedTaxReturnAccount(t *testing.T, fx *executorFixture, orgID, code, name, accountType string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (org_id, code) DO NOTHING`, orgID, code, name, accountType); err != nil {
		t.Fatal(err)
	}
}

func seedTaxReturnProfile(t *testing.T, fx *executorFixture, orgID, jurisdiction, providerMode string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO tax_profiles (org_id, jurisdiction_code, filing_frequency, provider_mode)
		VALUES ($1::uuid, $2, 'monthly', $3)
		ON CONFLICT (org_id) DO UPDATE SET jurisdiction_code = EXCLUDED.jurisdiction_code, provider_mode = EXCLUDED.provider_mode`,
		orgID, jurisdiction, providerMode); err != nil {
		t.Fatal(err)
	}
}

func seedTaxReturnTaxCode(t *testing.T, fx *executorFixture, orgID, jurisdiction, code, name, direction string, rateBasisPoints int64, recoverable bool) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tax_codes (org_id, jurisdiction_code, code, name, direction, rate_basis_points, price_includes_tax, recoverable)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, false, $7)
		RETURNING id::text`, orgID, jurisdiction, code, name, direction, rateBasisPoints, recoverable).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTaxReturnCustomer(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Tax return fixture customer')
		RETURNING id::text`, orgID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTaxReturnVendor(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Tax return fixture vendor')
		RETURNING id::text`, orgID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTaxReturnInvoice(t *testing.T, fx *executorFixture, orgID, customerID, currency, status string, subtotalMinor, taxMinor int64, issuedAt *time.Time, voidedAt *time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, issued_at, voided_at)
		VALUES ($1::uuid, $2::uuid, (SELECT coalesce(max(number), 0) + 1 FROM invoices WHERE org_id = $1::uuid), $3, $4, $5::int, $6::int, $5::int + $6::int, $7, $8)
		RETURNING id::text`, orgID, customerID, status, currency, subtotalMinor, taxMinor, issuedAt, voidedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTaxReturnInvoiceLine(t *testing.T, fx *executorFixture, invoiceID, description string, quantity, unitPriceMinor, taxMinor int64, taxCodeID *string, rateBasisPoints *int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, false)`,
		invoiceID, description, quantity, unitPriceMinor, taxMinor, taxCodeID, rateBasisPoints); err != nil {
		t.Fatal(err)
	}
}

func seedTaxReturnBill(t *testing.T, fx *executorFixture, orgID, vendorID, currency, status string, totalMinor int64, billDate *time.Time) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, bill_date)
		VALUES ($1::uuid, $2::uuid, (SELECT coalesce(max(number), 0) + 1 FROM vendor_bills WHERE org_id = $1::uuid), $3, $4, $5, $6)
		RETURNING id::text`, orgID, vendorID, status, currency, totalMinor, billDate).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedTaxReturnBillLine(t *testing.T, fx *executorFixture, billID, description string, quantity, unitPriceMinor, taxMinor int64, taxCodeID string, rateBasisPoints *int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bill_lines (bill_id, description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, false)`,
		billID, description, quantity, unitPriceMinor, taxMinor, taxCodeID, rateBasisPoints); err != nil {
		t.Fatal(err)
	}
}

func taxReturnEntryLines(t *testing.T, fx *executorFixture, entryID string) []expenseJournalLineSummary {
	t.Helper()
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
		WHERE jl.entry_id = $1::uuid ORDER BY a.code`, entryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	lines := []expenseJournalLineSummary{}
	for rows.Next() {
		var line expenseJournalLineSummary
		if err := rows.Scan(&line.code, &line.debit, &line.credit); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

func TestAccountingTaxReturnsParsersMirrorZodContracts(t *testing.T) {
	created, err := ParseCreateTaxReturnInput(json.RawMessage(`{"periodFrom":"2026-08-01","periodTo":"2026-08-31","amendsReturnId":"123e4567-e89b-42d3-a456-426614174000","unexpected":1}`))
	if err != nil || created.PeriodFrom != "2026-08-01" || created.PeriodTo != "2026-08-31" ||
		created.AmendsReturnID == nil || *created.AmendsReturnID != "123e4567-e89b-42d3-a456-426614174000" {
		t.Fatalf("ParseCreateTaxReturnInput() = %+v, %v", created, err)
	}
	if encoded, err := marshalJS(created); err != nil || string(encoded) != `{"periodFrom":"2026-08-01","periodTo":"2026-08-31","amendsReturnId":"123e4567-e89b-42d3-a456-426614174000"}` {
		t.Fatalf("create input JSON = %s, %v", encoded, err)
	}
	bare, err := ParseCreateTaxReturnInput(json.RawMessage(`{"periodFrom":"2026-08-01","periodTo":"2026-08-31"}`))
	if err != nil || bare.AmendsReturnID != nil {
		t.Fatalf("ParseCreateTaxReturnInput(bare) = %+v, %v, want absent amendment link", bare, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"periodFrom":"2026-08-01"}`,
		`{"periodFrom":"2026-8-1","periodTo":"2026-08-31"}`,
		`{"periodFrom":"20260801","periodTo":"2026-08-31"}`,
		`{"periodFrom":20260801,"periodTo":"2026-08-31"}`,
		`{"periodFrom":null,"periodTo":"2026-08-31"}`,
		`{"periodFrom":"2026-08-01","periodTo":null}`,
		`{"periodFrom":"2026-08-01","periodTo":"2026-08-31","amendsReturnId":"not-a-uuid"}`,
		`{"periodFrom":"2026-08-01","periodTo":"2026-08-31","amendsReturnId":null}`,
		`[]`,
		`"x"`,
	} {
		if _, err := ParseCreateTaxReturnInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateTaxReturnInput accepted %s", raw)
		}
	}

	idInput := `{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000"}`
	for _, parse := range []func(json.RawMessage) (TaxReturnIDInput, error){
		ParseCancelTaxReturnDraftInput, ParseRestoreTaxReturnDraftInput,
		ParseCreateTaxReturnAmendmentInput, ParseFileSalesTaxReturnInput,
	} {
		parsed, err := parse(json.RawMessage(idInput))
		if err != nil || parsed.TaxReturnID != "123e4567-e89b-42d3-a456-426614174000" {
			t.Fatalf("tax return id parser() = %+v, %v", parsed, err)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"taxReturnId":null}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-42661417400"}`,
		`{"taxReturnId":"123e4567-e89b-c2d3-a456-426614174000"}`,
		`{"taxReturnId":123}`,
	} {
		if _, err := ParseCancelTaxReturnDraftInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCancelTaxReturnDraftInput accepted %s", raw)
		}
	}

	submission, err := ParseRecordTaxReturnSubmissionInput(json.RawMessage(`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","submissionReference":"PORTAL-1","evidenceReference":"file://portal/receipt.pdf"}`))
	if err != nil || submission.SubmissionReference != "PORTAL-1" || submission.EvidenceReference != "file://portal/receipt.pdf" {
		t.Fatalf("ParseRecordTaxReturnSubmissionInput() = %+v, %v", submission, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","submissionReference":"","evidenceReference":"x"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","submissionReference":"` + strings.Repeat("s", 201) + `","evidenceReference":"x"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","submissionReference":"x","evidenceReference":""}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","submissionReference":"x","evidenceReference":"` + strings.Repeat("e", 501) + `"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","submissionReference":null,"evidenceReference":"x"}`,
	} {
		if _, err := ParseRecordTaxReturnSubmissionInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseRecordTaxReturnSubmissionInput accepted %s", raw)
		}
	}

	ack, err := ParseRecordTaxReturnAcknowledgmentInput(json.RawMessage(`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"accepted","acknowledgmentReference":"ACK-1","details":"ok","evidenceReference":"file://ack"}`))
	if err != nil || ack.Status != "accepted" || ack.AcknowledgmentReference == nil || ack.Details == nil || ack.EvidenceReference == nil {
		t.Fatalf("ParseRecordTaxReturnAcknowledgmentInput() = %+v, %v", ack, err)
	}
	bareAck, err := ParseRecordTaxReturnAcknowledgmentInput(json.RawMessage(`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"unknown"}`))
	if err != nil || bareAck.Status != "unknown" || bareAck.AcknowledgmentReference != nil || bareAck.Details != nil || bareAck.EvidenceReference != nil {
		t.Fatalf("ParseRecordTaxReturnAcknowledgmentInput(bare) = %+v, %v", bareAck, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"amended"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":null}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"accepted","acknowledgmentReference":null}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"accepted","details":null}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"accepted","evidenceReference":null}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"accepted","acknowledgmentReference":"` + strings.Repeat("a", 201) + `"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"accepted","details":"` + strings.Repeat("d", 1001) + `"}`,
		`{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"accepted","evidenceReference":"` + strings.Repeat("e", 501) + `"}`,
	} {
		if _, err := ParseRecordTaxReturnAcknowledgmentInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseRecordTaxReturnAcknowledgmentInput accepted %s", raw)
		}
	}

	validByCapability := map[string]string{
		createTaxReturnCapabilityID:               `{"periodFrom":"2026-08-01","periodTo":"2026-08-31"}`,
		cancelTaxReturnDraftCapabilityID:          idInput,
		restoreTaxReturnDraftCapabilityID:         idInput,
		recordTaxReturnSubmissionCapabilityID:     `{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","submissionReference":"P","evidenceReference":"E"}`,
		createTaxReturnAmendmentCapabilityID:      idInput,
		recordTaxReturnAcknowledgmentCapabilityID: `{"taxReturnId":"123e4567-e89b-42d3-a456-426614174000","status":"rejected"}`,
		fileSalesTaxReturnCapabilityID:            idInput,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingTaxReturnInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingTaxReturnInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingTaxReturnInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingTaxReturnInput accepted an unsupported capability")
	}
}

func TestAccountingTaxReturnsDateWindowAndSettlementMath(t *testing.T) {
	start, end, err := taxReturnDateWindow("2026-08-01", "2026-08-31")
	if err != nil || !start.Equal(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)) ||
		!end.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("taxReturnDateWindow(August) = %s..%s, %v", start, end, err)
	}
	if _, _, err := taxReturnDateWindow("2026-08-31", "2026-08-01"); err == nil || err.Error() != "`to` is before `from`" {
		t.Fatalf("taxReturnDateWindow(reversed) error = %v", err)
	}
	if _, _, err := taxReturnDateWindow("2026-02-30", "2026-08-31"); err == nil || err.Error() != "dates must be YYYY-MM-DD" {
		t.Fatalf("taxReturnDateWindow(impossible day) error = %v", err)
	}
	if _, _, err := taxReturnDateWindow("2026-08-01", "2026-02-30"); err == nil || err.Error() != "dates must be YYYY-MM-DD" {
		t.Fatalf("taxReturnDateWindow(impossible end) error = %v", err)
	}

	delta, err := calculateTaxReturnSettlementDelta(taxReturnTotals{outputTaxMinor: 29_000, inputTaxMinor: 9_500}, taxReturnTotals{outputTaxMinor: 19_000, inputTaxMinor: 9_500})
	if err != nil || delta != (taxReturnSettlementDelta{outputDeltaMinor: 10_000, inputDeltaMinor: 0, taxDeltaMinor: 10_000}) {
		t.Fatalf("calculateTaxReturnSettlementDelta(amendment) = %+v, %v", delta, err)
	}
	if delta, err = calculateTaxReturnSettlementDelta(taxReturnTotals{outputTaxMinor: 0, inputTaxMinor: 9_500}, taxReturnTotals{}); err != nil ||
		delta != (taxReturnSettlementDelta{outputDeltaMinor: 0, inputDeltaMinor: 9_500, taxDeltaMinor: -9_500}) {
		t.Fatalf("calculateTaxReturnSettlementDelta(refund) = %+v, %v", delta, err)
	}
	if _, err := calculateTaxReturnSettlementDelta(taxReturnTotals{outputTaxMinor: -1}, taxReturnTotals{}); err == nil || err.Error() != "current output tax must be a non-negative safe integer" {
		t.Fatalf("calculateTaxReturnSettlementDelta(negative current) error = %v", err)
	}
	if _, err := calculateTaxReturnSettlementDelta(taxReturnTotals{}, taxReturnTotals{inputTaxMinor: -5}); err == nil || err.Error() != "settled input tax must be a non-negative safe integer" {
		t.Fatalf("calculateTaxReturnSettlementDelta(negative settled) error = %v", err)
	}
	if _, err := calculateTaxReturnSettlementDelta(taxReturnTotals{outputTaxMinor: maxSafeInteger, inputTaxMinor: 0}, taxReturnTotals{outputTaxMinor: 0, inputTaxMinor: maxSafeInteger}); err == nil ||
		err.Error() != "tax settlement delta exceeds the supported amount range" {
		t.Fatalf("calculateTaxReturnSettlementDelta(overflow) error = %v", err)
	}
	if encoded, err := marshalJS(CreateTaxReturnOutput{}); err != nil || string(encoded) != `{"taxReturnId":"","periodFrom":"","periodTo":"","currency":"","outputTaxMinor":0,"inputTaxMinor":0,"taxMinor":0,"taxBreakdown":null,"status":"","amendsReturnId":null}` {
		t.Fatalf("create output zero JSON = %s, %v", encoded, err)
	}
}

func TestAccountingTaxReturnsSnapshotLifecycleStateMachines(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupTaxReturnFixtures(t, fx)
	claims := taxReturnTestClaims(fx)
	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	august5 := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

	_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-08-01", PeriodTo: "2026-08-31"}, now)
	})
	if err == nil || err.Error() != "set a jurisdiction-specific tax profile before preparing a return" {
		t.Fatalf("executeCreateTaxReturn(no profile) error = %v", err)
	}

	seedTaxReturnProfile(t, fx, fx.orgID, "DE", "manual")
	seedTaxReturnAccount(t, fx, fx.orgID, "1000", "Cash", "asset")
	seedTaxReturnAccount(t, fx, fx.orgID, "1205", "Input VAT recoverable", "asset")
	seedTaxReturnAccount(t, fx, fx.orgID, "2100", "Output VAT payable", "liability")
	seedTaxReturnAccount(t, fx, fx.orgID, "4000", "Sales", "income")
	outputVAT := seedTaxReturnTaxCode(t, fx, fx.orgID, "DE", "VAT19", "VAT 19%", "output", 1900, false)
	customer := seedTaxReturnCustomer(t, fx, fx.orgID)
	rate := int64(1900)
	invoiceAugust := seedTaxReturnInvoice(t, fx, fx.orgID, customer, "USD", "sent", 100_000, 19_000, &august5, nil)
	seedTaxReturnInvoiceLine(t, fx, invoiceAugust, "Consulting", 1000, 100_000, 19_000, &outputVAT, &rate)

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-08-01", PeriodTo: "2026-08-31"}, now)
	})
	if err != nil {
		t.Fatalf("executeCreateTaxReturn: %v", err)
	}
	wantBreakdown := []TaxReturnBreakdownLine{{
		Code: "VAT19", Name: "VAT 19%", Direction: "output", RateBasisPoints: &rate,
		PriceIncludesTax: false, Recoverable: false, TaxableBaseMinor: 100_000, TaxMinor: 19_000, LineCount: 1,
	}}
	encodedWant, err := marshalJS(wantBreakdown)
	if err != nil {
		t.Fatal(err)
	}
	encodedGot, err := marshalJS(created.TaxBreakdown)
	if err != nil {
		t.Fatal(err)
	}
	if !isUUID(created.TaxReturnID) || created.Status != "draft" || created.Currency != "USD" ||
		created.OutputTaxMinor != 19_000 || created.InputTaxMinor != 0 || created.TaxMinor != 19_000 ||
		created.AmendsReturnID != nil || string(encodedGot) != string(encodedWant) {
		t.Fatalf("executeCreateTaxReturn output = %+v breakdown %s, want 19000 net draft", created, encodedGot)
	}
	var jurisdiction, storedStatus, storedCurrency string
	var periodFrom, periodTo time.Time
	var breakdownMatches bool
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT jurisdiction_code, period_from, period_to, currency, tax_breakdown = $2::jsonb, status
		FROM tax_returns WHERE id = $1::uuid`, created.TaxReturnID, string(encodedWant)).
		Scan(&jurisdiction, &periodFrom, &periodTo, &storedCurrency, &breakdownMatches, &storedStatus); err != nil {
		t.Fatal(err)
	}
	if jurisdiction != "DE" || storedStatus != "draft" || storedCurrency != "USD" ||
		!periodFrom.Equal(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)) ||
		!periodTo.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) ||
		!breakdownMatches {
		t.Fatalf("stored return = %s %s..%s %s breakdownMatch %v, want DE August window with snapshot breakdown", jurisdiction, periodFrom, periodTo, storedCurrency, breakdownMatches)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-08-15", PeriodTo: "2026-09-15"}, now)
	})
	if err == nil || err.Error() != "an overlapping return already exists; prepare an amendment to correct it" {
		t.Fatalf("executeCreateTaxReturn(overlap) error = %v", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-08-31", PeriodTo: "2026-02-30"}, now)
	})
	if err == nil || err.Error() != "dates must be YYYY-MM-DD" {
		t.Fatalf("executeCreateTaxReturn(impossible date) error = %v", err)
	}

	cancelled, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (TaxReturnIDOutput, error) {
		return executeCancelTaxReturnDraft(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: created.TaxReturnID}, now)
	})
	if err != nil || cancelled.TaxReturnID != created.TaxReturnID {
		t.Fatalf("executeCancelTaxReturnDraft = %+v, %v", cancelled, err)
	}
	if got := fx.count(`SELECT count(*) FROM tax_returns WHERE org_id = $1::uuid AND id = $2::uuid AND status = 'cancelled'`, fx.orgID, created.TaxReturnID); got != 1 {
		t.Fatalf("cancelled draft rows = %d, want 1", got)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (TaxReturnIDOutput, error) {
		return executeCancelTaxReturnDraft(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: created.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "unsent return draft not found" {
		t.Fatalf("executeCancelTaxReturnDraft(again) error = %v", err)
	}
	restored, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (TaxReturnIDOutput, error) {
		return executeRestoreTaxReturnDraft(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: created.TaxReturnID}, now)
	})
	if err != nil || restored.TaxReturnID != created.TaxReturnID {
		t.Fatalf("executeRestoreTaxReturnDraft = %+v, %v", restored, err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (TaxReturnIDOutput, error) {
		return executeRestoreTaxReturnDraft(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: created.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "cancelled draft not found" {
		t.Fatalf("executeRestoreTaxReturnDraft(again) error = %v", err)
	}

	submission, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnSubmissionOutput, error) {
		return executeRecordTaxReturnSubmission(fx.ctx, tx, claims, RecordTaxReturnSubmissionInput{
			TaxReturnID: created.TaxReturnID, SubmissionReference: "PORTAL-2026-08", EvidenceReference: "file://portal/receipt.pdf",
		}, now)
	})
	if err != nil {
		t.Fatalf("executeRecordTaxReturnSubmission: %v", err)
	}
	if encoded, err := marshalJS(submission); err != nil ||
		string(encoded) != `{"taxReturnId":"`+created.TaxReturnID+`","status":"submitted","submissionReference":"PORTAL-2026-08","submittedAt":"2026-09-01T10:00:00.000Z"}` {
		t.Fatalf("submission output JSON = %s, %v", encoded, err)
	}
	var submissionReference, evidenceReference, storedSubmittedStatus string
	var submittedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, submission_reference, evidence_reference, submitted_at
		FROM tax_returns WHERE id = $1::uuid`, created.TaxReturnID).
		Scan(&storedSubmittedStatus, &submissionReference, &evidenceReference, &submittedAt); err != nil {
		t.Fatal(err)
	}
	if storedSubmittedStatus != "submitted" || submissionReference != "PORTAL-2026-08" || evidenceReference != "file://portal/receipt.pdf" || !submittedAt.Equal(now) {
		t.Fatalf("stored submission = %s %q %q %s", storedSubmittedStatus, submissionReference, evidenceReference, submittedAt)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnSubmissionOutput, error) {
		return executeRecordTaxReturnSubmission(fx.ctx, tx, claims, RecordTaxReturnSubmissionInput{
			TaxReturnID: created.TaxReturnID, SubmissionReference: "AGAIN", EvidenceReference: "E",
		}, now)
	})
	if err == nil || err.Error() != "only an unsent draft can be marked submitted; an unknown result must be reconciled before retrying" {
		t.Fatalf("executeRecordTaxReturnSubmission(again) error = %v", err)
	}

	ackDetails := "accepted by BZSt"
	ackReference := "ACK-1"
	acknowledgment, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnAcknowledgmentOutput, error) {
		return executeRecordTaxReturnAcknowledgment(fx.ctx, tx, claims, RecordTaxReturnAcknowledgmentInput{
			TaxReturnID: created.TaxReturnID, Status: "accepted",
			AcknowledgmentReference: &ackReference, Details: &ackDetails, EvidenceReference: &evidenceReference,
		}, now)
	})
	if err != nil {
		t.Fatalf("executeRecordTaxReturnAcknowledgment: %v", err)
	}
	if encoded, err := marshalJS(acknowledgment); err != nil ||
		string(encoded) != `{"taxReturnId":"`+created.TaxReturnID+`","status":"accepted","acknowledgedAt":"2026-09-01T10:00:00.000Z"}` {
		t.Fatalf("acknowledgment output JSON = %s, %v", encoded, err)
	}
	var ackStatus string
	var acknowledgmentMatches bool
	var acknowledgedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, acknowledgment = $2::jsonb, acknowledged_at FROM tax_returns WHERE id = $1::uuid`,
		created.TaxReturnID, `{"details":"accepted by BZSt","reference":"ACK-1"}`).
		Scan(&ackStatus, &acknowledgmentMatches, &acknowledgedAt); err != nil {
		t.Fatal(err)
	}
	if ackStatus != "accepted" || !acknowledgmentMatches || !acknowledgedAt.Equal(now) {
		t.Fatalf("stored acknowledgment = %s match %v %s", ackStatus, acknowledgmentMatches, acknowledgedAt)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnAcknowledgmentOutput, error) {
		return executeRecordTaxReturnAcknowledgment(fx.ctx, tx, claims, RecordTaxReturnAcknowledgmentInput{
			TaxReturnID: created.TaxReturnID, Status: "rejected",
		}, now)
	})
	if err == nil || err.Error() != "only submitted or unresolved returns can receive an acknowledgment" {
		t.Fatalf("executeRecordTaxReturnAcknowledgment(accepted) error = %v", err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE tax_profiles SET provider_mode = 'connected' WHERE org_id = $1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	createdSeptember, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-09-01", PeriodTo: "2026-09-30"}, now)
	})
	if err != nil {
		t.Fatalf("executeCreateTaxReturn(September): %v", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnSubmissionOutput, error) {
		return executeRecordTaxReturnSubmission(fx.ctx, tx, claims, RecordTaxReturnSubmissionInput{
			TaxReturnID: createdSeptember.TaxReturnID, SubmissionReference: "P", EvidenceReference: "E",
		}, now)
	})
	if err == nil || err.Error() != "no tax authority provider is configured; switch to manual recording or complete the jurisdiction integration" {
		t.Fatalf("executeRecordTaxReturnSubmission(connected) error = %v", err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE tax_profiles SET provider_mode = 'manual' WHERE org_id = $1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}

	october15 := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	seedTaxReturnInvoice(t, fx, fx.orgID, customer, "EUR", "sent", 50_000, 0, &october15, nil)
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-10-01", PeriodTo: "2026-10-31"}, now)
	})
	if err == nil || err.Error() != "return preparation is blocked while foreign-currency tax documents need conversion" {
		t.Fatalf("executeCreateTaxReturn(foreign) error = %v", err)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnAmendmentOutput, error) {
		return executeCreateTaxReturnAmendment(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: createdSeptember.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "only an accepted or rejected return can be amended" {
		t.Fatalf("executeCreateTaxReturnAmendment(draft) error = %v", err)
	}

	amendment, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnAmendmentOutput, error) {
		return executeCreateTaxReturnAmendment(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: created.TaxReturnID}, now)
	})
	if err != nil {
		t.Fatalf("executeCreateTaxReturnAmendment: %v", err)
	}
	if encoded, err := marshalJS(amendment); err != nil ||
		string(encoded) != `{"taxReturnId":"`+amendment.TaxReturnID+`","periodFrom":"2026-08-01","periodTo":"2026-08-31","status":"draft"}` {
		t.Fatalf("amendment output JSON = %s, %v", encoded, err)
	}
	var amendedFrom, amendedTo time.Time
	var amendsReturnID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT period_from, period_to, amends_return_id::text FROM tax_returns WHERE id = $1::uuid`, amendment.TaxReturnID).
		Scan(&amendedFrom, &amendedTo, &amendsReturnID); err != nil {
		t.Fatal(err)
	}
	if !amendedFrom.Equal(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)) ||
		!amendedTo.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) ||
		amendsReturnID == nil || *amendsReturnID != created.TaxReturnID {
		t.Fatalf("stored amendment = %s..%s amends %v", amendedFrom, amendedTo, amendsReturnID)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnAmendmentOutput, error) {
		return executeCreateTaxReturnAmendment(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: created.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "this return already has an active amendment" {
		t.Fatalf("executeCreateTaxReturnAmendment(duplicate) error = %v", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (TaxReturnIDOutput, error) {
		return executeCancelTaxReturnDraft(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: amendment.TaxReturnID}, now)
	}); err != nil {
		t.Fatalf("cancel amendment draft: %v", err)
	}
	recreated, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnAmendmentOutput, error) {
		return executeCreateTaxReturnAmendment(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: created.TaxReturnID}, now)
	})
	if err != nil || recreated.TaxReturnID == amendment.TaxReturnID {
		t.Fatalf("executeCreateTaxReturnAmendment(after cancel) = %+v, %v, want a fresh amendment", recreated, err)
	}
	if got := fx.count(`SELECT count(*) FROM tax_returns WHERE org_id = $1::uuid AND amends_return_id = $2::uuid AND status = 'draft'`, fx.orgID, created.TaxReturnID); got != 1 {
		t.Fatalf("active amendments after recreate = %d, want 1", got)
	}
}

func TestAccountingTaxReturnsFilingSettlesAmendmentDelta(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupTaxReturnFixtures(t, fx)
	claims := taxReturnTestClaims(fx)
	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	august5 := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	august10 := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)

	seedTaxReturnProfile(t, fx, fx.orgID, "DE", "manual")
	seedTaxReturnAccount(t, fx, fx.orgID, "1000", "Cash", "asset")
	seedTaxReturnAccount(t, fx, fx.orgID, "1205", "Input VAT recoverable", "asset")
	seedTaxReturnAccount(t, fx, fx.orgID, "2100", "Output VAT payable", "liability")
	seedTaxReturnAccount(t, fx, fx.orgID, "4000", "Sales", "income")
	outputVAT := seedTaxReturnTaxCode(t, fx, fx.orgID, "DE", "VAT19", "VAT 19%", "output", 1900, false)
	outputVAT25 := seedTaxReturnTaxCode(t, fx, fx.orgID, "DE", "VAT25", "VAT 25%", "output", 2500, false)
	inputVAT := seedTaxReturnTaxCode(t, fx, fx.orgID, "DE", "INVAT", "Input VAT 19%", "input", 1900, true)
	customer := seedTaxReturnCustomer(t, fx, fx.orgID)
	vendor := seedTaxReturnVendor(t, fx, fx.orgID)

	rate19 := int64(1900)
	rate25 := int64(2500)
	invoiceAugust := seedTaxReturnInvoice(t, fx, fx.orgID, customer, "USD", "sent", 100_000, 19_000, &august5, nil)
	seedTaxReturnInvoiceLine(t, fx, invoiceAugust, "Consulting", 1000, 100_000, 19_000, &outputVAT, &rate19)
	billAugust := seedTaxReturnBill(t, fx, fx.orgID, vendor, "USD", "open", 59_500, &august10)
	seedTaxReturnBillLine(t, fx, billAugust, "Hardware", 1000, 50_000, 9_500, inputVAT, &rate19)

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-08-01", PeriodTo: "2026-08-31"}, now)
	})
	if err != nil || first.OutputTaxMinor != 19_000 || first.InputTaxMinor != 9_500 || first.TaxMinor != 9_500 {
		t.Fatalf("executeCreateTaxReturn(August) = %+v, %v, want 19000/9500/9500", first, err)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (FileSalesTaxReturnOutput, error) {
		return executeFileSalesTaxReturn(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: first.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "only a submitted or accepted tax return can be settled" {
		t.Fatalf("executeFileSalesTaxReturn(draft) error = %v", err)
	}

	for _, submission := range []struct {
		returnID string
	}{
		{first.TaxReturnID},
	} {
		if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnSubmissionOutput, error) {
			return executeRecordTaxReturnSubmission(fx.ctx, tx, claims, RecordTaxReturnSubmissionInput{
				TaxReturnID: submission.returnID, SubmissionReference: "PORTAL", EvidenceReference: "E",
			}, now)
		}); err != nil {
			t.Fatalf("executeRecordTaxReturnSubmission: %v", err)
		}
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnAcknowledgmentOutput, error) {
		return executeRecordTaxReturnAcknowledgment(fx.ctx, tx, claims, RecordTaxReturnAcknowledgmentInput{
			TaxReturnID: first.TaxReturnID, Status: "accepted",
		}, now)
	}); err != nil {
		t.Fatalf("executeRecordTaxReturnAcknowledgment: %v", err)
	}

	august20 := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	invoiceLateAugust := seedTaxReturnInvoice(t, fx, fx.orgID, customer, "USD", "sent", 40_000, 10_000, &august20, nil)
	seedTaxReturnInvoiceLine(t, fx, invoiceLateAugust, "Training", 1000, 40_000, 10_000, &outputVAT25, &rate25)

	amendment, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnAmendmentOutput, error) {
		return executeCreateTaxReturnAmendment(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: first.TaxReturnID}, now)
	})
	if err != nil {
		t.Fatalf("executeCreateTaxReturnAmendment: %v", err)
	}
	var amendmentOutput, amendmentInput, amendmentTax int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT output_tax_minor, input_tax_minor, tax_minor FROM tax_returns WHERE id = $1::uuid`, amendment.TaxReturnID).
		Scan(&amendmentOutput, &amendmentInput, &amendmentTax); err != nil {
		t.Fatal(err)
	}
	if amendmentOutput != 29_000 || amendmentInput != 9_500 || amendmentTax != 19_500 {
		t.Fatalf("amendment totals = %d/%d/%d, want 29000/9500/19500", amendmentOutput, amendmentInput, amendmentTax)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (FileSalesTaxReturnOutput, error) {
		return executeFileSalesTaxReturn(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: first.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "settle the latest active return in this amendment chain" {
		t.Fatalf("executeFileSalesTaxReturn(superseded) error = %v", err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnSubmissionOutput, error) {
		return executeRecordTaxReturnSubmission(fx.ctx, tx, claims, RecordTaxReturnSubmissionInput{
			TaxReturnID: amendment.TaxReturnID, SubmissionReference: "PORTAL-AMENDED", EvidenceReference: "E",
		}, now)
	}); err != nil {
		t.Fatalf("executeRecordTaxReturnSubmission(amendment): %v", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnAcknowledgmentOutput, error) {
		return executeRecordTaxReturnAcknowledgment(fx.ctx, tx, claims, RecordTaxReturnAcknowledgmentInput{
			TaxReturnID: amendment.TaxReturnID, Status: "accepted",
		}, now)
	}); err != nil {
		t.Fatalf("executeRecordTaxReturnAcknowledgment(amendment): %v", err)
	}

	filed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (FileSalesTaxReturnOutput, error) {
		return executeFileSalesTaxReturn(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: amendment.TaxReturnID}, now)
	})
	if err != nil {
		t.Fatalf("executeFileSalesTaxReturn(amendment): %v", err)
	}
	if !isUUID(filed.FilingID) || !isUUID(filed.EntryID) || filed.TaxReturnID != amendment.TaxReturnID || filed.TaxMinor != 19_500 {
		t.Fatalf("executeFileSalesTaxReturn(amendment) output = %+v, want 19500 delta", filed)
	}
	var memo, sourceType, currency string
	var sourceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, currency FROM journal_entries WHERE id = $1::uuid`, filed.EntryID).
		Scan(&memo, &sourceType, &sourceID, &currency); err != nil {
		t.Fatal(err)
	}
	if memo != "Sales tax settlement 2026-08-01 → 2026-08-31" || sourceType != "sales_tax_filing" || sourceID != amendment.TaxReturnID || currency != "USD" {
		t.Fatalf("settlement entry = memo %q source %s/%s currency %s", memo, sourceType, sourceID, currency)
	}
	lines := taxReturnEntryLines(t, fx, filed.EntryID)
	if len(lines) != 3 ||
		lines[0] != (expenseJournalLineSummary{code: "1000", debit: 0, credit: 19_500}) ||
		lines[1] != (expenseJournalLineSummary{code: "1205", debit: 0, credit: 9_500}) ||
		lines[2] != (expenseJournalLineSummary{code: "2100", debit: 29_000, credit: 0}) {
		t.Fatalf("settlement lines = %+v, want 2100 debited 29000 and 1205/1000 credited", lines)
	}
	var filingTax int64
	var filingReturnID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT tax_minor, tax_return_id::text FROM sales_tax_filings WHERE id = $1::uuid`, filed.FilingID).
		Scan(&filingTax, &filingReturnID); err != nil {
		t.Fatal(err)
	}
	if filingTax != 19_500 || filingReturnID != amendment.TaxReturnID {
		t.Fatalf("stored filing = tax %d return %s", filingTax, filingReturnID)
	}
	if got := fx.count(`SELECT count(*) FROM tax_returns WHERE id = $1::uuid AND settlement_entry_id = $2::uuid AND settled_at IS NOT NULL`, amendment.TaxReturnID, filed.EntryID); got != 1 {
		t.Fatalf("amendment settlement link rows = %d, want 1", got)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (FileSalesTaxReturnOutput, error) {
		return executeFileSalesTaxReturn(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: amendment.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "this tax return already has a recorded settlement" {
		t.Fatalf("executeFileSalesTaxReturn(again) error = %v", err)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnAmendmentOutput, error) {
		return executeCreateTaxReturnAmendment(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: amendment.TaxReturnID}, now)
	})
	if err != nil {
		t.Fatalf("executeCreateTaxReturnAmendment(second): %v", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnSubmissionOutput, error) {
		return executeRecordTaxReturnSubmission(fx.ctx, tx, claims, RecordTaxReturnSubmissionInput{
			TaxReturnID: second.TaxReturnID, SubmissionReference: "P", EvidenceReference: "E",
		}, now)
	}); err != nil {
		t.Fatalf("executeRecordTaxReturnSubmission(second): %v", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnAcknowledgmentOutput, error) {
		return executeRecordTaxReturnAcknowledgment(fx.ctx, tx, claims, RecordTaxReturnAcknowledgmentInput{
			TaxReturnID: second.TaxReturnID, Status: "accepted",
		}, now)
	}); err != nil {
		t.Fatalf("executeRecordTaxReturnAcknowledgment(second): %v", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (FileSalesTaxReturnOutput, error) {
		return executeFileSalesTaxReturn(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: second.TaxReturnID}, now)
	})
	if err == nil || err.Error() != "this return has no new tax balance to settle" {
		t.Fatalf("executeFileSalesTaxReturn(no delta) error = %v", err)
	}
	if got := fx.count(`SELECT count(*) FROM sales_tax_filings WHERE tax_return_id = $1::uuid`, second.TaxReturnID); got != 0 {
		t.Fatalf("filings after refused settle = %d, want 0", got)
	}

	november5 := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	november15 := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	invoiceNovember := seedTaxReturnInvoice(t, fx, fx.orgID, customer, "USD", "sent", 50_000, 19_000, &november5, nil)
	seedTaxReturnInvoiceLine(t, fx, invoiceNovember, "Consulting", 1000, 50_000, 19_000, &outputVAT, &rate19)
	billNovember := seedTaxReturnBill(t, fx, fx.orgID, vendor, "USD", "open", 119_500, &november15)
	seedTaxReturnBillLine(t, fx, billNovember, "Hardware", 1000, 100_000, 19_000, inputVAT, &rate19)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Fixture sales credit note", SourceType: "invoice_credit_note", SourceID: &invoiceNovember,
			Currency: "USD", PostedAt: november15, ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{{AccountCode: "2100", DebitMinor: 3_000}, {AccountCode: "1000", CreditMinor: 3_000}},
		})
	}); err != nil {
		t.Fatalf("seed credit note: %v", err)
	}

	refundReturn, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateTaxReturnOutput, error) {
		return executeCreateTaxReturn(fx.ctx, tx, claims, CreateTaxReturnInput{PeriodFrom: "2026-11-01", PeriodTo: "2026-11-30"}, now)
	})
	if err != nil || refundReturn.OutputTaxMinor != 16_000 || refundReturn.InputTaxMinor != 19_000 || refundReturn.TaxMinor != -3_000 {
		t.Fatalf("executeCreateTaxReturn(November) = %+v, %v, want 16000/19000/-3000 after credit note", refundReturn, err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnSubmissionOutput, error) {
		return executeRecordTaxReturnSubmission(fx.ctx, tx, claims, RecordTaxReturnSubmissionInput{
			TaxReturnID: refundReturn.TaxReturnID, SubmissionReference: "P", EvidenceReference: "E",
		}, now)
	}); err != nil {
		t.Fatalf("executeRecordTaxReturnSubmission(November): %v", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordTaxReturnAcknowledgmentOutput, error) {
		return executeRecordTaxReturnAcknowledgment(fx.ctx, tx, claims, RecordTaxReturnAcknowledgmentInput{
			TaxReturnID: refundReturn.TaxReturnID, Status: "accepted",
		}, now)
	}); err != nil {
		t.Fatalf("executeRecordTaxReturnAcknowledgment(November): %v", err)
	}
	refundFiling, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (FileSalesTaxReturnOutput, error) {
		return executeFileSalesTaxReturn(fx.ctx, tx, claims, TaxReturnIDInput{TaxReturnID: refundReturn.TaxReturnID}, now)
	})
	if err != nil || refundFiling.TaxMinor != -3_000 {
		t.Fatalf("executeFileSalesTaxReturn(refund) = %+v, %v, want -3000 receivable", refundFiling, err)
	}
	lines = taxReturnEntryLines(t, fx, refundFiling.EntryID)
	if len(lines) != 3 ||
		lines[0] != (expenseJournalLineSummary{code: "1205", debit: 0, credit: 19_000}) ||
		lines[1] != (expenseJournalLineSummary{code: "1206", debit: 3_000, credit: 0}) ||
		lines[2] != (expenseJournalLineSummary{code: "2100", debit: 16_000, credit: 0}) {
		t.Fatalf("refund settlement lines = %+v, want 1206 receivable debited", lines)
	}
	if got := fx.count(`SELECT count(*) FROM accounts WHERE org_id = $1::uuid AND code = '1206' AND name = 'Tax refund receivable' AND type = 'asset'`, fx.orgID); got != 1 {
		t.Fatalf("tax refund receivable accounts = %d, want 1 created by the filing", got)
	}
	var novemberFilingTax int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT tax_minor FROM sales_tax_filings WHERE id = $1::uuid`, refundFiling.FilingID).Scan(&novemberFilingTax); err != nil {
		t.Fatal(err)
	}
	if novemberFilingTax != -3_000 {
		t.Fatalf("stored refund filing tax = %d, want -3000", novemberFilingTax)
	}
	if drift := fx.count(`SELECT count(*) FROM journal_entries je WHERE je.org_id = $1::uuid AND (SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0) FROM journal_lines jl WHERE jl.entry_id = je.id) <> 0`, fx.orgID); drift != 0 {
		t.Fatalf("unbalanced settlement entries = %d, want 0", drift)
	}
}
