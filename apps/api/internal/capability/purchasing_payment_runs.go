package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createPaymentRunCapabilityID       = "purchasing.createPaymentRun"
	cancelPaymentRunDraftCapabilityID  = "purchasing.cancelPaymentRunDraft"
	restorePaymentRunDraftCapabilityID = "purchasing.restorePaymentRunDraft"
	instructPaymentRunCapabilityID     = "purchasing.instructPaymentRun"
	reversePaymentRunCapabilityID      = "purchasing.reversePaymentRun"
	listPaymentRunsCapabilityID        = "purchasing.listPaymentRuns"
	listPaymentRunBillsCapabilityID    = "purchasing.listPaymentRunBills"
)

const paymentRunBankMethod = "bank_transfer"

type CreatePaymentRunLineInput struct {
	BillID      string `json:"billId"`
	AmountMinor int64  `json:"amountMinor"`
}

type CreatePaymentRunInput struct {
	Memo  *string                     `json:"memo,omitempty"`
	Lines []CreatePaymentRunLineInput `json:"lines"`
}

type CreatePaymentRunOutput struct {
	PaymentRunID string `json:"paymentRunId"`
	Reference    string `json:"reference"`
	Currency     string `json:"currency"`
	TotalMinor   int64  `json:"totalMinor"`
	BillCount    int    `json:"billCount"`
}

type PaymentRunIDInput struct {
	PaymentRunID string `json:"paymentRunId"`
}

type PaymentRunIDOutput struct {
	PaymentRunID string `json:"paymentRunId"`
}

type InstructPaymentRunOutput struct {
	PaymentRunID string `json:"paymentRunId"`
	Reference    string `json:"reference"`
	Currency     string `json:"currency"`
	TotalMinor   int64  `json:"totalMinor"`
	EntryID      string `json:"entryId"`
	BillCount    int    `json:"billCount"`
	Status       string `json:"status"`
}

type ReversePaymentRunInput struct {
	PaymentRunID string `json:"paymentRunId"`
	Reason       string `json:"reason"`
}

type ReversePaymentRunOutput struct {
	PaymentRunID    string `json:"paymentRunId"`
	ReversalEntryID string `json:"reversalEntryId"`
	Status          string `json:"status"`
}

type ListPaymentRunsInput struct{}

type PaymentRunLineItem struct {
	BillID      string  `json:"billId"`
	BillNumber  int64   `json:"billNumber"`
	VendorName  string  `json:"vendorName"`
	VendorRef   *string `json:"vendorRef"`
	AmountMinor int64   `json:"amountMinor"`
}

type PaymentRunItem struct {
	ID           string               `json:"id"`
	Reference    string               `json:"reference"`
	Currency     string               `json:"currency"`
	TotalMinor   int64                `json:"totalMinor"`
	Status       string               `json:"status"`
	CreatedAt    string               `json:"createdAt"`
	InstructedAt *string              `json:"instructedAt"`
	ConfirmedAt  *string              `json:"confirmedAt"`
	EntryID      *string              `json:"entryId"`
	Lines        []PaymentRunLineItem `json:"lines"`
}

type ListPaymentRunsOutput struct {
	Runs []PaymentRunItem `json:"runs"`
}

type ListPaymentRunBillsInput struct{}

type PaymentRunBill struct {
	ID         string  `json:"id"`
	Number     int64   `json:"number"`
	VendorName string  `json:"vendorName"`
	VendorRef  *string `json:"vendorRef"`
	Currency   string  `json:"currency"`
	DueMinor   int64   `json:"dueMinor"`
}

type ListPaymentRunBillsOutput struct {
	Bills []PaymentRunBill `json:"bills"`
}

func paymentRunIDField(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := requiredCRMDealString(fields, key, 0, 0)
	if err != nil || !isZodUUID(value) {
		return "", fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

func ParseCreatePaymentRunInput(raw json.RawMessage) (CreatePaymentRunInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatePaymentRunInput{}, err
	}
	var input CreatePaymentRunInput
	if input.Memo, err = optionalCRMDealString(fields, "memo", 500, false); err != nil {
		return CreatePaymentRunInput{}, err
	}
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return CreatePaymentRunInput{}, errors.New("lines must contain at least 1 line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) < 1 {
		return CreatePaymentRunInput{}, errors.New("lines must contain at least 1 line")
	}
	if len(lineValues) > 100 {
		return CreatePaymentRunInput{}, errors.New("lines must contain at most 100 lines")
	}
	input.Lines = make([]CreatePaymentRunLineInput, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return CreatePaymentRunInput{}, errors.New("each payment run line must be an object")
		}
		var line CreatePaymentRunLineInput
		if line.BillID, err = paymentRunIDField(lineFields, "billId"); err != nil {
			return CreatePaymentRunInput{}, err
		}
		line.AmountMinor, err = requiredSafeInteger(lineFields, "amountMinor")
		if err != nil || line.AmountMinor <= 0 {
			return CreatePaymentRunInput{}, errors.New("amountMinor must be a positive integer")
		}
		input.Lines = append(input.Lines, line)
	}
	return input, nil
}

func parsePaymentRunIDRaw(raw json.RawMessage) (PaymentRunIDInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PaymentRunIDInput{}, err
	}
	id, err := paymentRunIDField(fields, "paymentRunId")
	if err != nil {
		return PaymentRunIDInput{}, err
	}
	return PaymentRunIDInput{PaymentRunID: id}, nil
}

func ParseCancelPaymentRunDraftInput(raw json.RawMessage) (PaymentRunIDInput, error) {
	return parsePaymentRunIDRaw(raw)
}

func ParseRestorePaymentRunDraftInput(raw json.RawMessage) (PaymentRunIDInput, error) {
	return parsePaymentRunIDRaw(raw)
}

func ParseInstructPaymentRunInput(raw json.RawMessage) (PaymentRunIDInput, error) {
	return parsePaymentRunIDRaw(raw)
}

func ParseReversePaymentRunInput(raw json.RawMessage) (ReversePaymentRunInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReversePaymentRunInput{}, err
	}
	var input ReversePaymentRunInput
	if input.PaymentRunID, err = paymentRunIDField(fields, "paymentRunId"); err != nil {
		return ReversePaymentRunInput{}, err
	}
	if input.Reason, err = requiredCRMDealString(fields, "reason", 3, 500); err != nil {
		return ReversePaymentRunInput{}, err
	}
	return input, nil
}

func ParseListPaymentRunsInput(raw json.RawMessage) (ListPaymentRunsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListPaymentRunsInput{}, err
	}
	return ListPaymentRunsInput{}, nil
}

func ParseListPaymentRunBillsInput(raw json.RawMessage) (ListPaymentRunBillsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListPaymentRunBillsInput{}, err
	}
	return ListPaymentRunBillsInput{}, nil
}

var paymentRunCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

type paymentRunSelection struct {
	billID           string
	currency         string
	outstandingMinor int64
	payMinor         int64
}

type validatedPaymentRun struct {
	currency   string
	totalMinor int64
	billCount  int
	lines      []paymentRunSelection
}

// paymentRunValidate mirrors erp-core validatePaymentRun: fail closed on
// duplicate bills, mixed currencies, and overpayments before any row is
// written.
func paymentRunValidate(lines []paymentRunSelection) (validatedPaymentRun, error) {
	if len(lines) == 0 {
		return validatedPaymentRun{}, errors.New("select at least one bill")
	}
	currency := strings.ToUpper(lines[0].currency)
	if !paymentRunCurrencyPattern.MatchString(currency) {
		return validatedPaymentRun{}, errors.New("payment run currency must be an ISO currency code")
	}
	seen := make(map[string]struct{}, len(lines))
	var totalMinor int64
	for _, line := range lines {
		if line.billID == "" {
			return validatedPaymentRun{}, errors.New("a bill can appear only once in a payment run")
		}
		if _, duplicate := seen[line.billID]; duplicate {
			return validatedPaymentRun{}, errors.New("a bill can appear only once in a payment run")
		}
		seen[line.billID] = struct{}{}
		if strings.ToUpper(line.currency) != currency {
			return validatedPaymentRun{}, errors.New("all bills in a payment run must use the same currency")
		}
		if line.outstandingMinor <= 0 || line.outstandingMinor > maxSafeInteger {
			return validatedPaymentRun{}, fmt.Errorf("bill %s has no payable balance", line.billID)
		}
		if line.payMinor <= 0 || line.payMinor > maxSafeInteger {
			return validatedPaymentRun{}, fmt.Errorf("payment for bill %s must be positive", line.billID)
		}
		if line.payMinor > line.outstandingMinor {
			return validatedPaymentRun{}, fmt.Errorf("payment for bill %s exceeds its outstanding balance", line.billID)
		}
		total := totalMinor + line.payMinor
		if total < totalMinor || total > maxSafeInteger {
			return validatedPaymentRun{}, errors.New("payment run total exceeds the supported amount range")
		}
		totalMinor = total
	}
	normalized := make([]paymentRunSelection, len(lines))
	for index, line := range lines {
		normalized[index] = line
		normalized[index].currency = currency
	}
	return validatedPaymentRun{currency: currency, totalMinor: totalMinor, billCount: len(lines), lines: normalized}, nil
}

// nextPaymentRunNumber allocates the per-org payment_run counter. The
// TypeScript port calls nextDocNumber with kind "payment_run", but that kind
// is absent from the shared SEQUENCES map, so every TS call throws; the run
// table has no legacy number column to seed from, so this follows the
// authored-allocator shape: start at 1 per organization and increment.
func nextPaymentRunNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next")
		VALUES ($1::uuid, 'payment_run', 1)
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	if err != nil {
		return 0, fmt.Errorf("allocate payment run number: %w", err)
	}
	if number <= 0 || number > maxDatabaseInteger {
		return 0, errors.New("payment run number exceeds the database integer range")
	}
	return number, nil
}

type payableBillRow struct {
	id            string
	status        string
	voidedAt      *time.Time
	currency      string
	totalMinor    int64
	paidMinor     int64
	creditedMinor int64
}

func lockPayableBills(ctx context.Context, tx pgx.Tx, orgID string, billIDs []string) (map[string]payableBillRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, status, voided_at, currency, total_minor, paid_minor, credited_minor
		FROM vendor_bills
		WHERE org_id = $1::uuid AND id = ANY($2::uuid[])
		ORDER BY id
		FOR UPDATE`, orgID, billIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bills := make(map[string]payableBillRow, len(billIDs))
	for rows.Next() {
		var bill payableBillRow
		if err := rows.Scan(&bill.id, &bill.status, &bill.voidedAt, &bill.currency, &bill.totalMinor, &bill.paidMinor, &bill.creditedMinor); err != nil {
			return nil, err
		}
		bills[bill.id] = bill
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return bills, nil
}

func createPaymentRun(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreatePaymentRunInput) (CreatePaymentRunOutput, error) {
	orgID := claims.OrganizationID
	billIDs := make([]string, 0, len(input.Lines))
	for _, line := range input.Lines {
		billIDs = append(billIDs, line.BillID)
	}
	bills, err := lockPayableBills(ctx, tx, orgID, billIDs)
	if err != nil {
		return CreatePaymentRunOutput{}, err
	}
	selection := make([]paymentRunSelection, 0, len(input.Lines))
	for _, line := range input.Lines {
		bill, ok := bills[line.BillID]
		if !ok || bill.status == "void" || bill.voidedAt != nil {
			return CreatePaymentRunOutput{}, fmt.Errorf("bill %s is unavailable for payment", line.BillID)
		}
		balance, err := purchasingBalance(bill.totalMinor, bill.paidMinor, bill.creditedMinor)
		if err != nil {
			return CreatePaymentRunOutput{}, err
		}
		selection = append(selection, paymentRunSelection{
			billID: bill.id, currency: bill.currency,
			outstandingMinor: balance.outstandingMinor, payMinor: line.AmountMinor,
		})
	}
	validated, err := paymentRunValidate(selection)
	if err != nil {
		return CreatePaymentRunOutput{}, err
	}
	number, err := nextPaymentRunNumber(ctx, tx, orgID)
	if err != nil {
		return CreatePaymentRunOutput{}, err
	}
	reference := fmt.Sprintf("PR-%06d", number)
	var runID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO payment_runs (org_id, reference, currency, total_minor, memo, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
		RETURNING id::text`,
		orgID, reference, validated.currency, validated.totalMinor, input.Memo, claims.ActorType, claims.ActorID).Scan(&runID); err != nil {
		return CreatePaymentRunOutput{}, err
	}
	for _, line := range validated.lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO payment_run_lines (org_id, payment_run_id, vendor_bill_id, amount_minor)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`, orgID, runID, line.billID, line.payMinor); err != nil {
			return CreatePaymentRunOutput{}, err
		}
	}
	return CreatePaymentRunOutput{
		PaymentRunID: runID, Reference: reference, Currency: validated.currency,
		TotalMinor: validated.totalMinor, BillCount: validated.billCount,
	}, nil
}

func cancelPaymentRunDraft(ctx context.Context, tx pgx.Tx, orgID string, input PaymentRunIDInput) (PaymentRunIDOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE payment_runs SET status = 'cancelled'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'draft'`, input.PaymentRunID, orgID)
	if err != nil {
		return PaymentRunIDOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return PaymentRunIDOutput{}, errors.New("draft payment run not found")
	}
	return PaymentRunIDOutput{PaymentRunID: input.PaymentRunID}, nil
}

func restorePaymentRunDraft(ctx context.Context, tx pgx.Tx, orgID string, input PaymentRunIDInput) (PaymentRunIDOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE payment_runs SET status = 'draft'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'cancelled'`, input.PaymentRunID, orgID)
	if err != nil {
		return PaymentRunIDOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return PaymentRunIDOutput{}, errors.New("cancelled draft payment run not found")
	}
	return PaymentRunIDOutput{PaymentRunID: input.PaymentRunID}, nil
}

type paymentRunLineRow struct {
	id          string
	billID      string
	amountMinor int64
}

func loadPaymentRunLines(ctx context.Context, tx pgx.Tx, orgID, runID string, byBill bool) ([]paymentRunLineRow, error) {
	query := `
		SELECT id::text, vendor_bill_id::text, amount_minor
		FROM payment_run_lines
		WHERE payment_run_id = $1::uuid AND org_id = $2::uuid
		ORDER BY id`
	if byBill {
		query = `
		SELECT id::text, vendor_bill_id::text, amount_minor
		FROM payment_run_lines
		WHERE payment_run_id = $1::uuid AND org_id = $2::uuid
		ORDER BY vendor_bill_id`
	}
	rows, err := tx.Query(ctx, query, runID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := make([]paymentRunLineRow, 0, 8)
	for rows.Next() {
		var line paymentRunLineRow
		if err := rows.Scan(&line.id, &line.billID, &line.amountMinor); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

// Posting rule for instructions: one consolidated entry, DR Accounts
// Payable, CR Cash, for the whole run. Per-bill settlements are recorded as
// vendor payments against that single entry.
func instructPaymentRun(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PaymentRunIDInput, now time.Time) (InstructPaymentRunOutput, error) {
	orgID := claims.OrganizationID
	var runID, reference, currency, status string
	var totalMinor int64
	err := tx.QueryRow(ctx, `
		SELECT id::text, reference, currency, total_minor, status
		FROM payment_runs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.PaymentRunID, orgID).Scan(&runID, &reference, &currency, &totalMinor, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstructPaymentRunOutput{}, errors.New("only a draft payment run can be approved")
	}
	if err != nil {
		return InstructPaymentRunOutput{}, err
	}
	if status != "draft" {
		return InstructPaymentRunOutput{}, errors.New("only a draft payment run can be approved")
	}
	lines, err := loadPaymentRunLines(ctx, tx, orgID, runID, true)
	if err != nil {
		return InstructPaymentRunOutput{}, err
	}
	billIDs := make([]string, 0, len(lines))
	for _, line := range lines {
		billIDs = append(billIDs, line.billID)
	}
	bills, err := lockPayableBills(ctx, tx, orgID, billIDs)
	if err != nil {
		return InstructPaymentRunOutput{}, err
	}
	selection := make([]paymentRunSelection, 0, len(lines))
	for _, line := range lines {
		bill, ok := bills[line.billID]
		if !ok || bill.status == "void" || bill.voidedAt != nil {
			return InstructPaymentRunOutput{}, errors.New("a selected bill is no longer payable")
		}
		balance, err := purchasingBalance(bill.totalMinor, bill.paidMinor, bill.creditedMinor)
		if err != nil {
			return InstructPaymentRunOutput{}, err
		}
		selection = append(selection, paymentRunSelection{
			billID: bill.id, currency: bill.currency,
			outstandingMinor: balance.outstandingMinor, payMinor: line.amountMinor,
		})
	}
	validated, err := paymentRunValidate(selection)
	if err != nil {
		return InstructPaymentRunOutput{}, err
	}
	if validated.currency != currency || validated.totalMinor != totalMinor {
		return InstructPaymentRunOutput{}, errors.New("payment run total changed; cancel this draft and review the current bills")
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: orgID, Memo: fmt.Sprintf("Supplier payment run %s", reference),
		SourceType: "supplier_payment_run", SourceID: &runID, Currency: currency,
		PostedAt: now, ActorType: claims.ActorType, ActorID: claims.ActorID,
		Lines: []JournalEntryLineInput{
			{AccountCode: accountsPayableAccountCode, DebitMinor: validated.totalMinor},
			{AccountCode: cashAccountCode, CreditMinor: validated.totalMinor},
		},
	})
	if err != nil {
		return InstructPaymentRunOutput{}, err
	}
	for _, line := range lines {
		bill := bills[line.billID]
		var paymentID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO vendor_payments (org_id, bill_id, amount_minor, method, entry_id, payment_run_id, status, paid_at)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, 'instructed', $7)
			RETURNING id::text`, orgID, bill.id, line.amountMinor, paymentRunBankMethod, entryID, runID, now).Scan(&paymentID); err != nil {
			return InstructPaymentRunOutput{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE payment_run_lines SET vendor_payment_id = $2::uuid WHERE id = $1::uuid`, line.id, paymentID); err != nil {
			return InstructPaymentRunOutput{}, err
		}
		settled, err := purchasingBalance(bill.totalMinor, bill.paidMinor+line.amountMinor, bill.creditedMinor)
		if err != nil {
			return InstructPaymentRunOutput{}, err
		}
		newStatus := bill.status
		if settled.fullySettled {
			newStatus = "paid"
		}
		if _, err := tx.Exec(ctx, `UPDATE vendor_bills SET paid_minor = $2, status = $3 WHERE id = $1::uuid`, bill.id, bill.paidMinor+line.amountMinor, newStatus); err != nil {
			return InstructPaymentRunOutput{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE payment_runs SET status = 'instructed', journal_entry_id = $2::uuid, instructed_at = $3
		WHERE id = $1::uuid`, runID, entryID, now); err != nil {
		return InstructPaymentRunOutput{}, err
	}
	return InstructPaymentRunOutput{
		PaymentRunID: runID, Reference: reference, Currency: currency,
		TotalMinor: validated.totalMinor, EntryID: entryID, BillCount: len(lines), Status: "instructed",
	}, nil
}

func reversePaymentRun(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ReversePaymentRunInput, now time.Time) (ReversePaymentRunOutput, error) {
	orgID := claims.OrganizationID
	var runID, reference, status string
	var journalEntryID *string
	err := tx.QueryRow(ctx, `
		SELECT id::text, reference, status, journal_entry_id::text
		FROM payment_runs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.PaymentRunID, orgID).Scan(&runID, &reference, &status, &journalEntryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReversePaymentRunOutput{}, errors.New("only an instructed, unconfirmed run can be reversed; confirmed payments require a refund or bank correction")
	}
	if err != nil {
		return ReversePaymentRunOutput{}, err
	}
	if status != "instructed" || journalEntryID == nil || *journalEntryID == "" {
		return ReversePaymentRunOutput{}, errors.New("only an instructed, unconfirmed run can be reversed; confirmed payments require a refund or bank correction")
	}
	originalID := *journalEntryID
	var originalCurrency string
	if err := tx.QueryRow(ctx, `
		SELECT currency
		FROM journal_entries
		WHERE id = $1::uuid AND org_id = $2::uuid`, originalID, orgID).Scan(&originalCurrency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ReversePaymentRunOutput{}, errors.New("payment run journal entry not found")
		}
		return ReversePaymentRunOutput{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl
		JOIN accounts a ON a.id = jl.account_id AND a.org_id = $2::uuid
		WHERE jl.entry_id = $1::uuid
		ORDER BY jl.id`, originalID, orgID)
	if err != nil {
		return ReversePaymentRunOutput{}, err
	}
	lines := make([]JournalEntryLineInput, 0, 4)
	for rows.Next() {
		var code string
		var debit, credit int64
		if err := rows.Scan(&code, &debit, &credit); err != nil {
			rows.Close()
			return ReversePaymentRunOutput{}, err
		}
		lines = append(lines, JournalEntryLineInput{AccountCode: code, DebitMinor: credit, CreditMinor: debit})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ReversePaymentRunOutput{}, err
	}
	rows.Close()
	// Posted rows stay immutable; the reversal is a new entry linked by
	// reversal_of_id that keeps the original's currency (ADR 0021).
	reversalEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID: orgID, Memo: fmt.Sprintf("Reverse payment run %s: %s", reference, input.Reason),
		SourceType: "supplier_payment_run_reversal", SourceID: &runID, ReversalOfID: &originalID,
		Currency: originalCurrency, PostedAt: now,
		ActorType: claims.ActorType, ActorID: claims.ActorID, Lines: lines,
	})
	if err != nil {
		return ReversePaymentRunOutput{}, err
	}
	reversalLines, err := loadPaymentRunReversalLines(ctx, tx, orgID, runID)
	if err != nil {
		return ReversePaymentRunOutput{}, err
	}
	for _, line := range reversalLines {
		var totalMinor, paidMinor, creditedMinor int64
		err := tx.QueryRow(ctx, `
			SELECT total_minor, paid_minor, credited_minor
			FROM vendor_bills
			WHERE id = $1::uuid AND org_id = $2::uuid
			FOR UPDATE`, line.billID, orgID).Scan(&totalMinor, &paidMinor, &creditedMinor)
		if errors.Is(err, pgx.ErrNoRows) {
			return ReversePaymentRunOutput{}, errors.New("bill payment balance changed; the run cannot be reversed safely")
		}
		if err != nil {
			return ReversePaymentRunOutput{}, err
		}
		if paidMinor < line.amountMinor {
			return ReversePaymentRunOutput{}, errors.New("bill payment balance changed; the run cannot be reversed safely")
		}
		released, err := purchasingBalance(totalMinor, paidMinor-line.amountMinor, creditedMinor)
		if err != nil {
			return ReversePaymentRunOutput{}, err
		}
		newStatus := "open"
		if released.fullySettled {
			newStatus = "paid"
		}
		if _, err := tx.Exec(ctx, `UPDATE vendor_bills SET paid_minor = $2, status = $3 WHERE id = $1::uuid`, line.billID, paidMinor-line.amountMinor, newStatus); err != nil {
			return ReversePaymentRunOutput{}, err
		}
		if line.vendorPaymentID != nil {
			if _, err := tx.Exec(ctx, `
				UPDATE vendor_payments SET status = 'reversed', reversed_at = $2, reversal_entry_id = $3::uuid
				WHERE id = $1::uuid`, *line.vendorPaymentID, now, reversalEntryID); err != nil {
				return ReversePaymentRunOutput{}, err
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE payment_runs SET status = 'reversed', reversal_entry_id = $2::uuid WHERE id = $1::uuid`, runID, reversalEntryID); err != nil {
		return ReversePaymentRunOutput{}, err
	}
	return ReversePaymentRunOutput{PaymentRunID: runID, ReversalEntryID: reversalEntryID, Status: "reversed"}, nil
}

type paymentRunReversalLine struct {
	billID          string
	vendorPaymentID *string
	amountMinor     int64
}

func loadPaymentRunReversalLines(ctx context.Context, tx pgx.Tx, orgID, runID string) ([]paymentRunReversalLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT vendor_bill_id::text, vendor_payment_id::text, amount_minor
		FROM payment_run_lines
		WHERE payment_run_id = $1::uuid AND org_id = $2::uuid
		ORDER BY id`, runID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := make([]paymentRunReversalLine, 0, 8)
	for rows.Next() {
		var line paymentRunReversalLine
		if err := rows.Scan(&line.billID, &line.vendorPaymentID, &line.amountMinor); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

func paymentRunsTimestamp(at time.Time) string {
	return at.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func listPaymentRuns(ctx context.Context, tx pgx.Tx, orgID string, _ ListPaymentRunsInput) (ListPaymentRunsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, reference, currency, total_minor, status, created_at, instructed_at, confirmed_at, journal_entry_id::text
		FROM payment_runs
		WHERE org_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return ListPaymentRunsOutput{}, err
	}
	runs := make([]PaymentRunItem, 0, 8)
	runIDs := make([]string, 0, 8)
	for rows.Next() {
		var item PaymentRunItem
		var createdAt time.Time
		var instructedAt, confirmedAt *time.Time
		if err := rows.Scan(&item.ID, &item.Reference, &item.Currency, &item.TotalMinor, &item.Status, &createdAt, &instructedAt, &confirmedAt, &item.EntryID); err != nil {
			rows.Close()
			return ListPaymentRunsOutput{}, err
		}
		item.CreatedAt = paymentRunsTimestamp(createdAt)
		if instructedAt != nil {
			stamp := paymentRunsTimestamp(*instructedAt)
			item.InstructedAt = &stamp
		}
		if confirmedAt != nil {
			stamp := paymentRunsTimestamp(*confirmedAt)
			item.ConfirmedAt = &stamp
		}
		item.Lines = []PaymentRunLineItem{}
		runIDs = append(runIDs, item.ID)
		runs = append(runs, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ListPaymentRunsOutput{}, err
	}
	rows.Close()
	if len(runs) == 0 {
		return ListPaymentRunsOutput{Runs: runs}, nil
	}
	lineRows, err := tx.Query(ctx, `
		SELECT prl.payment_run_id::text, vb.id::text, vb.number, v.name, vb.vendor_ref, prl.amount_minor
		FROM payment_run_lines prl
		JOIN vendor_bills vb ON vb.id = prl.vendor_bill_id
		JOIN vendors v ON v.id = vb.vendor_id
		WHERE prl.org_id = $1::uuid AND prl.payment_run_id = ANY($2::uuid[])
		ORDER BY vb.number`, orgID, runIDs)
	if err != nil {
		return ListPaymentRunsOutput{}, err
	}
	linesByRun := make(map[string][]PaymentRunLineItem, len(runIDs))
	for lineRows.Next() {
		var runID, billID, vendorName string
		var billNumber, amountMinor int64
		var vendorRef *string
		if err := lineRows.Scan(&runID, &billID, &billNumber, &vendorName, &vendorRef, &amountMinor); err != nil {
			lineRows.Close()
			return ListPaymentRunsOutput{}, err
		}
		linesByRun[runID] = append(linesByRun[runID], PaymentRunLineItem{
			BillID: billID, BillNumber: billNumber, VendorName: vendorName,
			VendorRef: vendorRef, AmountMinor: amountMinor,
		})
	}
	if err := lineRows.Err(); err != nil {
		lineRows.Close()
		return ListPaymentRunsOutput{}, err
	}
	lineRows.Close()
	for index := range runs {
		if lines, ok := linesByRun[runs[index].ID]; ok {
			runs[index].Lines = lines
		}
	}
	return ListPaymentRunsOutput{Runs: runs}, nil
}

func listPaymentRunBills(ctx context.Context, tx pgx.Tx, orgID string, _ ListPaymentRunBillsInput) (ListPaymentRunBillsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT vb.id::text, vb.number, v.name, vb.vendor_ref, vb.currency,
			vb.total_minor, vb.paid_minor, vb.credited_minor
		FROM vendor_bills vb
		JOIN vendors v ON v.id = vb.vendor_id AND v.org_id = vb.org_id
		WHERE vb.org_id = $1::uuid AND vb.status = 'open' AND vb.voided_at IS NULL
		ORDER BY vb.due_at ASC NULLS LAST, vb.number ASC`, orgID)
	if err != nil {
		return ListPaymentRunBillsOutput{}, err
	}
	defer rows.Close()
	out := ListPaymentRunBillsOutput{Bills: make([]PaymentRunBill, 0)}
	for rows.Next() {
		var bill PaymentRunBill
		var totalMinor, paidMinor, creditedMinor int64
		if err := rows.Scan(&bill.ID, &bill.Number, &bill.VendorName, &bill.VendorRef, &bill.Currency, &totalMinor, &paidMinor, &creditedMinor); err != nil {
			return ListPaymentRunBillsOutput{}, err
		}
		balance, err := purchasingBalance(totalMinor, paidMinor, creditedMinor)
		if err != nil {
			return ListPaymentRunBillsOutput{}, err
		}
		if balance.outstandingMinor <= 0 {
			continue
		}
		bill.DueMinor = balance.outstandingMinor
		out.Bills = append(out.Bills, bill)
	}
	if err := rows.Err(); err != nil {
		return ListPaymentRunBillsOutput{}, err
	}
	return out, nil
}

func parsePurchasingPaymentRunInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createPaymentRunCapabilityID:
		return ParseCreatePaymentRunInput(raw)
	case cancelPaymentRunDraftCapabilityID:
		return ParseCancelPaymentRunDraftInput(raw)
	case restorePaymentRunDraftCapabilityID:
		return ParseRestorePaymentRunDraftInput(raw)
	case instructPaymentRunCapabilityID:
		return ParseInstructPaymentRunInput(raw)
	case reversePaymentRunCapabilityID:
		return ParseReversePaymentRunInput(raw)
	case listPaymentRunsCapabilityID:
		return ParseListPaymentRunsInput(raw)
	case listPaymentRunBillsCapabilityID:
		return ParseListPaymentRunBillsInput(raw)
	default:
		return nil, errors.New("unsupported purchasing payment run capability")
	}
}
