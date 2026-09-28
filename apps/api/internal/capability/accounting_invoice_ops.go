package capability

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	creditNoteCapabilityID          = "accounting.creditNote"
	shareInvoiceCapabilityID        = "accounting.shareInvoice"
	generateDueInvoicesCapabilityID = "accounting.generateDueInvoices"
	reverseEntryCapabilityID        = "accounting.reverseEntry"
)

type CreditNoteInput struct {
	InvoiceID   string `json:"invoiceId"`
	AmountMinor int64  `json:"amountMinor"`
	Reason      string `json:"reason"`
}

type CreditNoteOutput struct {
	EntryID             string `json:"entryId"`
	CreditedMinor       int64  `json:"creditedMinor"`
	InvoiceBalanceMinor int64  `json:"invoiceBalanceMinor"`
}

type ShareInvoiceInput struct {
	InvoiceNumber int64   `json:"invoiceNumber"`
	Revoke        bool    `json:"revoke"`
	Token         *string `json:"token,omitempty"`
}

// ShareInvoiceOutput mirrors the TypeScript union: a created link carries
// token and urlPath, a revoke carries only revoked.
type ShareInvoiceOutput struct {
	Token   *string `json:"token,omitempty"`
	URLPath *string `json:"urlPath,omitempty"`
	Revoked *bool   `json:"revoked,omitempty"`
}

type GenerateDueInvoicesInput struct{}

type GenerateDueInvoicesOutput struct {
	Generated int `json:"generated"`
}

type ReverseEntryInput struct {
	EntryID string `json:"entryId"`
}

type ReverseEntryOutput struct {
	ReversalEntryID string `json:"reversalEntryId"`
}

func parseAccountingInvoiceOpsInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case creditNoteCapabilityID:
		return ParseCreditNoteInput(raw)
	case shareInvoiceCapabilityID:
		return ParseShareInvoiceInput(raw)
	case generateDueInvoicesCapabilityID:
		return ParseGenerateDueInvoicesInput(raw)
	case reverseEntryCapabilityID:
		return ParseReverseEntryInput(raw)
	default:
		return nil, errors.New("unsupported accounting invoice ops capability")
	}
}

func ParseCreditNoteInput(raw json.RawMessage) (CreditNoteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreditNoteInput{}, err
	}
	var input CreditNoteInput
	if input.InvoiceID, err = requiredString(fields, "invoiceId"); err != nil {
		return CreditNoteInput{}, err
	}
	if !isZodUUID(input.InvoiceID) {
		return CreditNoteInput{}, errors.New("invoiceId must be a UUID")
	}
	input.AmountMinor, err = requiredSafeInteger(fields, "amountMinor")
	if err != nil || input.AmountMinor <= 0 {
		return CreditNoteInput{}, errors.New("amountMinor must be a positive integer")
	}
	if input.Reason, err = requiredString(fields, "reason"); err != nil {
		return CreditNoteInput{}, err
	}
	if length := utf16Length(input.Reason); length < 3 || length > 500 {
		return CreditNoteInput{}, errors.New("reason must contain between 3 and 500 characters")
	}
	return input, nil
}

func ParseShareInvoiceInput(raw json.RawMessage) (ShareInvoiceInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ShareInvoiceInput{}, err
	}
	var input ShareInvoiceInput
	input.InvoiceNumber, err = requiredSafeInteger(fields, "invoiceNumber")
	if err != nil || input.InvoiceNumber <= 0 {
		return ShareInvoiceInput{}, errors.New("invoiceNumber must be a positive integer")
	}
	if input.Revoke, err = invoiceOpsOptionalBool(fields, "revoke"); err != nil {
		return ShareInvoiceInput{}, err
	}
	if input.Token, err = optionalString(fields, "token"); err != nil {
		return ShareInvoiceInput{}, err
	}
	return input, nil
}

func invoiceOpsOptionalBool(fields map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := fields[key]
	if !ok {
		return false, nil
	}
	if bytesIsNull(raw) {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return value, nil
}

func ParseGenerateDueInvoicesInput(raw json.RawMessage) (GenerateDueInvoicesInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return GenerateDueInvoicesInput{}, err
	}
	return GenerateDueInvoicesInput{}, nil
}

func ParseReverseEntryInput(raw json.RawMessage) (ReverseEntryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReverseEntryInput{}, err
	}
	var input ReverseEntryInput
	if input.EntryID, err = requiredString(fields, "entryId"); err != nil {
		return ReverseEntryInput{}, err
	}
	return input, nil
}

// creditNoteRevenueShare mirrors the TypeScript BigInt split: the revenue leg
// takes amount * (total - tax) / total rounded half up, and the tax leg takes
// the remainder so the mirror always sums to the credited amount.
func creditNoteRevenueShare(amountMinor, totalMinor, taxMinor int64) int64 {
	numerator := new(big.Int).Mul(big.NewInt(amountMinor), big.NewInt(totalMinor-taxMinor))
	numerator.Add(numerator, new(big.Int).Quo(big.NewInt(totalMinor), big.NewInt(2)))
	return new(big.Int).Quo(numerator, big.NewInt(totalMinor)).Int64()
}

func executeCreditNote(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreditNoteInput, now time.Time) (CreditNoteOutput, error) {
	orgID := claims.OrganizationID
	var invoice struct {
		ID            string
		Number        int64
		Status        string
		Currency      string
		TotalMinor    int64
		PaidMinor     int64
		CreditedMinor int64
		TaxMinor      int64
	}
	err := tx.QueryRow(ctx, `
		SELECT id::text, number, status, currency, total_minor, paid_minor, credited_minor, tax_minor
		FROM invoices
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.InvoiceID, orgID).
		Scan(&invoice.ID, &invoice.Number, &invoice.Status, &invoice.Currency, &invoice.TotalMinor, &invoice.PaidMinor, &invoice.CreditedMinor, &invoice.TaxMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreditNoteOutput{}, errors.New("invoice not found")
	}
	if err != nil {
		return CreditNoteOutput{}, err
	}
	if invoice.Status == "void" {
		return CreditNoteOutput{}, errors.New("invoice is void; nothing to credit")
	}
	balance := invoice.TotalMinor - invoice.PaidMinor - invoice.CreditedMinor
	if input.AmountMinor > balance {
		return CreditNoteOutput{}, fmt.Errorf("credit %d exceeds the open balance %d (total %d - paid %d - credited %d)",
			input.AmountMinor, balance, invoice.TotalMinor, invoice.PaidMinor, invoice.CreditedMinor)
	}
	if invoice.TotalMinor <= 0 {
		return CreditNoteOutput{}, errors.New("invoice total must be positive to compute a credit note split")
	}
	revenueShare := creditNoteRevenueShare(input.AmountMinor, invoice.TotalMinor, invoice.TaxMinor)
	taxShare := input.AmountMinor - revenueShare
	lines := make([]JournalEntryLineInput, 0, 3)
	if revenueShare > 0 {
		lines = append(lines, JournalEntryLineInput{AccountCode: "4000", DebitMinor: revenueShare})
	}
	if taxShare > 0 {
		lines = append(lines, JournalEntryLineInput{AccountCode: "2100", DebitMinor: taxShare})
	}
	lines = append(lines, JournalEntryLineInput{AccountCode: "1100", CreditMinor: input.AmountMinor})

	var originalEntryID *string
	var originalEntryReversed bool
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM journal_entries
		WHERE org_id = $1::uuid AND source_type = 'invoice' AND source_id = $2::uuid
		LIMIT 1`, orgID, invoice.ID).Scan(&originalEntryID)
	if errors.Is(err, pgx.ErrNoRows) {
		originalEntryID = nil
	} else if err != nil {
		return CreditNoteOutput{}, err
	}
	if originalEntryID != nil {
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM journal_entries WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid)`,
			orgID, *originalEntryID).Scan(&originalEntryReversed); err != nil {
			return CreditNoteOutput{}, err
		}
	}
	var reversalOfID *string
	if originalEntryID != nil && !originalEntryReversed {
		reversalOfID = originalEntryID
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:        orgID,
		Memo:         fmt.Sprintf("Credit note on invoice %d: %s", invoice.Number, input.Reason),
		SourceType:   "invoice_credit_note",
		SourceID:     &invoice.ID,
		ReversalOfID: reversalOfID,
		Currency:     invoice.Currency,
		PostedAt:     now,
		ActorType:    claims.ActorType,
		ActorID:      claims.ActorID,
		Lines:        lines,
	})
	if err != nil {
		return CreditNoteOutput{}, err
	}
	credited := invoice.CreditedMinor + input.AmountMinor
	if _, err := tx.Exec(ctx, `
		UPDATE invoices SET credited_minor = $2
		WHERE id = $1::uuid AND org_id = $3::uuid`, invoice.ID, credited, orgID); err != nil {
		return CreditNoteOutput{}, err
	}
	return CreditNoteOutput{
		EntryID:             entryID,
		CreditedMinor:       credited,
		InvoiceBalanceMinor: invoice.TotalMinor - invoice.PaidMinor - credited,
	}, nil
}

func executeShareInvoice(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ShareInvoiceInput, now time.Time) (ShareInvoiceOutput, error) {
	orgID := claims.OrganizationID
	if input.Revoke {
		if input.Token == nil || *input.Token == "" {
			return ShareInvoiceOutput{}, errors.New("revoke requires the token to revoke")
		}
		if _, err := tx.Exec(ctx, `
			UPDATE invoice_shares SET revoked_at = $2
			WHERE token = $1 AND org_id = $3::uuid`, *input.Token, now, orgID); err != nil {
			return ShareInvoiceOutput{}, err
		}
		revoked := true
		return ShareInvoiceOutput{Revoked: &revoked}, nil
	}
	var invoiceID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM invoices
		WHERE org_id = $1::uuid AND number = $2
		LIMIT 1`, orgID, input.InvoiceNumber).Scan(&invoiceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ShareInvoiceOutput{}, errors.New("invoice not found")
	}
	if err != nil {
		return ShareInvoiceOutput{}, err
	}
	tokenBytes := make([]byte, 24)
	if _, err := cryptorand.Read(tokenBytes); err != nil {
		return ShareInvoiceOutput{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	if _, err := tx.Exec(ctx, `
		INSERT INTO invoice_shares (org_id, invoice_id, token, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)`,
		orgID, invoiceID, token, claims.ActorType, claims.ActorID); err != nil {
		return ShareInvoiceOutput{}, err
	}
	urlPath := "/portal/" + token
	return ShareInvoiceOutput{Token: &token, URLPath: &urlPath}, nil
}

type invoiceOpsDueTemplate struct {
	id         string
	customerID string
	memo       *string
	frequency  string
	lines      json.RawMessage
	scheduled  time.Time
}

func executeGenerateDueInvoices(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input GenerateDueInvoicesInput, now time.Time) (GenerateDueInvoicesOutput, error) {
	orgID := claims.OrganizationID
	rows, err := tx.Query(ctx, `
		SELECT id::text, customer_id::text, memo, frequency, lines, next_run_at
		FROM recurring_invoices
		WHERE org_id = $1::uuid AND active = true AND next_run_at <= $2
		ORDER BY next_run_at, id
		FOR UPDATE SKIP LOCKED`, orgID, now)
	if err != nil {
		return GenerateDueInvoicesOutput{}, err
	}
	due := make([]invoiceOpsDueTemplate, 0)
	for rows.Next() {
		var template invoiceOpsDueTemplate
		if err := rows.Scan(&template.id, &template.customerID, &template.memo, &template.frequency, &template.lines, &template.scheduled); err != nil {
			rows.Close()
			return GenerateDueInvoicesOutput{}, err
		}
		due = append(due, template)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return GenerateDueInvoicesOutput{}, err
	}
	rows.Close()

	generated := 0
	for _, template := range due {
		var runID string
		err := tx.QueryRow(ctx, `
			INSERT INTO recurring_invoice_runs (org_id, recurring_invoice_id, scheduled_for)
			VALUES ($1::uuid, $2::uuid, $3)
			ON CONFLICT DO NOTHING
			RETURNING id::text`, orgID, template.id, template.scheduled).Scan(&runID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return GenerateDueInvoicesOutput{}, err
		}
		var lines []CreateInvoiceLine
		if err := json.Unmarshal(template.lines, &lines); err != nil {
			return GenerateDueInvoicesOutput{}, fmt.Errorf("recurring template %s has unreadable lines: %w", template.id, err)
		}
		memo := template.memo
		if memo == nil || *memo == "" {
			fallback := fmt.Sprintf("Recurring (%s)", template.frequency)
			memo = &fallback
		}
		created, err := createInvoice(ctx, tx, claims, CreateInvoiceInput{
			CustomerID: template.customerID,
			Memo:       memo,
			Lines:      lines,
		}, now)
		if err != nil {
			return GenerateDueInvoicesOutput{}, err
		}
		nextRun, err := nextRunAfter(template.frequency, template.scheduled)
		if err != nil {
			return GenerateDueInvoicesOutput{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE recurring_invoices SET next_run_at = $2, last_run_at = $3
			WHERE id = $1::uuid AND org_id = $4::uuid`, template.id, nextRun, now, orgID); err != nil {
			return GenerateDueInvoicesOutput{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE recurring_invoice_runs SET invoice_id = $2::uuid, status = 'completed', completed_at = $3
			WHERE id = $1::uuid`, runID, created.InvoiceID, now); err != nil {
			return GenerateDueInvoicesOutput{}, err
		}
		generated++
	}
	return GenerateDueInvoicesOutput{Generated: generated}, nil
}

// nextRunAfter mirrors erp-core nextRunAfter: the next due instant strictly
// after the scheduled one, weekly plus 7 days, monthly and quarterly keeping
// the day-of-month intent clamped to the target month's length, all UTC.
func nextRunAfter(frequency string, from time.Time) (time.Time, error) {
	current := from.UTC()
	switch frequency {
	case "weekly":
		return current.AddDate(0, 0, 7), nil
	case "monthly", "quarterly":
		months := 1
		if frequency == "quarterly" {
			months = 3
		}
		totalMonth := int(current.Month()) - 1 + months
		year := current.Year() + totalMonth/12
		month := time.Month(totalMonth%12 + 1)
		day := current.Day()
		daysInMonth := time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
		if day > daysInMonth {
			day = daysInMonth
		}
		return time.Date(year, month, day, current.Hour(), current.Minute(), current.Second(), current.Nanosecond(), time.UTC), nil
	default:
		return time.Time{}, fmt.Errorf("unknown recurring frequency %q", frequency)
	}
}

// reverseEntryDomainRoutes mirrors the TypeScript N12 guard: subledger-owned
// source types must be undone by their domain compensation, never by a bare
// journal mirror.
var reverseEntryDomainRoutes = map[string]string{
	"payment":             "accounting.reversePayment on the payment",
	"vendor_payment":      "purchasing.reverseVendorPayment on the vendor payment",
	"pos_sale":            "pos.returnSale on the sale invoice",
	"payroll_run":         "hr.reversePayrollPosting on the payroll run",
	"invoice":             "accounting.creditNote against the invoice",
	"inventory-valuation": "inventory.reverseValuationSummary on the summary",
	"year_end_close":      "accounting.closeYear (reopen December first): it replaces the closing entry",
}

func executeReverseEntry(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ReverseEntryInput, now time.Time) (ReverseEntryOutput, error) {
	orgID := claims.OrganizationID
	var original struct {
		ID         string
		Memo       string
		SourceType string
		EntryKind  string
		Currency   string
		PostedAt   time.Time
	}
	err := tx.QueryRow(ctx, `
		SELECT id::text, memo, coalesce(source_type, ''), coalesce(entry_kind, ''), currency, posted_at
		FROM journal_entries
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.EntryID, orgID).
		Scan(&original.ID, &original.Memo, &original.SourceType, &original.EntryKind, &original.Currency, &original.PostedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReverseEntryOutput{}, errors.New("entry not found")
	}
	if err != nil {
		return ReverseEntryOutput{}, err
	}
	if original.SourceType == "reversal" || original.SourceType == "payment-reversal" {
		return ReverseEntryOutput{}, errors.New("cannot reverse a reversal")
	}
	if original.SourceType != "" {
		if route, routed := reverseEntryDomainRoutes[original.SourceType]; routed {
			return ReverseEntryOutput{}, fmt.Errorf("a %s entry is undone by its domain workflow: use %s", original.SourceType, route)
		}
	}
	if original.EntryKind == "year_end_close" {
		return ReverseEntryOutput{}, errors.New("a year-end closing entry is replaced by accounting.closeYear (reopen December first), not mirrored")
	}
	rows, err := tx.Query(ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl
		JOIN accounts a ON a.id = jl.account_id AND a.org_id = $2::uuid
		WHERE jl.entry_id = $1::uuid
		ORDER BY jl.id`, original.ID, orgID)
	if err != nil {
		return ReverseEntryOutput{}, err
	}
	lines := make([]JournalEntryLineInput, 0, 2)
	for rows.Next() {
		var code string
		var debit, credit int64
		if err := rows.Scan(&code, &debit, &credit); err != nil {
			rows.Close()
			return ReverseEntryOutput{}, err
		}
		lines = append(lines, JournalEntryLineInput{AccountCode: code, DebitMinor: credit, CreditMinor: debit})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ReverseEntryOutput{}, err
	}
	rows.Close()
	if len(lines) < 2 {
		return ReverseEntryOutput{}, errors.New("journal entry has no lines to reverse")
	}
	businessAt := original.PostedAt
	reversalEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:        orgID,
		Memo:         fmt.Sprintf("Reversal of: %s", original.Memo),
		SourceType:   "reversal",
		ReversalOfID: &original.ID,
		EntryKind:    "correction",
		BusinessAt:   &businessAt,
		Currency:     original.Currency,
		PostedAt:     now,
		ActorType:    claims.ActorType,
		ActorID:      claims.ActorID,
		Lines:        lines,
	})
	if err != nil {
		return ReverseEntryOutput{}, err
	}
	return ReverseEntryOutput{ReversalEntryID: reversalEntryID}, nil
}
