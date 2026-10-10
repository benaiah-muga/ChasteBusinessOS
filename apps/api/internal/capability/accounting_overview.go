package capability

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const accountingOverviewCapabilityID = "accounting.overview"

type AccountingOverviewInput struct{}

type AccountingOverviewEntry struct {
	ID           string  `json:"id"`
	Memo         string  `json:"memo"`
	SourceType   *string `json:"sourceType"`
	ReversalOfID *string `json:"reversalOfId"`
	PostedAt     string  `json:"postedAt"`
	ActorType    string  `json:"actorType"`
	Currency     string  `json:"currency"`
	AmountMinor  int64   `json:"amountMinor"`
	DebitMinor   int64   `json:"debitMinor"`
}

type AccountingOverviewAgingInvoice struct {
	Number           int64  `json:"number"`
	Currency         string `json:"currency"`
	OutstandingMinor int64  `json:"outstandingMinor"`
	AgeDays          int64  `json:"ageDays"`
}

type AccountingOverviewBill struct {
	ID               string `json:"id"`
	Number           int64  `json:"number"`
	Status           string `json:"status"`
	Currency         string `json:"currency"`
	TotalMinor       int64  `json:"totalMinor"`
	CreditedMinor    int64  `json:"creditedMinor"`
	PaidMinor        int64  `json:"paidMinor"`
	VendorName       string `json:"vendorName"`
	OutstandingMinor int64  `json:"outstandingMinor"`
}

type AccountingOverviewFiling struct {
	ID         string `json:"id"`
	PeriodFrom string `json:"periodFrom"`
	PeriodTo   string `json:"periodTo"`
	TaxMinor   int64  `json:"taxMinor"`
	FiledAt    string `json:"filedAt"`
}

type AccountingOverviewCustomer struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	PaymentTermDays *int64 `json:"paymentTermDays"`
}

type AccountingOverviewPayment struct {
	ID            string `json:"id"`
	InvoiceNumber int64  `json:"invoiceNumber"`
	AmountMinor   int64  `json:"amountMinor"`
	Method        string `json:"method"`
	ReceivedAt    string `json:"receivedAt"`
	Currency      string `json:"currency"`
}

type AccountingOverviewPeriod struct {
	Year  int64 `json:"year"`
	Month int64 `json:"month"`
}

type AccountingOverviewOutput struct {
	Entries                 []AccountingOverviewEntry        `json:"entries"`
	Aging                   ArAgingBucketTotals              `json:"aging"`
	AgingInvoices           []AccountingOverviewAgingInvoice `json:"agingInvoices"`
	BaseCurrency            string                           `json:"baseCurrency"`
	ForeignReceivablesCount int64                            `json:"foreignReceivablesCount"`
	ForeignPayablesCount    int64                            `json:"foreignPayablesCount"`
	ClosedPeriods           []AccountingOverviewPeriod       `json:"closedPeriods"`
	Bills                   []AccountingOverviewBill         `json:"bills"`
	Filings                 []AccountingOverviewFiling       `json:"filings"`
	Customers               []AccountingOverviewCustomer     `json:"customers"`
	Invoices                []ListInvoiceRow                 `json:"invoices"`
	Payments                []AccountingOverviewPayment      `json:"payments"`
}

func ParseAccountingOverviewInput(raw json.RawMessage) (AccountingOverviewInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AccountingOverviewInput{}, err
	}
	if len(fields) != 0 {
		return AccountingOverviewInput{}, errors.New("accounting overview input does not accept fields")
	}
	return AccountingOverviewInput{}, nil
}

type accountingOverviewReceivable struct {
	number           int64
	currency         string
	outstandingMinor int64
	issuedAt         time.Time
	dueAt            *time.Time
}

func (r accountingOverviewReceivable) ageDays(now time.Time) int64 {
	ref := r.issuedAt
	if r.dueAt != nil {
		ref = *r.dueAt
	}
	return reportFloorDays(now.UnixMilli() - ref.UnixMilli())
}

func accountingOverview(ctx context.Context, tx pgx.Tx, orgID string, _ AccountingOverviewInput, now time.Time) (AccountingOverviewOutput, error) {
	baseCurrency, err := reportBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	if !validReportCurrencyCode(baseCurrency) {
		return AccountingOverviewOutput{}, errors.New("report base currency is invalid")
	}
	output := AccountingOverviewOutput{
		Entries:       make([]AccountingOverviewEntry, 0),
		AgingInvoices: make([]AccountingOverviewAgingInvoice, 0),
		BaseCurrency:  baseCurrency,
		ClosedPeriods: make([]AccountingOverviewPeriod, 0),
		Bills:         make([]AccountingOverviewBill, 0),
		Filings:       make([]AccountingOverviewFiling, 0),
		Customers:     make([]AccountingOverviewCustomer, 0),
		Invoices:      make([]ListInvoiceRow, 0),
		Payments:      make([]AccountingOverviewPayment, 0),
	}

	entryRows, err := tx.Query(ctx, `
		SELECT je.id::text, je.memo, je.source_type, je.reversal_of_id::text, je.posted_at,
		       je.posted_by_actor_type, je.currency, COALESCE(SUM(jl.debit_minor), 0)::bigint
		FROM journal_entries je
		LEFT JOIN journal_lines jl ON jl.entry_id = je.id
		WHERE je.org_id = $1::uuid
		GROUP BY je.id
		ORDER BY je.posted_at DESC
		LIMIT 30`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	for entryRows.Next() {
		var row AccountingOverviewEntry
		var postedAt time.Time
		if err := entryRows.Scan(&row.ID, &row.Memo, &row.SourceType, &row.ReversalOfID, &postedAt,
			&row.ActorType, &row.Currency, &row.DebitMinor); err != nil {
			entryRows.Close()
			return AccountingOverviewOutput{}, err
		}
		if !reportSafeInteger(row.DebitMinor) {
			entryRows.Close()
			return AccountingOverviewOutput{}, errors.New("accounting overview amount exceeds the supported amount range")
		}
		row.AmountMinor = row.DebitMinor
		row.PostedAt = reportISODateTime(postedAt)
		output.Entries = append(output.Entries, row)
	}
	if err := entryRows.Err(); err != nil {
		entryRows.Close()
		return AccountingOverviewOutput{}, err
	}
	entryRows.Close()

	// The legacy overview includes draft invoices here when they have an issue date,
	// while excluding void status and any row marked voided.
	receivableRows, err := tx.Query(ctx, `
		SELECT number, currency, total_minor, paid_minor, credited_minor, issued_at, due_at
		FROM invoices
		WHERE org_id = $1::uuid AND status <> 'void' AND voided_at IS NULL
		ORDER BY issued_at DESC`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	receivables := make([]accountingOverviewReceivable, 0)
	for receivableRows.Next() {
		var number, totalMinor, paidMinor, creditedMinor int64
		var currency string
		var issuedAt, dueAt *time.Time
		if err := receivableRows.Scan(&number, &currency, &totalMinor, &paidMinor, &creditedMinor, &issuedAt, &dueAt); err != nil {
			receivableRows.Close()
			return AccountingOverviewOutput{}, err
		}
		if issuedAt == nil {
			continue
		}
		outstanding, err := reportDocumentOutstandingMinor(totalMinor, paidMinor, creditedMinor)
		if err != nil {
			receivableRows.Close()
			return AccountingOverviewOutput{}, err
		}
		if outstanding <= 0 {
			continue
		}
		receivables = append(receivables, accountingOverviewReceivable{
			number: number, currency: currency, outstandingMinor: outstanding, issuedAt: *issuedAt, dueAt: dueAt,
		})
	}
	if err := receivableRows.Err(); err != nil {
		receivableRows.Close()
		return AccountingOverviewOutput{}, err
	}
	receivableRows.Close()
	baseReceivables := make([]reportReceivable, 0, len(receivables))
	for _, row := range receivables {
		output.AgingInvoices = append(output.AgingInvoices, AccountingOverviewAgingInvoice{
			Number: row.number, Currency: row.currency, OutstandingMinor: row.outstandingMinor, AgeDays: row.ageDays(now),
		})
		if row.currency == baseCurrency {
			baseReceivables = append(baseReceivables, reportReceivable{
				invoiceNumber: row.number, outstandingMinor: row.outstandingMinor, issuedAt: row.issuedAt, dueAt: row.dueAt,
			})
		} else {
			output.ForeignReceivablesCount++
		}
	}
	sort.SliceStable(output.AgingInvoices, func(i, j int) bool {
		return output.AgingInvoices[i].AgeDays > output.AgingInvoices[j].AgeDays
	})
	output.Aging = computeReportAging(baseReceivables, now)
	if !reportSafeInteger(output.Aging.Current) || !reportSafeInteger(output.Aging.D30) ||
		!reportSafeInteger(output.Aging.D60) || !reportSafeInteger(output.Aging.D90Plus) ||
		!reportSafeInteger(output.Aging.TotalOutstanding) {
		return AccountingOverviewOutput{}, errors.New("accounting overview aging exceeds the supported amount range")
	}

	periodRows, err := tx.Query(ctx, `
		SELECT year, month FROM periods WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	for periodRows.Next() {
		var row AccountingOverviewPeriod
		if err := periodRows.Scan(&row.Year, &row.Month); err != nil {
			periodRows.Close()
			return AccountingOverviewOutput{}, err
		}
		output.ClosedPeriods = append(output.ClosedPeriods, row)
	}
	if err := periodRows.Err(); err != nil {
		periodRows.Close()
		return AccountingOverviewOutput{}, err
	}
	periodRows.Close()

	billRows, err := tx.Query(ctx, `
		SELECT vb.id::text, vb.number, vb.status, vb.currency, vb.total_minor, vb.credited_minor,
		       vb.paid_minor, v.name
		FROM vendor_bills vb
		JOIN vendors v ON v.id = vb.vendor_id AND v.org_id = $1::uuid
		WHERE vb.org_id = $1::uuid AND vb.status <> 'void'
		ORDER BY vb.number DESC`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	for billRows.Next() {
		var row AccountingOverviewBill
		if err := billRows.Scan(&row.ID, &row.Number, &row.Status, &row.Currency, &row.TotalMinor,
			&row.CreditedMinor, &row.PaidMinor, &row.VendorName); err != nil {
			billRows.Close()
			return AccountingOverviewOutput{}, err
		}
		row.OutstandingMinor, err = reportDocumentOutstandingMinor(row.TotalMinor, row.PaidMinor, row.CreditedMinor)
		if err != nil {
			billRows.Close()
			return AccountingOverviewOutput{}, err
		}
		if row.Currency != baseCurrency && row.OutstandingMinor > 0 {
			output.ForeignPayablesCount++
		}
		output.Bills = append(output.Bills, row)
	}
	if err := billRows.Err(); err != nil {
		billRows.Close()
		return AccountingOverviewOutput{}, err
	}
	billRows.Close()

	filingRows, err := tx.Query(ctx, `
		SELECT id::text, period_from, period_to, tax_minor, created_at
		FROM sales_tax_filings
		WHERE org_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 20`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	for filingRows.Next() {
		var row AccountingOverviewFiling
		var periodFrom, periodTo, filedAt time.Time
		if err := filingRows.Scan(&row.ID, &periodFrom, &periodTo, &row.TaxMinor, &filedAt); err != nil {
			filingRows.Close()
			return AccountingOverviewOutput{}, err
		}
		if !reportSafeInteger(row.TaxMinor) {
			filingRows.Close()
			return AccountingOverviewOutput{}, errors.New("accounting overview tax exceeds the supported amount range")
		}
		row.PeriodFrom = periodFrom.UTC().Format("2006-01-02")
		row.PeriodTo = periodTo.UTC().Format("2006-01-02")
		row.FiledAt = reportISODateTime(filedAt)
		output.Filings = append(output.Filings, row)
	}
	if err := filingRows.Err(); err != nil {
		filingRows.Close()
		return AccountingOverviewOutput{}, err
	}
	filingRows.Close()

	customerRows, err := tx.Query(ctx, `
		SELECT id::text, name, payment_term_days
		FROM customers
		WHERE org_id = $1::uuid
		ORDER BY name ASC`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	for customerRows.Next() {
		var row AccountingOverviewCustomer
		if err := customerRows.Scan(&row.ID, &row.Name, &row.PaymentTermDays); err != nil {
			customerRows.Close()
			return AccountingOverviewOutput{}, err
		}
		output.Customers = append(output.Customers, row)
	}
	if err := customerRows.Err(); err != nil {
		customerRows.Close()
		return AccountingOverviewOutput{}, err
	}
	customerRows.Close()

	invoiceRows, err := tx.Query(ctx, `
		SELECT i.id::text, i.number, i.customer_id::text, c.name, i.status, i.currency,
		       i.total_minor, i.paid_minor, i.credited_minor, i.issued_at
		FROM invoices i
		JOIN customers c ON c.id = i.customer_id AND c.org_id = $1::uuid
		WHERE i.org_id = $1::uuid
		ORDER BY i.number DESC
		LIMIT 50`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	for invoiceRows.Next() {
		var row ListInvoiceRow
		var issuedAt *time.Time
		if err := invoiceRows.Scan(&row.ID, &row.Number, &row.CustomerID, &row.CustomerName, &row.Status,
			&row.Currency, &row.TotalMinor, &row.PaidMinor, &row.CreditedMinor, &issuedAt); err != nil {
			invoiceRows.Close()
			return AccountingOverviewOutput{}, err
		}
		row.OutstandingMinor, err = reportDocumentOutstandingMinor(row.TotalMinor, row.PaidMinor, row.CreditedMinor)
		if err != nil {
			invoiceRows.Close()
			return AccountingOverviewOutput{}, err
		}
		if issuedAt != nil {
			formatted := reportISODateTime(*issuedAt)
			row.IssuedAt = &formatted
		}
		output.Invoices = append(output.Invoices, row)
	}
	if err := invoiceRows.Err(); err != nil {
		invoiceRows.Close()
		return AccountingOverviewOutput{}, err
	}
	invoiceRows.Close()

	paymentRows, err := tx.Query(ctx, `
		SELECT p.id::text, i.number, p.amount_minor, p.method, p.received_at, i.currency
		FROM payments p
		JOIN invoices i ON i.id = p.invoice_id AND i.org_id = $1::uuid
		WHERE p.org_id = $1::uuid
		ORDER BY p.received_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return AccountingOverviewOutput{}, err
	}
	for paymentRows.Next() {
		var row AccountingOverviewPayment
		var receivedAt time.Time
		if err := paymentRows.Scan(&row.ID, &row.InvoiceNumber, &row.AmountMinor, &row.Method, &receivedAt, &row.Currency); err != nil {
			paymentRows.Close()
			return AccountingOverviewOutput{}, err
		}
		row.ReceivedAt = reportISODateTime(receivedAt)
		output.Payments = append(output.Payments, row)
	}
	if err := paymentRows.Err(); err != nil {
		paymentRows.Close()
		return AccountingOverviewOutput{}, err
	}
	paymentRows.Close()

	return output, nil
}
