package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	incomeStatementCapabilityID        = "accounting.incomeStatement"
	reportCurrencyMetadataCapabilityID = "accounting.reportCurrencyMetadata"
	balanceSheetCapabilityID           = "accounting.balanceSheet"
	listInvoicesCapabilityID           = "accounting.listInvoices"
	arAgingCapabilityID                = "accounting.arAging"
	cashBasisReportCapabilityID        = "accounting.cashBasisReport"
	customerStatementCapabilityID      = "accounting.customerStatement"
	salesTaxReportCapabilityID         = "accounting.salesTaxReport"
	cashFlowCapabilityID               = "accounting.cashFlow"
	cashForecastCapabilityID           = "accounting.cashForecast"
)

type ReportCurrencyMetadataInput struct{}

type ReportCurrencyMetadataOutput struct {
	BaseCurrency          string   `json:"baseCurrency"`
	UnsupportedCurrencies []string `json:"unsupportedCurrencies"`
}

func ParseReportCurrencyMetadataInput(raw json.RawMessage) (ReportCurrencyMetadataInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ReportCurrencyMetadataInput{}, err
	}
	return ReportCurrencyMetadataInput{}, nil
}

func reportCurrencyMetadata(ctx context.Context, tx pgx.Tx, orgID string) (ReportCurrencyMetadataOutput, error) {
	baseCurrency, err := reportBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return ReportCurrencyMetadataOutput{}, err
	}
	if !validReportCurrencyCode(baseCurrency) {
		return ReportCurrencyMetadataOutput{}, errors.New("report base currency is invalid")
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT currency
		FROM journal_entries
		WHERE org_id = $1::uuid AND currency <> $2
		ORDER BY currency`, orgID, baseCurrency)
	if err != nil {
		return ReportCurrencyMetadataOutput{}, err
	}
	defer rows.Close()
	currencies := make([]string, 0)
	for rows.Next() {
		var currency string
		if err := rows.Scan(&currency); err != nil {
			return ReportCurrencyMetadataOutput{}, err
		}
		if !validReportCurrencyCode(currency) || currency == baseCurrency ||
			(len(currencies) > 0 && currency <= currencies[len(currencies)-1]) {
			return ReportCurrencyMetadataOutput{}, errors.New("report currency metadata is invalid")
		}
		currencies = append(currencies, currency)
	}
	if err := rows.Err(); err != nil {
		return ReportCurrencyMetadataOutput{}, err
	}
	return ReportCurrencyMetadataOutput{BaseCurrency: baseCurrency, UnsupportedCurrencies: currencies}, nil
}

func validReportCurrencyCode(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, char := range value {
		if char < 'A' || char > 'Z' {
			return false
		}
	}
	return true
}

type IncomeStatementInput struct{}

type IncomeStatementLine struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	AmountMinor int64  `json:"amountMinor"`
}

type IncomeStatementOutput struct {
	RevenueMinor   int64                 `json:"revenueMinor"`
	ExpenseMinor   int64                 `json:"expenseMinor"`
	NetIncomeMinor int64                 `json:"netIncomeMinor"`
	Lines          []IncomeStatementLine `json:"lines"`
}

type BalanceSheetInput struct{}

type BalanceSheetOutput struct {
	AssetsMinor         int64 `json:"assetsMinor"`
	LiabilitiesMinor    int64 `json:"liabilitiesMinor"`
	EquityMinor         int64 `json:"equityMinor"`
	RetainedResultMinor int64 `json:"retainedResultMinor"`
	Balanced            bool  `json:"balanced"`
}

type ListInvoicesInput struct {
	CustomerID *string `json:"customerId,omitempty"`
	Status     *string `json:"status,omitempty"`
	Limit      int64   `json:"limit"`
}

type ListInvoiceRow struct {
	ID               string  `json:"id"`
	Number           int64   `json:"number"`
	CustomerID       string  `json:"customerId"`
	CustomerName     string  `json:"customerName"`
	Status           string  `json:"status"`
	Currency         string  `json:"currency"`
	TotalMinor       int64   `json:"totalMinor"`
	PaidMinor        int64   `json:"paidMinor"`
	CreditedMinor    int64   `json:"creditedMinor"`
	OutstandingMinor int64   `json:"outstandingMinor"`
	IssuedAt         *string `json:"issuedAt"`
}

type ListInvoicesOutput struct {
	Invoices []ListInvoiceRow `json:"invoices"`
}

type ArAgingInput struct{}

type ArAgingBucketTotals struct {
	Current          int64 `json:"current"`
	D30              int64 `json:"d30"`
	D60              int64 `json:"d60"`
	D90Plus          int64 `json:"d90plus"`
	TotalOutstanding int64 `json:"totalOutstanding"`
}

type ArAgingInvoice struct {
	Number           int64 `json:"number"`
	OutstandingMinor int64 `json:"outstandingMinor"`
	AgeDays          int64 `json:"ageDays"`
}

type ArAgingOutput struct {
	Buckets  ArAgingBucketTotals `json:"buckets"`
	Invoices []ArAgingInvoice    `json:"invoices"`
}

type CashBasisReportInput struct {
	Year             int64    `json:"year"`
	Month            *int64   `json:"month,omitempty"`
	CashAccountCodes []string `json:"cashAccountCodes"`
}

type CashBasisReportOutput struct {
	CashInMinor         int64 `json:"cashInMinor"`
	CashOutMinor        int64 `json:"cashOutMinor"`
	NetCashMinor        int64 `json:"netCashMinor"`
	AccrualRevenueMinor int64 `json:"accrualRevenueMinor"`
	AccrualExpenseMinor int64 `json:"accrualExpenseMinor"`
	UncollectedMinor    int64 `json:"uncollectedMinor"`
}

type CashFlowInput struct {
	CashAccountCodes []string `json:"cashAccountCodes"`
}

type CashFlowCategoryTotal struct {
	InflowMinor  int64 `json:"inflowMinor"`
	OutflowMinor int64 `json:"outflowMinor"`
	NetMinor     int64 `json:"netMinor"`
	Entries      int64 `json:"entries"`
}

type CashFlowOutput struct {
	OpeningMinor          int64                 `json:"openingMinor"`
	ClosingMinor          int64                 `json:"closingMinor"`
	NetMinor              int64                 `json:"netMinor"`
	CashBalanceMinor      int64                 `json:"cashBalanceMinor"`
	Ties                  bool                  `json:"ties"`
	UnsupportedCurrencies []string              `json:"unsupportedCurrencies"`
	Operating             CashFlowCategoryTotal `json:"operating"`
	Investing             CashFlowCategoryTotal `json:"investing"`
	Financing             CashFlowCategoryTotal `json:"financing"`
}

type CashForecastInput struct {
	CashAccountCodes []string `json:"cashAccountCodes"`
	BudgetScenarioID *string  `json:"budgetScenarioId,omitempty"`
}

type CashForecastWeek struct {
	WeekStart    string `json:"weekStart"`
	InflowMinor  int64  `json:"inflowMinor"`
	OutflowMinor int64  `json:"outflowMinor"`
	CloseMinor   int64  `json:"closeMinor"`
}

type CashForecastOutput struct {
	StartMinor             int64              `json:"startMinor"`
	FinalMinor             int64              `json:"finalMinor"`
	LowestCloseMinor       int64              `json:"lowestCloseMinor"`
	LowestWeekIndex        int64              `json:"lowestWeekIndex"`
	ScenarioName           *string            `json:"scenarioName"`
	MinimumCashBufferMinor int64              `json:"minimumCashBufferMinor"`
	UnsupportedCurrencies  []string           `json:"unsupportedCurrencies"`
	Weeks                  []CashForecastWeek `json:"weeks"`
}

type CustomerStatementInput struct {
	CustomerID string `json:"customerId"`
}

type CustomerStatementRow struct {
	Date         string `json:"date"`
	Kind         string `json:"kind"`
	Ref          string `json:"ref"`
	AmountMinor  int64  `json:"amountMinor"`
	BalanceMinor int64  `json:"balanceMinor"`
}

type CustomerStatementCurrency struct {
	Currency            string                 `json:"currency"`
	OpeningBalanceMinor int64                  `json:"openingBalanceMinor"`
	ClosingBalanceMinor int64                  `json:"closingBalanceMinor"`
	Rows                []CustomerStatementRow `json:"rows"`
}

type CustomerStatementOutput struct {
	Currencies []CustomerStatementCurrency `json:"currencies"`
}

type SalesTaxReportInput struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type SalesTaxReportOutput struct {
	TaxableSalesMinor        int64  `json:"taxableSalesMinor"`
	TaxCollectedMinor        int64  `json:"taxCollectedMinor"`
	RecoverableInputTaxMinor int64  `json:"recoverableInputTaxMinor"`
	NetTaxMinor              int64  `json:"netTaxMinor"`
	BaseCurrency             string `json:"baseCurrency"`
	UnsupportedForeignCount  int64  `json:"unsupportedForeignCount"`
	Basis                    string `json:"basis"`
}

func ParseIncomeStatementInput(raw json.RawMessage) (IncomeStatementInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return IncomeStatementInput{}, err
	}
	return IncomeStatementInput{}, nil
}

func ParseBalanceSheetInput(raw json.RawMessage) (BalanceSheetInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return BalanceSheetInput{}, err
	}
	return BalanceSheetInput{}, nil
}

func ParseArAgingInput(raw json.RawMessage) (ArAgingInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ArAgingInput{}, err
	}
	return ArAgingInput{}, nil
}

func ParseListInvoicesInput(raw json.RawMessage) (ListInvoicesInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListInvoicesInput{}, err
	}
	var input ListInvoicesInput
	if input.CustomerID, err = optionalString(fields, "customerId"); err != nil {
		return ListInvoicesInput{}, err
	}
	if input.Status, err = optionalString(fields, "status"); err != nil {
		return ListInvoicesInput{}, err
	} else if input.Status != nil {
		switch *input.Status {
		case "draft", "sent", "paid", "void":
		default:
			return ListInvoicesInput{}, errors.New("status must be one of draft, sent, paid, void")
		}
	}
	input.Limit = 50
	if _, ok := fields["limit"]; ok {
		limit, err := requiredSafeInteger(fields, "limit")
		if err != nil || limit < 1 || limit > 100 {
			return ListInvoicesInput{}, errors.New("limit must be an integer between 1 and 100")
		}
		input.Limit = limit
	}
	return input, nil
}

func reportStringListField(fields map[string]json.RawMessage, key string, fallback []string) ([]string, error) {
	raw, ok := fields[key]
	if !ok {
		return fallback, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	return values, nil
}

func ParseCashBasisReportInput(raw json.RawMessage) (CashBasisReportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CashBasisReportInput{}, err
	}
	var input CashBasisReportInput
	if input.Year, err = requiredSafeInteger(fields, "year"); err != nil || input.Year < 2000 || input.Year > 2100 {
		return CashBasisReportInput{}, errors.New("year must be an integer between 2000 and 2100")
	}
	if rawMonth, ok := fields["month"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawMonth), []byte("null")) {
			return CashBasisReportInput{}, errors.New("month must be an integer between 1 and 12")
		}
		month, err := requiredSafeInteger(fields, "month")
		if err != nil || month < 1 || month > 12 {
			return CashBasisReportInput{}, errors.New("month must be an integer between 1 and 12")
		}
		input.Month = &month
	}
	if input.CashAccountCodes, err = reportStringListField(fields, "cashAccountCodes", []string{"1000"}); err != nil {
		return CashBasisReportInput{}, err
	}
	return input, nil
}

func ParseCashFlowInput(raw json.RawMessage) (CashFlowInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CashFlowInput{}, err
	}
	var input CashFlowInput
	if input.CashAccountCodes, err = reportStringListField(fields, "cashAccountCodes", []string{"1000"}); err != nil {
		return CashFlowInput{}, err
	}
	return input, nil
}

func ParseCashForecastInput(raw json.RawMessage) (CashForecastInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CashForecastInput{}, err
	}
	var input CashForecastInput
	if input.CashAccountCodes, err = reportStringListField(fields, "cashAccountCodes", []string{"1000"}); err != nil {
		return CashForecastInput{}, err
	}
	if _, ok := fields["budgetScenarioId"]; ok {
		if input.BudgetScenarioID, err = bankOptionalUUID(fields, "budgetScenarioId"); err != nil {
			return CashForecastInput{}, errors.New("budgetScenarioId must be a UUID")
		}
	}
	return input, nil
}

func ParseCustomerStatementInput(raw json.RawMessage) (CustomerStatementInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CustomerStatementInput{}, err
	}
	var input CustomerStatementInput
	if input.CustomerID, err = requiredString(fields, "customerId"); err != nil {
		return CustomerStatementInput{}, err
	}
	if !isZodUUID(input.CustomerID) {
		return CustomerStatementInput{}, errors.New("customerId must be a UUID")
	}
	return input, nil
}

func ParseSalesTaxReportInput(raw json.RawMessage) (SalesTaxReportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SalesTaxReportInput{}, err
	}
	var input SalesTaxReportInput
	if input.From, err = requiredString(fields, "from"); err != nil {
		return SalesTaxReportInput{}, err
	}
	if !bankISODatePattern.MatchString(input.From) {
		return SalesTaxReportInput{}, errors.New("from must be a YYYY-MM-DD date")
	}
	if input.To, err = requiredString(fields, "to"); err != nil {
		return SalesTaxReportInput{}, err
	}
	if !bankISODatePattern.MatchString(input.To) {
		return SalesTaxReportInput{}, errors.New("to must be a YYYY-MM-DD date")
	}
	return input, nil
}

type accountBalanceRow struct {
	code        string
	name        string
	accountType string
	debitMinor  int64
	creditMinor int64
}

func reportSignedBalance(a accountBalanceRow) int64 {
	net := a.debitMinor - a.creditMinor
	switch a.accountType {
	case "asset", "expense":
		return net
	default:
		return -net
	}
}

// reportDocumentOutstandingMinor mirrors erp-core documentBalance: one
// balance contract, credits reduce what collections chase, negative money
// inputs are refused rather than laundered.
func reportDocumentOutstandingMinor(totalMinor, paidMinor, creditedMinor int64) (int64, error) {
	for _, check := range []struct {
		value int64
		field string
	}{{totalMinor, "totalMinor"}, {paidMinor, "paidMinor"}, {creditedMinor, "creditedMinor"}} {
		if check.value < 0 {
			return 0, fmt.Errorf("%s must be a non-negative integer minor amount", check.field)
		}
	}
	outstanding := totalMinor - paidMinor - creditedMinor
	if outstanding < 0 {
		return 0, nil
	}
	return outstanding, nil
}

func reportBaseCurrency(ctx context.Context, tx pgx.Tx, orgID string) (string, error) {
	var base string
	err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&base)
	if errors.Is(err, pgx.ErrNoRows) {
		return "USD", nil
	}
	if err != nil {
		return "", err
	}
	return base, nil
}

// reportAccountBalances mirrors the TypeScript accountBalances helper:
// base-currency totals per account, with year-end rolls excluded either
// entirely (excludeClosing) or only for the year being closed
// (excludeClosingInYear) so closing never erases operating history.
func reportAccountBalances(ctx context.Context, tx pgx.Tx, orgID string, excludeClosing bool, excludeClosingInYear *int64) ([]accountBalanceRow, error) {
	base, err := reportBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return nil, err
	}
	query := `
		SELECT a.code, a.name, a.type,
		       coalesce(sum(jl.debit_minor), 0)::text, coalesce(sum(jl.credit_minor), 0)::text
		FROM accounts a
		LEFT JOIN journal_lines jl ON jl.account_id = a.id
		LEFT JOIN journal_entries je ON je.id = jl.entry_id
		WHERE a.org_id = $1::uuid
		  AND je.org_id = $1::uuid
		  AND (je.currency IS NULL OR je.currency = $2)`
	args := []any{orgID, base}
	switch {
	case excludeClosing:
		query += ` AND je.entry_kind <> 'year_end_close'`
	case excludeClosingInYear != nil:
		query += ` AND NOT (je.entry_kind = 'year_end_close' AND extract(year from je.posted_at) = $3)`
		args = append(args, *excludeClosingInYear)
	}
	query += ` GROUP BY a.code, a.name, a.type ORDER BY a.code`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	balances := make([]accountBalanceRow, 0, 8)
	for rows.Next() {
		var balance accountBalanceRow
		var debitText, creditText string
		if err := rows.Scan(&balance.code, &balance.name, &balance.accountType, &debitText, &creditText); err != nil {
			return nil, err
		}
		if balance.debitMinor, err = strconv.ParseInt(debitText, 10, 64); err != nil {
			return nil, err
		}
		if balance.creditMinor, err = strconv.ParseInt(creditText, 10, 64); err != nil {
			return nil, err
		}
		if !reportSafeInteger(balance.debitMinor) || !reportSafeInteger(balance.creditMinor) || !reportSafeInteger(reportSignedBalance(balance)) {
			return nil, errors.New("account balance exceeds the supported amount range")
		}
		balances = append(balances, balance)
	}
	return balances, rows.Err()
}

func reportSafeInteger(value int64) bool {
	return value >= -maxSafeInteger && value <= maxSafeInteger
}

func reportAddSafeIntegers(left, right int64) (int64, error) {
	if !reportSafeInteger(left) || !reportSafeInteger(right) ||
		(right > 0 && left > maxSafeInteger-right) ||
		(right < 0 && left < -maxSafeInteger-right) {
		return 0, errors.New("accounting report total exceeds the supported amount range")
	}
	return left + right, nil
}

// computeIncomeStatement mirrors erp-core computeIncomeStatement: a pure
// P&L over income and expense balances, ordered by account code.
func computeIncomeStatement(balances []accountBalanceRow) (IncomeStatementOutput, error) {
	var revenue, expense int64
	lines := make([]IncomeStatementLine, 0, len(balances))
	for _, a := range balances {
		amount := reportSignedBalance(a)
		switch a.accountType {
		case "income":
			var err error
			revenue, err = reportAddSafeIntegers(revenue, amount)
			if err != nil {
				return IncomeStatementOutput{}, err
			}
			lines = append(lines, IncomeStatementLine{Code: a.code, Name: a.name, AmountMinor: amount})
		case "expense":
			var err error
			expense, err = reportAddSafeIntegers(expense, amount)
			if err != nil {
				return IncomeStatementOutput{}, err
			}
			lines = append(lines, IncomeStatementLine{Code: a.code, Name: a.name, AmountMinor: amount})
		}
	}
	netIncome, err := reportAddSafeIntegers(revenue, -expense)
	if err != nil {
		return IncomeStatementOutput{}, err
	}
	return IncomeStatementOutput{
		RevenueMinor:   revenue,
		ExpenseMinor:   expense,
		NetIncomeMinor: netIncome,
		Lines:          lines,
	}, nil
}

// computeBalanceSheet mirrors erp-core computeBalanceSheet minus the
// display sections: balanced false means the ledger is corrupt.
func computeBalanceSheet(balances []accountBalanceRow) (BalanceSheetOutput, error) {
	var assets, liabilities, equity int64
	for _, a := range balances {
		amount := reportSignedBalance(a)
		switch a.accountType {
		case "asset":
			var err error
			assets, err = reportAddSafeIntegers(assets, amount)
			if err != nil {
				return BalanceSheetOutput{}, err
			}
		case "liability":
			var err error
			liabilities, err = reportAddSafeIntegers(liabilities, amount)
			if err != nil {
				return BalanceSheetOutput{}, err
			}
		case "equity":
			var err error
			equity, err = reportAddSafeIntegers(equity, amount)
			if err != nil {
				return BalanceSheetOutput{}, err
			}
		}
	}
	pnl, err := computeIncomeStatement(balances)
	if err != nil {
		return BalanceSheetOutput{}, err
	}
	retainedResult := pnl.NetIncomeMinor
	right, err := reportAddSafeIntegers(liabilities, equity)
	if err != nil {
		return BalanceSheetOutput{}, err
	}
	right, err = reportAddSafeIntegers(right, retainedResult)
	if err != nil {
		return BalanceSheetOutput{}, err
	}
	return BalanceSheetOutput{
		AssetsMinor:         assets,
		LiabilitiesMinor:    liabilities,
		EquityMinor:         equity,
		RetainedResultMinor: retainedResult,
		Balanced:            assets == right,
	}, nil
}

func incomeStatement(ctx context.Context, tx pgx.Tx, orgID string, input IncomeStatementInput) (IncomeStatementOutput, error) {
	balances, err := reportAccountBalances(ctx, tx, orgID, true, nil)
	if err != nil {
		return IncomeStatementOutput{}, err
	}
	return computeIncomeStatement(balances)
}

func balanceSheet(ctx context.Context, tx pgx.Tx, orgID string, input BalanceSheetInput) (BalanceSheetOutput, error) {
	balances, err := reportAccountBalances(ctx, tx, orgID, false, nil)
	if err != nil {
		return BalanceSheetOutput{}, err
	}
	return computeBalanceSheet(balances)
}

func listInvoices(ctx context.Context, tx pgx.Tx, orgID string, input ListInvoicesInput) (ListInvoicesOutput, error) {
	query := `
		SELECT i.id::text, i.number, i.customer_id::text, c.name, i.status, i.currency,
		       i.total_minor, i.paid_minor, i.credited_minor, i.issued_at
		FROM invoices i
		JOIN customers c ON c.id = i.customer_id
		WHERE i.org_id = $1::uuid`
	args := []any{orgID}
	if input.CustomerID != nil {
		query += ` AND i.customer_id = $2::uuid`
		args = append(args, *input.CustomerID)
	}
	if input.Status != nil {
		query += fmt.Sprintf(` AND i.status = $%d`, len(args)+1)
		args = append(args, *input.Status)
	}
	query += fmt.Sprintf(` ORDER BY i.number DESC LIMIT $%d`, len(args)+1)
	args = append(args, input.Limit)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return ListInvoicesOutput{}, err
	}
	defer rows.Close()
	invoices := make([]ListInvoiceRow, 0)
	for rows.Next() {
		var row ListInvoiceRow
		var issuedAt *time.Time
		if err := rows.Scan(&row.ID, &row.Number, &row.CustomerID, &row.CustomerName, &row.Status, &row.Currency,
			&row.TotalMinor, &row.PaidMinor, &row.CreditedMinor, &issuedAt); err != nil {
			return ListInvoicesOutput{}, err
		}
		if issuedAt != nil {
			formatted := reportISODateTime(*issuedAt)
			row.IssuedAt = &formatted
		}
		if row.OutstandingMinor, err = reportDocumentOutstandingMinor(row.TotalMinor, row.PaidMinor, row.CreditedMinor); err != nil {
			return ListInvoicesOutput{}, err
		}
		invoices = append(invoices, row)
	}
	if err := rows.Err(); err != nil {
		return ListInvoicesOutput{}, err
	}
	return ListInvoicesOutput{Invoices: invoices}, nil
}

const reportDayMillis int64 = 86_400_000

// reportFloorDays mirrors JavaScript Math.floor(delta / DAY) for the aging
// clocks, including negative (not yet due) deltas.
func reportFloorDays(deltaMillis int64) int64 {
	quotient := deltaMillis / reportDayMillis
	if deltaMillis%reportDayMillis != 0 && deltaMillis < 0 {
		quotient--
	}
	return quotient
}

type reportReceivable struct {
	invoiceNumber    int64
	outstandingMinor int64
	issuedAt         time.Time
	dueAt            *time.Time
}

func reportReceivableRef(r reportReceivable) time.Time {
	if r.dueAt != nil {
		return *r.dueAt
	}
	return r.issuedAt
}

// computeReportAging mirrors erp-core computeAging: buckets at the explicit
// as-of instant, the clock is the due date when present, not-yet-due
// invoices sit in current.
func computeReportAging(receivables []reportReceivable, now time.Time) ArAgingBucketTotals {
	var buckets ArAgingBucketTotals
	nowMillis := now.UnixMilli()
	for _, r := range receivables {
		if r.outstandingMinor <= 0 {
			continue
		}
		overdueDays := reportFloorDays(nowMillis - reportReceivableRef(r).UnixMilli())
		switch {
		case overdueDays <= 30:
			buckets.Current += r.outstandingMinor
		case overdueDays <= 60:
			buckets.D30 += r.outstandingMinor
		case overdueDays <= 90:
			buckets.D60 += r.outstandingMinor
		default:
			buckets.D90Plus += r.outstandingMinor
		}
		buckets.TotalOutstanding += r.outstandingMinor
	}
	return buckets
}

func arAging(ctx context.Context, tx pgx.Tx, orgID string, input ArAgingInput, now time.Time) (ArAgingOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT number, total_minor, paid_minor, credited_minor, issued_at, due_at
		FROM invoices
		WHERE org_id = $1::uuid
		  AND status IN ('sent', 'paid')
		  AND voided_at IS NULL
		ORDER BY number`, orgID)
	if err != nil {
		return ArAgingOutput{}, err
	}
	defer rows.Close()
	receivables := make([]reportReceivable, 0)
	ages := make([]int64, 0)
	for rows.Next() {
		var number int64
		var totalMinor, paidMinor, creditedMinor int64
		var issuedAt, dueAt *time.Time
		if err := rows.Scan(&number, &totalMinor, &paidMinor, &creditedMinor, &issuedAt, &dueAt); err != nil {
			return ArAgingOutput{}, err
		}
		if issuedAt == nil {
			continue
		}
		outstanding, err := reportDocumentOutstandingMinor(totalMinor, paidMinor, creditedMinor)
		if err != nil {
			return ArAgingOutput{}, err
		}
		if outstanding <= 0 {
			continue
		}
		receivable := reportReceivable{invoiceNumber: number, outstandingMinor: outstanding, issuedAt: *issuedAt, dueAt: dueAt}
		receivables = append(receivables, receivable)
		ages = append(ages, reportFloorDays(now.UnixMilli()-reportReceivableRef(receivable).UnixMilli()))
	}
	if err := rows.Err(); err != nil {
		return ArAgingOutput{}, err
	}
	invoices := make([]ArAgingInvoice, 0, len(receivables))
	for index, receivable := range receivables {
		invoices = append(invoices, ArAgingInvoice{
			Number:           receivable.invoiceNumber,
			OutstandingMinor: receivable.outstandingMinor,
			AgeDays:          ages[index],
		})
	}
	return ArAgingOutput{Buckets: computeReportAging(receivables, now), Invoices: invoices}, nil
}

type reportCashBasisLine struct {
	accountCode string
	accountType string
	debitMinor  int64
	creditMinor int64
}

type reportCashBasisEntry struct {
	occurredAt time.Time
	lines      []reportCashBasisLine
}

func reportCashLineSigned(l reportCashBasisLine) (int64, error) {
	return reportSubtractSafeIntegers(l.debitMinor, l.creditMinor)
}

func reportSubtractSafeIntegers(left, right int64) (int64, error) {
	if !reportSafeInteger(left) || !reportSafeInteger(right) {
		return 0, errors.New("accounting report total exceeds the supported amount range")
	}
	return reportAddSafeIntegers(left, -right)
}

// computeReportCashBasis mirrors erp-core computeCashBasis: the ledger
// stays accrual, cash basis is derived. An entry counts only inside the
// half-open window; only entries with a nonzero cash leg move cash, and
// refunds net against their side instead of double-counting gross flows.
func computeReportCashBasis(entries []reportCashBasisEntry, cashAccountCodes map[string]struct{}, from, to *time.Time) (CashBasisReportOutput, error) {
	var cashIn, cashOut, accrualRevenue, accrualExpense int64
	for _, entry := range entries {
		if from != nil && entry.occurredAt.Before(*from) {
			continue
		}
		if to != nil && !entry.occurredAt.Before(*to) {
			continue
		}
		cashLines := make([]reportCashBasisLine, 0, 1)
		for _, line := range entry.lines {
			if _, ok := cashAccountCodes[line.accountCode]; ok {
				cashLines = append(cashLines, line)
			}
		}
		hasCashLeg := false
		for _, line := range cashLines {
			delta, err := reportCashLineSigned(line)
			if err != nil {
				return CashBasisReportOutput{}, err
			}
			if delta != 0 {
				hasCashLeg = true
				break
			}
		}
		for _, line := range entry.lines {
			if line.accountType == "income" {
				delta, err := reportSubtractSafeIntegers(line.creditMinor, line.debitMinor)
				if err != nil {
					return CashBasisReportOutput{}, err
				}
				accrualRevenue, err = reportAddSafeIntegers(accrualRevenue, delta)
				if err != nil {
					return CashBasisReportOutput{}, err
				}
			}
			if line.accountType == "expense" {
				delta, err := reportSubtractSafeIntegers(line.debitMinor, line.creditMinor)
				if err != nil {
					return CashBasisReportOutput{}, err
				}
				accrualExpense, err = reportAddSafeIntegers(accrualExpense, delta)
				if err != nil {
					return CashBasisReportOutput{}, err
				}
			}
		}
		if !hasCashLeg {
			continue
		}
		for _, line := range cashLines {
			delta, err := reportCashLineSigned(line)
			if err != nil {
				return CashBasisReportOutput{}, err
			}
			if delta > 0 {
				cashIn, err = reportAddSafeIntegers(cashIn, delta)
				if err != nil {
					return CashBasisReportOutput{}, err
				}
			} else {
				cashOut, err = reportAddSafeIntegers(cashOut, -delta)
				if err != nil {
					return CashBasisReportOutput{}, err
				}
			}
		}
	}
	netCash, err := reportSubtractSafeIntegers(cashIn, cashOut)
	if err != nil {
		return CashBasisReportOutput{}, err
	}
	uncollected, err := reportSubtractSafeIntegers(accrualRevenue, cashIn)
	if err != nil {
		return CashBasisReportOutput{}, err
	}
	if uncollected < 0 {
		uncollected = 0
	}
	return CashBasisReportOutput{
		CashInMinor:         cashIn,
		CashOutMinor:        cashOut,
		NetCashMinor:        netCash,
		AccrualRevenueMinor: accrualRevenue,
		AccrualExpenseMinor: accrualExpense,
		UncollectedMinor:    uncollected,
	}, nil
}

func cashBasisReport(ctx context.Context, tx pgx.Tx, orgID string, input CashBasisReportInput) (CashBasisReportOutput, error) {
	var from, to time.Time
	if input.Month != nil {
		from = time.Date(int(input.Year), time.Month(*input.Month), 1, 0, 0, 0, 0, time.UTC)
		to = time.Date(int(input.Year), time.Month(*input.Month)+1, 1, 0, 0, 0, 0, time.UTC)
	} else {
		from = time.Date(int(input.Year), time.January, 1, 0, 0, 0, 0, time.UTC)
		to = time.Date(int(input.Year)+1, time.January, 1, 0, 0, 0, 0, time.UTC)
	}
	rows, err := tx.Query(ctx, `
		SELECT je.id::text, je.posted_at, a.code, a.type, jl.debit_minor, jl.credit_minor
		FROM journal_entries je
		JOIN journal_lines jl ON jl.entry_id = je.id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid
		ORDER BY je.id`, orgID)
	if err != nil {
		return CashBasisReportOutput{}, err
	}
	defer rows.Close()
	entries := make([]reportCashBasisEntry, 0, 8)
	indexByID := make(map[string]int)
	for rows.Next() {
		var entryID string
		var postedAt time.Time
		var line reportCashBasisLine
		if err := rows.Scan(&entryID, &postedAt, &line.accountCode, &line.accountType, &line.debitMinor, &line.creditMinor); err != nil {
			return CashBasisReportOutput{}, err
		}
		if index, ok := indexByID[entryID]; ok {
			entries[index].lines = append(entries[index].lines, line)
			continue
		}
		indexByID[entryID] = len(entries)
		entries = append(entries, reportCashBasisEntry{occurredAt: postedAt, lines: []reportCashBasisLine{line}})
	}
	if err := rows.Err(); err != nil {
		return CashBasisReportOutput{}, err
	}
	cashCodes := make(map[string]struct{}, len(input.CashAccountCodes))
	for _, code := range input.CashAccountCodes {
		cashCodes[code] = struct{}{}
	}
	return computeReportCashBasis(entries, cashCodes, &from, &to)
}

type reportCashFlowEntry struct {
	occurredAt time.Time
	currency   string
	lines      []reportCashBasisLine
}

var reportOperatingCashCodes = map[string]struct{}{"1100": {}, "1200": {}, "2000": {}, "2100": {}}

func reportIsCashLine(l reportCashBasisLine, cashCodes map[string]struct{}) bool {
	_, ok := cashCodes[l.accountCode]
	return ok
}

// classifyReportCashEntry mirrors erp-core classifyCashEntry: entries that
// never touch cash are invisible to a direct-method statement; the category
// comes from the counter-accounts.
func classifyReportCashEntry(lines []reportCashBasisLine, cashCodes map[string]struct{}) (cashDeltaMinor int64, category string, ok bool, err error) {
	var cashDelta int64
	hasCash := false
	counters := make([]reportCashBasisLine, 0, len(lines))
	for _, line := range lines {
		if reportIsCashLine(line, cashCodes) {
			delta, lineErr := reportCashLineSigned(line)
			if lineErr != nil {
				return 0, "", false, lineErr
			}
			cashDelta, lineErr = reportAddSafeIntegers(cashDelta, delta)
			if lineErr != nil {
				return 0, "", false, lineErr
			}
			hasCash = true
			continue
		}
		counters = append(counters, line)
	}
	if !hasCash {
		return 0, "", false, nil
	}
	category = "operating"
	if len(counters) > 0 {
		hasEquity := false
		allAssets := true
		noOperating := true
		for _, counter := range counters {
			if counter.accountType == "equity" {
				hasEquity = true
			}
			if counter.accountType != "asset" {
				allAssets = false
			}
			if _, operating := reportOperatingCashCodes[counter.accountCode]; operating {
				noOperating = false
			}
		}
		switch {
		case hasEquity:
			category = "financing"
		case allAssets && noOperating:
			category = "investing"
		}
	}
	return cashDelta, category, true, nil
}

func cashBalanceFromReportEntries(entries []reportCashFlowEntry, cashCodes map[string]struct{}) (int64, error) {
	var balance int64
	for _, entry := range entries {
		for _, line := range entry.lines {
			if reportIsCashLine(line, cashCodes) {
				delta, err := reportCashLineSigned(line)
				if err != nil {
					return 0, err
				}
				balance, err = reportAddSafeIntegers(balance, delta)
				if err != nil {
					return 0, err
				}
			}
		}
	}
	return balance, nil
}

// buildReportCashFlowStatement mirrors erp-core buildCashFlowStatement:
// every cash movement must land in exactly one category, and the derived
// closing must tie to the independent cash balance.
func buildReportCashFlowStatement(entries []reportCashFlowEntry, cashCodes map[string]struct{}, openingMinor int64) (CashFlowOutput, error) {
	if !reportSafeInteger(openingMinor) {
		return CashFlowOutput{}, errors.New("accounting report total exceeds the supported amount range")
	}
	statement := CashFlowOutput{OpeningMinor: openingMinor}
	for _, entry := range entries {
		cashDelta, category, ok, err := classifyReportCashEntry(entry.lines, cashCodes)
		if err != nil {
			return CashFlowOutput{}, err
		}
		if !ok {
			continue
		}
		total := &statement.Operating
		switch category {
		case "investing":
			total = &statement.Investing
		case "financing":
			total = &statement.Financing
		}
		if cashDelta >= 0 {
			total.InflowMinor, err = reportAddSafeIntegers(total.InflowMinor, cashDelta)
		} else {
			total.OutflowMinor, err = reportAddSafeIntegers(total.OutflowMinor, -cashDelta)
		}
		if err != nil {
			return CashFlowOutput{}, err
		}
		total.NetMinor, err = reportAddSafeIntegers(total.NetMinor, cashDelta)
		if err != nil {
			return CashFlowOutput{}, err
		}
		total.Entries++
	}
	net, err := reportAddSafeIntegers(statement.Operating.NetMinor, statement.Investing.NetMinor)
	if err != nil {
		return CashFlowOutput{}, err
	}
	statement.NetMinor, err = reportAddSafeIntegers(net, statement.Financing.NetMinor)
	if err != nil {
		return CashFlowOutput{}, err
	}
	statement.ClosingMinor, err = reportAddSafeIntegers(openingMinor, statement.NetMinor)
	if err != nil {
		return CashFlowOutput{}, err
	}
	statement.CashBalanceMinor, err = cashBalanceFromReportEntries(entries, cashCodes)
	if err != nil {
		return CashFlowOutput{}, err
	}
	closingFromBalance, err := reportAddSafeIntegers(openingMinor, statement.CashBalanceMinor)
	if err != nil {
		return CashFlowOutput{}, err
	}
	statement.Ties = statement.NetMinor == statement.CashBalanceMinor && statement.ClosingMinor == closingFromBalance
	return statement, nil
}

func loadReportCashFlowEntries(ctx context.Context, tx pgx.Tx, orgID string) ([]reportCashFlowEntry, error) {
	rows, err := tx.Query(ctx, `
		SELECT je.id::text, je.posted_at, je.currency, a.code, a.type, jl.debit_minor, jl.credit_minor
		FROM journal_entries je
		JOIN journal_lines jl ON jl.entry_id = je.id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid
		ORDER BY je.id, jl.id`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := make([]reportCashFlowEntry, 0, 8)
	indexByID := make(map[string]int)
	for rows.Next() {
		var entryID string
		var postedAt time.Time
		var currency string
		var line reportCashBasisLine
		if err := rows.Scan(&entryID, &postedAt, &currency, &line.accountCode, &line.accountType, &line.debitMinor, &line.creditMinor); err != nil {
			return nil, err
		}
		if index, ok := indexByID[entryID]; ok {
			entries[index].lines = append(entries[index].lines, line)
			continue
		}
		indexByID[entryID] = len(entries)
		entries = append(entries, reportCashFlowEntry{occurredAt: postedAt, currency: currency, lines: []reportCashBasisLine{line}})
	}
	return entries, rows.Err()
}

func reportSortedUniqueCurrencies(values map[string]struct{}) []string {
	currencies := make([]string, 0, len(values))
	for currency := range values {
		currencies = append(currencies, currency)
	}
	sort.Strings(currencies)
	return currencies
}

func reportCashCodeSet(codes []string) map[string]struct{} {
	set := make(map[string]struct{}, len(codes))
	for _, code := range codes {
		set[code] = struct{}{}
	}
	return set
}

func cashFlow(ctx context.Context, tx pgx.Tx, orgID string, input CashFlowInput) (CashFlowOutput, error) {
	entries, err := loadReportCashFlowEntries(ctx, tx, orgID)
	if err != nil {
		return CashFlowOutput{}, err
	}
	baseCurrency, err := reportBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return CashFlowOutput{}, err
	}
	baseEntries := make([]reportCashFlowEntry, 0, len(entries))
	unsupported := make(map[string]struct{})
	for _, entry := range entries {
		if entry.currency == baseCurrency {
			baseEntries = append(baseEntries, entry)
			continue
		}
		unsupported[entry.currency] = struct{}{}
	}
	statement, err := buildReportCashFlowStatement(baseEntries, reportCashCodeSet(input.CashAccountCodes), 0)
	if err != nil {
		return CashFlowOutput{}, err
	}
	statement.UnsupportedCurrencies = reportSortedUniqueCurrencies(unsupported)
	return statement, nil
}

func reportWeekStart(d time.Time) time.Time {
	utc := d.UTC()
	dayStart := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	dow := (int(dayStart.Weekday()) + 6) % 7
	return dayStart.AddDate(0, 0, -dow)
}

type reportForecastFlow struct {
	dueAt       time.Time
	amountMinor int64
	kind        string
}

type reportForecast struct {
	startMinor       int64
	finalMinor       int64
	lowestCloseMinor int64
	lowestWeekIndex  int64
	weeks            []CashForecastWeek
}

const reportForecastWeeks = 13

// buildReportThirteenWeekForecast mirrors erp-core
// buildThirteenWeekForecast: every flow lands in exactly one weekly bucket
// (clamped into the horizon), closes chain, and the trough is the minimum
// over start cash and every weekly close.
func buildReportThirteenWeekForecast(startCashMinor int64, flows []reportForecastFlow, asOf time.Time) (reportForecast, error) {
	if !reportSafeInteger(startCashMinor) {
		return reportForecast{}, errors.New("cash forecast exceeds the supported amount range")
	}
	weekMillis := int64(7) * reportDayMillis
	firstWeekStart := reportWeekStart(asOf).UnixMilli()
	inflows := make([]int64, reportForecastWeeks)
	outflows := make([]int64, reportForecastWeeks)
	for _, flow := range flows {
		index := (reportWeekStart(flow.dueAt).UnixMilli() - firstWeekStart) / weekMillis
		if index < 0 {
			index = 0
		}
		if index > reportForecastWeeks-1 {
			index = reportForecastWeeks - 1
		}
		if !reportSafeInteger(flow.amountMinor) || flow.amountMinor < 0 {
			return reportForecast{}, errors.New("cash forecast flow exceeds the supported amount range")
		}
		var err error
		if flow.kind == "inflow" {
			inflows[index], err = reportAddSafeIntegers(inflows[index], flow.amountMinor)
		} else {
			outflows[index], err = reportAddSafeIntegers(outflows[index], flow.amountMinor)
		}
		if err != nil {
			return reportForecast{}, err
		}
	}
	forecast := reportForecast{startMinor: startCashMinor, lowestCloseMinor: startCashMinor, lowestWeekIndex: -1}
	running := startCashMinor
	for index := 0; index < reportForecastWeeks; index++ {
		net, err := reportSubtractSafeIntegers(inflows[index], outflows[index])
		if err != nil {
			return reportForecast{}, err
		}
		running, err = reportAddSafeIntegers(running, net)
		if err != nil {
			return reportForecast{}, err
		}
		forecast.weeks = append(forecast.weeks, CashForecastWeek{
			WeekStart:    reportISODateTime(time.UnixMilli(firstWeekStart + int64(index)*weekMillis)),
			InflowMinor:  inflows[index],
			OutflowMinor: outflows[index],
			CloseMinor:   running,
		})
		if running < forecast.lowestCloseMinor {
			forecast.lowestCloseMinor = running
			forecast.lowestWeekIndex = int64(index)
		}
	}
	forecast.finalMinor = running
	return forecast, nil
}

// applyReportBasisPointUplift mirrors erp-core applyBasisPointUplift:
// half-up rounding over 10000 + uplift, safe-integer guarded.
func applyReportBasisPointUplift(amountMinor, upliftBasisPoints int64) (int64, error) {
	if amountMinor < 0 || amountMinor > maxSafeInteger {
		return 0, errors.New("amount must be a non-negative safe integer")
	}
	if upliftBasisPoints < 0 || upliftBasisPoints > maxSafeInteger {
		return 0, errors.New("uplift must be non-negative basis points")
	}
	scaled := new(big.Int).Mul(big.NewInt(amountMinor), big.NewInt(10_000+upliftBasisPoints))
	scaled.Add(scaled, big.NewInt(5_000))
	scaled.Div(scaled, big.NewInt(10_000))
	if !scaled.IsInt64() || scaled.Int64() > maxSafeInteger {
		return 0, errors.New("uplifted amount exceeds the supported amount range")
	}
	return scaled.Int64(), nil
}

func cashForecast(ctx context.Context, tx pgx.Tx, orgID string, input CashForecastInput, now time.Time) (CashForecastOutput, error) {
	entries, err := loadReportCashFlowEntries(ctx, tx, orgID)
	if err != nil {
		return CashForecastOutput{}, err
	}
	baseCurrency, err := reportBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return CashForecastOutput{}, err
	}
	baseEntries := make([]reportCashFlowEntry, 0, len(entries))
	unsupported := make(map[string]struct{})
	for _, entry := range entries {
		if entry.currency == baseCurrency {
			baseEntries = append(baseEntries, entry)
			continue
		}
		unsupported[entry.currency] = struct{}{}
	}
	cashCodes := reportCashCodeSet(input.CashAccountCodes)
	startMinor, err := cashBalanceFromReportEntries(baseEntries, cashCodes)
	if err != nil {
		return CashForecastOutput{}, err
	}
	var scenarioName *string
	var collectionDelayDays int64
	var spendUpliftBasisPoints int64
	var expectedMonthlyInflowMinor int64
	var expectedMonthlyOutflowMinor int64
	var minimumCashBufferMinor int64
	if input.BudgetScenarioID != nil {
		var name, currency string
		var assumptionsRaw []byte
		err := tx.QueryRow(ctx, `
			SELECT name, currency, assumptions FROM budget_scenarios
			WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`, *input.BudgetScenarioID, orgID).
			Scan(&name, &currency, &assumptionsRaw)
		if errors.Is(err, pgx.ErrNoRows) {
			return CashForecastOutput{}, errors.New("budget scenario not found")
		}
		if err != nil {
			return CashForecastOutput{}, err
		}
		if currency != baseCurrency {
			return CashForecastOutput{}, errors.New("cash scenario currency must match the organization's base currency")
		}
		var assumptions BudgetScenarioAssumptions
		if err := json.Unmarshal(assumptionsRaw, &assumptions); err != nil {
			return CashForecastOutput{}, errors.New("invalid budget scenario assumptions")
		}
		if assumptions.CollectionDelayDays < 0 || assumptions.CollectionDelayDays > 180 ||
			assumptions.SpendUpliftBasisPoints < 0 || assumptions.SpendUpliftBasisPoints > 20_000 ||
			assumptions.ExpectedMonthlyInflowMinor < 0 || assumptions.ExpectedMonthlyOutflowMinor < 0 ||
			assumptions.MinimumCashBufferMinor < 0 {
			return CashForecastOutput{}, errors.New("invalid budget scenario assumptions")
		}
		scenarioName = &name
		collectionDelayDays = assumptions.CollectionDelayDays
		spendUpliftBasisPoints = assumptions.SpendUpliftBasisPoints
		expectedMonthlyInflowMinor = assumptions.ExpectedMonthlyInflowMinor
		expectedMonthlyOutflowMinor = assumptions.ExpectedMonthlyOutflowMinor
		minimumCashBufferMinor = assumptions.MinimumCashBufferMinor
	}
	flows := make([]reportForecastFlow, 0, 8)
	arRows, err := tx.Query(ctx, `
		SELECT currency, due_at, issued_at, total_minor, paid_minor, credited_minor
		FROM invoices
		WHERE org_id = $1::uuid AND status = 'sent' AND voided_at IS NULL`, orgID)
	if err != nil {
		return CashForecastOutput{}, err
	}
	for arRows.Next() {
		var currency string
		var dueAt, issuedAt *time.Time
		var totalMinor, paidMinor, creditedMinor int64
		if err := arRows.Scan(&currency, &dueAt, &issuedAt, &totalMinor, &paidMinor, &creditedMinor); err != nil {
			arRows.Close()
			return CashForecastOutput{}, err
		}
		if currency != baseCurrency {
			unsupported[currency] = struct{}{}
			continue
		}
		outstanding, err := reportDocumentOutstandingMinor(totalMinor, paidMinor, creditedMinor)
		if err != nil {
			arRows.Close()
			return CashForecastOutput{}, err
		}
		if outstanding <= 0 {
			continue
		}
		var dueAtValue time.Time
		switch {
		case dueAt != nil:
			dueAtValue = *dueAt
		case issuedAt != nil:
			dueAtValue = *issuedAt
		default:
			dueAtValue = now
		}
		dueAtValue = dueAtValue.UTC().AddDate(0, 0, int(collectionDelayDays))
		flows = append(flows, reportForecastFlow{dueAt: dueAtValue, amountMinor: outstanding, kind: "inflow"})
	}
	if err := arRows.Err(); err != nil {
		arRows.Close()
		return CashForecastOutput{}, err
	}
	arRows.Close()
	apRows, err := tx.Query(ctx, `
		SELECT currency, due_at, created_at, total_minor, paid_minor, credited_minor
		FROM vendor_bills
		WHERE org_id = $1::uuid AND status = 'open' AND voided_at IS NULL`, orgID)
	if err != nil {
		return CashForecastOutput{}, err
	}
	for apRows.Next() {
		var currency string
		var dueAt, createdAt *time.Time
		var totalMinor, paidMinor, creditedMinor int64
		if err := apRows.Scan(&currency, &dueAt, &createdAt, &totalMinor, &paidMinor, &creditedMinor); err != nil {
			apRows.Close()
			return CashForecastOutput{}, err
		}
		if currency != baseCurrency {
			unsupported[currency] = struct{}{}
			continue
		}
		outstanding, err := reportDocumentOutstandingMinor(totalMinor, paidMinor, creditedMinor)
		if err != nil {
			apRows.Close()
			return CashForecastOutput{}, err
		}
		if outstanding <= 0 {
			continue
		}
		ref := createdAt
		if dueAt != nil {
			ref = dueAt
		}
		if ref == nil {
			apRows.Close()
			return CashForecastOutput{}, errors.New("vendor bill has neither due date nor creation date")
		}
		amount, err := applyReportBasisPointUplift(outstanding, spendUpliftBasisPoints)
		if err != nil {
			apRows.Close()
			return CashForecastOutput{}, err
		}
		flows = append(flows, reportForecastFlow{dueAt: ref.UTC(), amountMinor: amount, kind: "outflow"})
	}
	if err := apRows.Err(); err != nil {
		apRows.Close()
		return CashForecastOutput{}, err
	}
	apRows.Close()
	nowUTC := now.UTC()
	for monthOffset := 0; monthOffset < 4; monthOffset++ {
		dueAt := time.Date(nowUTC.Year(), nowUTC.Month()+time.Month(monthOffset), 15, 0, 0, 0, 0, time.UTC)
		if expectedMonthlyInflowMinor > 0 {
			flows = append(flows, reportForecastFlow{dueAt: dueAt, amountMinor: expectedMonthlyInflowMinor, kind: "inflow"})
		}
		if expectedMonthlyOutflowMinor > 0 {
			amount, err := applyReportBasisPointUplift(expectedMonthlyOutflowMinor, spendUpliftBasisPoints)
			if err != nil {
				return CashForecastOutput{}, err
			}
			flows = append(flows, reportForecastFlow{dueAt: dueAt, amountMinor: amount, kind: "outflow"})
		}
	}
	forecast, err := buildReportThirteenWeekForecast(startMinor, flows, nowUTC)
	if err != nil {
		return CashForecastOutput{}, err
	}
	return CashForecastOutput{
		StartMinor:             forecast.startMinor,
		FinalMinor:             forecast.finalMinor,
		LowestCloseMinor:       forecast.lowestCloseMinor,
		LowestWeekIndex:        forecast.lowestWeekIndex,
		ScenarioName:           scenarioName,
		MinimumCashBufferMinor: minimumCashBufferMinor,
		UnsupportedCurrencies:  reportSortedUniqueCurrencies(unsupported),
		Weeks:                  forecast.weeks,
	}, nil
}

func reportISODateTime(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

type reportsStatementRow struct {
	date        time.Time
	kind        string
	ref         string
	amountMinor int64
	currency    string
}

var reportsStatementKindOrder = map[string]int{"invoice": 0, "payment": 1, "credit_note": 2}

func reportsStatementKindRank(kind string) int {
	if rank, ok := reportsStatementKindOrder[kind]; ok {
		return rank
	}
	return 9
}

// customerStatement mirrors the TypeScript renderer: gross invoice rows,
// credit notes as their own lines from the 1100 ledger mirror, payments as
// negative rows, grouped per currency and ordered by business sequence
// (date, kind order, kind) so same-instant rows stay deterministic.
func customerStatement(ctx context.Context, tx pgx.Tx, orgID string, input CustomerStatementInput) (CustomerStatementOutput, error) {
	invRows, err := tx.Query(ctx, `
		SELECT id::text, number, total_minor, currency, status, issued_at, created_at, voided_at
		FROM invoices
		WHERE org_id = $1::uuid AND customer_id = $2::uuid
		ORDER BY number`, orgID, input.CustomerID)
	if err != nil {
		return CustomerStatementOutput{}, err
	}
	type liveInvoice struct {
		id         string
		number     int64
		totalMinor int64
		currency   string
		date       time.Time
	}
	live := make([]liveInvoice, 0)
	liveByID := make(map[string]liveInvoice)
	for invRows.Next() {
		var id string
		var number, totalMinor int64
		var currency, status string
		var issuedAt, createdAt, voidedAt *time.Time
		if err := invRows.Scan(&id, &number, &totalMinor, &currency, &status, &issuedAt, &createdAt, &voidedAt); err != nil {
			invRows.Close()
			return CustomerStatementOutput{}, err
		}
		if voidedAt != nil || (status != "sent" && status != "paid") {
			continue
		}
		invoice := liveInvoice{id: id, number: number, totalMinor: totalMinor, currency: currency}
		if issuedAt != nil {
			invoice.date = *issuedAt
		} else if createdAt != nil {
			invoice.date = *createdAt
		}
		live = append(live, invoice)
		liveByID[id] = invoice
	}
	if err := invRows.Err(); err != nil {
		invRows.Close()
		return CustomerStatementOutput{}, err
	}
	invRows.Close()

	rows := make([]reportsStatementRow, 0)
	if len(live) > 0 {
		creditRows, err := tx.Query(ctx, `
			SELECT je.source_id::text, je.posted_at, jl.credit_minor, jl.debit_minor
			FROM journal_entries je
			JOIN journal_lines jl ON jl.entry_id = je.id
			JOIN accounts a ON a.id = jl.account_id
			WHERE je.org_id = $1::uuid
			  AND je.source_type = 'invoice_credit_note'
			  AND a.code = '1100'
			ORDER BY je.posted_at, je.id, jl.id`, orgID)
		if err != nil {
			return CustomerStatementOutput{}, err
		}
		type creditLineRow struct {
			sourceID    string
			postedAt    time.Time
			creditMinor int64
			debitMinor  int64
		}
		creditLines := make([]creditLineRow, 0)
		for creditRows.Next() {
			var credit creditLineRow
			if err := creditRows.Scan(&credit.sourceID, &credit.postedAt, &credit.creditMinor, &credit.debitMinor); err != nil {
				creditRows.Close()
				return CustomerStatementOutput{}, err
			}
			creditLines = append(creditLines, credit)
		}
		if err := creditRows.Err(); err != nil {
			creditRows.Close()
			return CustomerStatementOutput{}, err
		}
		creditRows.Close()

		payRows, err := tx.Query(ctx, `
			SELECT invoice_id::text, amount_minor, received_at
			FROM payments
			WHERE org_id = $1::uuid
			ORDER BY received_at, id`, orgID)
		if err != nil {
			return CustomerStatementOutput{}, err
		}
		type paymentRow struct {
			invoiceID   string
			amountMinor int64
			receivedAt  time.Time
		}
		payments := make([]paymentRow, 0)
		for payRows.Next() {
			var payment paymentRow
			if err := payRows.Scan(&payment.invoiceID, &payment.amountMinor, &payment.receivedAt); err != nil {
				payRows.Close()
				return CustomerStatementOutput{}, err
			}
			payments = append(payments, payment)
		}
		if err := payRows.Err(); err != nil {
			payRows.Close()
			return CustomerStatementOutput{}, err
		}
		payRows.Close()

		for _, invoice := range live {
			rows = append(rows, reportsStatementRow{
				date: invoice.date, kind: "invoice", ref: fmt.Sprintf("Invoice #%d", invoice.number),
				amountMinor: invoice.totalMinor, currency: invoice.currency,
			})
			for _, credit := range creditLines {
				if credit.sourceID != invoice.id {
					continue
				}
				rows = append(rows, reportsStatementRow{
					date: credit.postedAt, kind: "credit_note", ref: fmt.Sprintf("Credit on invoice #%d", invoice.number),
					amountMinor: -(credit.creditMinor - credit.debitMinor), currency: invoice.currency,
				})
			}
		}
		for _, payment := range payments {
			invoice, ok := liveByID[payment.invoiceID]
			if !ok {
				continue
			}
			rows = append(rows, reportsStatementRow{
				date: payment.receivedAt, kind: "payment", ref: "Payment received",
				amountMinor: -payment.amountMinor, currency: invoice.currency,
			})
		}
	}

	for index := range rows {
		rows[index].date = rows[index].date.UTC().Truncate(time.Millisecond)
	}
	byCurrency := make(map[string][]reportsStatementRow)
	for _, row := range rows {
		byCurrency[row.currency] = append(byCurrency[row.currency], row)
	}
	currencyCodes := make([]string, 0, len(byCurrency))
	for currency := range byCurrency {
		currencyCodes = append(currencyCodes, currency)
	}
	sort.Strings(currencyCodes)
	currencies := make([]CustomerStatementCurrency, 0, len(currencyCodes))
	for _, currency := range currencyCodes {
		currencyRows := byCurrency[currency]
		sort.SliceStable(currencyRows, func(i, j int) bool {
			if !currencyRows[i].date.Equal(currencyRows[j].date) {
				return currencyRows[i].date.Before(currencyRows[j].date)
			}
			rankI, rankJ := reportsStatementKindRank(currencyRows[i].kind), reportsStatementKindRank(currencyRows[j].kind)
			if rankI != rankJ {
				return rankI < rankJ
			}
			return currencyRows[i].kind < currencyRows[j].kind
		})
		section := CustomerStatementCurrency{Currency: currency, Rows: make([]CustomerStatementRow, 0, len(currencyRows))}
		running := int64(0)
		for _, row := range currencyRows {
			var err error
			running, err = reportAddSafeIntegers(running, row.amountMinor)
			if err != nil {
				return CustomerStatementOutput{}, err
			}
			section.Rows = append(section.Rows, CustomerStatementRow{
				Date:         reportISODateTime(row.date),
				Kind:         row.kind,
				Ref:          row.ref,
				AmountMinor:  row.amountMinor,
				BalanceMinor: running,
			})
		}
		section.ClosingBalanceMinor = running
		currencies = append(currencies, section)
	}
	return CustomerStatementOutput{Currencies: currencies}, nil
}

type reportsTaxBreakdownLine struct {
	code             string
	name             string
	direction        string
	rateBasisPoints  *int64
	priceIncludesTax bool
	recoverable      bool
	taxableBaseMinor *big.Int
	taxMinor         *big.Int
	lineCount        int
}

type reportsTaxBreakdown struct {
	lines []*reportsTaxBreakdownLine
	byKey map[string]*reportsTaxBreakdownLine
}

func (b *reportsTaxBreakdown) add(line reportsTaxBreakdownLine) {
	key := line.direction + ":" + line.code
	prior, ok := b.byKey[key]
	if !ok {
		stored := line
		stored.taxableBaseMinor = new(big.Int).Set(line.taxableBaseMinor)
		stored.taxMinor = new(big.Int).Set(line.taxMinor)
		stored.lineCount = 1
		b.byKey[key] = &stored
		b.lines = append(b.lines, &stored)
		return
	}
	prior.taxableBaseMinor.Add(prior.taxableBaseMinor, line.taxableBaseMinor)
	prior.taxMinor.Add(prior.taxMinor, line.taxMinor)
	prior.lineCount++
}

func reportBigIntWithinSafeRange(value *big.Int) bool {
	if !value.IsInt64() {
		return false
	}
	absolute := new(big.Int).Abs(value)
	return absolute.IsInt64() && absolute.Int64() <= maxSafeInteger
}

func reportsTaxLineInputScan(rows pgx.Rows) (currency string, quantity, unitPriceMinor, taxMinor int64, rateBasisPoints *int64, priceIncludesTax bool, code, name *string, scanErr error) {
	var codeValue, nameValue *string
	scanErr = rows.Scan(&currency, &quantity, &unitPriceMinor, &taxMinor, &rateBasisPoints, &priceIncludesTax, &codeValue, &nameValue)
	if scanErr != nil {
		return
	}
	if codeValue != nil {
		code = codeValue
	}
	if nameValue != nil {
		name = nameValue
	}
	return
}

// salesTaxReport mirrors salesTaxWindow: header snapshots drive the return
// totals, tax-code and document line snapshots drive the breakdown, and the
// two must reconcile. Foreign-currency documents stay out of the totals and
// surface in the unsupported count instead.
func salesTaxReport(ctx context.Context, tx pgx.Tx, orgID string, input SalesTaxReportInput) (SalesTaxReportOutput, error) {
	start, end, err := bankDateWindow(input.From, input.To)
	if err != nil {
		return SalesTaxReportOutput{}, err
	}
	baseCurrency, err := reportBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return SalesTaxReportOutput{}, err
	}

	invoiceRows, err := tx.Query(ctx, `
		SELECT currency, subtotal_minor, tax_minor
		FROM invoices
		WHERE org_id = $1::uuid
		  AND issued_at >= $2::timestamptz
		  AND issued_at < $3::timestamptz
		  AND status <> 'void'
		  AND voided_at IS NULL`, orgID, start, end)
	if err != nil {
		return SalesTaxReportOutput{}, err
	}
	taxableSales := new(big.Int)
	taxCollected := new(big.Int)
	recoverableInputTax := new(big.Int)
	unsupportedForeignCount := int64(0)
	for invoiceRows.Next() {
		var currency string
		var subtotalMinor, taxMinor int64
		if err := invoiceRows.Scan(&currency, &subtotalMinor, &taxMinor); err != nil {
			invoiceRows.Close()
			return SalesTaxReportOutput{}, err
		}
		if currency != baseCurrency {
			unsupportedForeignCount++
			continue
		}
		taxableSales.Add(taxableSales, big.NewInt(subtotalMinor))
		taxCollected.Add(taxCollected, big.NewInt(taxMinor))
	}
	if err := invoiceRows.Err(); err != nil {
		invoiceRows.Close()
		return SalesTaxReportOutput{}, err
	}
	invoiceRows.Close()

	breakdown := reportsTaxBreakdown{byKey: make(map[string]*reportsTaxBreakdownLine)}
	outputTaxRows, err := tx.Query(ctx, `
		SELECT i.currency, il.quantity, il.unit_price_minor, il.tax_minor,
		       il.tax_rate_basis_points, il.price_includes_tax, tc.code, tc.name
		FROM invoice_lines il
		JOIN invoices i ON i.id = il.invoice_id
		LEFT JOIN tax_codes tc ON tc.id = il.tax_code_id
		WHERE i.org_id = $1::uuid
		  AND i.issued_at >= $2::timestamptz
		  AND i.issued_at < $3::timestamptz
		  AND i.status <> 'void'
		  AND i.voided_at IS NULL
		ORDER BY il.id`, orgID, start, end)
	if err != nil {
		return SalesTaxReportOutput{}, err
	}
	for outputTaxRows.Next() {
		currency, quantity, unitPriceMinor, taxMinor, rateBasisPoints, priceIncludesTax, code, name, scanErr := reportsTaxLineInputScan(outputTaxRows)
		if scanErr != nil {
			outputTaxRows.Close()
			return SalesTaxReportOutput{}, scanErr
		}
		if currency != baseCurrency {
			continue
		}
		rate := int64(0)
		if rateBasisPoints != nil {
			rate = *rateBasisPoints
		}
		amounts, err := budgetLineNetMinor(quantity, unitPriceMinor, rate, priceIncludesTax)
		if err != nil {
			outputTaxRows.Close()
			return SalesTaxReportOutput{}, err
		}
		breakdownCode := "MANUAL"
		if code != nil {
			breakdownCode = *code
		}
		breakdownName := "Manual tax"
		if name != nil {
			breakdownName = *name
		}
		breakdown.add(reportsTaxBreakdownLine{
			code: breakdownCode, name: breakdownName, direction: "output",
			rateBasisPoints: rateBasisPoints, priceIncludesTax: priceIncludesTax, recoverable: false,
			taxableBaseMinor: big.NewInt(amounts), taxMinor: big.NewInt(taxMinor),
		})
	}
	if err := outputTaxRows.Err(); err != nil {
		outputTaxRows.Close()
		return SalesTaxReportOutput{}, err
	}
	outputTaxRows.Close()

	creditRows, err := tx.Query(ctx, `
		SELECT je.source_id::text, je.currency, a.code, coalesce(sum(jl.debit_minor), 0)::text
		FROM journal_entries je
		JOIN journal_lines jl ON jl.entry_id = je.id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid
		  AND je.source_type = 'invoice_credit_note'
		  AND je.posted_at >= $2::timestamptz
		  AND je.posted_at < $3::timestamptz
		  AND a.code IN ('4000', '2100')
		GROUP BY je.source_id, je.currency, a.code`, orgID, start, end)
	if err != nil {
		return SalesTaxReportOutput{}, err
	}
	foreignCreditNotes := make(map[string]struct{})
	for creditRows.Next() {
		var sourceID *string
		var currency, code string
		var debitText string
		if err := creditRows.Scan(&sourceID, &currency, &code, &debitText); err != nil {
			creditRows.Close()
			return SalesTaxReportOutput{}, err
		}
		if currency != baseCurrency {
			key := "unknown"
			if sourceID != nil {
				key = *sourceID
			}
			foreignCreditNotes[key] = struct{}{}
			continue
		}
		amount, err := strconv.ParseInt(debitText, 10, 64)
		if err != nil {
			creditRows.Close()
			return SalesTaxReportOutput{}, err
		}
		switch code {
		case "4000":
			taxableSales.Sub(taxableSales, big.NewInt(amount))
			breakdown.add(reportsTaxBreakdownLine{
				code: "CREDIT_NOTE_ADJUSTMENT", name: "Sales credit note adjustments", direction: "output",
				taxableBaseMinor: big.NewInt(-amount), taxMinor: big.NewInt(0),
			})
		case "2100":
			taxCollected.Sub(taxCollected, big.NewInt(amount))
			breakdown.add(reportsTaxBreakdownLine{
				code: "CREDIT_NOTE_ADJUSTMENT", name: "Sales credit note adjustments", direction: "output",
				taxableBaseMinor: big.NewInt(0), taxMinor: big.NewInt(-amount),
			})
		}
	}
	if err := creditRows.Err(); err != nil {
		creditRows.Close()
		return SalesTaxReportOutput{}, err
	}
	creditRows.Close()

	inputTaxRows, err := tx.Query(ctx, `
		SELECT vb.currency, vbl.quantity, vbl.unit_price_minor, vbl.tax_minor,
		       vbl.tax_rate_basis_points, vbl.price_includes_tax, tc.code, tc.name
		FROM vendor_bill_lines vbl
		JOIN vendor_bills vb ON vb.id = vbl.bill_id
		JOIN tax_codes tc ON tc.id = vbl.tax_code_id
		WHERE vb.org_id = $1::uuid
		  AND vb.bill_date >= $2::timestamptz
		  AND vb.bill_date < $3::timestamptz
		  AND tc.direction = 'input'
		  AND tc.recoverable = true
		  AND vb.status <> 'void'
		ORDER BY vbl.id`, orgID, start, end)
	if err != nil {
		return SalesTaxReportOutput{}, err
	}
	for inputTaxRows.Next() {
		currency, quantity, unitPriceMinor, taxMinor, rateBasisPoints, priceIncludesTax, code, name, scanErr := reportsTaxLineInputScan(inputTaxRows)
		if scanErr != nil {
			inputTaxRows.Close()
			return SalesTaxReportOutput{}, scanErr
		}
		if currency != baseCurrency {
			unsupportedForeignCount++
			continue
		}
		recoverableInputTax.Add(recoverableInputTax, big.NewInt(taxMinor))
		rate := int64(0)
		if rateBasisPoints != nil {
			rate = *rateBasisPoints
		}
		amounts, err := budgetLineNetMinor(quantity, unitPriceMinor, rate, priceIncludesTax)
		if err != nil {
			inputTaxRows.Close()
			return SalesTaxReportOutput{}, err
		}
		breakdownCode := "MANUAL"
		if code != nil {
			breakdownCode = *code
		}
		breakdownName := "Manual tax"
		if name != nil {
			breakdownName = *name
		}
		breakdown.add(reportsTaxBreakdownLine{
			code: breakdownCode, name: breakdownName, direction: "input",
			rateBasisPoints: rateBasisPoints, priceIncludesTax: priceIncludesTax, recoverable: true,
			taxableBaseMinor: big.NewInt(amounts), taxMinor: big.NewInt(taxMinor),
		})
	}
	if err := inputTaxRows.Err(); err != nil {
		inputTaxRows.Close()
		return SalesTaxReportOutput{}, err
	}
	inputTaxRows.Close()

	supplierCreditRows, err := tx.Query(ctx, `
		SELECT je.source_id::text, je.currency, coalesce(sum(jl.credit_minor), 0)::text
		FROM journal_entries je
		JOIN journal_lines jl ON jl.entry_id = je.id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid
		  AND je.source_type = 'vendor_credit_note'
		  AND je.posted_at >= $2::timestamptz
		  AND je.posted_at < $3::timestamptz
		  AND a.code = '1205'
		GROUP BY je.source_id, je.currency`, orgID, start, end)
	if err != nil {
		return SalesTaxReportOutput{}, err
	}
	for supplierCreditRows.Next() {
		var sourceID *string
		var currency string
		var creditText string
		if err := supplierCreditRows.Scan(&sourceID, &currency, &creditText); err != nil {
			supplierCreditRows.Close()
			return SalesTaxReportOutput{}, err
		}
		if currency != baseCurrency {
			key := "unknown"
			if sourceID != nil {
				key = *sourceID
			}
			foreignCreditNotes[key] = struct{}{}
			continue
		}
		amount, err := strconv.ParseInt(creditText, 10, 64)
		if err != nil {
			supplierCreditRows.Close()
			return SalesTaxReportOutput{}, err
		}
		recoverableInputTax.Sub(recoverableInputTax, big.NewInt(amount))
		breakdown.add(reportsTaxBreakdownLine{
			code: "SUPPLIER_CREDIT_ADJUSTMENT", name: "Supplier credit note adjustments", direction: "input",
			recoverable:      true,
			taxableBaseMinor: big.NewInt(0), taxMinor: big.NewInt(-amount),
		})
	}
	if err := supplierCreditRows.Err(); err != nil {
		supplierCreditRows.Close()
		return SalesTaxReportOutput{}, err
	}
	supplierCreditRows.Close()

	unsupportedForeignCount += int64(len(foreignCreditNotes))
	netTax := new(big.Int).Sub(taxCollected, recoverableInputTax)
	for _, total := range []struct {
		value *big.Int
	}{{taxableSales}, {taxCollected}, {recoverableInputTax}, {netTax}} {
		if !reportBigIntWithinSafeRange(total.value) {
			return SalesTaxReportOutput{}, errors.New("sales tax report exceeds the supported amount range")
		}
	}
	outputBreakdownTax := new(big.Int)
	inputBreakdownTax := new(big.Int)
	salesBreakdownBase := new(big.Int)
	for _, line := range breakdown.lines {
		for _, amount := range []*big.Int{line.taxableBaseMinor, line.taxMinor} {
			if !reportBigIntWithinSafeRange(amount) {
				return SalesTaxReportOutput{}, errors.New("tax code breakdown exceeds the supported amount range")
			}
		}
		if line.direction == "output" {
			outputBreakdownTax.Add(outputBreakdownTax, line.taxMinor)
			salesBreakdownBase.Add(salesBreakdownBase, line.taxableBaseMinor)
		} else {
			inputBreakdownTax.Add(inputBreakdownTax, line.taxMinor)
		}
	}
	if outputBreakdownTax.Cmp(taxCollected) != 0 || inputBreakdownTax.Cmp(recoverableInputTax) != 0 || salesBreakdownBase.Cmp(taxableSales) != 0 {
		return SalesTaxReportOutput{}, errors.New("tax code breakdown does not reconcile to the jurisdiction return totals")
	}
	return SalesTaxReportOutput{
		TaxableSalesMinor:        taxableSales.Int64(),
		TaxCollectedMinor:        taxCollected.Int64(),
		RecoverableInputTaxMinor: recoverableInputTax.Int64(),
		NetTaxMinor:              netTax.Int64(),
		BaseCurrency:             baseCurrency,
		UnsupportedForeignCount:  unsupportedForeignCount,
		Basis:                    "tax-code-and-document-snapshots",
	}, nil
}

func parseAccountingReportInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case reportCurrencyMetadataCapabilityID:
		return ParseReportCurrencyMetadataInput(raw)
	case incomeStatementCapabilityID:
		return ParseIncomeStatementInput(raw)
	case balanceSheetCapabilityID:
		return ParseBalanceSheetInput(raw)
	case listInvoicesCapabilityID:
		return ParseListInvoicesInput(raw)
	case arAgingCapabilityID:
		return ParseArAgingInput(raw)
	case cashBasisReportCapabilityID:
		return ParseCashBasisReportInput(raw)
	case customerStatementCapabilityID:
		return ParseCustomerStatementInput(raw)
	case salesTaxReportCapabilityID:
		return ParseSalesTaxReportInput(raw)
	case cashFlowCapabilityID:
		return ParseCashFlowInput(raw)
	case cashForecastCapabilityID:
		return ParseCashForecastInput(raw)
	default:
		return nil, errors.New("unsupported accounting report capability")
	}
}
