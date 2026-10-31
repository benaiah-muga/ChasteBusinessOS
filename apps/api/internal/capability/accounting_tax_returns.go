package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createTaxReturnCapabilityID               = "accounting.createTaxReturn"
	cancelTaxReturnDraftCapabilityID          = "accounting.cancelTaxReturnDraft"
	restoreTaxReturnDraftCapabilityID         = "accounting.restoreTaxReturnDraft"
	recordTaxReturnSubmissionCapabilityID     = "accounting.recordTaxReturnSubmission"
	createTaxReturnAmendmentCapabilityID      = "accounting.createTaxReturnAmendment"
	recordTaxReturnAcknowledgmentCapabilityID = "accounting.recordTaxReturnAcknowledgment"
	fileSalesTaxReturnCapabilityID            = "accounting.fileSalesTaxReturn"
)

var taxReturnISODatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

var taxReturnAcknowledgmentStatuses = []string{"accepted", "rejected", "unknown"}

type TaxReturnBreakdownLine struct {
	Code             string `json:"code"`
	Name             string `json:"name"`
	Direction        string `json:"direction"`
	RateBasisPoints  *int64 `json:"rateBasisPoints"`
	PriceIncludesTax bool   `json:"priceIncludesTax"`
	Recoverable      bool   `json:"recoverable"`
	TaxableBaseMinor int64  `json:"taxableBaseMinor"`
	TaxMinor         int64  `json:"taxMinor"`
	LineCount        int64  `json:"lineCount"`
}

type CreateTaxReturnInput struct {
	PeriodFrom     string  `json:"periodFrom"`
	PeriodTo       string  `json:"periodTo"`
	AmendsReturnID *string `json:"amendsReturnId,omitempty"`
}

type CreateTaxReturnOutput struct {
	TaxReturnID    string                   `json:"taxReturnId"`
	PeriodFrom     string                   `json:"periodFrom"`
	PeriodTo       string                   `json:"periodTo"`
	Currency       string                   `json:"currency"`
	OutputTaxMinor int64                    `json:"outputTaxMinor"`
	InputTaxMinor  int64                    `json:"inputTaxMinor"`
	TaxMinor       int64                    `json:"taxMinor"`
	TaxBreakdown   []TaxReturnBreakdownLine `json:"taxBreakdown"`
	Status         string                   `json:"status"`
	AmendsReturnID *string                  `json:"amendsReturnId"`
}

type TaxReturnIDInput struct {
	TaxReturnID string `json:"taxReturnId"`
}

type TaxReturnIDOutput struct {
	TaxReturnID string `json:"taxReturnId"`
}

type RecordTaxReturnSubmissionInput struct {
	TaxReturnID         string `json:"taxReturnId"`
	SubmissionReference string `json:"submissionReference"`
	EvidenceReference   string `json:"evidenceReference"`
}

type RecordTaxReturnSubmissionOutput struct {
	TaxReturnID         string `json:"taxReturnId"`
	Status              string `json:"status"`
	SubmissionReference string `json:"submissionReference"`
	SubmittedAt         string `json:"submittedAt"`
}

type CreateTaxReturnAmendmentOutput struct {
	TaxReturnID string `json:"taxReturnId"`
	PeriodFrom  string `json:"periodFrom"`
	PeriodTo    string `json:"periodTo"`
	Status      string `json:"status"`
}

type RecordTaxReturnAcknowledgmentInput struct {
	TaxReturnID             string  `json:"taxReturnId"`
	Status                  string  `json:"status"`
	AcknowledgmentReference *string `json:"acknowledgmentReference,omitempty"`
	Details                 *string `json:"details,omitempty"`
	EvidenceReference       *string `json:"evidenceReference,omitempty"`
}

type RecordTaxReturnAcknowledgmentOutput struct {
	TaxReturnID    string `json:"taxReturnId"`
	Status         string `json:"status"`
	AcknowledgedAt string `json:"acknowledgedAt"`
}

type FileSalesTaxReturnOutput struct {
	FilingID    string `json:"filingId"`
	TaxReturnID string `json:"taxReturnId"`
	EntryID     string `json:"entryId"`
	TaxMinor    int64  `json:"taxMinor"`
}

func taxReturnRequiredUUID(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := requiredString(fields, key)
	if err != nil {
		return "", err
	}
	if !isZodUUID(value) {
		return "", fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

func taxReturnOptionalUUID(fields map[string]json.RawMessage, key string) (*string, error) {
	value, err := optionalString(fields, key)
	if err != nil || value == nil {
		return nil, err
	}
	if !isZodUUID(*value) {
		return nil, fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

func taxReturnBoundedString(fields map[string]json.RawMessage, key string, minLength, maxLength int) (string, error) {
	value, err := requiredString(fields, key)
	if err != nil {
		return "", err
	}
	if length := utf16Length(value); length < minLength || length > maxLength {
		return "", fmt.Errorf("%s must contain between %d and %d characters", key, minLength, maxLength)
	}
	return value, nil
}

func taxReturnOptionalBoundedString(fields map[string]json.RawMessage, key string, maxLength int) (*string, error) {
	value, err := optionalString(fields, key)
	if err != nil || value == nil {
		return nil, err
	}
	if utf16Length(*value) > maxLength {
		return nil, fmt.Errorf("%s must contain at most %d characters", key, maxLength)
	}
	return value, nil
}

func parseTaxReturnIDInput(raw json.RawMessage) (TaxReturnIDInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return TaxReturnIDInput{}, err
	}
	taxReturnID, err := taxReturnRequiredUUID(fields, "taxReturnId")
	if err != nil {
		return TaxReturnIDInput{}, err
	}
	return TaxReturnIDInput{TaxReturnID: taxReturnID}, nil
}

func ParseCreateTaxReturnInput(raw json.RawMessage) (CreateTaxReturnInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateTaxReturnInput{}, err
	}
	var input CreateTaxReturnInput
	if input.PeriodFrom, err = requiredString(fields, "periodFrom"); err != nil {
		return CreateTaxReturnInput{}, err
	}
	if !taxReturnISODatePattern.MatchString(input.PeriodFrom) {
		return CreateTaxReturnInput{}, errors.New("periodFrom must be an ISO date (YYYY-MM-DD)")
	}
	if input.PeriodTo, err = requiredString(fields, "periodTo"); err != nil {
		return CreateTaxReturnInput{}, err
	}
	if !taxReturnISODatePattern.MatchString(input.PeriodTo) {
		return CreateTaxReturnInput{}, errors.New("periodTo must be an ISO date (YYYY-MM-DD)")
	}
	if input.AmendsReturnID, err = taxReturnOptionalUUID(fields, "amendsReturnId"); err != nil {
		return CreateTaxReturnInput{}, err
	}
	return input, nil
}

func ParseCancelTaxReturnDraftInput(raw json.RawMessage) (TaxReturnIDInput, error) {
	return parseTaxReturnIDInput(raw)
}

func ParseRestoreTaxReturnDraftInput(raw json.RawMessage) (TaxReturnIDInput, error) {
	return parseTaxReturnIDInput(raw)
}

func ParseRecordTaxReturnSubmissionInput(raw json.RawMessage) (RecordTaxReturnSubmissionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RecordTaxReturnSubmissionInput{}, err
	}
	var input RecordTaxReturnSubmissionInput
	if input.TaxReturnID, err = taxReturnRequiredUUID(fields, "taxReturnId"); err != nil {
		return RecordTaxReturnSubmissionInput{}, err
	}
	if input.SubmissionReference, err = taxReturnBoundedString(fields, "submissionReference", 1, 200); err != nil {
		return RecordTaxReturnSubmissionInput{}, err
	}
	if input.EvidenceReference, err = taxReturnBoundedString(fields, "evidenceReference", 1, 500); err != nil {
		return RecordTaxReturnSubmissionInput{}, err
	}
	return input, nil
}

func ParseCreateTaxReturnAmendmentInput(raw json.RawMessage) (TaxReturnIDInput, error) {
	return parseTaxReturnIDInput(raw)
}

func ParseRecordTaxReturnAcknowledgmentInput(raw json.RawMessage) (RecordTaxReturnAcknowledgmentInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RecordTaxReturnAcknowledgmentInput{}, err
	}
	var input RecordTaxReturnAcknowledgmentInput
	if input.TaxReturnID, err = taxReturnRequiredUUID(fields, "taxReturnId"); err != nil {
		return RecordTaxReturnAcknowledgmentInput{}, err
	}
	if input.Status, err = projectRequiredEnum(fields, "status", taxReturnAcknowledgmentStatuses); err != nil {
		return RecordTaxReturnAcknowledgmentInput{}, err
	}
	if input.AcknowledgmentReference, err = taxReturnOptionalBoundedString(fields, "acknowledgmentReference", 200); err != nil {
		return RecordTaxReturnAcknowledgmentInput{}, err
	}
	if input.Details, err = taxReturnOptionalBoundedString(fields, "details", 1000); err != nil {
		return RecordTaxReturnAcknowledgmentInput{}, err
	}
	if input.EvidenceReference, err = taxReturnOptionalBoundedString(fields, "evidenceReference", 500); err != nil {
		return RecordTaxReturnAcknowledgmentInput{}, err
	}
	return input, nil
}

func ParseFileSalesTaxReturnInput(raw json.RawMessage) (TaxReturnIDInput, error) {
	return parseTaxReturnIDInput(raw)
}

func parseAccountingTaxReturnInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createTaxReturnCapabilityID:
		return ParseCreateTaxReturnInput(raw)
	case cancelTaxReturnDraftCapabilityID:
		return ParseCancelTaxReturnDraftInput(raw)
	case restoreTaxReturnDraftCapabilityID:
		return ParseRestoreTaxReturnDraftInput(raw)
	case recordTaxReturnSubmissionCapabilityID:
		return ParseRecordTaxReturnSubmissionInput(raw)
	case createTaxReturnAmendmentCapabilityID:
		return ParseCreateTaxReturnAmendmentInput(raw)
	case recordTaxReturnAcknowledgmentCapabilityID:
		return ParseRecordTaxReturnAcknowledgmentInput(raw)
	case fileSalesTaxReturnCapabilityID:
		return ParseFileSalesTaxReturnInput(raw)
	default:
		return nil, errors.New("unsupported accounting tax return capability")
	}
}

// taxReturnDateWindow mirrors the TypeScript dateWindow: an inclusive UTC day
// window whose end is the exclusive midnight after the `to` day.
func taxReturnDateWindow(fromISO, toISO string) (time.Time, time.Time, error) {
	start, err := time.Parse("2006-01-02", fromISO)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("dates must be YYYY-MM-DD")
	}
	endExclusive, err := time.Parse("2006-01-02", toISO)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("dates must be YYYY-MM-DD")
	}
	if endExclusive.Before(start) {
		return time.Time{}, time.Time{}, errors.New("`to` is before `from`")
	}
	return start, endExclusive.AddDate(0, 0, 1), nil
}

var (
	taxReturnMaxSafeBigInt = big.NewInt(maxSafeInteger)
	taxReturnMinSafeBigInt = big.NewInt(-maxSafeInteger)
)

func taxReturnSafeMinor(value *big.Int, message string) (int64, error) {
	if value.Cmp(taxReturnMinSafeBigInt) < 0 || value.Cmp(taxReturnMaxSafeBigInt) > 0 {
		return 0, errors.New(message)
	}
	return value.Int64(), nil
}

type taxReturnBreakdownEntry struct {
	code             string
	name             string
	direction        string
	rateBasisPoints  *int64
	priceIncludesTax bool
	recoverable      bool
	taxableBaseMinor *big.Int
	taxMinor         *big.Int
	lineCount        int64
}

// taxReturnBreakdown accumulates lines under the TypeScript Map insertion
// order, because the stored tax_breakdown snapshot keeps first-seen order.
type taxReturnBreakdown struct {
	order []string
	byKey map[string]*taxReturnBreakdownEntry
}

func newTaxReturnBreakdown() *taxReturnBreakdown {
	return &taxReturnBreakdown{byKey: make(map[string]*taxReturnBreakdownEntry)}
}

func (b *taxReturnBreakdown) add(line taxReturnBreakdownEntry) {
	key := line.direction + ":" + line.code
	prior := b.byKey[key]
	if prior == nil {
		stored := line
		stored.lineCount = 1
		b.byKey[key] = &stored
		b.order = append(b.order, key)
		return
	}
	prior.taxableBaseMinor.Add(prior.taxableBaseMinor, line.taxableBaseMinor)
	prior.taxMinor.Add(prior.taxMinor, line.taxMinor)
	prior.lineCount++
}

func (b *taxReturnBreakdown) resolve(taxCollected, recoverableInputTax, taxableSales *big.Int) ([]TaxReturnBreakdownLine, error) {
	lines := make([]TaxReturnBreakdownLine, 0, len(b.order))
	outputTax := new(big.Int)
	inputTax := new(big.Int)
	salesBase := new(big.Int)
	for _, key := range b.order {
		entry := b.byKey[key]
		base, err := taxReturnSafeMinor(entry.taxableBaseMinor, "tax code breakdown exceeds the supported amount range")
		if err != nil {
			return nil, err
		}
		tax, err := taxReturnSafeMinor(entry.taxMinor, "tax code breakdown exceeds the supported amount range")
		if err != nil {
			return nil, err
		}
		lines = append(lines, TaxReturnBreakdownLine{
			Code:             entry.code,
			Name:             entry.name,
			Direction:        entry.direction,
			RateBasisPoints:  entry.rateBasisPoints,
			PriceIncludesTax: entry.priceIncludesTax,
			Recoverable:      entry.recoverable,
			TaxableBaseMinor: base,
			TaxMinor:         tax,
			LineCount:        entry.lineCount,
		})
		if entry.direction == "output" {
			outputTax.Add(outputTax, big.NewInt(tax))
			salesBase.Add(salesBase, big.NewInt(base))
		} else {
			inputTax.Add(inputTax, big.NewInt(tax))
		}
	}
	if outputTax.Cmp(taxCollected) != 0 || inputTax.Cmp(recoverableInputTax) != 0 || salesBase.Cmp(taxableSales) != 0 {
		return nil, errors.New("tax code breakdown does not reconcile to the jurisdiction return totals")
	}
	return lines, nil
}

// taxReturnTaxLineNet mirrors erp-core calculateTaxLine for the report: the
// same math as calculateInvoiceLine with an explicit rate and no manual tax.
func taxReturnTaxLineNet(quantity, unitPriceMinor int64, rateBasisPoints *int64, priceIncludesTax bool) (int64, error) {
	rate := int64(0)
	if rateBasisPoints != nil {
		rate = *rateBasisPoints
	}
	net, _, _, err := calculateInvoiceLine(quantity, unitPriceMinor, &rate, priceIncludesTax, nil)
	return net, err
}

type taxReturnSalesReport struct {
	BaseCurrency             string
	TaxableSalesMinor        int64
	TaxCollectedMinor        int64
	RecoverableInputTaxMinor int64
	NetTaxMinor              int64
	UnsupportedForeignCount  int
	TaxBreakdown             []TaxReturnBreakdownLine
}

// taxReturnSalesWindow mirrors salesTaxWindow: base-currency tax documents in
// the half-open [start, end) window, with foreign documents counted as
// unsupported and credit notes reducing the reported totals.
func taxReturnSalesWindow(ctx context.Context, tx pgx.Tx, orgID, fromISO, toISO string) (taxReturnSalesReport, error) {
	start, end, err := taxReturnDateWindow(fromISO, toISO)
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	baseCurrency, err := periodCloseBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	taxableSales := new(big.Int)
	taxCollected := new(big.Int)
	recoverableInputTax := new(big.Int)
	bigZero := big.NewInt(0)
	unsupportedForeignCount := 0
	breakdown := newTaxReturnBreakdown()

	invoiceRows, err := tx.Query(ctx, `
		SELECT currency, subtotal_minor, tax_minor FROM invoices
		WHERE org_id = $1::uuid AND issued_at >= $2 AND issued_at < $3 AND status <> 'void' AND voided_at IS NULL`,
		orgID, start, end)
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	for invoiceRows.Next() {
		var currency string
		var subtotalMinor, invoiceTaxMinor int64
		if err := invoiceRows.Scan(&currency, &subtotalMinor, &invoiceTaxMinor); err != nil {
			invoiceRows.Close()
			return taxReturnSalesReport{}, err
		}
		if currency != baseCurrency {
			unsupportedForeignCount++
			continue
		}
		taxableSales.Add(taxableSales, big.NewInt(subtotalMinor))
		taxCollected.Add(taxCollected, big.NewInt(invoiceTaxMinor))
	}
	if err := invoiceRows.Err(); err != nil {
		invoiceRows.Close()
		return taxReturnSalesReport{}, err
	}
	invoiceRows.Close()

	outputRows, err := tx.Query(ctx, `
		SELECT i.currency, il.quantity, il.unit_price_minor, il.tax_minor, il.tax_rate_basis_points, il.price_includes_tax, tc.code, tc.name
		FROM invoice_lines il
		JOIN invoices i ON i.id = il.invoice_id
		LEFT JOIN tax_codes tc ON tc.id = il.tax_code_id
		WHERE i.org_id = $1::uuid AND i.issued_at >= $2 AND i.issued_at < $3 AND i.status <> 'void' AND i.voided_at IS NULL`,
		orgID, start, end)
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	for outputRows.Next() {
		var currency string
		var quantity, unitPriceMinor, lineTaxMinor int64
		var rateBasisPoints *int64
		var priceIncludesTax bool
		var code, name *string
		if err := outputRows.Scan(&currency, &quantity, &unitPriceMinor, &lineTaxMinor, &rateBasisPoints, &priceIncludesTax, &code, &name); err != nil {
			outputRows.Close()
			return taxReturnSalesReport{}, err
		}
		if currency != baseCurrency {
			continue
		}
		net, err := taxReturnTaxLineNet(quantity, unitPriceMinor, rateBasisPoints, priceIncludesTax)
		if err != nil {
			outputRows.Close()
			return taxReturnSalesReport{}, err
		}
		lineCode := "MANUAL"
		if code != nil {
			lineCode = *code
		}
		lineName := "Manual tax"
		if name != nil {
			lineName = *name
		}
		breakdown.add(taxReturnBreakdownEntry{
			code: lineCode, name: lineName, direction: "output",
			rateBasisPoints: rateBasisPoints, priceIncludesTax: priceIncludesTax, recoverable: false,
			taxableBaseMinor: big.NewInt(net), taxMinor: big.NewInt(lineTaxMinor),
		})
	}
	if err := outputRows.Err(); err != nil {
		outputRows.Close()
		return taxReturnSalesReport{}, err
	}
	outputRows.Close()

	inputRows, err := tx.Query(ctx, `
		SELECT vb.currency, vbl.quantity, vbl.unit_price_minor, vbl.tax_minor, vbl.tax_rate_basis_points, vbl.price_includes_tax, tc.code, tc.name
		FROM vendor_bill_lines vbl
		JOIN vendor_bills vb ON vb.id = vbl.bill_id
		JOIN tax_codes tc ON tc.id = vbl.tax_code_id
		WHERE vb.org_id = $1::uuid AND vb.bill_date >= $2 AND vb.bill_date < $3
		  AND tc.direction = 'input' AND tc.recoverable = true AND vb.status <> 'void'`,
		orgID, start, end)
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	for inputRows.Next() {
		var currency string
		var quantity, unitPriceMinor, lineTaxMinor int64
		var rateBasisPoints *int64
		var priceIncludesTax bool
		var code, name *string
		if err := inputRows.Scan(&currency, &quantity, &unitPriceMinor, &lineTaxMinor, &rateBasisPoints, &priceIncludesTax, &code, &name); err != nil {
			inputRows.Close()
			return taxReturnSalesReport{}, err
		}
		if currency != baseCurrency {
			unsupportedForeignCount++
			continue
		}
		recoverableInputTax.Add(recoverableInputTax, big.NewInt(lineTaxMinor))
		net, err := taxReturnTaxLineNet(quantity, unitPriceMinor, rateBasisPoints, priceIncludesTax)
		if err != nil {
			inputRows.Close()
			return taxReturnSalesReport{}, err
		}
		lineCode := "MANUAL"
		if code != nil {
			lineCode = *code
		}
		lineName := "Manual tax"
		if name != nil {
			lineName = *name
		}
		breakdown.add(taxReturnBreakdownEntry{
			code: lineCode, name: lineName, direction: "input",
			rateBasisPoints: rateBasisPoints, priceIncludesTax: priceIncludesTax, recoverable: true,
			taxableBaseMinor: big.NewInt(net), taxMinor: big.NewInt(lineTaxMinor),
		})
	}
	if err := inputRows.Err(); err != nil {
		inputRows.Close()
		return taxReturnSalesReport{}, err
	}
	inputRows.Close()

	foreignCreditNotes := make(map[string]struct{})
	creditRows, err := tx.Query(ctx, `
		SELECT je.source_id::text, je.currency, a.code, coalesce(sum(jl.debit_minor), 0)::text
		FROM journal_entries je
		JOIN journal_lines jl ON jl.entry_id = je.id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid AND je.source_type = 'invoice_credit_note'
		  AND je.posted_at >= $2 AND je.posted_at < $3 AND a.code = ANY($4::text[])
		GROUP BY je.source_id, je.currency, a.code`,
		orgID, start, end, []string{"4000", "2100"})
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	for creditRows.Next() {
		var sourceID *string
		var currency, code string
		var debitText string
		if err := creditRows.Scan(&sourceID, &currency, &code, &debitText); err != nil {
			creditRows.Close()
			return taxReturnSalesReport{}, err
		}
		if currency != baseCurrency {
			key := "unknown"
			if sourceID != nil {
				key = *sourceID
			}
			foreignCreditNotes[key] = struct{}{}
			continue
		}
		amount, ok := new(big.Int).SetString(debitText, 10)
		if !ok {
			creditRows.Close()
			return taxReturnSalesReport{}, fmt.Errorf("invalid credit note debit total %q", debitText)
		}
		switch code {
		case "4000":
			taxableSales.Sub(taxableSales, amount)
			breakdown.add(taxReturnBreakdownEntry{
				code: "CREDIT_NOTE_ADJUSTMENT", name: "Sales credit note adjustments", direction: "output",
				rateBasisPoints: nil, priceIncludesTax: false, recoverable: false,
				taxableBaseMinor: new(big.Int).Neg(amount), taxMinor: bigZero,
			})
		case "2100":
			taxCollected.Sub(taxCollected, amount)
			breakdown.add(taxReturnBreakdownEntry{
				code: "CREDIT_NOTE_ADJUSTMENT", name: "Sales credit note adjustments", direction: "output",
				rateBasisPoints: nil, priceIncludesTax: false, recoverable: false,
				taxableBaseMinor: bigZero, taxMinor: new(big.Int).Neg(amount),
			})
		}
	}
	if err := creditRows.Err(); err != nil {
		creditRows.Close()
		return taxReturnSalesReport{}, err
	}
	creditRows.Close()

	supplierCreditRows, err := tx.Query(ctx, `
		SELECT je.source_id::text, je.currency, coalesce(sum(jl.credit_minor), 0)::text
		FROM journal_entries je
		JOIN journal_lines jl ON jl.entry_id = je.id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid AND je.source_type = 'vendor_credit_note'
		  AND je.posted_at >= $2 AND je.posted_at < $3 AND a.code = '1205'
		GROUP BY je.source_id, je.currency`,
		orgID, start, end)
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	for supplierCreditRows.Next() {
		var sourceID *string
		var currency string
		var creditText string
		if err := supplierCreditRows.Scan(&sourceID, &currency, &creditText); err != nil {
			supplierCreditRows.Close()
			return taxReturnSalesReport{}, err
		}
		if currency != baseCurrency {
			key := "unknown"
			if sourceID != nil {
				key = *sourceID
			}
			foreignCreditNotes[key] = struct{}{}
			continue
		}
		amount, ok := new(big.Int).SetString(creditText, 10)
		if !ok {
			supplierCreditRows.Close()
			return taxReturnSalesReport{}, fmt.Errorf("invalid supplier credit total %q", creditText)
		}
		recoverableInputTax.Sub(recoverableInputTax, amount)
		breakdown.add(taxReturnBreakdownEntry{
			code: "SUPPLIER_CREDIT_ADJUSTMENT", name: "Supplier credit note adjustments", direction: "input",
			rateBasisPoints: nil, priceIncludesTax: false, recoverable: true,
			taxableBaseMinor: bigZero, taxMinor: new(big.Int).Neg(amount),
		})
	}
	if err := supplierCreditRows.Err(); err != nil {
		supplierCreditRows.Close()
		return taxReturnSalesReport{}, err
	}
	supplierCreditRows.Close()

	unsupportedForeignCount += len(foreignCreditNotes)
	netTax := new(big.Int).Sub(taxCollected, recoverableInputTax)
	for _, total := range []*big.Int{taxableSales, taxCollected, recoverableInputTax, netTax} {
		if total.Cmp(taxReturnMinSafeBigInt) < 0 || total.Cmp(taxReturnMaxSafeBigInt) > 0 {
			return taxReturnSalesReport{}, errors.New("sales tax report exceeds the supported amount range")
		}
	}
	taxBreakdown, err := breakdown.resolve(taxCollected, recoverableInputTax, taxableSales)
	if err != nil {
		return taxReturnSalesReport{}, err
	}
	return taxReturnSalesReport{
		BaseCurrency:             baseCurrency,
		TaxableSalesMinor:        taxableSales.Int64(),
		TaxCollectedMinor:        taxCollected.Int64(),
		RecoverableInputTaxMinor: recoverableInputTax.Int64(),
		NetTaxMinor:              netTax.Int64(),
		UnsupportedForeignCount:  unsupportedForeignCount,
		TaxBreakdown:             taxBreakdown,
	}, nil
}

// insertTaxReturnSnapshot mirrors the TypeScript insertTaxReturnSnapshot: it
// serializes prepares per org under the tax-returns advisory lock, guards the
// amendment linkage and overlap rules, and saves the computed snapshot as a
// draft return.
func insertTaxReturnSnapshot(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, periodFrom, periodTo string, amendsReturnID *string) (CreateTaxReturnOutput, error) {
	orgID := claims.OrganizationID
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, "tax-returns"); err != nil {
		return CreateTaxReturnOutput{}, err
	}
	var jurisdiction string
	err := tx.QueryRow(ctx, `SELECT jurisdiction_code FROM tax_profiles WHERE org_id = $1::uuid LIMIT 1`, orgID).Scan(&jurisdiction)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateTaxReturnOutput{}, errors.New("set a jurisdiction-specific tax profile before preparing a return")
	} else if err != nil {
		return CreateTaxReturnOutput{}, err
	}
	report, err := taxReturnSalesWindow(ctx, tx, orgID, periodFrom, periodTo)
	if err != nil {
		return CreateTaxReturnOutput{}, err
	}
	if report.UnsupportedForeignCount > 0 {
		return CreateTaxReturnOutput{}, errors.New("return preparation is blocked while foreign-currency tax documents need conversion")
	}
	start, end, err := taxReturnDateWindow(periodFrom, periodTo)
	if err != nil {
		return CreateTaxReturnOutput{}, err
	}
	var amended *string
	if amendsReturnID != nil {
		var originalStatus string
		var originalFrom, originalTo time.Time
		err := tx.QueryRow(ctx, `
			SELECT status, period_from, period_to FROM tax_returns
			WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`, *amendsReturnID, orgID).Scan(&originalStatus, &originalFrom, &originalTo)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && originalStatus != "accepted" && originalStatus != "rejected" {
			return CreateTaxReturnOutput{}, errors.New("only an accepted or rejected return can be amended")
		} else if err != nil {
			return CreateTaxReturnOutput{}, err
		}
		if !originalFrom.Equal(start) || !originalTo.Equal(end) {
			return CreateTaxReturnOutput{}, errors.New("amended return must use the original filing window")
		}
		amended = amendsReturnID
	} else {
		var overlapID string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM tax_returns
			WHERE org_id = $1::uuid AND period_from < $2 AND period_to > $3 AND status <> 'cancelled'
			LIMIT 1`, orgID, end, start).Scan(&overlapID)
		if err == nil {
			return CreateTaxReturnOutput{}, errors.New("an overlapping return already exists; prepare an amendment to correct it")
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return CreateTaxReturnOutput{}, err
		}
		var legacySettlementID string
		err = tx.QueryRow(ctx, `
			SELECT id::text FROM sales_tax_filings
			WHERE org_id = $1::uuid AND period_from < $2 AND period_to > $3 AND tax_return_id IS NULL
			LIMIT 1`, orgID, end, start).Scan(&legacySettlementID)
		if err == nil {
			return CreateTaxReturnOutput{}, errors.New("this period already has a ledger settlement without a return snapshot; review its filing history before preparing another return")
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return CreateTaxReturnOutput{}, err
		}
	}
	breakdownJSON, err := marshalJS(report.TaxBreakdown)
	if err != nil {
		return CreateTaxReturnOutput{}, err
	}
	var taxReturnID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO tax_returns (org_id, jurisdiction_code, period_from, period_to, currency, tax_breakdown, output_tax_minor, input_tax_minor, tax_minor, status, amends_return_id, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'draft', $10::uuid, $11, $12::uuid)
		RETURNING id::text`,
		orgID, jurisdiction, start, end, report.BaseCurrency, breakdownJSON,
		report.TaxCollectedMinor, report.RecoverableInputTaxMinor, report.NetTaxMinor,
		amended, claims.ActorType, claims.ActorID).Scan(&taxReturnID); err != nil {
		return CreateTaxReturnOutput{}, err
	}
	return CreateTaxReturnOutput{
		TaxReturnID:    taxReturnID,
		PeriodFrom:     periodFrom,
		PeriodTo:       periodTo,
		Currency:       report.BaseCurrency,
		OutputTaxMinor: report.TaxCollectedMinor,
		InputTaxMinor:  report.RecoverableInputTaxMinor,
		TaxMinor:       report.NetTaxMinor,
		TaxBreakdown:   report.TaxBreakdown,
		Status:         "draft",
		AmendsReturnID: amended,
	}, nil
}

func executeCreateTaxReturn(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateTaxReturnInput, now time.Time) (CreateTaxReturnOutput, error) {
	_ = now
	return insertTaxReturnSnapshot(ctx, tx, claims, input.PeriodFrom, input.PeriodTo, input.AmendsReturnID)
}

func executeCancelTaxReturnDraft(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input TaxReturnIDInput, now time.Time) (TaxReturnIDOutput, error) {
	_ = now
	var taxReturnID string
	err := tx.QueryRow(ctx, `
		UPDATE tax_returns SET status = 'cancelled'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'draft'
		RETURNING id::text`, input.TaxReturnID, claims.OrganizationID).Scan(&taxReturnID)
	if errors.Is(err, pgx.ErrNoRows) {
		return TaxReturnIDOutput{}, errors.New("unsent return draft not found")
	} else if err != nil {
		return TaxReturnIDOutput{}, err
	}
	return TaxReturnIDOutput{TaxReturnID: taxReturnID}, nil
}

func executeRestoreTaxReturnDraft(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input TaxReturnIDInput, now time.Time) (TaxReturnIDOutput, error) {
	_ = now
	var taxReturnID string
	err := tx.QueryRow(ctx, `
		UPDATE tax_returns SET status = 'draft'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'cancelled'
		RETURNING id::text`, input.TaxReturnID, claims.OrganizationID).Scan(&taxReturnID)
	if errors.Is(err, pgx.ErrNoRows) {
		return TaxReturnIDOutput{}, errors.New("cancelled draft not found")
	} else if err != nil {
		return TaxReturnIDOutput{}, err
	}
	return TaxReturnIDOutput{TaxReturnID: taxReturnID}, nil
}

func executeRecordTaxReturnSubmission(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RecordTaxReturnSubmissionInput, now time.Time) (RecordTaxReturnSubmissionOutput, error) {
	orgID := claims.OrganizationID
	var providerMode *string
	if err := tx.QueryRow(ctx, `SELECT provider_mode FROM tax_profiles WHERE org_id = $1::uuid LIMIT 1`, orgID).Scan(&providerMode); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return RecordTaxReturnSubmissionOutput{}, err
	}
	if providerMode != nil && *providerMode == "connected" {
		return RecordTaxReturnSubmissionOutput{}, errors.New("no tax authority provider is configured; switch to manual recording or complete the jurisdiction integration")
	}
	var taxReturnID string
	err := tx.QueryRow(ctx, `
		UPDATE tax_returns SET status = 'submitted', submission_reference = $3, evidence_reference = $4, submitted_at = $5
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'draft'
		RETURNING id::text`, input.TaxReturnID, orgID, input.SubmissionReference, input.EvidenceReference, now).Scan(&taxReturnID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordTaxReturnSubmissionOutput{}, errors.New("only an unsent draft can be marked submitted; an unknown result must be reconciled before retrying")
	} else if err != nil {
		return RecordTaxReturnSubmissionOutput{}, err
	}
	return RecordTaxReturnSubmissionOutput{
		TaxReturnID:         taxReturnID,
		Status:              "submitted",
		SubmissionReference: input.SubmissionReference,
		SubmittedAt:         now.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	}, nil
}

func executeCreateTaxReturnAmendment(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input TaxReturnIDInput, now time.Time) (CreateTaxReturnAmendmentOutput, error) {
	_ = now
	orgID := claims.OrganizationID
	var originalID, originalStatus string
	var originalFrom, originalTo time.Time
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, period_from, period_to FROM tax_returns
		WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1 FOR UPDATE`, input.TaxReturnID, orgID).
		Scan(&originalID, &originalStatus, &originalFrom, &originalTo)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && originalStatus != "accepted" && originalStatus != "rejected" {
		return CreateTaxReturnAmendmentOutput{}, errors.New("only an accepted or rejected return can be amended")
	} else if err != nil {
		return CreateTaxReturnAmendmentOutput{}, err
	}
	var existingAmendmentID string
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM tax_returns
		WHERE org_id = $1::uuid AND amends_return_id = $2::uuid AND status <> 'cancelled'
		LIMIT 1`, orgID, originalID).Scan(&existingAmendmentID)
	if err == nil {
		return CreateTaxReturnAmendmentOutput{}, errors.New("this return already has an active amendment")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return CreateTaxReturnAmendmentOutput{}, err
	}
	fromISO := originalFrom.UTC().Format("2006-01-02")
	toISO := originalTo.UTC().AddDate(0, 0, -1).Format("2006-01-02")
	created, err := insertTaxReturnSnapshot(ctx, tx, claims, fromISO, toISO, &originalID)
	if err != nil {
		return CreateTaxReturnAmendmentOutput{}, err
	}
	return CreateTaxReturnAmendmentOutput{
		TaxReturnID: created.TaxReturnID,
		PeriodFrom:  created.PeriodFrom,
		PeriodTo:    created.PeriodTo,
		Status:      "draft",
	}, nil
}

func executeRecordTaxReturnAcknowledgment(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RecordTaxReturnAcknowledgmentInput, now time.Time) (RecordTaxReturnAcknowledgmentOutput, error) {
	orgID := claims.OrganizationID
	acknowledgment, err := marshalJS(struct {
		Details   *string `json:"details"`
		Reference *string `json:"reference"`
	}{Details: input.Details, Reference: input.AcknowledgmentReference})
	if err != nil {
		return RecordTaxReturnAcknowledgmentOutput{}, err
	}
	var taxReturnID string
	if input.EvidenceReference != nil {
		err = tx.QueryRow(ctx, `
			UPDATE tax_returns SET status = $3, acknowledgment = $4::jsonb, evidence_reference = $5, acknowledged_at = $6
			WHERE id = $1::uuid AND org_id = $2::uuid AND status IN ('submitted', 'unknown')
			RETURNING id::text`, input.TaxReturnID, orgID, input.Status, acknowledgment, *input.EvidenceReference, now).Scan(&taxReturnID)
	} else {
		err = tx.QueryRow(ctx, `
			UPDATE tax_returns SET status = $3, acknowledgment = $4::jsonb, acknowledged_at = $5
			WHERE id = $1::uuid AND org_id = $2::uuid AND status IN ('submitted', 'unknown')
			RETURNING id::text`, input.TaxReturnID, orgID, input.Status, acknowledgment, now).Scan(&taxReturnID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordTaxReturnAcknowledgmentOutput{}, errors.New("only submitted or unresolved returns can receive an acknowledgment")
	} else if err != nil {
		return RecordTaxReturnAcknowledgmentOutput{}, err
	}
	return RecordTaxReturnAcknowledgmentOutput{
		TaxReturnID:    taxReturnID,
		Status:         input.Status,
		AcknowledgedAt: now.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	}, nil
}

type taxReturnTotals struct {
	outputTaxMinor int64
	inputTaxMinor  int64
}

type taxReturnSettlementDelta struct {
	outputDeltaMinor int64
	inputDeltaMinor  int64
	taxDeltaMinor    int64
}

// calculateTaxReturnSettlementDelta mirrors erp-core calculateTaxSettlementDelta.
func calculateTaxReturnSettlementDelta(current, settled taxReturnTotals) (taxReturnSettlementDelta, error) {
	checks := []struct {
		label  string
		amount int64
	}{
		{"current output tax", current.outputTaxMinor},
		{"current input tax", current.inputTaxMinor},
		{"settled output tax", settled.outputTaxMinor},
		{"settled input tax", settled.inputTaxMinor},
	}
	for _, check := range checks {
		if check.amount < 0 || check.amount > maxSafeInteger {
			return taxReturnSettlementDelta{}, fmt.Errorf("%s must be a non-negative safe integer", check.label)
		}
	}
	outputDelta := current.outputTaxMinor - settled.outputTaxMinor
	inputDelta := current.inputTaxMinor - settled.inputTaxMinor
	taxDelta := outputDelta - inputDelta
	for _, delta := range []struct {
		name   string
		amount int64
	}{
		{"output", outputDelta},
		{"input", inputDelta},
		{"tax", taxDelta},
	} {
		if delta.amount < -maxSafeInteger || delta.amount > maxSafeInteger {
			return taxReturnSettlementDelta{}, errors.New("tax settlement delta exceeds the supported amount range")
		}
	}
	return taxReturnSettlementDelta{outputDeltaMinor: outputDelta, inputDeltaMinor: inputDelta, taxDeltaMinor: taxDelta}, nil
}

func taxReturnEnsureAccount(ctx context.Context, tx pgx.Tx, orgID, code, name, accountType string) error {
	var existing string
	err := tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE org_id = $1::uuid AND code = $2 LIMIT 1`, orgID, code).Scan(&existing)
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`, orgID, code, name, accountType)
	return err
}

func executeFileSalesTaxReturn(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input TaxReturnIDInput, now time.Time) (FileSalesTaxReturnOutput, error) {
	orgID := claims.OrganizationID
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, "tax-returns"); err != nil {
		return FileSalesTaxReturnOutput{}, err
	}
	var returnRow struct {
		id                string
		status            string
		periodFrom        time.Time
		periodTo          time.Time
		currency          string
		outputTaxMinor    int64
		inputTaxMinor     int64
		taxMinor          int64
		amendsReturnID    *string
		settlementEntryID *string
	}
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, period_from, period_to, currency, output_tax_minor, input_tax_minor, tax_minor, amends_return_id::text, settlement_entry_id::text
		FROM tax_returns WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1 FOR UPDATE`,
		input.TaxReturnID, orgID).Scan(
		&returnRow.id, &returnRow.status, &returnRow.periodFrom, &returnRow.periodTo, &returnRow.currency,
		&returnRow.outputTaxMinor, &returnRow.inputTaxMinor, &returnRow.taxMinor,
		&returnRow.amendsReturnID, &returnRow.settlementEntryID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && returnRow.status != "submitted" && returnRow.status != "accepted" {
		return FileSalesTaxReturnOutput{}, errors.New("only a submitted or accepted tax return can be settled")
	} else if err != nil {
		return FileSalesTaxReturnOutput{}, err
	}
	if returnRow.settlementEntryID != nil {
		return FileSalesTaxReturnOutput{}, errors.New("this tax return already has a recorded settlement")
	}
	notBalanced := func() (FileSalesTaxReturnOutput, error) {
		return FileSalesTaxReturnOutput{}, errors.New("the saved return tax totals do not balance; review the return before settlement")
	}
	if returnRow.outputTaxMinor < 0 || returnRow.inputTaxMinor < 0 ||
		absInt64(returnRow.outputTaxMinor) > maxSafeInteger || absInt64(returnRow.inputTaxMinor) > maxSafeInteger || absInt64(returnRow.taxMinor) > maxSafeInteger ||
		returnRow.outputTaxMinor-returnRow.inputTaxMinor != returnRow.taxMinor {
		return notBalanced()
	}

	lineage := make(map[string]struct{})
	var settledBaseline *taxReturnTotals
	parentID := returnRow.amendsReturnID
	for parentID != nil {
		if _, cyclic := lineage[*parentID]; cyclic {
			return FileSalesTaxReturnOutput{}, errors.New("return amendment chain contains a cycle")
		}
		lineage[*parentID] = struct{}{}
		var parentIDText, parentAmendsID *string
		var parentOutputTaxMinor, parentInputTaxMinor int64
		var parentSettlementEntryID *string
		err := tx.QueryRow(ctx, `
			SELECT id::text, amends_return_id::text, output_tax_minor, input_tax_minor, settlement_entry_id::text
			FROM tax_returns WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`, *parentID, orgID).
			Scan(&parentIDText, &parentAmendsID, &parentOutputTaxMinor, &parentInputTaxMinor, &parentSettlementEntryID)
		if errors.Is(err, pgx.ErrNoRows) {
			return FileSalesTaxReturnOutput{}, errors.New("the original return in this amendment chain no longer exists")
		} else if err != nil {
			return FileSalesTaxReturnOutput{}, err
		}
		if settledBaseline == nil && parentSettlementEntryID != nil {
			settledBaseline = &taxReturnTotals{outputTaxMinor: parentOutputTaxMinor, inputTaxMinor: parentInputTaxMinor}
		}
		parentID = parentAmendsID
	}

	var activeChildID string
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM tax_returns
		WHERE org_id = $1::uuid AND amends_return_id = $2::uuid AND status <> 'cancelled'
		LIMIT 1`, orgID, returnRow.id).Scan(&activeChildID)
	if err == nil {
		return FileSalesTaxReturnOutput{}, errors.New("settle the latest active return in this amendment chain")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return FileSalesTaxReturnOutput{}, err
	}

	baseline := taxReturnTotals{}
	if settledBaseline != nil {
		baseline = *settledBaseline
	}
	delta, err := calculateTaxReturnSettlementDelta(taxReturnTotals{outputTaxMinor: returnRow.outputTaxMinor, inputTaxMinor: returnRow.inputTaxMinor}, baseline)
	if err != nil {
		return FileSalesTaxReturnOutput{}, err
	}
	if delta.outputDeltaMinor == 0 && delta.inputDeltaMinor == 0 {
		return FileSalesTaxReturnOutput{}, errors.New("this return has no new tax balance to settle")
	}

	start := returnRow.periodFrom.UTC()
	end := returnRow.periodTo.UTC()
	var overlappingFilingID string
	var overlappingFilingReturnID *string
	err = tx.QueryRow(ctx, `
		SELECT id::text, tax_return_id::text FROM sales_tax_filings
		WHERE org_id = $1::uuid AND period_from < $2 AND period_to > $3
		LIMIT 1`, orgID, end, start).Scan(&overlappingFilingID, &overlappingFilingReturnID)
	if err == nil {
		filedOutsideLineage := overlappingFilingReturnID == nil
		if overlappingFilingReturnID != nil {
			_, inLineage := lineage[*overlappingFilingReturnID]
			filedOutsideLineage = !inLineage
		}
		if filedOutsideLineage {
			return FileSalesTaxReturnOutput{}, fmt.Errorf("period %s to %s overlaps an already-filed return",
				start.Format("2006-01-02"), end.AddDate(0, 0, -1).Format("2006-01-02"))
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return FileSalesTaxReturnOutput{}, err
	}

	if delta.taxDeltaMinor < 0 {
		if err := taxReturnEnsureAccount(ctx, tx, orgID, "1206", "Tax refund receivable", "asset"); err != nil {
			return FileSalesTaxReturnOutput{}, err
		}
	}
	settlementLines := []JournalEntryLineInput{
		{AccountCode: "2100", DebitMinor: max64(delta.outputDeltaMinor, 0), CreditMinor: max64(-delta.outputDeltaMinor, 0)},
		{AccountCode: "1205", DebitMinor: max64(-delta.inputDeltaMinor, 0), CreditMinor: max64(delta.inputDeltaMinor, 0)},
	}
	if delta.taxDeltaMinor > 0 {
		settlementLines = append(settlementLines, JournalEntryLineInput{AccountCode: "1000", DebitMinor: 0, CreditMinor: delta.taxDeltaMinor})
	} else {
		settlementLines = append(settlementLines, JournalEntryLineInput{AccountCode: "1206", DebitMinor: -delta.taxDeltaMinor, CreditMinor: 0})
	}
	postingLines := make([]JournalEntryLineInput, 0, len(settlementLines))
	for _, line := range settlementLines {
		if line.DebitMinor != 0 || line.CreditMinor != 0 {
			postingLines = append(postingLines, line)
		}
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: orgID,
		Memo: fmt.Sprintf("Sales tax settlement %s → %s",
			start.Format("2006-01-02"), end.AddDate(0, 0, -1).Format("2006-01-02")),
		SourceType: "sales_tax_filing",
		SourceID:   &returnRow.id,
		Currency:   returnRow.currency,
		PostedAt:   now,
		ActorType:  claims.ActorType,
		ActorID:    claims.ActorID,
		Lines:      postingLines,
	})
	if err != nil {
		return FileSalesTaxReturnOutput{}, err
	}

	var filingID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO sales_tax_filings (org_id, period_from, period_to, tax_return_id, tax_minor, entry_id, filed_by_actor_type, filed_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::uuid, $7, $8::uuid)
		RETURNING id::text`,
		orgID, start, end, returnRow.id, delta.taxDeltaMinor, entryID, claims.ActorType, claims.ActorID).Scan(&filingID); err != nil {
		return FileSalesTaxReturnOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tax_returns SET settlement_entry_id = $2::uuid, settled_at = $3 WHERE id = $1::uuid`,
		returnRow.id, entryID, now); err != nil {
		return FileSalesTaxReturnOutput{}, err
	}
	return FileSalesTaxReturnOutput{FilingID: filingID, TaxReturnID: returnRow.id, EntryID: entryID, TaxMinor: delta.taxDeltaMinor}, nil
}

func max64(value, floor int64) int64 {
	if value > floor {
		return value
	}
	return floor
}
