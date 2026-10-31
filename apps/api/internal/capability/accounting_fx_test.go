package capability

import (
	"encoding/json"
	"math/big"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func accountingFxClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func accountingFxOrgClaims(fx *executorFixture, orgID string) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: orgID, ActorType: "human", ActorID: &actorID}
}

// cleanupAccountingFxLedger removes every FX fixture row in reverse dependency
// order: revaluations before the entries they reference, journal lines before
// entries, rates before invoices, invoices before customers and accounts.
// Posted ledger rows refuse DELETE unless the transaction enables
// app.ledger_maintenance first.
func cleanupAccountingFxLedger(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin accounting fx fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable accounting fx fixture ledger cleanup: %v", err)
			return
		}
		statements := []string{
			`DELETE FROM period_fx_revaluations WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM fx_rates WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM invoices WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM periods WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, statement := range statements {
			if _, err := tx.Exec(fx.ctx, statement, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("accounting fx fixture cleanup %q: %v", statement, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit accounting fx fixture cleanup: %v", err)
		}
	})
}

func seedAccountingFxInvoice(t *testing.T, fx *executorFixture, orgID, currency, status string, totalMinor, paidMinor, creditedMinor int64, issuedAt *time.Time, voidedAt *time.Time, fxRateNum, fxRateDen *int64) string {
	t.Helper()
	var id string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, fx_rate_num, fx_rate_den, issued_at, voided_at)
		VALUES ($1::uuid, (SELECT id FROM customers WHERE org_id = $1::uuid LIMIT 1), (SELECT coalesce(max(number), 0) + 1 FROM invoices WHERE org_id = $1::uuid), $2, $3, $4, 0, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text`, orgID, status, currency, totalMinor, paidMinor, creditedMinor, fxRateNum, fxRateDen, issuedAt, voidedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedAccountingFxRate(t *testing.T, fx *executorFixture, orgID, base, quote string, num, den int64, effectiveAt time.Time) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO fx_rates (org_id, base, quote, rate_num, rate_den, effective_at, source, recorded_by_actor_type, recorded_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, 'manual', 'human', $7::uuid)`, orgID, base, quote, num, den, effectiveAt, fx.userID); err != nil {
		t.Fatal(err)
	}
}

func seedAccountingFxBase(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, '1100', 'Accounts Receivable', 'asset')`, orgID); err != nil {
		t.Fatal(err)
	}
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Accounting FX fixture customer')
		RETURNING id::text`, orgID).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func accountingFxExecuteRevalue(fx *executorFixture, orgID string, claims authbridge.CapabilityClaims, year, month int64, now time.Time) (RevalueForeignReceivablesOutput, error) {
	return dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (RevalueForeignReceivablesOutput, error) {
		return executeRevalueForeignReceivables(fx.ctx, tx, claims, ClosePeriodInput{Year: year, Month: month}, now)
	})
}

func accountingFxExecuteReverse(fx *executorFixture, orgID string, claims authbridge.CapabilityClaims, revaluationID, reason string, now time.Time) (ReversePeriodFxRevaluationOutput, error) {
	return dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (ReversePeriodFxRevaluationOutput, error) {
		return executeReversePeriodFxRevaluation(fx.ctx, tx, claims, ReversePeriodFxRevaluationInput{RevaluationID: revaluationID, Reason: reason}, now)
	})
}

type accountingFxLineSummary struct {
	code   string
	debit  int64
	credit int64
}

func accountingFxEntryLines(t *testing.T, fx *executorFixture, entryID string) []accountingFxLineSummary {
	t.Helper()
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
		WHERE jl.entry_id = $1::uuid ORDER BY jl.id`, entryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	lines := make([]accountingFxLineSummary, 0, 2)
	for rows.Next() {
		var line accountingFxLineSummary
		if err := rows.Scan(&line.code, &line.debit, &line.credit); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i].code < lines[j].code })
	return lines
}

func TestAccountingFxParsersMirrorZodContracts(t *testing.T) {
	if _, err := ParseUnrealizedFxExposureInput(json.RawMessage(`{"unexpected":1}`)); err != nil {
		t.Fatalf("ParseUnrealizedFxExposureInput() = %v", err)
	}
	for _, raw := range []string{`[]`, `"x"`, `null`, `3`} {
		if _, err := ParseUnrealizedFxExposureInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseUnrealizedFxExposureInput accepted %s", raw)
		}
	}

	if period, err := ParseRevalueForeignReceivablesInput(json.RawMessage(`{"year":2026,"month":8,"unexpected":1}`)); err != nil || period != (ClosePeriodInput{Year: 2026, Month: 8}) {
		t.Fatalf("ParseRevalueForeignReceivablesInput() = %+v, %v", period, err)
	}
	if boundary, err := ParseRevalueForeignReceivablesInput(json.RawMessage(`{"year":2000,"month":12}`)); err != nil || boundary != (ClosePeriodInput{Year: 2000, Month: 12}) {
		t.Fatalf("ParseRevalueForeignReceivablesInput(2000-12) = %+v, %v", boundary, err)
	}
	if boundary, err := ParseRevalueForeignReceivablesInput(json.RawMessage(`{"year":2100,"month":1}`)); err != nil || boundary != (ClosePeriodInput{Year: 2100, Month: 1}) {
		t.Fatalf("ParseRevalueForeignReceivablesInput(2100-01) = %+v, %v", boundary, err)
	}
	for _, raw := range []string{
		`[]`,
		`{}`,
		`{"year":1999,"month":1}`,
		`{"year":2101,"month":1}`,
		`{"year":2026.5,"month":1}`,
		`{"year":2026,"month":0}`,
		`{"year":2026,"month":13}`,
		`{"year":2026,"month":null}`,
	} {
		if _, err := ParseRevalueForeignReceivablesInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseRevalueForeignReceivablesInput accepted %s", raw)
		}
	}

	validUUID := "5c9e1a52-6e3b-4c1a-9d3e-8a7f1b2c4d5e"
	if reversal, err := ParseReversePeriodFxRevaluationInput(json.RawMessage(`{"revaluationId":"` + validUUID + `","reason":"undo period-end FX revaluation","unexpected":true}`)); err != nil ||
		reversal != (ReversePeriodFxRevaluationInput{RevaluationID: validUUID, Reason: "undo period-end FX revaluation"}) {
		t.Fatalf("ParseReversePeriodFxRevaluationInput() = %+v, %v", reversal, err)
	}
	longReason := strings.Repeat("r", 501)
	for _, raw := range []string{
		`{}`,
		`{"revaluationId":"` + validUUID + `"}`,
		`{"reason":"undo period-end FX revaluation"}`,
		`{"revaluationId":"not-a-uuid","reason":"undo period-end FX revaluation"}`,
		`{"revaluationId":null,"reason":"undo period-end FX revaluation"}`,
		`{"revaluationId":"` + validUUID + `","reason":"no"}`,
		`{"revaluationId":"` + validUUID + `","reason":null}`,
		`{"revaluationId":"` + validUUID + `","reason":5}`,
		`{"revaluationId":"` + validUUID + `","reason":"` + longReason + `"}`,
		`[]`,
	} {
		if _, err := ParseReversePeriodFxRevaluationInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseReversePeriodFxRevaluationInput accepted %s", raw)
		}
	}

	validByCapability := map[string]string{
		unrealizedFxExposureCapabilityID:       `{}`,
		revalueForeignReceivablesCapabilityID:  `{"year":2026,"month":8}`,
		reversePeriodFxRevaluationCapabilityID: `{"revaluationId":"` + validUUID + `","reason":"undo period-end FX revaluation"}`,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingFxInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingFxInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingFxInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingFxInput accepted an unsupported capability")
	}

	if delta, err := fxRevaluationDeltaMinor(100_000, 110_000, 120_000); err != nil || delta != 10_000 {
		t.Fatalf("fxRevaluationDeltaMinor(gain) = %d, %v, want 10000", delta, err)
	}
	if delta, err := fxRevaluationDeltaMinor(100_000, 120_000, 110_000); err != nil || delta != -10_000 {
		t.Fatalf("fxRevaluationDeltaMinor(loss) = %d, %v, want -10000", delta, err)
	}
	for _, call := range []struct{ foreign, historical, close int64 }{
		{-1, 0, 0},
		{0, -1, 0},
		{0, 0, -1},
		{maxSafeInteger + 1, 0, 0},
		{0, maxSafeInteger + 1, 0},
	} {
		if _, err := fxRevaluationDeltaMinor(call.foreign, call.historical, call.close); err == nil {
			t.Errorf("fxRevaluationDeltaMinor(%d, %d, %d) accepted invalid input", call.foreign, call.historical, call.close)
		}
	}

	encoded, err := marshalJS(RevalueForeignReceivablesOutput{Currencies: []FxRevaluationCurrencyLine{}})
	if err != nil || string(encoded) != `{"revaluationId":"","entryId":null,"totalAdjustmentMinor":0,"currencies":[],"alreadyReviewed":false}` {
		t.Fatalf("revalue output zero JSON = %s, %v", encoded, err)
	}
	encoded, err = marshalJS(ReversePeriodFxRevaluationOutput{Year: 2026, Month: 8})
	if err != nil || string(encoded) != `{"entryId":null,"year":2026,"month":8}` {
		t.Fatalf("reversal output zero JSON = %s, %v", encoded, err)
	}
	encoded, err = marshalJS(UnrealizedFxExposureOutput{Exposures: []UnrealizedFxExposureRow{}})
	if err != nil || string(encoded) != `{"exposures":[]}` {
		t.Fatalf("exposure output zero JSON = %s, %v", encoded, err)
	}
}

func TestAccountingFxUnrealizedExposureNetsCreditsAndScopesByOrg(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFxLedger(t, fx)
	seedAccountingFxBase(t, fx, fx.orgID)
	seedAccountingFxBase(t, fx, fx.otherOrgID)

	issued := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 200_000, 0, 50_000, &issued, nil, nil, nil)
	overpaid := int64(300_000)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 100_000, overpaid, 0, &issued, nil, nil, nil)
	seedAccountingFxInvoice(t, fx, fx.orgID, "GBP", "sent", 100_000, overpaid, 0, &issued, nil, nil, nil)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "void", 90_000, 0, 0, &issued, &issued, nil, nil)
	seedAccountingFxInvoice(t, fx, fx.orgID, "USD", "sent", 70_000, 0, 0, &issued, nil, nil, nil)
	jpyTotal := int64(10_000)
	seedAccountingFxInvoice(t, fx, fx.orgID, "JPY", "sent", jpyTotal, 0, 0, &issued, nil, nil, nil)
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "EUR", 11, 10, time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "JPY", 1, 150, time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))
	foreignIssued := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.otherOrgID, "EUR", "sent", 60_000, 0, 0, &foreignIssued, nil, nil, nil)

	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	exposure, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (UnrealizedFxExposureOutput, error) {
		return executeUnrealizedFxExposure(fx.ctx, tx, fx.orgID, UnrealizedFxExposureInput{}, now)
	})
	if err != nil {
		t.Fatalf("executeUnrealizedFxExposure: %v", err)
	}
	eurNum, eurDen := int64(11), int64(10)
	eurBase := int64(165_000)
	jpyNum, jpyDen := int64(1), int64(150)
	jpyBase := int64(6_667)
	want := UnrealizedFxExposureOutput{Exposures: []UnrealizedFxExposureRow{
		{Currency: "EUR", OutstandingForeignMinor: 150_000, LatestRateNum: &eurNum, LatestRateDen: &eurDen, OutstandingBaseMinor: &eurBase},
		{Currency: "GBP", OutstandingForeignMinor: 0},
		{Currency: "JPY", OutstandingForeignMinor: 10_000, LatestRateNum: &jpyNum, LatestRateDen: &jpyDen, OutstandingBaseMinor: &jpyBase},
	}}
	encoded, err := marshalJS(exposure)
	if err != nil {
		t.Fatal(err)
	}
	wantEncoded, err := marshalJS(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != string(wantEncoded) {
		t.Fatalf("exposure JSON = %s, want %s", encoded, wantEncoded)
	}

	foreign, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (UnrealizedFxExposureOutput, error) {
		return executeUnrealizedFxExposure(fx.ctx, tx, fx.otherOrgID, UnrealizedFxExposureInput{}, now)
	})
	if err != nil {
		t.Fatalf("executeUnrealizedFxExposure(foreign): %v", err)
	}
	if len(foreign.Exposures) != 1 || foreign.Exposures[0].Currency != "EUR" || foreign.Exposures[0].OutstandingForeignMinor != 60_000 ||
		foreign.Exposures[0].LatestRateNum != nil || foreign.Exposures[0].LatestRateDen != nil || foreign.Exposures[0].OutstandingBaseMinor != nil {
		t.Fatalf("foreign exposure = %+v, want EUR 60000 with no leaked rates", foreign.Exposures)
	}
}

func TestAccountingFxExposureRejectsUnsafeAggregates(t *testing.T) {
	totals := make(map[string]*big.Int)
	if err := addFxExposureOutstanding(totals, "EUR", maxSafeInteger); err != nil {
		t.Fatalf("add first safe exposure: %v", err)
	}
	if err := addFxExposureOutstanding(totals, "EUR", 1); err == nil {
		t.Fatal("FX exposure accepted a currency aggregate above JavaScript's safe-integer range")
	}
}

func TestAccountingFxRevaluePostsBalancedAdjustmentOnce(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFxLedger(t, fx)
	seedAccountingFxBase(t, fx, fx.orgID)
	claims := accountingFxClaims(fx)
	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	historicalNum, historicalDen := int64(11), int64(10)
	augustIssued := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 100_000, 0, 0, &augustIssued, nil, &historicalNum, &historicalDen)
	julyIssued := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 50_000, 0, 0, &julyIssued, nil, &historicalNum, &historicalDen)

	_, err := accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 7, now)
	wantNoRate := "no USD/EUR rate effective at period end; record a close rate before revaluation"
	if err == nil || err.Error() != wantNoRate {
		t.Fatalf("revalue(July, no close rate) error = %v, want %q", err, wantNoRate)
	}
	if got := fx.count(`SELECT count(*) FROM period_fx_revaluations WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("refused revaluation left %d rows, want 0", got)
	}

	seedAccountingFxRate(t, fx, fx.orgID, "USD", "EUR", 11, 10, time.Date(2026, 7, 5, 0, 0, 0, 0, time.UTC))
	zero, err := accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 7, now)
	if err != nil {
		t.Fatalf("revalue(July, rate matches historical): %v", err)
	}
	if zero.EntryID != nil || zero.TotalAdjustmentMinor != 0 || zero.AlreadyReviewed || len(zero.Currencies) != 1 ||
		zero.Currencies[0] != (FxRevaluationCurrencyLine{Currency: "EUR", ForeignMinor: 50_000, HistoricalBaseMinor: 55_000, CloseBaseMinor: 55_000, AdjustmentMinor: 0, RateNum: 11, RateDen: 10}) {
		t.Fatalf("zero revalue output = %+v, want a no-entry revaluation", zero)
	}
	var julyEntry *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT entry_id::text FROM period_fx_revaluations WHERE id = $1::uuid`, zero.RevaluationID).Scan(&julyEntry); err != nil {
		t.Fatal(err)
	}
	if julyEntry != nil {
		t.Fatalf("zero revaluation stored entry %v, want null", julyEntry)
	}

	seedAccountingFxRate(t, fx, fx.orgID, "USD", "EUR", 12, 10, time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC))
	revalued, err := accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 8, now)
	if err != nil {
		t.Fatalf("revalue(August): %v", err)
	}
	if !isUUID(revalued.RevaluationID) || revalued.EntryID == nil || revalued.TotalAdjustmentMinor != 15_000 || revalued.AlreadyReviewed ||
		len(revalued.Currencies) != 1 ||
		revalued.Currencies[0] != (FxRevaluationCurrencyLine{Currency: "EUR", ForeignMinor: 150_000, HistoricalBaseMinor: 165_000, CloseBaseMinor: 180_000, AdjustmentMinor: 15_000, RateNum: 12, RateDen: 10}) {
		t.Fatalf("August revalue output = %+v, want a 15000 gain revaluation over both open invoices", revalued)
	}
	encoded, err := marshalJS(revalued)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"revaluationId":"` + revalued.RevaluationID + `","entryId":"` + *revalued.EntryID + `","totalAdjustmentMinor":15000,` +
		`"currencies":[{"currency":"EUR","foreignMinor":150000,"historicalBaseMinor":165000,"closeBaseMinor":180000,"adjustmentMinor":15000,"rateNum":12,"rateDen":10}],` +
		`"alreadyReviewed":false}`
	if string(encoded) != wantJSON {
		t.Fatalf("revalue JSON = %s, want %s", encoded, wantJSON)
	}

	var memo, sourceType, currency string
	var postedAt time.Time
	var sourceID, reversalOfID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, currency, posted_at, source_id::text, reversal_of_id::text
		FROM journal_entries WHERE id = $1::uuid`, *revalued.EntryID).
		Scan(&memo, &sourceType, &currency, &postedAt, &sourceID, &reversalOfID); err != nil {
		t.Fatal(err)
	}
	if memo != "FX revaluation 2026-08" || sourceType != "fx_revaluation" || currency != "USD" ||
		!postedAt.Equal(time.Date(2026, 8, 31, 23, 59, 59, 999_000_000, time.UTC)) || sourceID != nil || reversalOfID != nil {
		t.Fatalf("revaluation entry = memo %q source %s currency %s posted %v sourceId %v reversalOf %v", memo, sourceType, currency, postedAt, sourceID, reversalOfID)
	}
	if lines := accountingFxEntryLines(t, fx, *revalued.EntryID); len(lines) != 2 ||
		lines[0] != (accountingFxLineSummary{code: "1100", debit: 15_000, credit: 0}) ||
		lines[1] != (accountingFxLineSummary{code: "7910", debit: 0, credit: 15_000}) {
		t.Fatalf("revaluation lines = %+v, want AR debited and FX gain credited", lines)
	}
	var gainName, gainType string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name, type FROM accounts WHERE org_id = $1::uuid AND code = '7910'`, fx.orgID).Scan(&gainName, &gainType); err != nil {
		t.Fatal(err)
	}
	if gainName != "Unrealized FX gain" || gainType != "income" {
		t.Fatalf("lazily created 7910 = %q/%q", gainName, gainType)
	}

	var storedEntry *string
	var storedReversal *string
	var storedReversed *time.Time
	var storedTotal int64
	var storedSnapshot string
	var storedReviewed time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT entry_id::text, reversal_entry_id::text, reversed_at, total_adjustment_minor, rate_snapshot::text, reviewed_at
		FROM period_fx_revaluations WHERE id = $1::uuid`, revalued.RevaluationID).
		Scan(&storedEntry, &storedReversal, &storedReversed, &storedTotal, &storedSnapshot, &storedReviewed); err != nil {
		t.Fatal(err)
	}
	if storedEntry == nil || *storedEntry != *revalued.EntryID || storedReversal != nil || storedReversed != nil || storedTotal != 15_000 || !storedReviewed.Equal(now) {
		t.Fatalf("stored revaluation = entry %v reversal %v reversed %v total %d reviewed %v", storedEntry, storedReversal, storedReversed, storedTotal, storedReviewed)
	}
	var snapshot []FxRevaluationRateSnapshot
	if err := json.Unmarshal([]byte(storedSnapshot), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot) != 1 || snapshot[0] != (FxRevaluationRateSnapshot{Currency: "EUR", RateNum: 12, RateDen: 10, ForeignMinor: 150_000, HistoricalBaseMinor: 165_000, CloseBaseMinor: 180_000}) {
		t.Fatalf("stored rate snapshot = %+v, want one EUR row at the close rate", snapshot)
	}

	_, err = accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 8, now)
	wantLocked := "this period already has an FX revaluation; reverse it before recalculating"
	if err == nil || err.Error() != wantLocked {
		t.Fatalf("revalue(August again) error = %v, want %q", err, wantLocked)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid AND source_type = 'fx_revaluation'`, fx.orgID); got != 1 {
		t.Fatalf("fx_revaluation entries after refused recalc = %d, want still 1", got)
	}

	juneIssued := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	juneInvoice := seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 10_000, 0, 0, &juneIssued, nil, nil, nil)
	_, err = accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 6, now)
	wantNoSnapshot := "invoice in EUR has no historical FX snapshot"
	if err == nil || err.Error() != wantNoSnapshot {
		t.Fatalf("revalue(June, no snapshot) error = %v, want %q", err, wantNoSnapshot)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE invoices SET fx_rate_num = 11, fx_rate_den = 10 WHERE id = $1::uuid`, juneInvoice); err != nil {
		t.Fatal(err)
	}

	if _, err := accountingFxExecuteReverse(fx, fx.orgID, claims, revalued.RevaluationID, "reopen for the sealed-period guard", now); err != nil {
		t.Fatal(err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO periods (org_id, year, month) VALUES ($1::uuid, 2026, 8)`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	_, err = accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 8, now)
	wantSealed := "period 2026-08 is closed; post to the current period or reopen it"
	if err == nil || err.Error() != wantSealed {
		t.Fatalf("revalue(sealed August) error = %v, want %q", err, wantSealed)
	}
}

func TestAccountingFxReversalMirrorsEntryAndAllowsRecalc(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFxLedger(t, fx)
	seedAccountingFxBase(t, fx, fx.orgID)
	claims := accountingFxClaims(fx)
	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	historicalNum, historicalDen := int64(11), int64(10)
	augustIssued := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 100_000, 0, 0, &augustIssued, nil, &historicalNum, &historicalDen)
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "EUR", 12, 10, time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC))

	revalued, err := accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 8, now)
	if err != nil {
		t.Fatalf("revalue(August): %v", err)
	}
	originalEntryID := *revalued.EntryID

	_, err = accountingFxExecuteReverse(fx, fx.otherOrgID, accountingFxOrgClaims(fx, fx.otherOrgID), revalued.RevaluationID, "cross tenant attempt", now)
	wantMissing := "FX revaluation not found or already reversed"
	if err == nil || err.Error() != wantMissing {
		t.Fatalf("reverse(cross org) error = %v, want %q", err, wantMissing)
	}
	if _, err := accountingFxExecuteReverse(fx, fx.orgID, claims, "7c9e6679-7425-40de-944b-e07fc1f90ae7", "unknown revaluation", now); err == nil || err.Error() != wantMissing {
		t.Fatalf("reverse(unknown id) error = %v, want %q", err, wantMissing)
	}

	reason := "recalculate from corrected rates"
	reversed, err := accountingFxExecuteReverse(fx, fx.orgID, claims, revalued.RevaluationID, reason, now)
	if err != nil {
		t.Fatalf("reverse: %v", err)
	}
	if reversed.EntryID == nil || reversed.Year != 2026 || reversed.Month != 8 {
		t.Fatalf("reverse output = %+v, want a 2026-8 reversal receipt", reversed)
	}
	encoded, err := marshalJS(reversed)
	if err != nil || string(encoded) != `{"entryId":"`+*reversed.EntryID+`","year":2026,"month":8}` {
		t.Fatalf("reverse JSON = %s, %v", encoded, err)
	}
	var memo, sourceType, currency string
	var sourceID, reversalOfID *string
	var postedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, currency, posted_at, source_id::text, reversal_of_id::text
		FROM journal_entries WHERE id = $1::uuid`, *reversed.EntryID).
		Scan(&memo, &sourceType, &currency, &postedAt, &sourceID, &reversalOfID); err != nil {
		t.Fatal(err)
	}
	if memo != "Reverse FX revaluation 2026-08: "+reason || sourceType != "fx_revaluation_reversal" || currency != "USD" ||
		!postedAt.Equal(now) || sourceID == nil || *sourceID != revalued.RevaluationID || reversalOfID == nil || *reversalOfID != originalEntryID {
		t.Fatalf("reversal entry = memo %q source %s currency %s posted %v sourceId %v reversalOf %v", memo, sourceType, currency, postedAt, sourceID, reversalOfID)
	}
	if lines := accountingFxEntryLines(t, fx, *reversed.EntryID); len(lines) != 2 ||
		lines[0] != (accountingFxLineSummary{code: "1100", debit: 0, credit: 10_000}) ||
		lines[1] != (accountingFxLineSummary{code: "7910", debit: 10_000, credit: 0}) {
		t.Fatalf("reversal lines = %+v, want the revaluation mirrored", lines)
	}
	var storedReversed *time.Time
	var storedReversalEntry *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT reversed_at, reversal_entry_id::text FROM period_fx_revaluations WHERE id = $1::uuid`, revalued.RevaluationID).
		Scan(&storedReversed, &storedReversalEntry); err != nil {
		t.Fatal(err)
	}
	if storedReversed == nil || storedReversalEntry == nil || *storedReversalEntry != *reversed.EntryID {
		t.Fatalf("stored reversal = reversed %v entry %v, want stamped with the reversal entry", storedReversed, storedReversalEntry)
	}

	if _, err := accountingFxExecuteReverse(fx, fx.orgID, claims, revalued.RevaluationID, reason, now); err == nil || err.Error() != wantMissing {
		t.Fatalf("reverse(already reversed) error = %v, want %q", err, wantMissing)
	}

	seedAccountingFxRate(t, fx, fx.orgID, "USD", "EUR", 13, 10, time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC))
	recalculated, err := accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 8, now)
	if err != nil {
		t.Fatalf("revalue(after reversal): %v", err)
	}
	if recalculated.RevaluationID != revalued.RevaluationID || recalculated.EntryID == nil || *recalculated.EntryID == originalEntryID ||
		recalculated.TotalAdjustmentMinor != 20_000 || recalculated.AlreadyReviewed ||
		recalculated.Currencies[0].CloseBaseMinor != 130_000 || recalculated.Currencies[0].AdjustmentMinor != 20_000 {
		t.Fatalf("recalculated revalue = %+v, want the same revaluation row updated to a 20000 gain", recalculated)
	}
	var resetReversed *time.Time
	var resetReversalEntry *string
	var resetEntry *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT reversed_at, reversal_entry_id::text, entry_id::text FROM period_fx_revaluations WHERE id = $1::uuid`, revalued.RevaluationID).
		Scan(&resetReversed, &resetReversalEntry, &resetEntry); err != nil {
		t.Fatal(err)
	}
	if resetReversed != nil || resetReversalEntry != nil || resetEntry == nil || *resetEntry != *recalculated.EntryID {
		t.Fatalf("recalculated row = reversed %v reversalEntry %v entry %v, want reset for the fresh entry", resetReversed, resetReversalEntry, resetEntry)
	}

	reversedAgain, err := accountingFxExecuteReverse(fx, fx.orgID, claims, revalued.RevaluationID, "second correction", now)
	if err != nil {
		t.Fatalf("reverse(recalculated): %v", err)
	}
	if reversedAgain.EntryID == nil || *reversedAgain.EntryID == *reversed.EntryID {
		t.Fatalf("second reversal = %+v, want a fresh reversal entry", reversedAgain)
	}
	if drift := fx.count(`SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.org_id = $1::uuid`, fx.orgID); drift != 0 {
		t.Fatalf("journal drift = %d, want balanced books", drift)
	}
}

func TestAccountingFxReversalOfZeroAdjustmentMarksReversed(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFxLedger(t, fx)
	seedAccountingFxBase(t, fx, fx.orgID)
	claims := accountingFxClaims(fx)
	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	historicalNum, historicalDen := int64(11), int64(10)
	julyIssued := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 50_000, 0, 0, &julyIssued, nil, &historicalNum, &historicalDen)
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "EUR", 11, 10, time.Date(2026, 7, 5, 0, 0, 0, 0, time.UTC))

	zero, err := accountingFxExecuteRevalue(fx, fx.orgID, claims, 2026, 7, now)
	if err != nil {
		t.Fatalf("revalue(July zero): %v", err)
	}
	if zero.EntryID != nil {
		t.Fatalf("zero revalue entry = %v, want nil", zero.EntryID)
	}
	reversed, err := accountingFxExecuteReverse(fx, fx.orgID, claims, zero.RevaluationID, "reopen the close", now)
	if err != nil {
		t.Fatalf("reverse(zero revaluation): %v", err)
	}
	if encoded, err := marshalJS(reversed); err != nil || string(encoded) != `{"entryId":null,"year":2026,"month":7}` {
		t.Fatalf("zero reversal JSON = %s, %v", encoded, err)
	}
	var storedReversed *time.Time
	var storedReversalEntry *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT reversed_at, reversal_entry_id::text FROM period_fx_revaluations WHERE id = $1::uuid`, zero.RevaluationID).
		Scan(&storedReversed, &storedReversalEntry); err != nil {
		t.Fatal(err)
	}
	if storedReversed == nil || storedReversalEntry != nil {
		t.Fatalf("stored zero reversal = reversed %v entry %v, want reversed with null entry", storedReversed, storedReversalEntry)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("journal entries after zero revaluation cycle = %d, want 0", got)
	}
}
