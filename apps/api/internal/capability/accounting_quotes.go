package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createQuoteCapabilityID  = "accounting.createQuote"
	acceptQuoteCapabilityID  = "accounting.acceptQuote"
	declineQuoteCapabilityID = "accounting.declineQuote"
	expireQuoteCapabilityID  = "accounting.expireQuote"
	listQuotesCapabilityID   = "accounting.listQuotes"
)

type CreateQuoteInput struct {
	CustomerID string              `json:"customerId"`
	Memo       *string             `json:"memo,omitempty"`
	ExpiresAt  *string             `json:"expiresAt,omitempty"`
	Lines      []CreateInvoiceLine `json:"lines"`
}

type CreateQuoteOutput struct {
	QuoteID     string `json:"quoteId"`
	QuoteNumber int64  `json:"quoteNumber"`
	TotalMinor  int64  `json:"totalMinor"`
}

type AcceptQuoteInput struct {
	QuoteID string `json:"quoteId"`
}

type AcceptQuoteOutput struct {
	InvoiceID     string `json:"invoiceId"`
	InvoiceNumber int64  `json:"invoiceNumber"`
	TotalMinor    int64  `json:"totalMinor"`
}

type DeclineQuoteInput struct {
	QuoteID string `json:"quoteId"`
}

type DeclineQuoteOutput struct {
	Status string `json:"status"`
}

type ExpireQuoteInput struct{}

type ExpireQuoteOutput struct {
	ExpiredCount int64 `json:"expiredCount"`
}

type ListQuotesInput struct {
	Status *string `json:"status,omitempty"`
}

type ListQuoteSummary struct {
	ID         string  `json:"id"`
	Number     int64   `json:"number"`
	Status     string  `json:"status"`
	TotalMinor int64   `json:"totalMinor"`
	CustomerID string  `json:"customerId"`
	CreatedAt  *string `json:"createdAt"`
	ExpiresAt  *string `json:"expiresAt"`
	InvoiceID  *string `json:"invoiceId"`
}

type ListQuotesOutput struct {
	Quotes []ListQuoteSummary `json:"quotes"`
}

var quoteListStatuses = map[string]struct{}{
	"draft": {}, "sent": {}, "accepted": {}, "declined": {}, "expired": {},
}

func ParseCreateQuoteInput(raw json.RawMessage) (CreateQuoteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateQuoteInput{}, err
	}
	var input CreateQuoteInput
	input.CustomerID, err = requiredString(fields, "customerId")
	if err != nil {
		return CreateQuoteInput{}, err
	}
	if input.Memo, err = optionalString(fields, "memo"); err != nil {
		return CreateQuoteInput{}, err
	}
	if input.ExpiresAt, err = crmTaskOptionalDateTime(fields, "expiresAt"); err != nil {
		return CreateQuoteInput{}, err
	}
	if input.Lines, err = parseCreateQuoteLines(fields); err != nil {
		return CreateQuoteInput{}, err
	}
	return input, nil
}

func parseCreateQuoteLines(fields map[string]json.RawMessage) ([]CreateInvoiceLine, error) {
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return nil, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) == 0 {
		return nil, errors.New("lines must contain at least one line")
	}
	lines := make([]CreateInvoiceLine, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return nil, errors.New("each quote line must be an object")
		}
		var line CreateInvoiceLine
		line.Description, err = requiredString(lineFields, "description")
		if err != nil || utf16Length(line.Description) < 1 {
			return nil, errors.New("line description must contain at least one character")
		}
		line.Quantity, err = requiredSafeInteger(lineFields, "quantity")
		if err != nil || line.Quantity <= 0 {
			return nil, errors.New("quantity must be a positive integer")
		}
		line.UnitPriceMinor, err = requiredSafeInteger(lineFields, "unitPriceMinor")
		if err != nil || line.UnitPriceMinor < 0 {
			return nil, errors.New("unitPriceMinor must be a non-negative integer")
		}
		if line.TaxMinor, err = optionalSafeInteger(lineFields, "taxMinor"); err != nil || line.TaxMinor != nil && *line.TaxMinor < 0 {
			return nil, errors.New("taxMinor must be a non-negative integer")
		}
		if line.TaxCodeID, err = optionalString(lineFields, "taxCodeId"); err != nil {
			return nil, errors.New("taxCodeId must be a UUID")
		} else if line.TaxCodeID != nil && !isZodUUID(*line.TaxCodeID) {
			return nil, errors.New("taxCodeId must be a UUID")
		}
		if line.TaxCodeID != nil && line.TaxMinor != nil {
			return nil, errors.New("use a configured tax code or a manual tax amount, not both")
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func ParseAcceptQuoteInput(raw json.RawMessage) (AcceptQuoteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AcceptQuoteInput{}, err
	}
	quoteID, err := requiredString(fields, "quoteId")
	if err != nil {
		return AcceptQuoteInput{}, err
	}
	if !isZodUUID(quoteID) {
		return AcceptQuoteInput{}, errors.New("quoteId must be a UUID")
	}
	return AcceptQuoteInput{QuoteID: quoteID}, nil
}

func ParseDeclineQuoteInput(raw json.RawMessage) (DeclineQuoteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DeclineQuoteInput{}, err
	}
	quoteID, err := requiredString(fields, "quoteId")
	if err != nil {
		return DeclineQuoteInput{}, err
	}
	if !isZodUUID(quoteID) {
		return DeclineQuoteInput{}, errors.New("quoteId must be a UUID")
	}
	return DeclineQuoteInput{QuoteID: quoteID}, nil
}

func ParseExpireQuoteInput(raw json.RawMessage) (ExpireQuoteInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ExpireQuoteInput{}, err
	}
	return ExpireQuoteInput{}, nil
}

func ParseListQuotesInput(raw json.RawMessage) (ListQuotesInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListQuotesInput{}, err
	}
	input := ListQuotesInput{}
	if rawStatus, ok := fields["status"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawStatus), []byte("null")) {
			return ListQuotesInput{}, errors.New("status is invalid")
		}
		var status string
		if err := json.Unmarshal(rawStatus, &status); err != nil {
			return ListQuotesInput{}, errors.New("status is invalid")
		}
		if _, valid := quoteListStatuses[status]; !valid {
			return ListQuotesInput{}, errors.New("status is invalid")
		}
		input.Status = &status
	}
	return input, nil
}

// computeQuoteTotals mirrors erp-core computeInvoiceTotals, which the
// TypeScript createQuote applies with taxMinor defaulted to zero.
func computeQuoteTotals(lines []CreateInvoiceLine) (int64, int64, int64, error) {
	var subtotal, tax big.Int
	for _, line := range lines {
		if line.Quantity <= 0 || line.Quantity > maxSafeInteger {
			return 0, 0, 0, errors.New("invalid quantity")
		}
		if line.UnitPriceMinor < 0 || line.UnitPriceMinor > maxSafeInteger {
			return 0, 0, 0, errors.New("invalid unit price")
		}
		taxMinor := int64(0)
		if line.TaxMinor != nil {
			taxMinor = *line.TaxMinor
		}
		if taxMinor < 0 || taxMinor > maxSafeInteger {
			return 0, 0, 0, errors.New("invalid tax")
		}
		numerator := new(big.Int).Mul(big.NewInt(line.Quantity), big.NewInt(line.UnitPriceMinor))
		numerator.Add(numerator, big.NewInt(500))
		subtotal.Add(&subtotal, numerator.Quo(numerator, big.NewInt(1000)))
		tax.Add(&tax, big.NewInt(taxMinor))
	}
	total := new(big.Int).Add(&subtotal, &tax)
	if total.Sign() <= 0 {
		return 0, 0, 0, errors.New("invoice must have a non-zero total")
	}
	safeMax := big.NewInt(maxSafeInteger)
	if subtotal.Cmp(safeMax) > 0 || tax.Cmp(safeMax) > 0 || total.Cmp(safeMax) > 0 {
		return 0, 0, 0, errors.New("invoice total exceeds the supported amount range")
	}
	return subtotal.Int64(), tax.Int64(), total.Int64(), nil
}

func nextQuoteNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		SELECT $1::uuid, 'quote', COALESCE(MAX(number), 0) + 1 FROM quotes WHERE org_id = $1::uuid
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate quote number: %w", err)
	}
	if number <= 0 || number > maxDatabaseInteger {
		return 0, errors.New("quote number exceeds the database integer range")
	}
	return number, nil
}

func createQuote(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateQuoteInput) (CreateQuoteOutput, error) {
	var customerExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1::uuid AND org_id = $2::uuid)`,
		input.CustomerID, claims.OrganizationID).Scan(&customerExists); err != nil {
		return CreateQuoteOutput{}, err
	}
	if !customerExists {
		return CreateQuoteOutput{}, errors.New("customer not found")
	}
	subtotalMinor, taxMinor, totalMinor, err := computeQuoteTotals(input.Lines)
	if err != nil {
		return CreateQuoteOutput{}, err
	}
	number, err := nextQuoteNumber(ctx, tx, claims.OrganizationID)
	if err != nil {
		return CreateQuoteOutput{}, err
	}
	expiresAt, err := projectDateTimeValue(input.ExpiresAt)
	if err != nil {
		return CreateQuoteOutput{}, err
	}
	var quoteID string
	err = tx.QueryRow(ctx, `
		INSERT INTO quotes (
			org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor,
			memo, expires_at, created_by_actor_type, created_by_actor_id
		)
		VALUES ($1::uuid, $2::uuid, $3, 'sent', $4, $5, $6, $7, $8, $9, $10::uuid)
		RETURNING id::text`,
		claims.OrganizationID, input.CustomerID, number, subtotalMinor, taxMinor, totalMinor,
		input.Memo, expiresAt, claims.ActorType, claims.ActorID).Scan(&quoteID)
	if err != nil {
		return CreateQuoteOutput{}, err
	}
	for _, line := range input.Lines {
		taxMinor := int64(0)
		if line.TaxMinor != nil {
			taxMinor = *line.TaxMinor
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO quote_lines (quote_id, description, quantity, unit_price_minor, tax_minor)
			VALUES ($1::uuid, $2, $3, $4, $5)`,
			quoteID, line.Description, line.Quantity, line.UnitPriceMinor, taxMinor); err != nil {
			return CreateQuoteOutput{}, err
		}
	}
	return CreateQuoteOutput{QuoteID: quoteID, QuoteNumber: number, TotalMinor: totalMinor}, nil
}

func acceptQuote(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input AcceptQuoteInput, now time.Time) (AcceptQuoteOutput, error) {
	var customerID, status string
	var memo *string
	var expiresAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT customer_id::text, status, memo, expires_at
		FROM quotes
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.QuoteID, claims.OrganizationID).Scan(&customerID, &status, &memo, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptQuoteOutput{}, errors.New("quote not found")
	}
	if err != nil {
		return AcceptQuoteOutput{}, err
	}
	if status != "sent" {
		return AcceptQuoteOutput{}, fmt.Errorf("quote is %s; only sent quotes convert", status)
	}
	if expiresAt != nil && !expiresAt.After(now) {
		return AcceptQuoteOutput{}, fmt.Errorf("quote expired on %s; decline it and issue a fresh quote", expiresAt.UTC().Format("2006-01-02"))
	}
	rows, err := tx.Query(ctx, `
		SELECT description, quantity, unit_price_minor, tax_minor
		FROM quote_lines
		WHERE quote_id = $1::uuid
		ORDER BY id`, input.QuoteID)
	if err != nil {
		return AcceptQuoteOutput{}, err
	}
	lines := make([]CreateInvoiceLine, 0)
	for rows.Next() {
		var line CreateInvoiceLine
		var taxMinor int64
		if err := rows.Scan(&line.Description, &line.Quantity, &line.UnitPriceMinor, &taxMinor); err != nil {
			rows.Close()
			return AcceptQuoteOutput{}, err
		}
		line.TaxMinor = &taxMinor
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return AcceptQuoteOutput{}, err
	}
	rows.Close()
	var claimedID string
	err = tx.QueryRow(ctx, `
		UPDATE quotes SET status = 'accepted', decided_at = $3
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'sent'
		RETURNING id::text`, input.QuoteID, claims.OrganizationID, now).Scan(&claimedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptQuoteOutput{}, errors.New("quote was just decided by someone else")
	}
	if err != nil {
		return AcceptQuoteOutput{}, err
	}
	created, err := createInvoice(ctx, tx, claims, CreateInvoiceInput{CustomerID: customerID, Memo: memo, Lines: lines}, now)
	if err != nil {
		return AcceptQuoteOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE quotes SET converted_invoice_id = $2::uuid WHERE id = $1::uuid`, input.QuoteID, created.InvoiceID); err != nil {
		return AcceptQuoteOutput{}, err
	}
	return AcceptQuoteOutput{InvoiceID: created.InvoiceID, InvoiceNumber: created.InvoiceNumber, TotalMinor: created.TotalMinor}, nil
}

func declineQuote(ctx context.Context, tx pgx.Tx, orgID string, input DeclineQuoteInput, now time.Time) (DeclineQuoteOutput, error) {
	var quoteID string
	err := tx.QueryRow(ctx, `
		UPDATE quotes SET status = 'declined', decided_at = $3
		WHERE id = $1::uuid AND org_id = $2::uuid AND status IN ('draft', 'sent')
		RETURNING id::text`, input.QuoteID, orgID, now).Scan(&quoteID)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeclineQuoteOutput{}, errors.New("quote not found or already decided")
	}
	if err != nil {
		return DeclineQuoteOutput{}, err
	}
	return DeclineQuoteOutput{Status: "declined"}, nil
}

func expireQuote(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) (ExpireQuoteOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE quotes SET status = 'expired', decided_at = $2
		WHERE org_id = $1::uuid AND status = 'sent' AND expires_at < $2`, orgID, now)
	if err != nil {
		return ExpireQuoteOutput{}, err
	}
	return ExpireQuoteOutput{ExpiredCount: tag.RowsAffected()}, nil
}

func listQuotes(ctx context.Context, tx pgx.Tx, orgID string, input ListQuotesInput) (ListQuotesOutput, error) {
	query := `
		SELECT id::text, number, status, total_minor, customer_id::text, created_at, expires_at, converted_invoice_id::text
		FROM quotes
		WHERE org_id = $1::uuid`
	args := []any{orgID}
	if input.Status != nil {
		query += ` AND status = $2`
		args = append(args, *input.Status)
	}
	query += ` ORDER BY created_at DESC LIMIT 100`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return ListQuotesOutput{}, err
	}
	defer rows.Close()
	quotes := make([]ListQuoteSummary, 0)
	for rows.Next() {
		var quote ListQuoteSummary
		var createdAt, expiresAt *time.Time
		if err := rows.Scan(&quote.ID, &quote.Number, &quote.Status, &quote.TotalMinor, &quote.CustomerID, &createdAt, &expiresAt, &quote.InvoiceID); err != nil {
			return ListQuotesOutput{}, err
		}
		quote.CreatedAt = crmISOTime(createdAt)
		quote.ExpiresAt = crmISOTime(expiresAt)
		quotes = append(quotes, quote)
	}
	if err := rows.Err(); err != nil {
		return ListQuotesOutput{}, err
	}
	return ListQuotesOutput{Quotes: quotes}, nil
}

func parseAccountingQuoteInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createQuoteCapabilityID:
		return ParseCreateQuoteInput(raw)
	case acceptQuoteCapabilityID:
		return ParseAcceptQuoteInput(raw)
	case declineQuoteCapabilityID:
		return ParseDeclineQuoteInput(raw)
	case expireQuoteCapabilityID:
		return ParseExpireQuoteInput(raw)
	case listQuotesCapabilityID:
		return ParseListQuotesInput(raw)
	default:
		return nil, errors.New("unsupported accounting quote capability")
	}
}
