package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type RecordPaymentInput struct {
	InvoiceNumber int64   `json:"invoiceNumber"`
	AmountMinor   int64   `json:"amountMinor"`
	Method        string  `json:"method"`
	SettleFXRate  *string `json:"settleFxRate,omitempty"`
}

type RecordPaymentOutput struct {
	PaymentID      string  `json:"paymentId"`
	EntryID        string  `json:"entryId"`
	FullyPaid      bool    `json:"fullyPaid"`
	GainLossMinor  *int64  `json:"gainLossMinor,omitempty"`
	BaseEntryID    *string `json:"baseEntryId,omitempty"`
	ForeignEntryID *string `json:"foreignEntryId,omitempty"`
}

type ReversePaymentInput struct {
	PaymentID string `json:"paymentId"`
	Reason    string `json:"reason"`
}

type ReversePaymentOutput struct {
	ReversalEntryIDs []string `json:"reversalEntryIds"`
	RefundedMinor    int64    `json:"refundedMinor"`
	InvoiceNumber    int64    `json:"invoiceNumber"`
	OutstandingMinor int64    `json:"outstandingMinor"`
}

func ParseRecordPaymentInput(raw json.RawMessage) (RecordPaymentInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RecordPaymentInput{}, err
	}
	var input RecordPaymentInput
	input.InvoiceNumber, err = requiredSafeInteger(fields, "invoiceNumber")
	if err != nil || input.InvoiceNumber <= 0 {
		return RecordPaymentInput{}, errors.New("invoiceNumber must be a positive integer")
	}
	input.AmountMinor, err = requiredSafeInteger(fields, "amountMinor")
	if err != nil || input.AmountMinor <= 0 {
		return RecordPaymentInput{}, errors.New("amountMinor must be a positive integer")
	}
	input.Method = "bank_transfer"
	if rawMethod, ok := fields["method"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawMethod), []byte("null")) || json.Unmarshal(rawMethod, &input.Method) != nil {
			return RecordPaymentInput{}, errors.New("method is invalid")
		}
	}
	switch input.Method {
	case "cash", "bank_transfer", "card":
	default:
		return RecordPaymentInput{}, errors.New("method is invalid")
	}
	if input.SettleFXRate, err = optionalString(fields, "settleFxRate"); err != nil {
		return RecordPaymentInput{}, err
	}
	return input, nil
}

func ParseReversePaymentInput(raw json.RawMessage) (ReversePaymentInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReversePaymentInput{}, err
	}
	var input ReversePaymentInput
	input.PaymentID, err = requiredString(fields, "paymentId")
	if err != nil || !isZodUUID(input.PaymentID) {
		return ReversePaymentInput{}, errors.New("paymentId must be a UUID")
	}
	input.Reason, err = requiredString(fields, "reason")
	if err != nil {
		return ReversePaymentInput{}, errors.New("reason must be a string")
	}
	length := len(utf16.Encode([]rune(input.Reason)))
	if length < 3 || length > 500 {
		return ReversePaymentInput{}, errors.New("reason must be between 3 and 500 characters")
	}
	return input, nil
}

type paymentInvoiceRow struct {
	ID            string
	Number        int64
	Status        string
	Currency      string
	TotalMinor    int64
	PaidMinor     int64
	CreditedMinor int64
}

func recordPayment(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RecordPaymentInput, now time.Time) (RecordPaymentOutput, error) {
	var output RecordPaymentOutput
	if input.AmountMinor > maxDatabaseInteger {
		return output, errors.New("payment amount exceeds the database integer range")
	}
	var invoice paymentInvoiceRow
	var invoiceRateNum, invoiceRateDen *int64
	err := tx.QueryRow(ctx, `
		SELECT id::text, number, status, currency, total_minor, paid_minor, credited_minor, fx_rate_num, fx_rate_den
		FROM invoices WHERE org_id = $1::uuid AND number = $2
		FOR UPDATE`, claims.OrganizationID, input.InvoiceNumber).
		Scan(&invoice.ID, &invoice.Number, &invoice.Status, &invoice.Currency, &invoice.TotalMinor, &invoice.PaidMinor, &invoice.CreditedMinor, &invoiceRateNum, &invoiceRateDen)
	if errors.Is(err, pgx.ErrNoRows) {
		return output, errors.New("invoice not found")
	}
	if err != nil {
		return output, err
	}
	if invoice.Status == "draft" || invoice.Status == "void" {
		return output, fmt.Errorf("document is %s and cannot receive money", invoice.Status)
	}
	if invoice.TotalMinor < 0 || invoice.PaidMinor < 0 || invoice.CreditedMinor < 0 {
		return output, errors.New("invoice balance contains an invalid negative amount")
	}
	allocated := invoice.PaidMinor + invoice.CreditedMinor
	if allocated < invoice.PaidMinor {
		return output, errors.New("invoice balance exceeds the supported amount range")
	}
	outstanding := invoice.TotalMinor - allocated
	if outstanding < 0 {
		outstanding = 0
	}
	if input.AmountMinor > outstanding {
		return output, fmt.Errorf("overpayment: outstanding is %d minor (total %d, credited %d, paid %d)", outstanding, invoice.TotalMinor, invoice.CreditedMinor, invoice.PaidMinor)
	}
	var baseCurrency string
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, claims.OrganizationID).Scan(&baseCurrency); err != nil {
		return output, err
	}
	if invoice.Currency == baseCurrency {
		entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
			OrgID:      claims.OrganizationID,
			Memo:       fmt.Sprintf("Payment for invoice %d (%s)", invoice.Number, input.Method),
			SourceType: "payment",
			Currency:   baseCurrency,
			PostedAt:   now,
			ActorType:  claims.ActorType,
			ActorID:    claims.ActorID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "1000", DebitMinor: input.AmountMinor},
				{AccountCode: "1100", CreditMinor: input.AmountMinor},
			},
		})
		if err != nil {
			return output, err
		}
		return finishPayment(ctx, tx, claims.OrganizationID, invoice, input, now, entryID)
	}
	settleRate, err := settleFXRate(ctx, tx, claims.OrganizationID, baseCurrency, invoice.Currency, input.SettleFXRate, now)
	if err != nil {
		return output, err
	}
	if settleRate == nil {
		return output, fmt.Errorf("no settlement rate for %s/%s", baseCurrency, invoice.Currency)
	}
	if settleRate.Den > maxDatabaseInteger {
		return output, errors.New("settlement rate denominator exceeds the database integer range")
	}
	cashBase, err := toBaseMinorExact(input.AmountMinor, *settleRate, invoice.Currency, baseCurrency)
	if err != nil {
		return output, err
	}
	bookedBase := cashBase
	if invoiceRateNum != nil && invoiceRateDen != nil {
		bookedBase, err = toBaseMinorExact(input.AmountMinor, fxRateSnapshot{Num: *invoiceRateNum, Den: *invoiceRateDen}, invoice.Currency, baseCurrency)
		if err != nil {
			return output, err
		}
	}
	gainLoss := cashBase - bookedBase
	if cashBase > maxDatabaseInteger || bookedBase > maxDatabaseInteger || gainLoss > maxDatabaseInteger || gainLoss < -maxDatabaseInteger {
		return output, errors.New("FX settlement amount exceeds the database integer range")
	}
	if err := ensureFXAccount(ctx, tx, claims.OrganizationID, fxClearingAccountCode, "FX Clearing", "asset"); err != nil {
		return output, err
	}
	glType := "income"
	if gainLoss < 0 {
		glType = "expense"
	}
	if err := ensureFXAccount(ctx, tx, claims.OrganizationID, realizedFXAccountCode, "Realized FX Gain/Loss", glType); err != nil {
		return output, err
	}
	baseLines := []JournalEntryLineInput{
		{AccountCode: "1000", DebitMinor: cashBase},
		{AccountCode: fxClearingAccountCode, CreditMinor: bookedBase},
	}
	if gainLoss > 0 {
		baseLines = append(baseLines, JournalEntryLineInput{AccountCode: realizedFXAccountCode, CreditMinor: gainLoss})
	} else if gainLoss < 0 {
		baseLines = append(baseLines, JournalEntryLineInput{AccountCode: realizedFXAccountCode, DebitMinor: -gainLoss})
	}
	baseMemo := fmt.Sprintf("Settlement of invoice %d (%s %d) @ %d/%d", invoice.Number, invoice.Currency, input.AmountMinor, settleRate.Num, settleRate.Den)
	baseEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: claims.OrganizationID, Memo: baseMemo, SourceType: "payment", Currency: baseCurrency,
		PostedAt: now, ActorType: claims.ActorType, ActorID: claims.ActorID, Lines: baseLines,
	})
	if err != nil {
		return output, err
	}
	invoiceID := invoice.ID
	foreignEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: claims.OrganizationID, Memo: fmt.Sprintf("FX clearing of invoice %d", invoice.Number), SourceType: "payment",
		SourceID: &invoiceID, Currency: invoice.Currency, PostedAt: now, ActorType: claims.ActorType, ActorID: claims.ActorID,
		Lines: []JournalEntryLineInput{
			{AccountCode: fxClearingAccountCode, DebitMinor: input.AmountMinor},
			{AccountCode: "1100", CreditMinor: input.AmountMinor},
		},
	})
	if err != nil {
		return output, err
	}
	var paymentID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, method, entry_id, received_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
		RETURNING id::text`, claims.OrganizationID, invoice.ID, input.AmountMinor, input.Method, baseEntryID, now).
		Scan(&paymentID); err != nil {
		return output, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO fx_settlements (org_id, payment_id, invoice_id, currency, settled_foreign_minor, base_settled_minor, gain_loss_minor, settle_rate_num, settle_rate_den, base_entry_id, foreign_entry_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::uuid, $11::uuid)`,
		claims.OrganizationID, paymentID, invoice.ID, invoice.Currency, input.AmountMinor, cashBase, gainLoss, settleRate.Num, settleRate.Den, baseEntryID, foreignEntryID); err != nil {
		return output, err
	}
	paidMinor := invoice.PaidMinor + input.AmountMinor
	fullyPaid := paidMinor >= invoice.TotalMinor
	if _, err := tx.Exec(ctx, `UPDATE invoices SET paid_minor = $2, status = CASE WHEN $3 THEN 'paid' ELSE status END WHERE id = $1::uuid AND org_id = $4::uuid`, invoice.ID, paidMinor, fullyPaid, claims.OrganizationID); err != nil {
		return output, err
	}
	gainLossOutput := gainLoss
	baseEntryOutput, foreignEntryOutput := baseEntryID, foreignEntryID
	return RecordPaymentOutput{PaymentID: paymentID, EntryID: baseEntryID, FullyPaid: fullyPaid, GainLossMinor: &gainLossOutput, BaseEntryID: &baseEntryOutput, ForeignEntryID: &foreignEntryOutput}, nil
}

const fxClearingAccountCode = "1305"
const realizedFXAccountCode = "7900"

func finishPayment(ctx context.Context, tx pgx.Tx, orgID string, invoice paymentInvoiceRow, input RecordPaymentInput, now time.Time, entryID string) (RecordPaymentOutput, error) {
	var paymentID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO payments (org_id, invoice_id, amount_minor, method, entry_id, received_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
		RETURNING id::text`, orgID, invoice.ID, input.AmountMinor, input.Method, entryID, now).
		Scan(&paymentID); err != nil {
		return RecordPaymentOutput{}, err
	}
	paidMinor := invoice.PaidMinor + input.AmountMinor
	fullyPaid := paidMinor+invoice.CreditedMinor >= invoice.TotalMinor
	if _, err := tx.Exec(ctx, `UPDATE invoices SET paid_minor = $2, status = CASE WHEN $3 THEN 'paid' ELSE status END WHERE id = $1::uuid AND org_id = $4::uuid`, invoice.ID, paidMinor, fullyPaid, orgID); err != nil {
		return RecordPaymentOutput{}, err
	}
	return RecordPaymentOutput{PaymentID: paymentID, EntryID: entryID, FullyPaid: fullyPaid}, nil
}

func settleFXRate(ctx context.Context, tx pgx.Tx, orgID, base, quote string, explicit *string, at time.Time) (*fxRateSnapshot, error) {
	if explicit != nil && *explicit != "" {
		rate, err := parseFXRateDecimal(*explicit)
		if err != nil {
			return nil, nil
		}
		return rate, nil
	}
	return latestFXRate(ctx, tx, orgID, base, quote, at)
}

func ensureFXAccount(ctx context.Context, tx pgx.Tx, orgID, code, name, accountType string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (org_id, code) DO NOTHING`, orgID, code, name, accountType)
	return err
}

func reversePayment(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ReversePaymentInput, now time.Time) (ReversePaymentOutput, error) {
	var output ReversePaymentOutput
	var invoiceID string
	var entryID *string
	var amountMinor int64
	err := tx.QueryRow(ctx, `
		SELECT invoice_id::text, entry_id::text, amount_minor
		FROM payments WHERE id = $1::uuid AND org_id = $2::uuid`, input.PaymentID, claims.OrganizationID).
		Scan(&invoiceID, &entryID, &amountMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return output, errors.New("payment not found")
	}
	if err != nil {
		return output, err
	}
	var invoice paymentInvoiceRow
	err = tx.QueryRow(ctx, `
		SELECT id::text, number, status, currency, total_minor, paid_minor, credited_minor
		FROM invoices WHERE id = $1::uuid AND org_id = $2::uuid
		FOR UPDATE`, invoiceID, claims.OrganizationID).
		Scan(&invoice.ID, &invoice.Number, &invoice.Status, &invoice.Currency, &invoice.TotalMinor, &invoice.PaidMinor, &invoice.CreditedMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return output, errors.New("payment's invoice not found")
	}
	if err != nil {
		return output, err
	}
	if invoice.Status == "void" {
		return output, errors.New("invoice is void; a void compensates its payments")
	}
	if entryID == nil || *entryID == "" {
		return output, errors.New("payment has no journal entry to reverse")
	}
	entryIDValue := *entryID
	var sourceType string
	if err := tx.QueryRow(ctx, `SELECT source_type FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, entryIDValue, claims.OrganizationID).Scan(&sourceType); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return output, errors.New("payment has no journal entry to reverse")
		}
		return output, err
	}
	if sourceType == "pos_sale" {
		return output, errors.New("register sales are undone with pos.returnSale, not a payment reversal")
	}
	entryIDs := []string{entryIDValue}
	var foreignEntryID string
	err = tx.QueryRow(ctx, `
		SELECT foreign_entry_id::text
		FROM fx_settlements
		WHERE org_id = $1::uuid AND payment_id = $2::uuid`, claims.OrganizationID, input.PaymentID).
		Scan(&foreignEntryID)
	if err == nil {
		entryIDs = append(entryIDs, foreignEntryID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return output, err
	}
	for _, originalID := range entryIDs {
		var already bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM journal_entries WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid)`, claims.OrganizationID, originalID).Scan(&already); err != nil {
			return output, err
		}
		if already {
			return output, errors.New("payment has already been reversed")
		}
	}
	memo := fmt.Sprintf("Payment reversal for invoice %d: %s", invoice.Number, input.Reason)
	reversalIDs := make([]string, 0, len(entryIDs))
	for _, originalID := range entryIDs {
		var originalCurrency string
		if err := tx.QueryRow(ctx, `SELECT currency FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, originalID, claims.OrganizationID).Scan(&originalCurrency); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return output, errors.New("payment has no journal entry to reverse")
			}
			return output, err
		}
		rows, err := tx.Query(ctx, `
			SELECT a.code, jl.debit_minor, jl.credit_minor
			FROM journal_lines jl
			JOIN accounts a ON a.id = jl.account_id AND a.org_id = $2::uuid
			WHERE jl.entry_id = $1::uuid
			ORDER BY jl.id`, originalID, claims.OrganizationID)
		if err != nil {
			return output, err
		}
		lines := make([]JournalEntryLineInput, 0)
		for rows.Next() {
			var code string
			var debit, credit int64
			if err := rows.Scan(&code, &debit, &credit); err != nil {
				rows.Close()
				return output, err
			}
			lines = append(lines, JournalEntryLineInput{AccountCode: code, DebitMinor: credit, CreditMinor: debit})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return output, err
		}
		rows.Close()
		if len(lines) < 2 {
			return output, errors.New("payment journal entry has no lines to reverse")
		}
		reversalID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
			OrgID:        claims.OrganizationID,
			Memo:         memo,
			SourceType:   "payment-reversal",
			SourceID:     &invoice.ID,
			ReversalOfID: &originalID,
			Currency:     originalCurrency,
			PostedAt:     now,
			ActorType:    claims.ActorType,
			ActorID:      claims.ActorID,
			Lines:        lines,
		})
		if err != nil {
			return output, err
		}
		reversalIDs = append(reversalIDs, reversalID)
	}
	if amountMinor <= 0 || invoice.PaidMinor < amountMinor {
		return output, errors.New("payment allocation is inconsistent with invoice balance")
	}
	paidMinor := invoice.PaidMinor - amountMinor
	allocated := paidMinor + invoice.CreditedMinor
	if allocated < paidMinor {
		return output, errors.New("invoice balance exceeds the supported amount range")
	}
	fullySettled := allocated >= invoice.TotalMinor
	outstanding := invoice.TotalMinor - allocated
	if outstanding < 0 {
		outstanding = 0
	}
	status := invoice.Status
	if !fullySettled && status == "paid" {
		status = "sent"
	}
	if _, err := tx.Exec(ctx, `UPDATE invoices SET paid_minor = $2, status = $3 WHERE id = $1::uuid AND org_id = $4::uuid`, invoice.ID, paidMinor, status, claims.OrganizationID); err != nil {
		return output, err
	}
	return ReversePaymentOutput{
		ReversalEntryIDs: reversalIDs,
		RefundedMinor:    amountMinor,
		InvoiceNumber:    invoice.Number,
		OutstandingMinor: outstanding,
	}, nil
}
