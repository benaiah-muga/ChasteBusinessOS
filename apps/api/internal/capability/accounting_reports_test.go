package capability

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestAccountingReportsParsersMirrorZodContracts(t *testing.T) {
	for _, fn := range []func(json.RawMessage) error{
		func(raw json.RawMessage) error { _, err := ParseReportCurrencyMetadataInput(raw); return err },
		func(raw json.RawMessage) error { _, err := ParseIncomeStatementInput(raw); return err },
		func(raw json.RawMessage) error { _, err := ParseBalanceSheetInput(raw); return err },
		func(raw json.RawMessage) error { _, err := ParseArAgingInput(raw); return err },
	} {
		if err := fn(json.RawMessage(`{}`)); err != nil {
			t.Fatalf("empty object input must parse: %v", err)
		}
		for _, bad := range []string{`[]`, `"x"`, `null`} {
			if err := fn(json.RawMessage(bad)); err == nil {
				t.Errorf("input %s must be refused like a non-object zod payload", bad)
			}
		}
	}
	for _, extra := range []string{`{"currency":"USD"}`, `{"unknown":true}`} {
		if _, err := ParseReportCurrencyMetadataInput(json.RawMessage(extra)); err != nil {
			t.Errorf("ParseReportCurrencyMetadataInput must strip unknown fields like z.object({}): %s: %v", extra, err)
		}
	}

	listed, err := ParseListInvoicesInput(json.RawMessage(`{}`))
	if err != nil || listed.CustomerID != nil || listed.Status != nil || listed.Limit != 50 {
		t.Fatalf("ParseListInvoicesInput({}) = %+v, %v, want default limit 50", listed, err)
	}
	encoded, err := marshalJS(listed)
	if err != nil || string(encoded) != `{"limit":50}` {
		t.Fatalf("default list invoices JSON = %s, %v", encoded, err)
	}
	customerID := "22222222-2222-4222-8222-222222222222"
	full, err := ParseListInvoicesInput(json.RawMessage(`{"customerId":"` + customerID + `","status":"sent","limit":100,"unknown":true}`))
	if err != nil || full.CustomerID == nil || *full.CustomerID != customerID || full.Status == nil || *full.Status != "sent" || full.Limit != 100 {
		t.Fatalf("ParseListInvoicesInput(full) = %+v, %v", full, err)
	}
	for _, bad := range []string{
		`{"status":"refunded"}`,
		`{"status":null}`,
		`{"limit":0}`,
		`{"limit":101}`,
		`{"limit":50.5}`,
		`{"limit":null}`,
		`{"customerId":null}`,
	} {
		if _, err := ParseListInvoicesInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseListInvoicesInput accepted %s", bad)
		}
	}

	cashBasis, err := ParseCashBasisReportInput(json.RawMessage(`{"year":2026,"month":2}`))
	if err != nil || cashBasis.Year != 2026 || cashBasis.Month == nil || *cashBasis.Month != 2 {
		t.Fatalf("ParseCashBasisReportInput(month) = %+v, %v", cashBasis, err)
	}
	if len(cashBasis.CashAccountCodes) != 1 || cashBasis.CashAccountCodes[0] != "1000" {
		t.Fatalf("cash account default = %v, want [1000]", cashBasis.CashAccountCodes)
	}
	yearOnly, err := ParseCashBasisReportInput(json.RawMessage(`{"year":2026,"cashAccountCodes":["1000","1050"]}`))
	if err != nil || yearOnly.Month != nil || len(yearOnly.CashAccountCodes) != 2 {
		t.Fatalf("ParseCashBasisReportInput(year only) = %+v, %v", yearOnly, err)
	}
	for _, bad := range []string{
		`{}`,
		`{"year":1999}`,
		`{"year":2101}`,
		`{"year":2026.5}`,
		`{"year":null}`,
		`{"year":2026,"month":0}`,
		`{"year":2026,"month":13}`,
		`{"year":2026,"month":null}`,
		`{"year":2026,"cashAccountCodes":null}`,
		`{"year":2026,"cashAccountCodes":"1000"}`,
		`{"year":2026,"cashAccountCodes":[1]}`,
	} {
		if _, err := ParseCashBasisReportInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseCashBasisReportInput accepted %s", bad)
		}
	}

	cashFlow, err := ParseCashFlowInput(json.RawMessage(`{}`))
	if err != nil || len(cashFlow.CashAccountCodes) != 1 || cashFlow.CashAccountCodes[0] != "1000" {
		t.Fatalf("ParseCashFlowInput({}) = %+v, %v", cashFlow, err)
	}
	for _, bad := range []string{`{"cashAccountCodes":null}`, `{"cashAccountCodes":3}`} {
		if _, err := ParseCashFlowInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseCashFlowInput accepted %s", bad)
		}
	}

	forecast, err := ParseCashForecastInput(json.RawMessage(`{"budgetScenarioId":"` + customerID + `","cashAccountCodes":["1050"]}`))
	if err != nil || forecast.BudgetScenarioID == nil || *forecast.BudgetScenarioID != customerID || len(forecast.CashAccountCodes) != 1 {
		t.Fatalf("ParseCashForecastInput(scenario) = %+v, %v", forecast, err)
	}
	bare, err := ParseCashForecastInput(json.RawMessage(`{}`))
	if err != nil || bare.BudgetScenarioID != nil || len(bare.CashAccountCodes) != 1 {
		t.Fatalf("ParseCashForecastInput({}) = %+v, %v", bare, err)
	}
	for _, bad := range []string{
		`{"budgetScenarioId":"nope"}`,
		`{"budgetScenarioId":null}`,
		`{"budgetScenarioId":5}`,
	} {
		if _, err := ParseCashForecastInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseCashForecastInput accepted %s", bad)
		}
	}

	statement, err := ParseCustomerStatementInput(json.RawMessage(`{"customerId":"` + customerID + `"}`))
	if err != nil || statement.CustomerID != customerID {
		t.Fatalf("ParseCustomerStatementInput = %+v, %v", statement, err)
	}
	for _, bad := range []string{`{}`, `{"customerId":"nope"}`, `{"customerId":null}`} {
		if _, err := ParseCustomerStatementInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseCustomerStatementInput accepted %s", bad)
		}
	}

	tax, err := ParseSalesTaxReportInput(json.RawMessage(`{"from":"2026-03-01","to":"2026-03-31"}`))
	if err != nil || tax.From != "2026-03-01" || tax.To != "2026-03-31" {
		t.Fatalf("ParseSalesTaxReportInput = %+v, %v", tax, err)
	}
	for _, bad := range []string{
		`{}`,
		`{"from":"2026-3-1","to":"2026-03-31"}`,
		`{"from":null,"to":"2026-03-31"}`,
		`{"from":"2026-03-01","to":null}`,
	} {
		if _, err := ParseSalesTaxReportInput(json.RawMessage(bad)); err == nil {
			t.Errorf("ParseSalesTaxReportInput accepted %s", bad)
		}
	}
	// Calendar strictness lives in the execute path (dateWindow), exactly as
	// the TypeScript schema only checks the shape here.
	if _, err := ParseSalesTaxReportInput(json.RawMessage(`{"from":"2026-03-01","to":"2026-13-01"}`)); err != nil {
		t.Fatalf("shape-only date validation expected: %v", err)
	}

	validByCapability := map[string]string{
		incomeStatementCapabilityID:   `{}`,
		balanceSheetCapabilityID:      `{}`,
		listInvoicesCapabilityID:      `{}`,
		arAgingCapabilityID:           `{}`,
		cashBasisReportCapabilityID:   `{"year":2026}`,
		customerStatementCapabilityID: `{"customerId":"` + customerID + `"}`,
		salesTaxReportCapabilityID:    `{"from":"2026-03-01","to":"2026-03-31"}`,
		cashFlowCapabilityID:          `{}`,
		cashForecastCapabilityID:      `{}`,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingReportInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingReportInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingReportInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingReportInput accepted an unsupported capability")
	}
}

func TestAccountingReportsDomainMathMirrorsErpCore(t *testing.T) {
	if got := reportSignedBalance(accountBalanceRow{debitMinor: 100, accountType: "asset"}); got != 100 {
		t.Fatalf("asset debit signed balance = %d, want 100", got)
	}
	if got := reportSignedBalance(accountBalanceRow{creditMinor: 100, accountType: "liability"}); got != 100 {
		t.Fatalf("liability credit signed balance = %d, want 100", got)
	}
	if got := reportSignedBalance(accountBalanceRow{debitMinor: 40, creditMinor: 90, accountType: "income"}); got != 50 {
		t.Fatalf("income signed balance = %d, want 50", got)
	}

	pnl, err := computeIncomeStatement([]accountBalanceRow{
		{code: "1000", name: "Cash", accountType: "asset", debitMinor: 500},
		{code: "4000", name: "Sales", accountType: "income", creditMinor: 8_000},
		{code: "6000", name: "Ops", accountType: "expense", debitMinor: 3_000},
	})
	if err != nil {
		t.Fatalf("computeIncomeStatement error = %v", err)
	}
	if pnl.RevenueMinor != 8_000 || pnl.ExpenseMinor != 3_000 || pnl.NetIncomeMinor != 5_000 ||
		len(pnl.Lines) != 2 || pnl.Lines[0].Code != "4000" || pnl.Lines[0].AmountMinor != 8_000 || pnl.Lines[1].AmountMinor != 3_000 {
		t.Fatalf("computeIncomeStatement = %+v", pnl)
	}

	balances := []accountBalanceRow{
		{code: "1000", name: "Cash", accountType: "asset", debitMinor: 3_200},
		{code: "1100", name: "AR", accountType: "asset", debitMinor: 800},
		{code: "2000", name: "AP", accountType: "liability", creditMinor: 1_000},
		{code: "3000", name: "Equity", accountType: "equity", creditMinor: 2_000},
		{code: "4000", name: "Sales", accountType: "income", creditMinor: 1_500},
		{code: "6000", name: "Ops", accountType: "expense", debitMinor: 500},
	}
	sheet, err := computeBalanceSheet(balances)
	if err != nil {
		t.Fatalf("computeBalanceSheet error = %v", err)
	}
	if sheet.AssetsMinor != 4_000 || sheet.LiabilitiesMinor != 1_000 || sheet.EquityMinor != 2_000 ||
		sheet.RetainedResultMinor != 1_000 || !sheet.Balanced {
		t.Fatalf("computeBalanceSheet = %+v, want balanced assets 4000", sheet)
	}
	corrupt, err := computeBalanceSheet([]accountBalanceRow{
		{code: "1000", name: "Cash", accountType: "asset", debitMinor: 999},
		{code: "3000", name: "Equity", accountType: "equity", creditMinor: 1_000},
	})
	if err != nil {
		t.Fatalf("computeBalanceSheet(corrupt) error = %v", err)
	}
	if corrupt.Balanced {
		t.Fatalf("computeBalanceSheet(corrupt) = %+v, want balanced false", corrupt)
	}
	if _, err := computeIncomeStatement([]accountBalanceRow{
		{code: "4000", name: "Sales A", accountType: "income", creditMinor: maxSafeInteger},
		{code: "4001", name: "Sales B", accountType: "income", creditMinor: 1},
	}); err == nil {
		t.Fatal("income statement must refuse an aggregate beyond JavaScript's safe integer range")
	}
	if _, err := computeBalanceSheet([]accountBalanceRow{
		{code: "1000", name: "Cash A", accountType: "asset", debitMinor: maxSafeInteger},
		{code: "1001", name: "Cash B", accountType: "asset", debitMinor: 1},
	}); err == nil {
		t.Fatal("balance sheet must refuse an aggregate beyond JavaScript's safe integer range")
	}

	outstanding, err := reportDocumentOutstandingMinor(10_000, 4_000, 1_000)
	if err != nil || outstanding != 5_000 {
		t.Fatalf("reportDocumentOutstandingMinor = %d, %v, want 5000", outstanding, err)
	}
	if outstanding, err = reportDocumentOutstandingMinor(100, 60, 50); err != nil || outstanding != 0 {
		t.Fatalf("over-allocated outstanding = %d, %v, want floored zero", outstanding, err)
	}
	if _, err = reportDocumentOutstandingMinor(-1, 0, 0); err == nil {
		t.Fatal("negative total must be refused")
	}

	if got := reportFloorDays(0); got != 0 {
		t.Fatalf("reportFloorDays(0) = %d", got)
	}
	if got := reportFloorDays(reportDayMillis - 1); got != 0 {
		t.Fatalf("reportFloorDays(DAY-1) = %d, want 0", got)
	}
	if got := reportFloorDays(reportDayMillis); got != 1 {
		t.Fatalf("reportFloorDays(DAY) = %d, want 1", got)
	}
	if got := reportFloorDays(-1); got != -1 {
		t.Fatalf("reportFloorDays(-1) = %d, want -1 like Math.floor", got)
	}
	if got := reportFloorDays(-reportDayMillis - 1); got != -2 {
		t.Fatalf("reportFloorDays(-DAY-1) = %d, want -2 like Math.floor", got)
	}

	now := time.Date(2026, 3, 25, 12, 0, 0, 0, time.UTC)
	day := func(days int) *time.Time {
		at := now.AddDate(0, 0, -days)
		return &at
	}
	buckets := computeReportAging([]reportReceivable{
		{invoiceNumber: 1, outstandingMinor: 100, issuedAt: *day(5), dueAt: day(30)},
		{invoiceNumber: 2, outstandingMinor: 200, issuedAt: *day(40), dueAt: day(31)},
		{invoiceNumber: 3, outstandingMinor: 400, issuedAt: *day(70), dueAt: day(61)},
		{invoiceNumber: 4, outstandingMinor: 800, issuedAt: *day(200), dueAt: day(91)},
		{invoiceNumber: 5, outstandingMinor: 1_600, issuedAt: *day(10)},
		{invoiceNumber: 6, outstandingMinor: 0, issuedAt: *day(400)},
	}, now)
	if buckets.Current != 100+1_600 || buckets.D30 != 200 || buckets.D60 != 400 || buckets.D90Plus != 800 || buckets.TotalOutstanding != 3_100 {
		t.Fatalf("computeReportAging buckets = %+v, want boundary values at 30/31, 60/61, 90/91", buckets)
	}

	cash := func(debitCode, creditCode string, amount int64, at time.Time, debitType, creditType string) reportCashBasisEntry {
		return reportCashBasisEntry{occurredAt: at, lines: []reportCashBasisLine{
			{accountCode: debitCode, accountType: debitType, debitMinor: amount},
			{accountCode: creditCode, accountType: creditType, creditMinor: amount},
		}}
	}
	entries := []reportCashBasisEntry{
		cash("1000", "4000", 8_000, time.Date(2026, 1, 10, 0, 0, 0, 0, time.UTC), "asset", "income"),
		cash("1100", "4000", 5_000, time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC), "asset", "income"),
		cash("1000", "1100", 3_000, time.Date(2026, 2, 15, 0, 0, 0, 0, time.UTC), "asset", "asset"),
		cash("6000", "1000", 2_000, time.Date(2026, 2, 20, 0, 0, 0, 0, time.UTC), "expense", "asset"),
	}
	basis, err := computeReportCashBasis(entries, map[string]struct{}{"1000": {}},
		toPointer(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), toPointer(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)))
	if err != nil {
		t.Fatal(err)
	}
	if basis.CashInMinor != 11_000 || basis.CashOutMinor != 2_000 || basis.NetCashMinor != 9_000 ||
		basis.AccrualRevenueMinor != 13_000 || basis.AccrualExpenseMinor != 2_000 || basis.UncollectedMinor != 2_000 {
		t.Fatalf("computeReportCashBasis = %+v, want cash 11000/2000 and accrual 13000/2000", basis)
	}
	openWindow, err := computeReportCashBasis(entries, map[string]struct{}{"1000": {}}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if openWindow.CashInMinor != 11_000 || openWindow.UncollectedMinor != 2_000 {
		t.Fatalf("computeReportCashBasis(open window) = %+v", openWindow)
	}

	operating, _, ok, err := classifyReportCashEntry([]reportCashBasisLine{
		{accountCode: "1000", accountType: "asset", debitMinor: 600},
		{accountCode: "1100", accountType: "asset", creditMinor: 600},
	}, map[string]struct{}{"1000": {}})
	if err != nil || !ok || operating != 600 {
		t.Fatalf("collection classification = %d, %v, want operating 600", operating, ok)
	}
	investing, category, ok, err := classifyReportCashEntry([]reportCashBasisLine{
		{accountCode: "1000", accountType: "asset", debitMinor: 500},
		{accountCode: "1500", accountType: "asset", creditMinor: 500},
	}, map[string]struct{}{"1000": {}})
	if err != nil || !ok || category != "investing" || investing != 500 {
		t.Fatalf("equipment classification = %d, %s, %v, want investing", investing, category, ok)
	}
	operatingCode, category, _, err := classifyReportCashEntry([]reportCashBasisLine{
		{accountCode: "1000", accountType: "asset", debitMinor: 500},
		{accountCode: "2100", accountType: "liability", creditMinor: 500},
	}, map[string]struct{}{"1000": {}})
	if category != "operating" || operatingCode != 500 {
		t.Fatalf("tax counter classification = %d, %s, want operating", operatingCode, category)
	}
	_, category, _, err = classifyReportCashEntry([]reportCashBasisLine{
		{accountCode: "1000", accountType: "asset", debitMinor: 5_000},
		{accountCode: "3000", accountType: "equity", creditMinor: 5_000},
	}, map[string]struct{}{"1000": {}})
	if err != nil || category != "financing" {
		t.Fatalf("equity counter category = %s, want financing", category)
	}
	if _, _, ok, err = classifyReportCashEntry([]reportCashBasisLine{
		{accountCode: "1100", accountType: "asset", debitMinor: 500},
		{accountCode: "4000", accountType: "income", creditMinor: 500},
	}, map[string]struct{}{"1000": {}}); ok {
		t.Fatal("a credit sale must not classify as a cash entry")
	}

	flowEntries := []reportCashFlowEntry{
		{lines: entries[0].lines},
		{lines: entries[1].lines},
		{lines: entries[2].lines},
		{lines: entries[3].lines},
	}
	statement, err := buildReportCashFlowStatement(flowEntries, map[string]struct{}{"1000": {}}, 0)
	if err != nil || statement.NetMinor != statement.CashBalanceMinor || !statement.Ties || statement.OpeningMinor != 0 {
		t.Fatalf("cash flow statement must tie: %+v", statement)
	}

	weekMillis := int64(7) * reportDayMillis
	asOf := time.Date(2026, 3, 25, 9, 0, 0, 0, time.UTC)
	firstWeek := reportWeekStart(asOf)
	if firstWeek.Weekday() != time.Monday || firstWeek.Format("2006-01-02T15:04:05.000Z") != "2026-03-23T00:00:00.000Z" {
		t.Fatalf("reportWeekStart = %s, want Monday 2026-03-23", firstWeek)
	}
	forecast, err := buildReportThirteenWeekForecast(1_000, []reportForecastFlow{
		{dueAt: firstWeek.Add(2 * 24 * time.Hour), amountMinor: 500, kind: "inflow"},
		{dueAt: firstWeek.Add(time.Duration(2*weekMillis) * time.Millisecond), amountMinor: 2_000, kind: "outflow"},
		{dueAt: firstWeek.Add(-3 * 24 * time.Hour), amountMinor: 7_000, kind: "inflow"},
		{dueAt: firstWeek.Add(time.Duration(20*weekMillis) * time.Millisecond), amountMinor: 50, kind: "outflow"},
	}, asOf)
	if err != nil {
		t.Fatal(err)
	}
	if len(forecast.weeks) != 13 {
		t.Fatalf("forecast weeks = %d, want 13", len(forecast.weeks))
	}
	if forecast.weeks[0].InflowMinor != 7_500 || forecast.weeks[2].OutflowMinor != 2_000 || forecast.weeks[12].OutflowMinor != 50 {
		t.Fatalf("forecast clamping wrong: weeks[0] = %+v weeks[2] = %+v weeks[12] = %+v", forecast.weeks[0], forecast.weeks[2], forecast.weeks[12])
	}
	if forecast.startMinor != 1_000 || forecast.finalMinor != 6_450 ||
		forecast.lowestCloseMinor != 1_000 || forecast.lowestWeekIndex != -1 {
		t.Fatalf("forecast = %+v, want final 6450 and the trough at start cash", forecast)
	}

	uplift, err := applyReportBasisPointUplift(10_000, 2_500)
	if err != nil || uplift != 12_500 {
		t.Fatalf("applyReportBasisPointUplift(10000, 2500) = %d, %v, want 12500", uplift, err)
	}
	uplift, err = applyReportBasisPointUplift(1, 0)
	if err != nil || uplift != 1 {
		t.Fatalf("applyReportBasisPointUplift(1, 0) = %d, %v, want half-up 1", uplift, err)
	}
	if _, err = applyReportBasisPointUplift(-1, 0); err == nil || err.Error() != "amount must be a non-negative safe integer" {
		t.Fatalf("applyReportBasisPointUplift(-1, 0) error = %v", err)
	}
	if _, err = applyReportBasisPointUplift(1, -1); err == nil {
		t.Fatal("negative uplift must be refused")
	}
	if _, err = applyReportBasisPointUplift(maxSafeInteger, maxSafeInteger); err == nil {
		t.Fatal("overflowing uplift must be refused")
	}
}

func toPointer(value time.Time) *time.Time { return &value }

func cleanupReportsFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin reports fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable reports fixture ledger cleanup: %v", err)
			return
		}
		steps := []struct {
			label string
			query string
		}{
			{"payments", `DELETE FROM payments WHERE org_id = ANY($1::uuid[])`},
			{"journal lines", `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = ANY($1::uuid[]))`},
			{"journal entries", `DELETE FROM journal_entries WHERE org_id = ANY($1::uuid[])`},
			{"invoices", `DELETE FROM invoices WHERE org_id = ANY($1::uuid[])`},
			{"vendor bills", `DELETE FROM vendor_bills WHERE org_id = ANY($1::uuid[])`},
			{"tax codes", `DELETE FROM tax_codes WHERE org_id = ANY($1::uuid[])`},
			{"budget lines", `DELETE FROM budget_lines WHERE org_id = ANY($1::uuid[])`},
			{"budget scenarios", `DELETE FROM budget_scenarios WHERE org_id = ANY($1::uuid[])`},
			{"accounts", `DELETE FROM accounts WHERE org_id = ANY($1::uuid[])`},
			{"customers", `DELETE FROM customers WHERE org_id = ANY($1::uuid[])`},
			{"vendors", `DELETE FROM vendors WHERE org_id = ANY($1::uuid[])`},
		}
		for _, step := range steps {
			if _, err := tx.Exec(fx.ctx, step.query, []string{fx.orgID, fx.otherOrgID}); err != nil {
				t.Errorf("delete reports fixture %s: %v", step.label, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit reports fixture cleanup: %v", err)
		}
	})
}

func seedReportsAccount(t *testing.T, fx *executorFixture, code, name, accountType string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`, fx.orgID, code, name, accountType); err != nil {
		t.Fatal(err)
	}
}

func seedReportsCustomer(t *testing.T, fx *executorFixture, orgID, name string) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, $2) RETURNING id::text`, orgID, name).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func seedReportsInvoice(t *testing.T, fx *executorFixture, orgID, customerID string, number int64, status, currency string, subtotalMinor, taxMinor, totalMinor, paidMinor, creditedMinor int64, issuedAt, dueAt, voidedAt *time.Time) string {
	t.Helper()
	var invoiceID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, issued_at, due_at, voided_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id::text`, orgID, customerID, number, status, currency, subtotalMinor, taxMinor, totalMinor, paidMinor, creditedMinor, issuedAt, dueAt, voidedAt).Scan(&invoiceID)
	if err != nil {
		t.Fatal(err)
	}
	return invoiceID
}

func seedReportsInvoiceLine(t *testing.T, fx *executorFixture, invoiceID string, quantity, unitPriceMinor, taxMinor int64, taxCodeID *string, rateBasisPoints *int64, priceIncludesTax bool) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax)
		VALUES ($1::uuid, 'reports fixture line', $2, $3, $4, $5::uuid, $6, $7)`,
		invoiceID, quantity, unitPriceMinor, taxMinor, taxCodeID, rateBasisPoints, priceIncludesTax); err != nil {
		t.Fatal(err)
	}
}

func seedReportsPayment(t *testing.T, fx *executorFixture, orgID, invoiceID string, amountMinor int64, receivedAt time.Time) string {
	t.Helper()
	var paymentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING id::text`, orgID, invoiceID, amountMinor, receivedAt).Scan(&paymentID); err != nil {
		t.Fatal(err)
	}
	return paymentID
}

func seedReportsVendor(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Reports fixture vendor')
		RETURNING id::text`, orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	return vendorID
}

func seedReportsVendorBill(t *testing.T, fx *executorFixture, orgID, vendorID string, number int64, status, currency string, totalMinor, paidMinor, creditedMinor int64, billDate, dueAt, voidedAt *time.Time) string {
	t.Helper()
	var billID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, paid_minor, credited_minor, bill_date, due_at, voided_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id::text`, orgID, vendorID, number, status, currency, totalMinor, paidMinor, creditedMinor, billDate, dueAt, voidedAt).Scan(&billID)
	if err != nil {
		t.Fatal(err)
	}
	return billID
}

func seedReportsVendorBillLine(t *testing.T, fx *executorFixture, billID string, quantity, unitPriceMinor, taxMinor int64, taxCodeID *string, rateBasisPoints *int64, priceIncludesTax bool) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bill_lines (bill_id, description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax)
		VALUES ($1::uuid, 'reports fixture bill line', $2, $3, $4, $5::uuid, $6, $7)`,
		billID, quantity, unitPriceMinor, taxMinor, taxCodeID, rateBasisPoints, priceIncludesTax); err != nil {
		t.Fatal(err)
	}
}

func seedReportsTaxCode(t *testing.T, fx *executorFixture, orgID, code, name, direction string, rateBasisPoints int64, recoverable bool) string {
	t.Helper()
	var taxCodeID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tax_codes (org_id, jurisdiction_code, code, name, direction, rate_basis_points, price_includes_tax, recoverable)
		VALUES ($1::uuid, 'US', $2, $3, $4, $5, false, $6)
		RETURNING id::text`, orgID, code, name, direction, rateBasisPoints, recoverable).Scan(&taxCodeID)
	if err != nil {
		t.Fatal(err)
	}
	return taxCodeID
}

type reportsSeedLine struct {
	accountCode string
	debitMinor  int64
	creditMinor int64
}

func seedReportsJournalEntry(t *testing.T, fx *executorFixture, orgID, currency, entryKind string, postedAt time.Time, sourceType *string, sourceID *string, lines []reportsSeedLine) string {
	t.Helper()
	tx, err := fx.owner.Begin(fx.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var entryID string
	if err := tx.QueryRow(fx.ctx, `
		INSERT INTO journal_entries (org_id, memo, currency, entry_kind, posted_at, posted_by_actor_type, source_type, source_id)
		VALUES ($1::uuid, 'reports fixture entry', $2, $3, $4, 'system', $5, $6::uuid)
		RETURNING id::text`, orgID, currency, entryKind, postedAt, sourceType, sourceID).Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		if _, err := tx.Exec(fx.ctx, `
			INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
			SELECT $1::uuid, id, $2, $3 FROM accounts WHERE org_id = $4::uuid AND code = $5`,
			entryID, line.debitMinor, line.creditMinor, orgID, line.accountCode); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(fx.ctx); err != nil {
		t.Fatal(err)
	}
	return entryID
}

func TestAccountingReportsStatementsReadBaseLedger(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	seedReportsAccount(t, fx, "1000", "Cash", "asset")
	seedReportsAccount(t, fx, "1100", "Accounts receivable", "asset")
	seedReportsAccount(t, fx, "3000", "Retained earnings", "equity")
	seedReportsAccount(t, fx, "4000", "Sales", "income")
	seedReportsAccount(t, fx, "6000", "Ops expense", "expense")
	foreignAccountSeed := func(orgID string) {
		t.Helper()
		for _, account := range []struct{ code, name, kind string }{
			{"1000", "Cash", "asset"}, {"1100", "Accounts receivable", "asset"},
			{"3000", "Retained earnings", "equity"}, {"4000", "Sales", "income"},
		} {
			if _, err := fx.owner.Exec(fx.ctx, `
				INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`, orgID, account.code, account.name, account.kind); err != nil {
				t.Fatal(err)
			}
		}
	}
	foreignAccountSeed(fx.otherOrgID)

	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 2, 10, 0, 0, 0, 0, time.UTC), nil, nil, []reportsSeedLine{
		{accountCode: "1100", debitMinor: 5_000},
		{accountCode: "4000", creditMinor: 5_000},
	})
	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC), nil, nil, []reportsSeedLine{
		{accountCode: "1000", debitMinor: 4_000},
		{accountCode: "1100", creditMinor: 4_000},
	})
	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC), nil, nil, []reportsSeedLine{
		{accountCode: "6000", debitMinor: 1_500},
		{accountCode: "1000", creditMinor: 1_500},
	})
	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "year_end_close", time.Date(2026, 12, 31, 12, 0, 0, 0, time.UTC), nil, nil, []reportsSeedLine{
		{accountCode: "4000", debitMinor: 2_000},
		{accountCode: "3000", creditMinor: 2_000},
	})
	seedReportsJournalEntry(t, fx, fx.orgID, "EUR", "operational", time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC), nil, nil, []reportsSeedLine{
		{accountCode: "6000", debitMinor: 700},
		{accountCode: "1000", creditMinor: 700},
	})
	seedReportsJournalEntry(t, fx, fx.otherOrgID, "USD", "operational", time.Date(2026, 2, 11, 0, 0, 0, 0, time.UTC), nil, nil, []reportsSeedLine{
		{accountCode: "1100", debitMinor: 9_999},
		{accountCode: "4000", creditMinor: 9_999},
	})

	pnl, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (IncomeStatementOutput, error) {
		return incomeStatement(fx.ctx, tx, fx.orgID, IncomeStatementInput{})
	})
	if err != nil {
		t.Fatalf("incomeStatement: %v", err)
	}
	if pnl.RevenueMinor != 5_000 || pnl.ExpenseMinor != 1_500 || pnl.NetIncomeMinor != 3_500 {
		t.Fatalf("incomeStatement = %+v, want base currency operating result without the year end close", pnl)
	}
	if len(pnl.Lines) != 2 || pnl.Lines[0].Code != "4000" || pnl.Lines[0].Name != "Sales" || pnl.Lines[0].AmountMinor != 5_000 ||
		pnl.Lines[1].Code != "6000" || pnl.Lines[1].AmountMinor != 1_500 {
		t.Fatalf("incomeStatement lines = %+v, want code ordered 4000 then 6000", pnl.Lines)
	}
	encoded, err := marshalJS(pnl)
	if err != nil || string(encoded) != `{"revenueMinor":5000,"expenseMinor":1500,"netIncomeMinor":3500,"lines":[{"code":"4000","name":"Sales","amountMinor":5000},{"code":"6000","name":"Ops expense","amountMinor":1500}]}` {
		t.Fatalf("incomeStatement JSON = %s, %v", encoded, err)
	}

	sheet, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BalanceSheetOutput, error) {
		return balanceSheet(fx.ctx, tx, fx.orgID, BalanceSheetInput{})
	})
	if err != nil {
		t.Fatalf("balanceSheet: %v", err)
	}
	if sheet.AssetsMinor != 3_500 || sheet.LiabilitiesMinor != 0 || sheet.EquityMinor != 2_000 ||
		sheet.RetainedResultMinor != 1_500 || !sheet.Balanced {
		t.Fatalf("balanceSheet = %+v, want assets 3500 = equity 2000 + result 1500", sheet)
	}
	encoded, err = marshalJS(sheet)
	if err != nil || string(encoded) != `{"assetsMinor":3500,"liabilitiesMinor":0,"equityMinor":2000,"retainedResultMinor":1500,"balanced":true}` {
		t.Fatalf("balanceSheet JSON = %s, %v", encoded, err)
	}

	foreignPnl, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (IncomeStatementOutput, error) {
		return incomeStatement(fx.ctx, tx, fx.otherOrgID, IncomeStatementInput{})
	})
	if err != nil {
		t.Fatalf("foreign incomeStatement: %v", err)
	}
	if foreignPnl.RevenueMinor != 9_999 {
		t.Fatalf("foreign incomeStatement = %+v, want only the foreign organization revenue", foreignPnl)
	}
}

func TestAccountingReportsInvoicesAgingAndScoping(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	customerOne := seedReportsCustomer(t, fx, fx.orgID, "Reports Customer")
	customerTwo := seedReportsCustomer(t, fx, fx.orgID, "Second Customer")
	foreignCustomer := seedReportsCustomer(t, fx, fx.otherOrgID, "Foreign Customer")

	date := func(value string) *time.Time {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatal(err)
		}
		return &parsed
	}
	seedReportsInvoice(t, fx, fx.orgID, customerOne, 1, "sent", "USD", 10_000, 0, 10_000, 4_000, 1_000, date("2026-01-05T10:00:00Z"), date("2026-01-15T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.orgID, customerOne, 2, "sent", "USD", 2_000, 0, 2_000, 0, 0, date("2025-11-01T00:00:00Z"), date("2025-12-01T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.orgID, customerOne, 3, "draft", "USD", 9_999, 0, 9_999, 0, 0, nil, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, customerOne, 4, "paid", "USD", 500, 0, 500, 500, 0, date("2026-01-06T00:00:00Z"), date("2026-01-06T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.orgID, customerOne, 5, "sent", "USD", 7_000, 0, 7_000, 0, 0, date("2026-01-07T00:00:00Z"), date("2026-01-07T00:00:00Z"), date("2026-01-08T00:00:00Z"))
	seedReportsInvoice(t, fx, fx.orgID, customerOne, 6, "sent", "USD", 3_333, 0, 3_333, 0, 0, nil, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, customerTwo, 7, "sent", "USD", 3_000, 0, 3_000, 0, 0, date("2025-09-01T00:00:00Z"), nil, nil)
	seedReportsInvoice(t, fx, fx.otherOrgID, foreignCustomer, 1, "sent", "USD", 8_888, 0, 8_888, 0, 0, date("2025-08-01T00:00:00Z"), date("2025-08-15T00:00:00Z"), nil)

	all, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListInvoicesOutput, error) {
		return listInvoices(fx.ctx, tx, fx.orgID, ListInvoicesInput{Limit: 50})
	})
	if err != nil {
		t.Fatalf("listInvoices: %v", err)
	}
	if len(all.Invoices) != 7 {
		t.Fatalf("listInvoices rows = %d, want the seven org scoped invoices", len(all.Invoices))
	}
	for index, expected := range []int64{7, 6, 5, 4, 3, 2, 1} {
		if all.Invoices[index].Number != expected {
			t.Fatalf("listInvoices order = %+v, want descending numbers", all.Invoices)
		}
	}
	first := all.Invoices[6]
	if first.CustomerID != customerOne || first.CustomerName != "Reports Customer" || first.Status != "sent" || first.Currency != "USD" ||
		first.TotalMinor != 10_000 || first.PaidMinor != 4_000 || first.CreditedMinor != 1_000 || first.OutstandingMinor != 5_000 ||
		first.IssuedAt == nil || *first.IssuedAt != "2026-01-05T10:00:00.000Z" {
		t.Fatalf("first invoice row = %+v, want credit adjusted outstanding 5000", first)
	}
	encoded, err := marshalJS(first)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"id":%q,"number":1,"customerId":%q,"customerName":"Reports Customer","status":"sent",`+
		`"currency":"USD","totalMinor":10000,"paidMinor":4000,"creditedMinor":1000,"outstandingMinor":5000,`+
		`"issuedAt":"2026-01-05T10:00:00.000Z"}`, first.ID, customerOne)
	if string(encoded) != want {
		t.Fatalf("invoice row JSON = %s, want %s", encoded, want)
	}
	withoutIssueDate := all.Invoices[1]
	if withoutIssueDate.Number != 6 || withoutIssueDate.IssuedAt != nil {
		t.Fatalf("invoice six row = %+v, want null issuedAt", withoutIssueDate)
	}

	customerID := customerOne
	filtered, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListInvoicesOutput, error) {
		return listInvoices(fx.ctx, tx, fx.orgID, ListInvoicesInput{CustomerID: &customerID, Limit: 50})
	})
	if err != nil {
		t.Fatalf("listInvoices(customer): %v", err)
	}
	if len(filtered.Invoices) != 6 {
		t.Fatalf("customer filtered rows = %d, want six", len(filtered.Invoices))
	}
	sentOnly, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListInvoicesOutput, error) {
		status := "sent"
		return listInvoices(fx.ctx, tx, fx.orgID, ListInvoicesInput{Status: &status, Limit: 50})
	})
	if err != nil {
		t.Fatalf("listInvoices(status): %v", err)
	}
	if len(sentOnly.Invoices) != 5 {
		t.Fatalf("sent rows = %d, want five", len(sentOnly.Invoices))
	}
	limited, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListInvoicesOutput, error) {
		return listInvoices(fx.ctx, tx, fx.orgID, ListInvoicesInput{Limit: 2})
	})
	if err != nil {
		t.Fatalf("listInvoices(limit): %v", err)
	}
	if len(limited.Invoices) != 2 || limited.Invoices[0].Number != 7 || limited.Invoices[1].Number != 6 {
		t.Fatalf("limited rows = %+v, want the two newest", limited.Invoices)
	}

	now := time.Date(2026, 1, 20, 0, 0, 0, 0, time.UTC)
	aging, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ArAgingOutput, error) {
		return arAging(fx.ctx, tx, fx.orgID, ArAgingInput{}, now)
	})
	if err != nil {
		t.Fatalf("arAging: %v", err)
	}
	if aging.Buckets != (ArAgingBucketTotals{Current: 5_000, D30: 2_000, D60: 0, D90Plus: 3_000, TotalOutstanding: 10_000}) {
		t.Fatalf("arAging buckets = %+v, want 5000 current, 2000 d30, 3000 d90plus", aging.Buckets)
	}
	if len(aging.Invoices) != 3 || aging.Invoices[0].Number != 1 || aging.Invoices[0].AgeDays != 5 ||
		aging.Invoices[1].Number != 2 || aging.Invoices[1].AgeDays != 50 ||
		aging.Invoices[2].Number != 7 || aging.Invoices[2].AgeDays != 141 {
		t.Fatalf("arAging invoices = %+v, want ages 5, 50 and 141", aging.Invoices)
	}
	encodedAging, err := marshalJS(aging)
	if err != nil {
		t.Fatal(err)
	}
	wantAging := `{"buckets":{"current":5000,"d30":2000,"d60":0,"d90plus":3000,"totalOutstanding":10000},` +
		`"invoices":[{"number":1,"outstandingMinor":5000,"ageDays":5},{"number":2,"outstandingMinor":2000,"ageDays":50},{"number":7,"outstandingMinor":3000,"ageDays":141}]}`
	if string(encodedAging) != wantAging {
		t.Fatalf("aging JSON = %s, want %s", encodedAging, wantAging)
	}

	foreignAging, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (ArAgingOutput, error) {
		return arAging(fx.ctx, tx, fx.otherOrgID, ArAgingInput{}, now)
	})
	if err != nil {
		t.Fatalf("foreign arAging: %v", err)
	}
	if len(foreignAging.Invoices) != 1 || foreignAging.Invoices[0].Number != 1 || foreignAging.Buckets.TotalOutstanding != 8_888 {
		t.Fatalf("foreign aging = %+v, want only the foreign invoice", foreignAging)
	}
}

func TestAccountingReportsCashBasisWindowMath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	seedReportsAccount(t, fx, "1000", "Cash", "asset")
	seedReportsAccount(t, fx, "1100", "Accounts receivable", "asset")
	seedReportsAccount(t, fx, "4000", "Sales", "income")
	seedReportsAccount(t, fx, "6000", "Ops expense", "expense")

	seed := func(postedAt time.Time, lines []reportsSeedLine) {
		t.Helper()
		seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", postedAt, nil, nil, lines)
	}
	seed(time.Date(2026, 1, 10, 0, 0, 0, 0, time.UTC), []reportsSeedLine{
		{accountCode: "1000", debitMinor: 8_000}, {accountCode: "4000", creditMinor: 8_000},
	})
	seed(time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC), []reportsSeedLine{
		{accountCode: "1100", debitMinor: 5_000}, {accountCode: "4000", creditMinor: 5_000},
	})
	seed(time.Date(2026, 2, 15, 0, 0, 0, 0, time.UTC), []reportsSeedLine{
		{accountCode: "1000", debitMinor: 3_000}, {accountCode: "1100", creditMinor: 3_000},
	})
	seed(time.Date(2026, 2, 20, 0, 0, 0, 0, time.UTC), []reportsSeedLine{
		{accountCode: "6000", debitMinor: 2_000}, {accountCode: "1000", creditMinor: 2_000},
	})
	seed(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), []reportsSeedLine{
		{accountCode: "4000", debitMinor: 500}, {accountCode: "1000", creditMinor: 500},
	})
	seed(time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC), []reportsSeedLine{
		{accountCode: "1000", debitMinor: 700}, {accountCode: "4000", creditMinor: 700},
	})

	year, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashBasisReportOutput, error) {
		return cashBasisReport(fx.ctx, tx, fx.orgID, CashBasisReportInput{Year: 2026, CashAccountCodes: []string{"1000"}})
	})
	if err != nil {
		t.Fatalf("cashBasisReport(year): %v", err)
	}
	if year.CashInMinor != 11_000 || year.CashOutMinor != 2_500 || year.NetCashMinor != 8_500 ||
		year.AccrualRevenueMinor != 12_500 || year.AccrualExpenseMinor != 2_000 || year.UncollectedMinor != 1_500 {
		t.Fatalf("cashBasisReport(year) = %+v, want refunds netted against their side", year)
	}
	month := int64(2)
	february, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashBasisReportOutput, error) {
		return cashBasisReport(fx.ctx, tx, fx.orgID, CashBasisReportInput{Year: 2026, Month: &month, CashAccountCodes: []string{"1000"}})
	})
	if err != nil {
		t.Fatalf("cashBasisReport(month): %v", err)
	}
	if february.CashInMinor != 3_000 || february.CashOutMinor != 2_000 || february.NetCashMinor != 1_000 ||
		february.AccrualRevenueMinor != 5_000 || february.AccrualExpenseMinor != 2_000 || february.UncollectedMinor != 2_000 {
		t.Fatalf("cashBasisReport(february) = %+v", february)
	}
	receivableCash, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashBasisReportOutput, error) {
		return cashBasisReport(fx.ctx, tx, fx.orgID, CashBasisReportInput{Year: 2026, CashAccountCodes: []string{"1100"}})
	})
	if err != nil {
		t.Fatalf("cashBasisReport(1100): %v", err)
	}
	if receivableCash.CashInMinor != 5_000 || receivableCash.CashOutMinor != 3_000 || receivableCash.NetCashMinor != 2_000 ||
		receivableCash.UncollectedMinor != 7_500 {
		t.Fatalf("cashBasisReport(1100) = %+v, want receivables treated as the cash ledger", receivableCash)
	}
}

func TestAccountingReportsCashFlowForecastStatement(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	seedReportsAccount(t, fx, "1000", "Cash", "asset")
	seedReportsAccount(t, fx, "1100", "Accounts receivable", "asset")
	seedReportsAccount(t, fx, "1500", "Equipment", "asset")
	seedReportsAccount(t, fx, "3000", "Retained earnings", "equity")
	seedReportsAccount(t, fx, "4000", "Sales", "income")
	seedReportsAccount(t, fx, "6000", "Ops expense", "expense")

	entry := func(postedAt time.Time, currency string, lines []reportsSeedLine) {
		t.Helper()
		seedReportsJournalEntry(t, fx, fx.orgID, currency, "operational", postedAt, nil, nil, lines)
	}
	entry(time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC), "USD", []reportsSeedLine{
		{accountCode: "1000", debitMinor: 20_000}, {accountCode: "3000", creditMinor: 20_000},
	})
	entry(time.Date(2026, 1, 20, 0, 0, 0, 0, time.UTC), "USD", []reportsSeedLine{
		{accountCode: "1500", debitMinor: 5_000}, {accountCode: "1000", creditMinor: 5_000},
	})
	entry(time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC), "USD", []reportsSeedLine{
		{accountCode: "1100", debitMinor: 8_000}, {accountCode: "4000", creditMinor: 8_000},
	})
	entry(time.Date(2026, 2, 10, 0, 0, 0, 0, time.UTC), "USD", []reportsSeedLine{
		{accountCode: "1000", debitMinor: 6_000}, {accountCode: "1100", creditMinor: 6_000},
	})
	entry(time.Date(2026, 2, 15, 0, 0, 0, 0, time.UTC), "USD", []reportsSeedLine{
		{accountCode: "6000", debitMinor: 2_500}, {accountCode: "1000", creditMinor: 2_500},
	})
	entry(time.Date(2026, 2, 20, 0, 0, 0, 0, time.UTC), "EUR", []reportsSeedLine{
		{accountCode: "1000", debitMinor: 1_000}, {accountCode: "4000", creditMinor: 1_000},
	})

	flow, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashFlowOutput, error) {
		return cashFlow(fx.ctx, tx, fx.orgID, CashFlowInput{CashAccountCodes: []string{"1000"}})
	})
	if err != nil {
		t.Fatalf("cashFlow: %v", err)
	}
	if flow.OpeningMinor != 0 || flow.Operating != (CashFlowCategoryTotal{InflowMinor: 6_000, OutflowMinor: 2_500, NetMinor: 3_500, Entries: 2}) ||
		flow.Investing != (CashFlowCategoryTotal{OutflowMinor: 5_000, NetMinor: -5_000, Entries: 1}) ||
		flow.Financing != (CashFlowCategoryTotal{InflowMinor: 20_000, NetMinor: 20_000, Entries: 1}) {
		t.Fatalf("cashFlow categories = %+v", flow)
	}
	if flow.NetMinor != 18_500 || flow.ClosingMinor != 18_500 || flow.CashBalanceMinor != 18_500 || !flow.Ties {
		t.Fatalf("cashFlow totals = %+v, want a tied statement", flow)
	}
	if len(flow.UnsupportedCurrencies) != 1 || flow.UnsupportedCurrencies[0] != "EUR" {
		t.Fatalf("unsupported currencies = %v, want [EUR]", flow.UnsupportedCurrencies)
	}
	encoded, err := marshalJS(flow)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"openingMinor":0,"closingMinor":18500,"netMinor":18500,"cashBalanceMinor":18500,"ties":true,` +
		`"unsupportedCurrencies":["EUR"],` +
		`"operating":{"inflowMinor":6000,"outflowMinor":2500,"netMinor":3500,"entries":2},` +
		`"investing":{"inflowMinor":0,"outflowMinor":5000,"netMinor":-5000,"entries":1},` +
		`"financing":{"inflowMinor":20000,"outflowMinor":0,"netMinor":20000,"entries":1}}`
	if string(encoded) != want {
		t.Fatalf("cashFlow JSON = %s, want %s", encoded, want)
	}

	customer := seedReportsCustomer(t, fx, fx.orgID, "Forecast Customer")
	foreignCustomer := seedReportsCustomer(t, fx, fx.otherOrgID, "Foreign Forecast Customer")
	vendor := seedReportsVendor(t, fx, fx.orgID)
	date := func(value string) *time.Time {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatal(err)
		}
		return &parsed
	}
	seedReportsInvoice(t, fx, fx.orgID, customer, 1, "sent", "USD", 5_000, 0, 5_000, 0, 0, date("2026-03-01T00:00:00Z"), date("2026-03-26T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.orgID, customer, 2, "sent", "USD", 2_500, 0, 2_500, 0, 0, date("2026-03-02T00:00:00Z"), date("2026-04-15T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.orgID, customer, 3, "sent", "EUR", 7_000, 0, 7_000, 0, 0, date("2026-03-03T00:00:00Z"), date("2026-03-30T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.orgID, customer, 4, "draft", "USD", 9_000, 0, 9_000, 0, 0, date("2026-03-04T00:00:00Z"), date("2026-03-27T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.orgID, customer, 5, "sent", "USD", 4_000, 0, 4_000, 4_000, 0, date("2026-03-05T00:00:00Z"), date("2026-03-28T00:00:00Z"), nil)
	seedReportsInvoice(t, fx, fx.otherOrgID, foreignCustomer, 1, "sent", "USD", 6_000, 0, 6_000, 0, 0, date("2026-03-06T00:00:00Z"), date("2026-03-29T00:00:00Z"), nil)
	billOne := seedReportsVendorBill(t, fx, fx.orgID, vendor, 1, "open", "USD", 4_000, 0, 0, date("2026-03-07T00:00:00Z"), date("2026-04-08T00:00:00Z"), nil)
	seedReportsVendorBillLine(t, fx, billOne, 1_000, 4_000, 0, nil, nil, false)
	billVoided := seedReportsVendorBill(t, fx, fx.orgID, vendor, 2, "open", "USD", 1_200, 0, 0, date("2026-03-08T00:00:00Z"), date("2026-04-01T00:00:00Z"), date("2026-03-09T00:00:00Z"))
	seedReportsVendorBillLine(t, fx, billVoided, 1_000, 1_200, 0, nil, nil, false)
	foreignBill := seedReportsVendorBill(t, fx, fx.orgID, vendor, 3, "open", "EUR", 3_000, 0, 0, date("2026-03-10T00:00:00Z"), date("2026-04-02T00:00:00Z"), nil)
	seedReportsVendorBillLine(t, fx, foreignBill, 1_000, 3_000, 0, nil, nil, false)
	billSettled := seedReportsVendorBill(t, fx, fx.orgID, vendor, 4, "open", "USD", 800, 800, 0, date("2026-03-11T00:00:00Z"), date("2026-04-03T00:00:00Z"), nil)
	seedReportsVendorBillLine(t, fx, billSettled, 1_000, 800, 0, nil, nil, false)

	now := time.Date(2026, 3, 25, 12, 0, 0, 0, time.UTC)
	plain, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashForecastOutput, error) {
		return cashForecast(fx.ctx, tx, fx.orgID, CashForecastInput{CashAccountCodes: []string{"1000"}}, now)
	})
	if err != nil {
		t.Fatalf("cashForecast: %v", err)
	}
	if plain.StartMinor != 18_500 || plain.FinalMinor != 22_000 || plain.LowestCloseMinor != 18_500 || plain.LowestWeekIndex != -1 {
		t.Fatalf("plain forecast = %+v, want start 18500 final 22000 trough at start", plain)
	}
	if plain.ScenarioName != nil || plain.MinimumCashBufferMinor != 0 {
		t.Fatalf("plain forecast scenario fields = %+v", plain)
	}
	if len(plain.UnsupportedCurrencies) != 1 || plain.UnsupportedCurrencies[0] != "EUR" {
		t.Fatalf("forecast unsupported currencies = %v, want [EUR]", plain.UnsupportedCurrencies)
	}
	if len(plain.Weeks) != 13 ||
		plain.Weeks[0] != (CashForecastWeek{WeekStart: "2026-03-23T00:00:00.000Z", InflowMinor: 5_000, OutflowMinor: 0, CloseMinor: 23_500}) ||
		plain.Weeks[2] != (CashForecastWeek{WeekStart: "2026-04-06T00:00:00.000Z", InflowMinor: 0, OutflowMinor: 4_000, CloseMinor: 19_500}) ||
		plain.Weeks[3] != (CashForecastWeek{WeekStart: "2026-04-13T00:00:00.000Z", InflowMinor: 2_500, OutflowMinor: 0, CloseMinor: 22_000}) {
		t.Fatalf("forecast weeks = %+v", plain.Weeks)
	}

	scenarioID := seedBudgetScenarioRow(t, fx, fx.orgID, "forecast-plan", "Forecast Plan", 2026, 1, "USD", true,
		`{"collectionDelayDays":7,"spendUpliftBasisPoints":10000,"expectedMonthlyInflowMinor":1000,`+
			`"expectedMonthlyOutflowMinor":2000,"minimumCashBufferMinor":500}`, time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC))
	scenario, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashForecastOutput, error) {
		return cashForecast(fx.ctx, tx, fx.orgID, CashForecastInput{CashAccountCodes: []string{"1000"}, BudgetScenarioID: &scenarioID}, now)
	})
	if err != nil {
		t.Fatalf("cashForecast(scenario): %v", err)
	}
	if scenario.ScenarioName == nil || *scenario.ScenarioName != "Forecast Plan" || scenario.MinimumCashBufferMinor != 500 {
		t.Fatalf("scenario fields = %+v", scenario)
	}
	if scenario.StartMinor != 18_500 || scenario.FinalMinor != 6_000 ||
		scenario.LowestCloseMinor != 6_000 || scenario.LowestWeekIndex != 12 {
		t.Fatalf("scenario forecast = %+v, want doubled outflows and a week 12 trough", scenario)
	}
	if scenario.Weeks[0] != (CashForecastWeek{WeekStart: "2026-03-23T00:00:00.000Z", InflowMinor: 1_000, OutflowMinor: 4_000, CloseMinor: 15_500}) ||
		scenario.Weeks[1] != (CashForecastWeek{WeekStart: "2026-03-30T00:00:00.000Z", InflowMinor: 5_000, OutflowMinor: 0, CloseMinor: 20_500}) ||
		scenario.Weeks[2] != (CashForecastWeek{WeekStart: "2026-04-06T00:00:00.000Z", InflowMinor: 0, OutflowMinor: 8_000, CloseMinor: 12_500}) ||
		scenario.Weeks[3] != (CashForecastWeek{WeekStart: "2026-04-13T00:00:00.000Z", InflowMinor: 1_000, OutflowMinor: 4_000, CloseMinor: 9_500}) ||
		scenario.Weeks[4] != (CashForecastWeek{WeekStart: "2026-04-20T00:00:00.000Z", InflowMinor: 2_500, OutflowMinor: 0, CloseMinor: 12_000}) ||
		scenario.Weeks[12] != (CashForecastWeek{WeekStart: "2026-06-15T00:00:00.000Z", InflowMinor: 1_000, OutflowMinor: 4_000, CloseMinor: 6_000}) {
		t.Fatalf("scenario weeks = %+v", scenario.Weeks)
	}

	unknown := executorUUID(t)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashForecastOutput, error) {
		return cashForecast(fx.ctx, tx, fx.orgID, CashForecastInput{CashAccountCodes: []string{"1000"}, BudgetScenarioID: &unknown}, now)
	}); err == nil || err.Error() != "budget scenario not found" {
		t.Fatalf("unknown scenario error = %v, want budget scenario not found", err)
	}
	foreignScenario := seedBudgetScenarioRow(t, fx, fx.otherOrgID, "foreign-forecast", "Foreign Forecast", 2026, 1, "USD", true, "{}", time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC))
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashForecastOutput, error) {
		return cashForecast(fx.ctx, tx, fx.orgID, CashForecastInput{CashAccountCodes: []string{"1000"}, BudgetScenarioID: &foreignScenario}, now)
	}); err == nil || err.Error() != "budget scenario not found" {
		t.Fatalf("foreign scenario error = %v, want budget scenario not found", err)
	}
	euroScenario := seedBudgetScenarioRow(t, fx, fx.orgID, "euro-forecast", "Euro Forecast", 2026, 1, "EUR", true, "{}", time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC))
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CashForecastOutput, error) {
		return cashForecast(fx.ctx, tx, fx.orgID, CashForecastInput{CashAccountCodes: []string{"1000"}, BudgetScenarioID: &euroScenario}, now)
	}); err == nil || err.Error() != "cash scenario currency must match the organization's base currency" {
		t.Fatalf("euro scenario error = %v, want currency mismatch refusal", err)
	}
}

func TestAccountingReportsRejectUnsafeCashAggregates(t *testing.T) {
	max := maxSafeInteger
	now := time.Date(2026, time.June, 10, 0, 0, 0, 0, time.UTC)
	entries := []reportCashBasisEntry{
		{occurredAt: now, lines: []reportCashBasisLine{
			{accountCode: "1000", accountType: "asset", debitMinor: max},
			{accountCode: "4000", accountType: "income", creditMinor: max},
		}},
		{occurredAt: now, lines: []reportCashBasisLine{
			{accountCode: "1000", accountType: "asset", debitMinor: max},
			{accountCode: "4000", accountType: "income", creditMinor: max},
		}},
	}
	if _, err := computeReportCashBasis(entries, map[string]struct{}{"1000": {}}, nil, nil); err == nil {
		t.Fatal("cash basis accepted totals beyond the JavaScript safe-integer range")
	}

	flowEntries := []reportCashFlowEntry{
		{occurredAt: now, currency: "USD", lines: entries[0].lines},
		{occurredAt: now, currency: "USD", lines: entries[1].lines},
	}
	if _, err := buildReportCashFlowStatement(flowEntries, map[string]struct{}{"1000": {}}, 0); err == nil {
		t.Fatal("cash flow accepted category totals beyond the JavaScript safe-integer range")
	}

	if _, err := buildReportThirteenWeekForecast(max, []reportForecastFlow{
		{dueAt: now, amountMinor: max, kind: "inflow"},
		{dueAt: now, amountMinor: max, kind: "inflow"},
	}, now); err == nil {
		t.Fatal("cash forecast accepted weekly totals beyond the JavaScript safe-integer range")
	}
}

func TestAccountingReportsCustomerStatementRendering(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	seedReportsAccount(t, fx, "1000", "Cash", "asset")
	seedReportsAccount(t, fx, "1100", "Accounts receivable", "asset")
	seedReportsAccount(t, fx, "4000", "Sales", "income")

	customer := seedReportsCustomer(t, fx, fx.orgID, "Statement Customer")
	otherCustomer := seedReportsCustomer(t, fx, fx.orgID, "Other Customer")
	date := func(value string) *time.Time {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatal(err)
		}
		return &parsed
	}
	invoiceOne := seedReportsInvoice(t, fx, fx.orgID, customer, 1, "sent", "USD", 10_000, 0, 10_000, 0, 0, date("2026-01-05T10:00:00Z"), nil, nil)
	invoiceTwo := seedReportsInvoice(t, fx, fx.orgID, customer, 2, "paid", "USD", 4_000, 0, 4_000, 0, 0, date("2026-01-20T09:00:00Z"), nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, customer, 3, "draft", "USD", 999, 0, 999, 0, 0, date("2026-01-21T00:00:00Z"), nil, nil)
	invoiceVoided := seedReportsInvoice(t, fx, fx.orgID, customer, 4, "sent", "USD", 5_000, 0, 5_000, 0, 0, date("2026-01-22T00:00:00Z"), nil, date("2026-01-23T00:00:00Z"))
	invoiceEuro := seedReportsInvoice(t, fx, fx.orgID, customer, 5, "sent", "EUR", 2_000, 0, 2_000, 0, 0, date("2026-02-01T08:00:00Z"), nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, otherCustomer, 6, "sent", "USD", 1_111, 0, 1_111, 0, 0, date("2026-02-02T00:00:00Z"), nil, nil)

	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 2, 10, 9, 0, 0, 0, time.UTC),
		reportsStringPointer("invoice_credit_note"), &invoiceOne, []reportsSeedLine{
			{accountCode: "4000", debitMinor: 1_000}, {accountCode: "1100", creditMinor: 1_000},
		})
	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 2, 15, 12, 0, 0, 0, time.UTC),
		reportsStringPointer("invoice_credit_note"), &invoiceTwo, []reportsSeedLine{
			{accountCode: "4000", debitMinor: 500}, {accountCode: "1100", creditMinor: 500},
		})
	seedReportsPayment(t, fx, fx.orgID, invoiceOne, 6_000, time.Date(2026, 2, 15, 12, 0, 0, 0, time.UTC))
	seedReportsPayment(t, fx, fx.orgID, invoiceTwo, 4_000, time.Date(2026, 1, 25, 8, 0, 0, 0, time.UTC))
	seedReportsPayment(t, fx, fx.orgID, invoiceVoided, 5_000, time.Date(2026, 1, 24, 0, 0, 0, 0, time.UTC))
	seedReportsPayment(t, fx, fx.orgID, invoiceEuro, 1_500, time.Date(2026, 2, 20, 10, 0, 0, 0, time.UTC))

	statement, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CustomerStatementOutput, error) {
		return customerStatement(fx.ctx, tx, fx.orgID, CustomerStatementInput{CustomerID: customer})
	})
	if err != nil {
		t.Fatalf("customerStatement: %v", err)
	}
	if len(statement.Currencies) != 2 || statement.Currencies[0].Currency != "EUR" || statement.Currencies[1].Currency != "USD" {
		t.Fatalf("statement currencies = %+v, want EUR before USD", statement.Currencies)
	}
	euro := statement.Currencies[0]
	if euro.OpeningBalanceMinor != 0 || euro.ClosingBalanceMinor != 500 || len(euro.Rows) != 2 ||
		euro.Rows[0].Kind != "invoice" || euro.Rows[0].AmountMinor != 2_000 || euro.Rows[0].BalanceMinor != 2_000 ||
		euro.Rows[1].Kind != "payment" || euro.Rows[1].AmountMinor != -1_500 || euro.Rows[1].BalanceMinor != 500 {
		t.Fatalf("euro section = %+v", euro)
	}
	usd := statement.Currencies[1]
	expectedKinds := []string{"invoice", "invoice", "payment", "credit_note", "payment", "credit_note"}
	if usd.ClosingBalanceMinor != 2_500 || len(usd.Rows) != len(expectedKinds) {
		t.Fatalf("usd section = %+v, want six rows closing 2500", usd)
	}
	for index, kind := range expectedKinds {
		if usd.Rows[index].Kind != kind {
			t.Fatalf("usd row %d kind = %s, want %s (rows %+v)", index, usd.Rows[index].Kind, kind, usd.Rows)
		}
	}
	if usd.Rows[0].Date != "2026-01-05T10:00:00.000Z" || usd.Rows[0].Ref != "Invoice #1" || usd.Rows[0].AmountMinor != 10_000 || usd.Rows[0].BalanceMinor != 10_000 {
		t.Fatalf("first usd row = %+v", usd.Rows[0])
	}
	if usd.Rows[1].Ref != "Invoice #2" || usd.Rows[1].BalanceMinor != 14_000 {
		t.Fatalf("second usd row = %+v", usd.Rows[1])
	}
	if usd.Rows[4].Ref != "Payment received" || usd.Rows[4].AmountMinor != -6_000 || usd.Rows[4].BalanceMinor != 3_000 {
		t.Fatalf("payment row = %+v, want same instant payment before the credit note", usd.Rows[4])
	}
	if usd.Rows[5].Ref != "Credit on invoice #2" || usd.Rows[5].AmountMinor != -500 || usd.Rows[5].BalanceMinor != 2_500 {
		t.Fatalf("last usd row = %+v", usd.Rows[5])
	}
	encoded, err := marshalJS(usd.Rows[3])
	if err != nil || string(encoded) != `{"date":"2026-02-10T09:00:00.000Z","kind":"credit_note","ref":"Credit on invoice #1","amountMinor":-1000,"balanceMinor":9000}` {
		t.Fatalf("credit note row JSON = %s, %v", encoded, err)
	}

	empty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CustomerStatementOutput, error) {
		return customerStatement(fx.ctx, tx, fx.orgID, CustomerStatementInput{CustomerID: executorUUID(t)})
	})
	if err != nil {
		t.Fatalf("unknown customerStatement: %v", err)
	}
	encoded, err = marshalJS(empty)
	if err != nil || string(encoded) != `{"currencies":[]}` {
		t.Fatalf("unknown customer statement JSON = %s, %v", encoded, err)
	}
}

func TestAccountingReportsSalesTaxWindowReconciles(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupReportsFixture(t, fx)
	for _, account := range []struct{ code, name, kind string }{
		{"1000", "Cash", "asset"}, {"1100", "Accounts receivable", "asset"},
		{"1205", "Input tax recoverable", "asset"}, {"2000", "Accounts payable", "liability"},
		{"2100", "Sales tax payable", "liability"}, {"4000", "Sales", "income"},
	} {
		seedReportsAccount(t, fx, account.code, account.name, account.kind)
	}
	outputCode := seedReportsTaxCode(t, fx, fx.orgID, "VAT20", "VAT twenty percent", "output", 2_000, false)
	inputCode := seedReportsTaxCode(t, fx, fx.orgID, "INP10", "Recoverable input ten", "input", 1_000, true)

	customer := seedReportsCustomer(t, fx, fx.orgID, "Tax Customer")
	vendor := seedReportsVendor(t, fx, fx.orgID)
	date := func(value string) *time.Time {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatal(err)
		}
		return &parsed
	}

	taxedInvoice := seedReportsInvoice(t, fx, fx.orgID, customer, 1, "paid", "USD", 10_000, 2_000, 12_000, 0, 0, date("2026-03-05T00:00:00Z"), nil, nil)
	seedReportsInvoiceLine(t, fx, taxedInvoice, 1_000, 10_000, 2_000, &outputCode, toInt64Pointer(2_000), false)
	manualInvoice := seedReportsInvoice(t, fx, fx.orgID, customer, 2, "sent", "USD", 5_000, 0, 5_000, 0, 0, date("2026-03-20T00:00:00Z"), nil, nil)
	seedReportsInvoiceLine(t, fx, manualInvoice, 1_000, 5_000, 0, nil, nil, false)
	voided := seedReportsInvoice(t, fx, fx.orgID, customer, 3, "void", "USD", 99_000, 999, 99_999, 0, 0, date("2026-03-10T00:00:00Z"), nil, nil)
	seedReportsInvoiceLine(t, fx, voided, 1_000, 99_000, 999, &outputCode, toInt64Pointer(1_000), false)
	foreignInvoice := seedReportsInvoice(t, fx, fx.orgID, customer, 4, "sent", "EUR", 8_000, 1_600, 9_600, 0, 0, date("2026-03-15T00:00:00Z"), nil, nil)
	seedReportsInvoiceLine(t, fx, foreignInvoice, 1_000, 8_000, 1_600, &outputCode, toInt64Pointer(2_000), false)
	lateInvoice := seedReportsInvoice(t, fx, fx.orgID, customer, 5, "sent", "USD", 50_000, 10_000, 60_000, 0, 0, date("2026-04-02T00:00:00Z"), nil, nil)
	seedReportsInvoiceLine(t, fx, lateInvoice, 1_000, 50_000, 10_000, &outputCode, toInt64Pointer(2_000), false)

	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC),
		reportsStringPointer("invoice_credit_note"), &taxedInvoice, []reportsSeedLine{
			{accountCode: "4000", debitMinor: 1_000}, {accountCode: "2100", debitMinor: 400}, {accountCode: "1100", creditMinor: 1_400},
		})
	seedReportsJournalEntry(t, fx, fx.orgID, "EUR", "operational", time.Date(2026, 3, 26, 0, 0, 0, 0, time.UTC),
		reportsStringPointer("invoice_credit_note"), &foreignInvoice, []reportsSeedLine{
			{accountCode: "4000", debitMinor: 222}, {accountCode: "1100", creditMinor: 222},
		})

	billOne := seedReportsVendorBill(t, fx, fx.orgID, vendor, 1, "open", "USD", 11_000, 0, 0, date("2026-03-12T00:00:00Z"), nil, nil)
	seedReportsVendorBillLine(t, fx, billOne, 1_000, 10_000, 1_000, &inputCode, toInt64Pointer(1_000), false)
	billLate := seedReportsVendorBill(t, fx, fx.orgID, vendor, 2, "open", "USD", 20_000, 0, 0, date("2026-04-05T00:00:00Z"), nil, nil)
	seedReportsVendorBillLine(t, fx, billLate, 1_000, 20_000, 2_000, &inputCode, toInt64Pointer(1_000), false)
	foreignBill := seedReportsVendorBill(t, fx, fx.orgID, vendor, 3, "open", "EUR", 5_000, 0, 0, date("2026-03-14T00:00:00Z"), nil, nil)
	seedReportsVendorBillLine(t, fx, foreignBill, 1_000, 5_000, 500, &inputCode, toInt64Pointer(1_000), false)
	voidedBill := seedReportsVendorBill(t, fx, fx.orgID, vendor, 4, "void", "USD", 7_000, 0, 0, date("2026-03-16T00:00:00Z"), nil, nil)
	seedReportsVendorBillLine(t, fx, voidedBill, 1_000, 7_000, 700, &inputCode, toInt64Pointer(1_000), false)

	seedReportsJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 3, 18, 0, 0, 0, 0, time.UTC),
		reportsStringPointer("vendor_credit_note"), &billOne, []reportsSeedLine{
			{accountCode: "2000", debitMinor: 300}, {accountCode: "1205", creditMinor: 300},
		})

	report, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SalesTaxReportOutput, error) {
		return salesTaxReport(fx.ctx, tx, fx.orgID, SalesTaxReportInput{From: "2026-03-01", To: "2026-03-31"})
	})
	if err != nil {
		t.Fatalf("salesTaxReport: %v", err)
	}
	if report.TaxableSalesMinor != 14_000 || report.TaxCollectedMinor != 1_600 ||
		report.RecoverableInputTaxMinor != 700 || report.NetTaxMinor != 900 {
		t.Fatalf("salesTaxReport totals = %+v, want 14000/1600/700/900", report)
	}
	if report.BaseCurrency != "USD" || report.UnsupportedForeignCount != 3 || report.Basis != "tax-code-and-document-snapshots" {
		t.Fatalf("salesTaxReport header = %+v, want three unsupported foreign documents", report)
	}
	encoded, err := marshalJS(report)
	if err != nil || string(encoded) != `{"taxableSalesMinor":14000,"taxCollectedMinor":1600,"recoverableInputTaxMinor":700,`+
		`"netTaxMinor":900,"baseCurrency":"USD","unsupportedForeignCount":3,"basis":"tax-code-and-document-snapshots"}` {
		t.Fatalf("salesTaxReport JSON = %s, %v", encoded, err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SalesTaxReportOutput, error) {
		return salesTaxReport(fx.ctx, tx, fx.orgID, SalesTaxReportInput{From: "2026-03-31", To: "2026-03-01"})
	}); err == nil || err.Error() != "`to` is before `from`" {
		t.Fatalf("inverted window error = %v, want to before from refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SalesTaxReportOutput, error) {
		return salesTaxReport(fx.ctx, tx, fx.orgID, SalesTaxReportInput{From: "2026-02-30", To: "2026-03-31"})
	}); err == nil || err.Error() != "dates must be YYYY-MM-DD" {
		t.Fatalf("impossible date error = %v, want strict calendar refusal", err)
	}
}

func toInt64Pointer(value int64) *int64 { return &value }

func reportsStringPointer(value string) *string { return &value }
