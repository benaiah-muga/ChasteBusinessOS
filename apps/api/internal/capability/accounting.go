package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

// CreateInvoiceInput is the accepted legacy accounting.createInvoice payload.
// Currency and configured tax codes are validated by the createInvoice path.
type CreateInvoiceInput struct {
	CustomerID string              `json:"customerId"`
	Memo       *string             `json:"memo,omitempty"`
	Lines      []CreateInvoiceLine `json:"lines"`
	Currency   *string             `json:"currency,omitempty"`
	FXRate     *string             `json:"fxRate,omitempty"`
	DueAt      *string             `json:"dueAt,omitempty"`
}

type CreateInvoiceLine struct {
	Description    string  `json:"description"`
	Quantity       int64   `json:"quantity"`
	UnitPriceMinor int64   `json:"unitPriceMinor"`
	TaxMinor       *int64  `json:"taxMinor,omitempty"`
	TaxCodeID      *string `json:"taxCodeId,omitempty"`
}

type CreateInvoiceOutput struct {
	InvoiceID     string `json:"invoiceId"`
	InvoiceNumber int64  `json:"invoiceNumber"`
	TotalMinor    int64  `json:"totalMinor"`
	EntryID       string `json:"entryId"`
	Currency      string `json:"currency"`
}

type TrialBalanceInput struct{}

type TrialBalanceLine struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	Currency    string `json:"currency"`
	DebitMinor  int64  `json:"debitMinor"`
	CreditMinor int64  `json:"creditMinor"`
}

type TrialBalanceOutput struct {
	Lines    []TrialBalanceLine `json:"lines"`
	Balanced bool               `json:"balanced"`
}

// ParseCreateInvoiceInput mirrors the public TypeScript schema's accepted
// fields and validates all data used by the Go transaction implementation.
// Unknown object members are stripped, as the TypeScript z.object schema does.
func ParseCreateInvoiceInput(raw json.RawMessage) (CreateInvoiceInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateInvoiceInput{}, err
	}
	var input CreateInvoiceInput
	input.CustomerID, err = requiredString(fields, "customerId")
	if err != nil || !isZodUUID(input.CustomerID) {
		return CreateInvoiceInput{}, errors.New("customerId must be a UUID")
	}
	if input.Memo, err = optionalString(fields, "memo"); err != nil {
		return CreateInvoiceInput{}, err
	}
	if input.Currency, err = optionalString(fields, "currency"); err != nil {
		return CreateInvoiceInput{}, err
	}
	if input.FXRate, err = optionalString(fields, "fxRate"); err != nil {
		return CreateInvoiceInput{}, err
	}
	if input.DueAt, err = optionalString(fields, "dueAt"); err != nil {
		return CreateInvoiceInput{}, err
	} else if input.DueAt != nil {
		if _, err := parseLegacyDateTime(*input.DueAt); err != nil {
			return CreateInvoiceInput{}, errors.New("dueAt must be a UTC ISO datetime")
		}
	}

	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return CreateInvoiceInput{}, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) == 0 {
		return CreateInvoiceInput{}, errors.New("lines must contain at least one line")
	}
	input.Lines = make([]CreateInvoiceLine, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return CreateInvoiceInput{}, errors.New("each invoice line must be an object")
		}
		var line CreateInvoiceLine
		line.Description, err = requiredString(lineFields, "description")
		if err != nil || utf16Length(line.Description) < 1 {
			return CreateInvoiceInput{}, errors.New("line description must contain at least one character")
		}
		line.Quantity, err = requiredSafeInteger(lineFields, "quantity")
		if err != nil || line.Quantity <= 0 {
			return CreateInvoiceInput{}, errors.New("quantity must be a positive integer")
		}
		line.UnitPriceMinor, err = requiredSafeInteger(lineFields, "unitPriceMinor")
		if err != nil || line.UnitPriceMinor < 0 {
			return CreateInvoiceInput{}, errors.New("unitPriceMinor must be a non-negative integer")
		}
		if line.TaxMinor, err = optionalSafeInteger(lineFields, "taxMinor"); err != nil {
			return CreateInvoiceInput{}, errors.New("taxMinor must be a non-negative integer")
		} else if line.TaxMinor != nil && *line.TaxMinor < 0 {
			return CreateInvoiceInput{}, errors.New("taxMinor must be a non-negative integer")
		}
		if line.TaxCodeID, err = optionalString(lineFields, "taxCodeId"); err != nil {
			return CreateInvoiceInput{}, err
		} else if line.TaxCodeID != nil && !isZodUUID(*line.TaxCodeID) {
			return CreateInvoiceInput{}, errors.New("taxCodeId must be a UUID")
		}
		if line.TaxCodeID != nil && line.TaxMinor != nil {
			return CreateInvoiceInput{}, errors.New("use a configured tax code or a manual tax amount, not both")
		}
		input.Lines = append(input.Lines, line)
	}
	return input, nil
}

func ParseTrialBalanceInput(raw json.RawMessage) (TrialBalanceInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return TrialBalanceInput{}, err
	}
	return TrialBalanceInput{}, nil
}

func decodeJSONObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return nil, errors.New("expected an object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("contains trailing JSON data")
	}
	return fields, nil
}

func optionalString(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	return &value, nil
}

func requiredSafeInteger(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, fmt.Errorf("%s is required", key)
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	value, err := number.Int64()
	if err == nil {
		if absInt64(value) > maxSafeInteger {
			return 0, fmt.Errorf("%s must be a safe integer", key)
		}
		return value, nil
	}
	// JS accepts integral numeric spellings such as 1e3 and 2.0. Keep that
	// behavior while refusing fractional or unsafe IEEE-754 values.
	floating, parseErr := strconv.ParseFloat(number.String(), 64)
	if parseErr != nil || math.IsNaN(floating) || math.IsInf(floating, 0) || math.Trunc(floating) != floating || math.Abs(floating) > float64(maxSafeInteger) {
		return 0, fmt.Errorf("%s must be a safe integer", key)
	}
	return int64(floating), nil
}

const maxSafeInteger int64 = 9_007_199_254_740_991
const maxDatabaseInteger int64 = 1<<31 - 1

func optionalSafeInteger(fields map[string]json.RawMessage, key string) (*int64, error) {
	if _, ok := fields[key]; !ok {
		return nil, nil
	}
	value, err := requiredSafeInteger(fields, key)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func absInt64(value int64) int64 {
	if value == math.MinInt64 {
		return math.MaxInt64
	}
	if value < 0 {
		return -value
	}
	return value
}

func parseLegacyDateTime(value string) (time.Time, error) {
	if !strings.HasSuffix(value, "Z") {
		return time.Time{}, errors.New("datetime must use UTC Z notation")
	}
	return time.Parse(time.RFC3339Nano, value)
}

type invoiceResolvedLine struct {
	input            CreateInvoiceLine
	netMinor         int64
	taxMinor         int64
	grossMinor       int64
	rateBasisPoints  *int64
	priceIncludesTax bool
	taxCodeID        *string
	taxLiabilityCode string
}

type taxCodeRow struct {
	ID                   string
	JurisdictionCode     string
	Direction            string
	RateBasisPoints      int64
	PriceIncludesTax     bool
	LiabilityAccountCode string
	Active               bool
}

type fxRateSnapshot struct {
	Num int64
	Den int64
}

var fxRateDecimalPattern = regexp.MustCompile(`^\d{1,9}(\.\d{1,12})?$`)

// createInvoice writes an invoice, immutable line snapshots, and its balanced
// AR/revenue/tax entry in the caller's org-scoped transaction. The caller must
// append the capability ledger event in this same transaction before commit.
func createInvoice(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateInvoiceInput, now time.Time) (CreateInvoiceOutput, error) {
	var out CreateInvoiceOutput
	if tx == nil {
		return out, errors.New("invoice transaction is required")
	}
	if claims.OrganizationID == "" {
		return out, errors.New("organization id is required")
	}
	if len(input.Lines) == 0 {
		return out, errors.New("lines must contain at least one line")
	}
	var baseCurrency string
	var err error
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, claims.OrganizationID).Scan(&baseCurrency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, errors.New("organization not found")
		}
		return out, err
	}
	currency := baseCurrency
	var invoiceRate *fxRateSnapshot
	if input.Currency != nil && *input.Currency != "" {
		if _, ok := currencyMinorUnits(*input.Currency); !ok {
			return out, fmt.Errorf("unknown currency code: %s", *input.Currency)
		}
		if *input.Currency != baseCurrency {
			if input.FXRate != nil && *input.FXRate != "" {
				invoiceRate, _ = parseFXRateDecimal(*input.FXRate)
			} else {
				invoiceRate, err = latestFXRate(ctx, tx, claims.OrganizationID, baseCurrency, *input.Currency, now)
				if err != nil {
					return out, err
				}
			}
			if invoiceRate == nil {
				return out, fmt.Errorf("no FX rate for %s/%s; post one with accounting.recordFxRate", baseCurrency, *input.Currency)
			}
			if invoiceRate.Den > maxDatabaseInteger {
				return out, errors.New("FX rate denominator exceeds the database integer range")
			}
			currency = *input.Currency
		} else if input.FXRate != nil && *input.FXRate != "" {
			return out, errors.New("fxRate applies only when currency differs from the base")
		}
	}

	var paymentTermDays int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(payment_term_days, 0) FROM customers WHERE id = $1::uuid AND org_id = $2::uuid`, input.CustomerID, claims.OrganizationID).Scan(&paymentTermDays); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, errors.New("customer not found")
		}
		return out, err
	}
	resolved, subtotalMinor, taxMinor, totalMinor, err := resolveInvoiceLines(ctx, tx, claims.OrganizationID, input.Lines)
	if err != nil {
		return out, err
	}
	if totalMinor <= 0 {
		return out, errors.New("invoice total must be greater than zero")
	}
	if subtotalMinor > maxDatabaseInteger || taxMinor > maxDatabaseInteger || totalMinor > maxDatabaseInteger {
		return out, errors.New("invoice totals exceed the database integer range")
	}

	dueAt := now
	if paymentTermDays > 0 {
		if paymentTermDays > 3_000_000 {
			return out, errors.New("customer payment terms exceed the supported date range")
		}
		dueAt = now.AddDate(0, 0, int(paymentTermDays))
	}
	if input.DueAt != nil {
		dueAt, err = parseLegacyDateTime(*input.DueAt)
		if err != nil {
			return out, errors.New("dueAt must be a UTC ISO datetime")
		}
	}
	invoiceNumber, err := nextInvoiceNumber(ctx, tx, claims.OrganizationID)
	if err != nil {
		return out, err
	}
	var invoiceID string
	var fxRateNum, fxRateDen any
	if invoiceRate != nil {
		fxRateNum, fxRateDen = invoiceRate.Num, invoiceRate.Den
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, fx_rate_num, fx_rate_den, subtotal_minor, tax_minor, total_minor, memo, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, $3, 'sent', $4, $5::bigint, $6::integer, $7, $8, $9, $10, $11, $12)
		RETURNING id::text`, claims.OrganizationID, input.CustomerID, invoiceNumber, currency, fxRateNum, fxRateDen, subtotalMinor, taxMinor, totalMinor, input.Memo, now, dueAt).Scan(&invoiceID)
	if err != nil {
		return out, err
	}
	for _, line := range resolved {
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_minor, tax_minor, tax_code_id, tax_rate_basis_points, price_includes_tax)
			VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8)`,
			invoiceID, line.input.Description, line.input.Quantity, line.input.UnitPriceMinor, line.taxMinor, line.taxCodeID, line.rateBasisPoints, line.priceIncludesTax); err != nil {
			return out, err
		}
	}
	var entryID string
	postingLines := make([]JournalEntryLineInput, 0, len(resolved)+2)
	postingLines = append(postingLines, JournalEntryLineInput{AccountCode: "1100", DebitMinor: totalMinor})
	for _, line := range resolved {
		if line.netMinor != 0 {
			postingLines = append(postingLines, JournalEntryLineInput{AccountCode: "4000", CreditMinor: line.netMinor})
		}
	}
	taxByAccount := make(map[string]int64)
	taxAccountOrder := make([]string, 0)
	for _, line := range resolved {
		if _, exists := taxByAccount[line.taxLiabilityCode]; !exists {
			taxAccountOrder = append(taxAccountOrder, line.taxLiabilityCode)
		}
		taxByAccount[line.taxLiabilityCode] += line.taxMinor
	}
	for _, code := range taxAccountOrder {
		if taxByAccount[code] != 0 {
			postingLines = append(postingLines, JournalEntryLineInput{AccountCode: code, CreditMinor: taxByAccount[code]})
		}
	}
	memo := fmt.Sprintf("Invoice %d", invoiceNumber)
	if currency != baseCurrency {
		memo += " (" + currency + ")"
	}
	entryID, err = postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: claims.OrganizationID, Memo: memo, SourceType: "invoice", SourceID: &invoiceID,
		Currency: currency, PostedAt: now, ActorType: claims.ActorType, ActorID: claims.ActorID, Lines: postingLines,
	})
	if err != nil {
		return out, err
	}
	return CreateInvoiceOutput{InvoiceID: invoiceID, InvoiceNumber: invoiceNumber, TotalMinor: totalMinor, EntryID: entryID, Currency: currency}, nil
}

func validInvoiceCurrency(currency string) bool {
	_, valid := currencyMinorUnits(currency)
	return valid
}

func currencyMinorUnits(currency string) (int64, bool) {
	upper := strings.ToUpper(currency)
	if len(upper) != 3 {
		return 0, false
	}
	for _, char := range upper {
		if char < 'A' || char > 'Z' {
			return 0, false
		}
	}
	switch upper {
	case "JPY", "KRW", "VND", "CLP", "ISK", "UGX":
		return 0, true
	case "BHD", "JOD", "KWD", "OMR", "TND", "IQD", "LYD":
		return 3, true
	default:
		return 2, true
	}
}

func parseFXRateDecimal(input string) (*fxRateSnapshot, error) {
	value := strings.TrimSpace(input)
	if !fxRateDecimalPattern.MatchString(value) {
		return nil, errors.New("invalid rate; use a positive decimal like 1.0875")
	}
	parts := strings.SplitN(value, ".", 2)
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	denominator := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(len(fraction))), nil)
	numerator, ok := new(big.Int).SetString(parts[0]+fraction, 10)
	if !ok || numerator.Sign() <= 0 {
		return nil, errors.New("invalid rate; use a positive decimal like 1.0875")
	}
	gcd := new(big.Int).GCD(nil, nil, numerator, denominator)
	numerator.Quo(numerator, gcd)
	denominator.Quo(denominator, gcd)
	if numerator.Cmp(big.NewInt(maxSafeInteger)) > 0 || denominator.Cmp(big.NewInt(maxSafeInteger)) > 0 {
		return nil, errors.New("FX rate exceeds the supported integer range")
	}
	return &fxRateSnapshot{Num: numerator.Int64(), Den: denominator.Int64()}, nil
}

func latestFXRate(ctx context.Context, tx pgx.Tx, orgID, base, quote string, at time.Time) (*fxRateSnapshot, error) {
	var rateNum int64
	var rateDen int64
	err := tx.QueryRow(ctx, `
		SELECT rate_num, rate_den FROM fx_rates
		WHERE org_id = $1::uuid AND base = $2 AND quote = $3 AND effective_at <= $4
		ORDER BY effective_at DESC LIMIT 1`, orgID, base, quote, at).Scan(&rateNum, &rateDen)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if rateNum <= 0 || rateDen <= 0 || rateNum > maxSafeInteger || rateDen > maxDatabaseInteger {
		return nil, errors.New("stored FX rate is outside the supported range")
	}
	return &fxRateSnapshot{Num: rateNum, Den: rateDen}, nil
}

func toBaseMinorExact(foreignMinor int64, rate fxRateSnapshot, quoteCurrency, baseCurrency string) (int64, error) {
	quoteUnits, quoteOK := currencyMinorUnits(quoteCurrency)
	baseUnits, baseOK := currencyMinorUnits(baseCurrency)
	if !quoteOK || !baseOK {
		return 0, errors.New("unknown currency code for FX conversion")
	}
	if foreignMinor < 0 || foreignMinor > maxSafeInteger || rate.Num <= 0 || rate.Den <= 0 || rate.Num > maxSafeInteger || rate.Den > maxSafeInteger {
		return 0, errors.New("amounts must be safe integers and FX rates must be positive safe integer ratios")
	}
	numerator := new(big.Int).Mul(big.NewInt(foreignMinor), big.NewInt(rate.Num))
	numerator.Mul(numerator, new(big.Int).Exp(big.NewInt(10), big.NewInt(baseUnits), nil))
	denominator := new(big.Int).Mul(big.NewInt(rate.Den), new(big.Int).Exp(big.NewInt(10), big.NewInt(quoteUnits), nil))
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, denominator, remainder)
	if new(big.Int).Mul(remainder, big.NewInt(2)).Cmp(denominator) >= 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	if quotient.Cmp(big.NewInt(maxSafeInteger)) > 0 {
		return 0, errors.New("FX result exceeds the supported amount range")
	}
	return quotient.Int64(), nil
}

func resolveInvoiceLines(ctx context.Context, tx pgx.Tx, orgID string, lines []CreateInvoiceLine) ([]invoiceResolvedLine, int64, int64, int64, error) {
	var jurisdiction string
	var hasTaxProfile bool
	if err := tx.QueryRow(ctx, `SELECT jurisdiction_code FROM tax_profiles WHERE org_id = $1::uuid LIMIT 1`, orgID).Scan(&jurisdiction); err == nil {
		hasTaxProfile = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, 0, 0, err
	}
	resolved := make([]invoiceResolvedLine, 0, len(lines))
	var subtotal, taxes, total big.Int
	for _, line := range lines {
		if line.Quantity > maxDatabaseInteger || line.UnitPriceMinor > maxDatabaseInteger || line.TaxMinor != nil && *line.TaxMinor > maxDatabaseInteger {
			return nil, 0, 0, 0, errors.New("invoice line amount exceeds the database integer range")
		}
		if line.TaxCodeID != nil {
			if !hasTaxProfile {
				return nil, 0, 0, 0, errors.New("set the organization tax jurisdiction before using tax codes")
			}
			var code taxCodeRow
			err := tx.QueryRow(ctx, `
				SELECT id::text, jurisdiction_code, direction, rate_basis_points, price_includes_tax, liability_account_code, active
				FROM tax_codes WHERE id = $1::uuid AND org_id = $2::uuid`, *line.TaxCodeID, orgID).Scan(&code.ID, &code.JurisdictionCode, &code.Direction, &code.RateBasisPoints, &code.PriceIncludesTax, &code.LiabilityAccountCode, &code.Active)
			if errors.Is(err, pgx.ErrNoRows) || err == nil && !code.Active {
				return nil, 0, 0, 0, errors.New("tax code not found or inactive")
			}
			if err != nil {
				return nil, 0, 0, 0, err
			}
			if code.JurisdictionCode != jurisdiction {
				return nil, 0, 0, 0, errors.New("tax code jurisdiction does not match the organization tax profile")
			}
			if code.Direction != "output" {
				return nil, 0, 0, 0, fmt.Errorf("tax code is configured for %s tax", code.Direction)
			}
			net, tax, gross, err := calculateInvoiceLine(line.Quantity, line.UnitPriceMinor, &code.RateBasisPoints, code.PriceIncludesTax, nil)
			if err != nil {
				return nil, 0, 0, 0, err
			}
			resolved = append(resolved, invoiceResolvedLine{input: line, netMinor: net, taxMinor: tax, grossMinor: gross, rateBasisPoints: &code.RateBasisPoints, priceIncludesTax: code.PriceIncludesTax, taxCodeID: line.TaxCodeID, taxLiabilityCode: code.LiabilityAccountCode})
		} else {
			net, tax, gross, err := calculateInvoiceLine(line.Quantity, line.UnitPriceMinor, nil, false, line.TaxMinor)
			if err != nil {
				return nil, 0, 0, 0, err
			}
			resolved = append(resolved, invoiceResolvedLine{input: line, netMinor: net, taxMinor: tax, grossMinor: gross, taxLiabilityCode: "2100"})
		}
		last := resolved[len(resolved)-1]
		if last.netMinor > maxDatabaseInteger || last.taxMinor > maxDatabaseInteger || last.grossMinor > maxDatabaseInteger {
			return nil, 0, 0, 0, errors.New("invoice line amount exceeds the database integer range")
		}
		subtotal.Add(&subtotal, big.NewInt(last.netMinor))
		taxes.Add(&taxes, big.NewInt(last.taxMinor))
		total.Add(&total, big.NewInt(last.grossMinor))
	}
	if subtotal.Cmp(big.NewInt(maxSafeInteger)) > 0 || taxes.Cmp(big.NewInt(maxSafeInteger)) > 0 || total.Cmp(big.NewInt(maxSafeInteger)) > 0 {
		return nil, 0, 0, 0, errors.New("document total exceeds the supported amount range")
	}
	return resolved, subtotal.Int64(), taxes.Int64(), total.Int64(), nil
}

func calculateInvoiceLine(quantity, unitPrice int64, rateBasisPoints *int64, priceIncludesTax bool, manualTax *int64) (int64, int64, int64, error) {
	if quantity <= 0 || quantity > maxSafeInteger {
		return 0, 0, 0, errors.New("quantity must be positive thousandths")
	}
	if unitPrice < 0 || unitPrice > maxSafeInteger {
		return 0, 0, 0, errors.New("unit price must be a non-negative safe integer")
	}
	product := new(big.Int).Mul(big.NewInt(quantity), big.NewInt(unitPrice))
	grossOrNet := roundedQuotient(product, big.NewInt(1000))
	if grossOrNet.Cmp(big.NewInt(maxSafeInteger)) > 0 {
		return 0, 0, 0, errors.New("line amount exceeds the supported amount range")
	}
	if rateBasisPoints == nil {
		tax := int64(0)
		if manualTax != nil {
			tax = *manualTax
		}
		if tax < 0 || tax > maxSafeInteger {
			return 0, 0, 0, errors.New("taxMinor must be a non-negative safe integer")
		}
		gross := grossOrNet.Int64() + tax
		if gross > maxSafeInteger {
			return 0, 0, 0, errors.New("line total exceeds the supported amount range")
		}
		return grossOrNet.Int64(), tax, gross, nil
	}
	if *rateBasisPoints < 0 {
		return 0, 0, 0, errors.New("tax rate must be non-negative basis points")
	}
	if priceIncludesTax {
		denominator := big.NewInt(10_000 + *rateBasisPoints)
		numerator := new(big.Int).Mul(grossOrNet, big.NewInt(20_000))
		numerator.Add(numerator, denominator)
		net := numerator.Quo(numerator, new(big.Int).Mul(denominator, big.NewInt(2)))
		if net.Cmp(big.NewInt(maxSafeInteger)) > 0 {
			return 0, 0, 0, errors.New("line amount exceeds the supported amount range")
		}
		tax := new(big.Int).Sub(grossOrNet, net)
		return net.Int64(), tax.Int64(), grossOrNet.Int64(), nil
	}
	numerator := new(big.Int).Mul(grossOrNet, big.NewInt(*rateBasisPoints))
	numerator.Add(numerator, big.NewInt(5_000))
	tax := numerator.Quo(numerator, big.NewInt(10_000))
	if tax.Cmp(big.NewInt(maxSafeInteger)) > 0 {
		return 0, 0, 0, errors.New("tax amount exceeds the supported amount range")
	}
	gross := new(big.Int).Add(grossOrNet, tax)
	if gross.Cmp(big.NewInt(maxSafeInteger)) > 0 {
		return 0, 0, 0, errors.New("line total exceeds the supported amount range")
	}
	return grossOrNet.Int64(), tax.Int64(), gross.Int64(), nil
}

func roundedQuotient(numerator, denominator *big.Int) *big.Int {
	adjusted := new(big.Int).Add(new(big.Int).Set(numerator), new(big.Int).Quo(new(big.Int).Set(denominator), big.NewInt(2)))
	return adjusted.Quo(adjusted, denominator)
}

func lockAccountingPeriod(ctx context.Context, tx pgx.Tx, orgID string, at time.Time) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, int64(7_362_911), orgID); err != nil {
		return fmt.Errorf("lock accounting period: %w", err)
	}
	var closed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM periods WHERE org_id = $1::uuid AND year = $2 AND month = $3)`, orgID, at.UTC().Year(), int(at.UTC().Month())).Scan(&closed); err != nil {
		return err
	}
	if closed {
		return fmt.Errorf("period %d-%02d is closed; post to the current period or reopen it", at.UTC().Year(), int(at.UTC().Month()))
	}
	return nil
}

func nextInvoiceNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		SELECT $1::uuid, 'invoice', COALESCE(MAX(number), 0) + 1 FROM invoices WHERE org_id = $1::uuid
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate invoice number: %w", err)
	}
	if number <= 0 || number > maxDatabaseInteger {
		return 0, errors.New("invoice number exceeds the database integer range")
	}
	return number, nil
}

type JournalEntryLineInput struct {
	AccountCode string
	DebitMinor  int64
	CreditMinor int64
}

type PostJournalEntryInput struct {
	OrgID        string
	Memo         string
	SourceType   string
	SourceID     *string
	ReversalOfID *string
	Currency     string
	EntryKind    string
	BusinessAt   *time.Time
	PostedAt     time.Time
	ActorType    string
	ActorID      *string
	Lines        []JournalEntryLineInput
}

// postJournalEntry is the shared append-only posting door for accounting
// capabilities. It serializes against period close, checks balance and active
// org-owned accounts, and inserts entry and lines atomically in the caller's
// transaction.
func postJournalEntry(ctx context.Context, tx pgx.Tx, input PostJournalEntryInput) (string, error) {
	if tx == nil {
		return "", errors.New("journal transaction is required")
	}
	if input.OrgID == "" || input.ActorType == "" || strings.TrimSpace(input.Memo) == "" || strings.TrimSpace(input.SourceType) == "" || len(input.Lines) < 2 {
		return "", errors.New("journal entry requires organization, actor, memo, source, and at least two lines")
	}
	if input.PostedAt.IsZero() {
		return "", errors.New("journal entry postedAt is required")
	}
	if input.EntryKind == "" {
		input.EntryKind = "operational"
	}
	switch input.EntryKind {
	case "operational", "year_end_close", "correction":
	default:
		return "", errors.New("journal entry kind is invalid")
	}
	if err := lockAccountingPeriod(ctx, tx, input.OrgID, input.PostedAt); err != nil {
		return "", err
	}
	if input.ReversalOfID != nil {
		var originalExists, alreadyReversed bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid),
			       EXISTS (SELECT 1 FROM journal_entries WHERE reversal_of_id = $1::uuid AND org_id = $2::uuid)`,
			*input.ReversalOfID, input.OrgID).Scan(&originalExists, &alreadyReversed); err != nil {
			return "", err
		}
		if !originalExists {
			return "", errors.New("journal entry to reverse was not found")
		}
		if alreadyReversed {
			return "", errors.New("journal entry has already been reversed")
		}
	}
	var debits, credits big.Int
	codes := make([]string, 0, len(input.Lines))
	seen := make(map[string]struct{}, len(input.Lines))
	for _, line := range input.Lines {
		if line.AccountCode == "" || line.DebitMinor < 0 || line.CreditMinor < 0 || line.DebitMinor != 0 && line.CreditMinor != 0 || line.DebitMinor == 0 && line.CreditMinor == 0 {
			return "", errors.New("journal posting line is invalid")
		}
		if line.DebitMinor > maxDatabaseInteger || line.CreditMinor > maxDatabaseInteger {
			return "", errors.New("journal posting amount exceeds the database integer range")
		}
		debits.Add(&debits, big.NewInt(line.DebitMinor))
		credits.Add(&credits, big.NewInt(line.CreditMinor))
		if _, ok := seen[line.AccountCode]; !ok {
			seen[line.AccountCode] = struct{}{}
			codes = append(codes, line.AccountCode)
		}
	}
	if debits.Sign() <= 0 || debits.Cmp(&credits) != 0 {
		return "", errors.New("journal entry is not balanced")
	}
	accountIDs := make(map[string]string, len(codes))
	rows, err := tx.Query(ctx, `SELECT id::text, code, archived_at IS NOT NULL FROM accounts WHERE org_id = $1::uuid AND code = ANY($2::text[])`, input.OrgID, codes)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var id, code string
		var archived bool
		if err := rows.Scan(&id, &code, &archived); err != nil {
			rows.Close()
			return "", err
		}
		if archived {
			rows.Close()
			return "", fmt.Errorf("account %s is archived; reopen it before posting", code)
		}
		accountIDs[code] = id
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return "", err
	}
	rows.Close()
	for _, code := range codes {
		if accountIDs[code] == "" {
			return "", fmt.Errorf("account %s does not belong to this organization or does not exist", code)
		}
	}
	var entryID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO journal_entries (org_id, memo, source_type, source_id, reversal_of_id, currency, entry_kind, business_at, posted_at, posted_by_actor_type, posted_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11::uuid)
		RETURNING id::text`, input.OrgID, input.Memo, input.SourceType, input.SourceID, input.ReversalOfID, input.Currency, input.EntryKind, input.BusinessAt, input.PostedAt, input.ActorType, input.ActorID).Scan(&entryID); err != nil {
		return "", err
	}
	for _, line := range input.Lines {
		if _, err := tx.Exec(ctx, `INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor) VALUES ($1::uuid, $2::uuid, $3, $4)`, entryID, accountIDs[line.AccountCode], line.DebitMinor, line.CreditMinor); err != nil {
			return "", err
		}
	}
	return entryID, nil
}

func trialBalance(ctx context.Context, tx pgx.Tx, input TrialBalanceInput) (TrialBalanceOutput, error) {
	_ = input
	if tx == nil {
		return TrialBalanceOutput{}, errors.New("trial balance transaction is required")
	}
	rows, err := tx.Query(ctx, `
		SELECT a.code, a.name, je.currency,
		       COALESCE(SUM(jl.debit_minor), 0)::numeric::text,
		       COALESCE(SUM(jl.credit_minor), 0)::numeric::text
		FROM accounts a
		JOIN journal_lines jl ON jl.account_id = a.id
		JOIN journal_entries je ON je.id = jl.entry_id
		WHERE a.org_id = current_setting('app.org_id')::uuid
		  AND je.org_id = current_setting('app.org_id')::uuid
		GROUP BY a.code, a.name, je.currency
		ORDER BY a.code, je.currency`)
	if err != nil {
		return TrialBalanceOutput{}, err
	}
	defer rows.Close()
	output := TrialBalanceOutput{Lines: make([]TrialBalanceLine, 0), Balanced: true}
	type currencyTotals struct{ debit, credit big.Int }
	totals := make(map[string]*currencyTotals)
	for rows.Next() {
		var line TrialBalanceLine
		var debitText, creditText string
		if err := rows.Scan(&line.Code, &line.Name, &line.Currency, &debitText, &creditText); err != nil {
			return TrialBalanceOutput{}, err
		}
		debit, ok := new(big.Int).SetString(debitText, 10)
		if !ok || debit.Sign() < 0 || debit.Cmp(big.NewInt(maxSafeInteger)) > 0 {
			return TrialBalanceOutput{}, errors.New("trial balance exceeds the supported amount range")
		}
		credit, ok := new(big.Int).SetString(creditText, 10)
		if !ok || credit.Sign() < 0 || credit.Cmp(big.NewInt(maxSafeInteger)) > 0 {
			return TrialBalanceOutput{}, errors.New("trial balance exceeds the supported amount range")
		}
		line.DebitMinor = debit.Int64()
		line.CreditMinor = credit.Int64()
		output.Lines = append(output.Lines, line)
		currencyTotal := totals[line.Currency]
		if currencyTotal == nil {
			currencyTotal = &currencyTotals{}
			totals[line.Currency] = currencyTotal
		}
		currencyTotal.debit.Add(&currencyTotal.debit, debit)
		currencyTotal.credit.Add(&currencyTotal.credit, credit)
	}
	if err := rows.Err(); err != nil {
		return TrialBalanceOutput{}, err
	}
	for _, currencyTotal := range totals {
		if currencyTotal.debit.Cmp(&currencyTotal.credit) != 0 {
			output.Balanced = false
			break
		}
	}
	return output, nil
}
