package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type MemorySearchResult struct {
	Kind    string  `json:"kind"`
	Source  *string `json:"source"`
	Title   *string `json:"title"`
	Content string  `json:"content"`
}

type SearchOrgMemoryOutput struct {
	Mode    string               `json:"mode"`
	Results []MemorySearchResult `json:"results"`
}

type DocumentRecordValues map[string]string

type DocumentRecord struct {
	ID     string               `json:"id"`
	Label  string               `json:"label"`
	Detail string               `json:"detail"`
	Values DocumentRecordValues `json:"values"`
}

type SearchRecordsOutput struct {
	Records []DocumentRecord `json:"records"`
}

const documentsDefaultSearchMemoryLimit = 5

var documentsRecordTypes = []string{"customer", "supplier", "employee", "invoice", "quote", "purchase_order", "sales_order"}

func parseSearchMemoryInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	query, err := documentsRequiredString(fields, "query", 2, 500)
	if err != nil {
		return DocumentsInput{}, err
	}
	// Zod's limit carries a default of 5, so an absent key means the default
	// rather than a validation failure.
	limit := int64(documentsDefaultSearchMemoryLimit)
	if _, present := fields["limit"]; present {
		value, err := documentsBoundedInteger(fields, "limit", 1, 10)
		if err != nil {
			return DocumentsInput{}, err
		}
		limit = value
	}
	return DocumentsInput{Query: &query, Limit: &limit}, nil
}

func parseSearchRecordsInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	recordType, err := documentsRequiredString(fields, "type", 0, documentsUnbounded)
	if err != nil {
		return DocumentsInput{}, err
	}
	if !documentsContainsString(documentsRecordTypes, recordType) {
		return DocumentsInput{}, errors.New("type is invalid")
	}
	query, err := documentsOptionalString(fields, "query", 0, 120)
	if err != nil {
		return DocumentsInput{}, err
	}
	if query == nil {
		empty := ""
		query = &empty
	}
	id, err := documentsOptionalUUID(fields, "id")
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{Type: &recordType, Query: query, ID: id}, nil
}

// searchOrgMemory always answers from the deterministic text path. The Go
// embed pipeline is not wired, so the semantic branch the TypeScript runtime
// tries first stays unreachable here; retrieval must never hard-fail, so the
// same degradation the TypeScript fallback performs is the only behavior.
func searchOrgMemory(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput) (SearchOrgMemoryOutput, error) {
	needle := "%" + strings.NewReplacer("%", "", "_", "").Replace(*input.Query) + "%"
	rows, err := tx.Query(ctx, `
		SELECT kind, source, metadata->>'title', content
		FROM memories
		WHERE org_id = $1::uuid AND content ILIKE $2
		LIMIT $3`, orgID, needle, *input.Limit)
	if err != nil {
		return SearchOrgMemoryOutput{}, err
	}
	defer rows.Close()
	out := SearchOrgMemoryOutput{Mode: "text", Results: make([]MemorySearchResult, 0)}
	for rows.Next() {
		var result MemorySearchResult
		if err := rows.Scan(&result.Kind, &result.Source, &result.Title, &result.Content); err != nil {
			return SearchOrgMemoryOutput{}, err
		}
		out.Results = append(out.Results, result)
	}
	if err := rows.Err(); err != nil {
		return SearchOrgMemoryOutput{}, err
	}
	return out, nil
}

type documentsOrgContext struct {
	Name     string
	Currency string
}

func documentsLoadOrgContext(ctx context.Context, tx pgx.Tx, orgID string) (documentsOrgContext, error) {
	var org documentsOrgContext
	err := tx.QueryRow(ctx, `
		SELECT name, base_currency FROM organizations WHERE id = $1::uuid LIMIT 1`, orgID).
		Scan(&org.Name, &org.Currency)
	if errors.Is(err, pgx.ErrNoRows) {
		return documentsOrgContext{}, nil
	}
	if err != nil {
		return documentsOrgContext{}, err
	}
	return org, nil
}

// documentsRecordFilter builds the shared lookup predicate: an id pins one
// row, a non-empty query matches the type's searchable columns, and neither
// lists the first 25 rows in the type's natural order.
func documentsRecordFilter(id *string, query string, columns ...string) string {
	if id != nil {
		return " AND id = $2::uuid"
	}
	if query == "" {
		return ""
	}
	parts := make([]string, 0, len(columns))
	for _, column := range columns {
		parts = append(parts, column+" ILIKE $2")
	}
	return " AND (" + strings.Join(parts, " OR ") + ")"
}

func documentsRecordArgs(orgID string, id *string, query string) []any {
	if id != nil {
		return []any{orgID, *id}
	}
	if query != "" {
		return []any{orgID, "%" + query + "%"}
	}
	return []any{orgID}
}

type documentsLine struct {
	Description          string
	Quantity             int64
	UnitPriceMinor       int64
	DeliveredThousandths int64
}

// documentsLineTotalMinor mirrors Math.round(quantity * unitPriceMinor /
// 1000) with exact integer math: quantities are thousandths, so the product
// is scaled back by 1000 and rounded half away from zero.
func documentsLineTotalMinor(line documentsLine) int64 {
	product := line.Quantity * line.UnitPriceMinor
	negative := product < 0
	if negative {
		product = -product
	}
	total := (product + 500) / 1000
	if negative {
		return -total
	}
	return total
}

func documentsSumLineTotals(lines []documentsLine) int64 {
	total := int64(0)
	for _, line := range lines {
		total += documentsLineTotalMinor(line)
	}
	return total
}

func documentsQuantityString(thousandths int64) string {
	return documentsNumberString(float64(thousandths) / 1000)
}

// documentsNumberString renders a float the way JavaScript's Number
// toString does for the magnitudes these templates carry: plain decimal, no
// exponent, no trailing zeros.
func documentsNumberString(value float64) string {
	if value != value || value > 1.7976931348623157e308 || value < -1.7976931348623157e308 {
		return "0"
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func documentsCloneValues(base DocumentRecordValues) DocumentRecordValues {
	values := make(DocumentRecordValues, len(base)+32)
	for key, value := range base {
		values[key] = value
	}
	return values
}

func documentsDeref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func documentsCoalesce(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

// documentsMoney renders one formatted amount or refuses the whole
// capability, because the TypeScript Intl formatter throws on a currency it
// cannot represent and the record it belongs to would be incomplete anyway.
func documentsMoney(minor int64, currency string) (string, error) {
	formatted, err := documentsDisplayMoney(minor, currency)
	if err != nil {
		return "", rejectDocuments("%s", err)
	}
	return formatted, nil
}

func documentsMoneyMap(values DocumentRecordValues, key string, minor int64, currency string) error {
	formatted, err := documentsMoney(minor, currency)
	if err != nil {
		return err
	}
	values[key] = formatted
	return nil
}

var documentsCurrencyCodePattern = regexp.MustCompile(`^[A-Za-z]{3}$`)

// documentsCurrencyFormat is one CLDR display name for the "en" locale.
// Spaced records whether CLDR puts a space between a word-like symbol and the
// number; symbols built from currency glyphs sit flush against the digits.
type documentsCurrencyFormat struct {
	Symbol string
	Spaced bool
}

var documentsCurrencyFormats = map[string]documentsCurrencyFormat{
	"AED": {"AED", true}, "ARS": {"AR$", false}, "AUD": {"A$", false},
	"BRL": {"R$", false}, "CAD": {"CA$", false}, "CHF": {"CHF", true},
	"CNY": {"CN¥", false}, "DKK": {"DKK", true}, "EUR": {"€", false},
	"GBP": {"£", false}, "GHS": {"GH₵", false}, "HKD": {"HK$", false},
	"HUF": {"Ft", false}, "IDR": {"Rp", false}, "ILS": {"₪", false},
	"INR": {"₹", false}, "JPY": {"¥", false}, "KES": {"KSh", true},
	"KRW": {"₩", false}, "MXN": {"MX$", false}, "MYR": {"MYR", true},
	"NGN": {"NGN", true}, "NOK": {"NOK", true}, "NZD": {"NZ$", false},
	"PHP": {"₱", false}, "PLN": {"PLN", true}, "RUB": {"₽", false},
	"SGD": {"S$", false}, "THB": {"THB", true}, "TRY": {"TRY", true},
	"TWD": {"NT$", false}, "UAH": {"₴", false}, "USD": {"$", false},
	"VND": {"₫", false}, "ZAR": {"ZAR", true},
}

// documentsDisplayMoney mirrors Intl.NumberFormat("en", { style: "currency",
// currency, maximumFractionDigits: 2 }).format(minor / 100): a symbol prefix,
// comma grouping, and a minimum of the currency's own decimal digits. Intl
// raises a RangeError when a currency's standard digits exceed the requested
// maximum or the code is not three letters, and TypeScript then fails the
// whole capability, so this refuses the same inputs instead of guessing.
func documentsDisplayMoney(minor int64, currency string) (string, error) {
	code := strings.ToUpper(currency)
	if !documentsCurrencyCodePattern.MatchString(code) {
		return "", fmt.Errorf("Invalid currency code : %s", currency)
	}
	standardDigits, known := currencyMinorUnits(code)
	if !known || standardDigits > 2 {
		return "", fmt.Errorf("Invalid currency code : %s", currency)
	}
	// An unrecognized three-letter code formats as the bare code, which is
	// what Intl does with a structurally valid currency it has no data for.
	format, isKnown := documentsCurrencyFormats[code]
	prefix := code + " "
	if isKnown {
		prefix = format.Symbol
		if format.Spaced {
			prefix += " "
		}
	}
	if standardDigits == 0 {
		// Intl rounds to the currency's own digit count, so a zero-decimal
		// currency loses the cents entirely. A tie rounds toward positive
		// infinity, matching ECMA-402's default halfExpand.
		return documentsRoundedForZeroDecimalCurrency(prefix, minor), nil
	}
	sign := ""
	units := minor
	if units < 0 {
		sign = "-"
		units = -units
	}
	whole := units / 100
	fraction := units % 100
	return fmt.Sprintf("%s%s%s.%02d", sign, prefix, documentsGroupDigits(whole), fraction), nil
}

func documentsRoundedForZeroDecimalCurrency(prefix string, minor int64) string {
	whole := floorDiv64(minor, 100)
	remainder := minor - whole*100
	if 2*remainder >= 100 {
		whole++
	}
	if whole < 0 {
		return "-" + prefix + documentsGroupDigits(-whole)
	}
	return prefix + documentsGroupDigits(whole)
}

func floorDiv64(value, divisor int64) int64 {
	quotient := value / divisor
	if value%divisor != 0 && (value < 0) != (divisor < 0) {
		quotient--
	}
	return quotient
}

// documentsGroupDigits inserts a comma every three digits from the right.
func documentsGroupDigits(value int64) string {
	digits := strconv.FormatInt(value, 10)
	var builder strings.Builder
	for position, digit := range digits {
		if position > 0 && (len(digits)-position)%3 == 0 {
			builder.WriteByte(',')
		}
		builder.WriteRune(digit)
	}
	return builder.String()
}

// searchRecordsForDocument returns only the fields a template needs, under
// the placeholder names the module's templates use.
func searchRecordsForDocument(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput, now time.Time) (SearchRecordsOutput, error) {
	org, err := documentsLoadOrgContext(ctx, tx, claims.OrganizationID)
	if err != nil {
		return SearchRecordsOutput{}, err
	}
	base := DocumentRecordValues{
		"sender.name":   org.Name,
		"employer.name": org.Name,
		"document.date": documentsDateOnly(now),
	}
	query := strings.TrimSpace(*input.Query)
	records := make([]DocumentRecord, 0)

	switch *input.Type {
	case "customer":
		rows, err := documentsSearchCustomers(ctx, tx, claims.OrganizationID, input, query)
		if err != nil {
			return SearchRecordsOutput{}, err
		}
		for _, row := range rows {
			values := documentsCloneValues(base)
			values["customer.name"] = row.Name
			values["customer.email"] = documentsDeref(row.Email)
			if row.PaymentTermDays != nil && *row.PaymentTermDays != 0 {
				values["invoice.paymentInstructions"] = fmt.Sprintf("Payment due in %d days.", *row.PaymentTermDays)
			} else {
				values["invoice.paymentInstructions"] = "Payment due on receipt."
			}
			records = append(records, DocumentRecord{ID: row.ID, Label: row.Name,
				Detail: documentsCoalesce(row.Email, "Customer"), Values: values})
		}

	case "supplier":
		rows, err := documentsSearchSuppliers(ctx, tx, claims.OrganizationID, input, query)
		if err != nil {
			return SearchRecordsOutput{}, err
		}
		for _, row := range rows {
			values := documentsCloneValues(base)
			values["supplier.name"] = row.Name
			values["supplier.email"] = documentsDeref(row.Email)
			if row.PaymentTermDays != nil && *row.PaymentTermDays != 0 {
				values["purchaseOrder.paymentTerms"] = fmt.Sprintf("Net %d", *row.PaymentTermDays)
			} else {
				values["purchaseOrder.paymentTerms"] = "Due on receipt"
			}
			records = append(records, DocumentRecord{ID: row.ID, Label: row.Name,
				Detail: documentsCoalesce(row.Email, "Supplier"), Values: values})
		}

	case "employee":
		rows, err := documentsSearchEmployees(ctx, tx, claims.OrganizationID, input, query)
		if err != nil {
			return SearchRecordsOutput{}, err
		}
		for _, row := range rows {
			values := documentsCloneValues(base)
			values["employee.name"] = row.Name
			values["employee.email"] = documentsDeref(row.Email)
			values["employee.title"] = documentsDeref(row.Title)
			if err := documentsMoneyMap(values, "employment.compensation", row.MonthlySalaryMinor, org.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			values["employment.startDate"] = documentsDateOnly(row.HiredAt)
			values["employment.leaveDays"] = strconv.FormatInt(row.AnnualLeaveDays, 10)
			values["employment.manager"] = ""
			values["employment.location"] = ""
			records = append(records, DocumentRecord{ID: row.ID, Label: row.Name,
				Detail: documentsEmployeeDetail(row.Title, row.Department, row.Email), Values: values})
		}

	case "invoice":
		rows, err := documentsSearchInvoices(ctx, tx, claims.OrganizationID, input, query)
		if err != nil {
			return SearchRecordsOutput{}, err
		}
		for _, row := range rows {
			values := documentsCloneValues(base)
			values["customer.name"] = row.CustomerName
			values["customer.email"] = documentsDeref(row.CustomerEmail)
			values["invoice.number"] = strconv.FormatInt(row.Number, 10)
			values["invoice.issuedAt"] = documentsDateOnlyPtr(row.IssuedAt)
			values["invoice.dueAt"] = documentsDateOnlyPtr(row.DueAt)
			if err := documentsMoneyMap(values, "invoice.subtotal", row.SubtotalMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsMoneyMap(values, "invoice.tax", row.TaxMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsMoneyMap(values, "invoice.total", row.TotalMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsMoneyMap(values, "invoice.balance",
				row.TotalMinor-row.PaidMinor-row.CreditedMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsMoneyMap(values, "invoice.previousBalance", row.TotalMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			lines, err := documentsReadInvoiceLines(ctx, tx, row.ID)
			if err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsAttachMoneyLines(values, "invoice", lines, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			total, err := documentsMoney(row.TotalMinor, row.Currency)
			if err != nil {
				return SearchRecordsOutput{}, err
			}
			records = append(records, DocumentRecord{ID: row.ID,
				Label:  fmt.Sprintf("Invoice %d | %s", row.Number, row.CustomerName),
				Detail: fmt.Sprintf("%s | %s", row.Status, total), Values: values})
		}

	case "quote":
		rows, err := documentsSearchQuotes(ctx, tx, claims.OrganizationID, input, query)
		if err != nil {
			return SearchRecordsOutput{}, err
		}
		for _, row := range rows {
			values := documentsCloneValues(base)
			values["customer.name"] = row.CustomerName
			values["customer.email"] = documentsDeref(row.CustomerEmail)
			values["quotation.number"] = strconv.FormatInt(row.Number, 10)
			values["quotation.validUntil"] = documentsDateOnlyPtr(row.ExpiresAt)
			if err := documentsMoneyMap(values, "quotation.subtotal", row.SubtotalMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsMoneyMap(values, "quotation.tax", row.TaxMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsMoneyMap(values, "quotation.total", row.TotalMinor, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			values["quotation.objective"] = documentsDeref(row.Memo)
			lines, err := documentsReadQuoteLines(ctx, tx, row.ID)
			if err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsAttachMoneyLines(values, "quotation", lines, row.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			total, err := documentsMoney(row.TotalMinor, row.Currency)
			if err != nil {
				return SearchRecordsOutput{}, err
			}
			records = append(records, DocumentRecord{ID: row.ID,
				Label:  fmt.Sprintf("Quote %d | %s", row.Number, row.CustomerName),
				Detail: fmt.Sprintf("%s | %s", row.Status, total), Values: values})
		}

	case "purchase_order":
		rows, err := documentsSearchPurchaseOrders(ctx, tx, claims.OrganizationID, input, query)
		if err != nil {
			return SearchRecordsOutput{}, err
		}
		for _, row := range rows {
			values := documentsCloneValues(base)
			values["supplier.name"] = row.SupplierName
			values["supplier.email"] = documentsDeref(row.SupplierEmail)
			values["purchaseOrder.number"] = strconv.FormatInt(row.Number, 10)
			values["purchaseOrder.deliveryDate"] = documentsDateOnlyPtr(row.PromisedAt)
			values["purchaseOrder.scope"] = documentsDeref(row.Memo)
			if row.PaymentTermDays != nil && *row.PaymentTermDays != 0 {
				values["purchaseOrder.paymentTerms"] = fmt.Sprintf("Net %d", *row.PaymentTermDays)
			} else {
				values["purchaseOrder.paymentTerms"] = "Due on receipt"
			}
			lines, err := documentsReadPurchaseOrderLines(ctx, tx, row.ID)
			if err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsMoneyMap(values, "purchaseOrder.total", documentsSumLineTotals(lines), org.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			if err := documentsAttachMoneyLines(values, "purchaseOrder", lines, org.Currency); err != nil {
				return SearchRecordsOutput{}, err
			}
			total, err := documentsMoney(documentsSumLineTotals(lines), org.Currency)
			if err != nil {
				return SearchRecordsOutput{}, err
			}
			records = append(records, DocumentRecord{ID: row.ID,
				Label:  fmt.Sprintf("PO %d | %s", row.Number, row.SupplierName),
				Detail: fmt.Sprintf("%s | %s", row.Status, total), Values: values})
		}

	default:
		rows, err := documentsSearchSalesOrders(ctx, tx, claims.OrganizationID, input, query)
		if err != nil {
			return SearchRecordsOutput{}, err
		}
		for _, row := range rows {
			values := documentsCloneValues(base)
			values["customer.name"] = row.CustomerName
			values["customer.email"] = documentsDeref(row.CustomerEmail)
			values["salesOrder.number"] = strconv.FormatInt(row.Number, 10)
			values["delivery.backorderNote"] = documentsDeref(row.Note)
			lines, err := documentsReadSalesOrderLines(ctx, tx, claims.OrganizationID, row.ID)
			if err != nil {
				return SearchRecordsOutput{}, err
			}
			for index, line := range lines {
				position := index + 1
				values[fmt.Sprintf("delivery.line%d.description", position)] = line.Description
				values[fmt.Sprintf("delivery.line%d.ordered", position)] = documentsQuantityString(line.Quantity)
				values[fmt.Sprintf("delivery.line%d.delivered", position)] = documentsQuantityString(line.DeliveredThousandths)
				values[fmt.Sprintf("delivery.item%d", position)] = line.Description
				values[fmt.Sprintf("delivery.quantity%d", position)] = documentsQuantityString(line.Quantity)
			}
			detail := row.Status
			if row.Backordered {
				detail += " | backordered"
			}
			records = append(records, DocumentRecord{ID: row.ID,
				Label:  fmt.Sprintf("Sales order %d | %s", row.Number, row.CustomerName),
				Detail: detail, Values: values})
		}
	}
	return SearchRecordsOutput{Records: records}, nil
}

func documentsEmployeeDetail(title, department, email *string) string {
	parts := make([]string, 0, 2)
	if title != nil && *title != "" {
		parts = append(parts, *title)
	}
	if department != nil && *department != "" {
		parts = append(parts, *department)
	}
	if joined := strings.Join(parts, " | "); joined != "" {
		return joined
	}
	if email != nil && *email != "" {
		return *email
	}
	return "Employee"
}

func documentsAttachMoneyLines(values DocumentRecordValues, prefix string, lines []documentsLine, currency string) error {
	for index, line := range lines {
		position := index + 1
		if err := documentsMoneyMap(values, fmt.Sprintf("%s.line%d.rate", prefix, position), line.UnitPriceMinor, currency); err != nil {
			return err
		}
		if err := documentsMoneyMap(values, fmt.Sprintf("%s.line%d.amount", prefix, position),
			documentsLineTotalMinor(line), currency); err != nil {
			return err
		}
		values[fmt.Sprintf("%s.line%d.description", prefix, position)] = line.Description
		values[fmt.Sprintf("%s.line%d.quantity", prefix, position)] = documentsQuantityString(line.Quantity)
	}
	return nil
}

type documentsPartyRow struct {
	ID                 string
	Name               string
	Email              *string
	Title              *string
	Department         *string
	PaymentTermDays    *int64
	MonthlySalaryMinor int64
	AnnualLeaveDays    int64
	HiredAt            time.Time
}

func documentsSearchCustomers(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput, query string) ([]documentsPartyRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, email, NULL::text, NULL::text, payment_term_days, 0, 0, now()
		FROM customers
		WHERE org_id = $1::uuid`+documentsRecordFilter(input.ID, query, "name", "email")+`
		ORDER BY name
		LIMIT 25`, documentsRecordArgs(orgID, input.ID, query)...)
	if err != nil {
		return nil, err
	}
	return documentsScanPartyRows(rows)
}

func documentsSearchSuppliers(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput, query string) ([]documentsPartyRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, email, NULL::text, NULL::text, payment_term_days, 0, 0, now()
		FROM vendors
		WHERE org_id = $1::uuid`+documentsRecordFilter(input.ID, query, "name", "email")+`
		ORDER BY name
		LIMIT 25`, documentsRecordArgs(orgID, input.ID, query)...)
	if err != nil {
		return nil, err
	}
	return documentsScanPartyRows(rows)
}

func documentsSearchEmployees(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput, query string) ([]documentsPartyRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, email, title, department, NULL::bigint,
		       monthly_salary_minor, annual_leave_days, hired_at
		FROM employees
		WHERE org_id = $1::uuid`+documentsRecordFilter(input.ID, query, "name", "email", "title")+`
		ORDER BY name
		LIMIT 25`, documentsRecordArgs(orgID, input.ID, query)...)
	if err != nil {
		return nil, err
	}
	return documentsScanPartyRows(rows)
}

func documentsScanPartyRows(rows pgx.Rows) ([]documentsPartyRow, error) {
	defer rows.Close()
	out := make([]documentsPartyRow, 0)
	for rows.Next() {
		var row documentsPartyRow
		if err := rows.Scan(&row.ID, &row.Name, &row.Email, &row.Title, &row.Department,
			&row.PaymentTermDays, &row.MonthlySalaryMinor, &row.AnnualLeaveDays, &row.HiredAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

type documentsInvoiceRow struct {
	ID            string
	Number        int64
	Status        string
	Currency      string
	SubtotalMinor int64
	TaxMinor      int64
	TotalMinor    int64
	PaidMinor     int64
	CreditedMinor int64
	IssuedAt      *time.Time
	DueAt         *time.Time
	CustomerName  string
	CustomerEmail *string
}

func documentsSearchInvoices(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput, query string) ([]documentsInvoiceRow, error) {
	condition := ""
	if input.ID != nil {
		condition = " AND i.id = $2::uuid"
	} else if query != "" {
		condition = " AND (c.name ILIKE $2 OR i.number::text ILIKE $2)"
	}
	rows, err := tx.Query(ctx, `
		SELECT i.id::text, i.number, i.status, i.currency, i.subtotal_minor, i.tax_minor,
		       i.total_minor, i.paid_minor, i.credited_minor, i.issued_at, i.due_at,
		       c.name, c.email
		FROM invoices i
		JOIN customers c ON c.id = i.customer_id
		WHERE i.org_id = $1::uuid`+condition+`
		ORDER BY i.created_at DESC
		LIMIT 25`, documentsRecordArgs(orgID, input.ID, query)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]documentsInvoiceRow, 0)
	for rows.Next() {
		var row documentsInvoiceRow
		if err := rows.Scan(&row.ID, &row.Number, &row.Status, &row.Currency, &row.SubtotalMinor,
			&row.TaxMinor, &row.TotalMinor, &row.PaidMinor, &row.CreditedMinor, &row.IssuedAt,
			&row.DueAt, &row.CustomerName, &row.CustomerEmail); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

type documentsQuoteRow struct {
	ID            string
	Number        int64
	Status        string
	Currency      string
	SubtotalMinor int64
	TaxMinor      int64
	TotalMinor    int64
	ExpiresAt     *time.Time
	Memo          *string
	CustomerName  string
	CustomerEmail *string
}

func documentsSearchQuotes(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput, query string) ([]documentsQuoteRow, error) {
	condition := ""
	if input.ID != nil {
		condition = " AND q.id = $2::uuid"
	} else if query != "" {
		condition = " AND (c.name ILIKE $2 OR q.number::text ILIKE $2)"
	}
	rows, err := tx.Query(ctx, `
		SELECT q.id::text, q.number, q.status, q.currency, q.subtotal_minor, q.tax_minor,
		       q.total_minor, q.expires_at, q.memo, c.name, c.email
		FROM quotes q
		JOIN customers c ON c.id = q.customer_id
		WHERE q.org_id = $1::uuid`+condition+`
		ORDER BY q.created_at DESC
		LIMIT 25`, documentsRecordArgs(orgID, input.ID, query)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]documentsQuoteRow, 0)
	for rows.Next() {
		var row documentsQuoteRow
		if err := rows.Scan(&row.ID, &row.Number, &row.Status, &row.Currency, &row.SubtotalMinor,
			&row.TaxMinor, &row.TotalMinor, &row.ExpiresAt, &row.Memo, &row.CustomerName,
			&row.CustomerEmail); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

type documentsPurchaseOrderRow struct {
	ID              string
	Number          int64
	Status          string
	Memo            *string
	PromisedAt      *time.Time
	SupplierName    string
	SupplierEmail   *string
	PaymentTermDays *int64
}

func documentsSearchPurchaseOrders(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput, query string) ([]documentsPurchaseOrderRow, error) {
	condition := ""
	if input.ID != nil {
		condition = " AND o.id = $2::uuid"
	} else if query != "" {
		condition = " AND (v.name ILIKE $2 OR o.number::text ILIKE $2)"
	}
	rows, err := tx.Query(ctx, `
		SELECT o.id::text, o.number, o.status, o.memo, o.promised_at, v.name, v.email, v.payment_term_days
		FROM purchase_orders o
		JOIN vendors v ON v.id = o.vendor_id
		WHERE o.org_id = $1::uuid`+condition+`
		ORDER BY o.created_at DESC
		LIMIT 25`, documentsRecordArgs(orgID, input.ID, query)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]documentsPurchaseOrderRow, 0)
	for rows.Next() {
		var row documentsPurchaseOrderRow
		if err := rows.Scan(&row.ID, &row.Number, &row.Status, &row.Memo, &row.PromisedAt,
			&row.SupplierName, &row.SupplierEmail, &row.PaymentTermDays); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

type documentsSalesOrderRow struct {
	ID            string
	Number        int64
	Status        string
	Backordered   bool
	Note          *string
	CustomerName  string
	CustomerEmail *string
}

func documentsSearchSalesOrders(ctx context.Context, tx pgx.Tx, orgID string, input DocumentsInput, query string) ([]documentsSalesOrderRow, error) {
	condition := ""
	if input.ID != nil {
		condition = " AND o.id = $2::uuid"
	} else if query != "" {
		condition = " AND (c.name ILIKE $2 OR o.number::text ILIKE $2)"
	}
	rows, err := tx.Query(ctx, `
		SELECT o.id::text, o.number, o.status, o.backordered, o.note, c.name, c.email
		FROM sales_orders o
		JOIN customers c ON c.id = o.customer_id
		WHERE o.org_id = $1::uuid`+condition+`
		ORDER BY o.created_at DESC
		LIMIT 25`, documentsRecordArgs(orgID, input.ID, query)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]documentsSalesOrderRow, 0)
	for rows.Next() {
		var row documentsSalesOrderRow
		if err := rows.Scan(&row.ID, &row.Number, &row.Status, &row.Backordered, &row.Note,
			&row.CustomerName, &row.CustomerEmail); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func documentsReadInvoiceLines(ctx context.Context, tx pgx.Tx, invoiceID string) ([]documentsLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT description, quantity, unit_price_minor, 0
		FROM invoice_lines WHERE invoice_id = $1::uuid LIMIT 3`, invoiceID)
	if err != nil {
		return nil, err
	}
	return documentsScanLines(rows)
}

func documentsReadQuoteLines(ctx context.Context, tx pgx.Tx, quoteID string) ([]documentsLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT description, quantity, unit_price_minor, 0
		FROM quote_lines WHERE quote_id = $1::uuid LIMIT 3`, quoteID)
	if err != nil {
		return nil, err
	}
	return documentsScanLines(rows)
}

func documentsReadPurchaseOrderLines(ctx context.Context, tx pgx.Tx, orderID string) ([]documentsLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT description, quantity, unit_price_minor, 0
		FROM po_lines WHERE po_id = $1::uuid ORDER BY position LIMIT 3`, orderID)
	if err != nil {
		return nil, err
	}
	return documentsScanLines(rows)
}

func documentsReadSalesOrderLines(ctx context.Context, tx pgx.Tx, orgID, orderID string) ([]documentsLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT description, quantity, unit_price_minor, delivered_thousandths
		FROM sales_order_lines
		WHERE org_id = $1::uuid AND order_id = $2::uuid
		LIMIT 3`, orgID, orderID)
	if err != nil {
		return nil, err
	}
	return documentsScanLines(rows)
}

func documentsScanLines(rows pgx.Rows) ([]documentsLine, error) {
	defer rows.Close()
	lines := make([]documentsLine, 0)
	for rows.Next() {
		var line documentsLine
		if err := rows.Scan(&line.Description, &line.Quantity, &line.UnitPriceMinor, &line.DeliveredThousandths); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	return lines, rows.Err()
}
