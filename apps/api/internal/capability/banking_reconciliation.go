package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	addBankAccountCapabilityID           = "accounting.addBankAccount"
	importBankFeedCapabilityID           = "accounting.importBankFeed"
	deleteBankTransactionCapabilityID    = "accounting.deleteBankTransaction"
	matchBankTransactionCapabilityID     = "accounting.matchBankTransaction"
	unmatchBankTransactionCapabilityID   = "accounting.unmatchBankTransaction"
	bankReconciliationCapabilityID       = "accounting.bankReconciliation"
	excludeBankTransactionCapabilityID   = "accounting.excludeBankTransaction"
	unexcludeBankTransactionCapabilityID = "accounting.unexcludeBankTransaction"
	bankSummaryCapabilityID              = "accounting.bankSummary"
)

type AddBankAccountInput struct {
	Name         string  `json:"name"`
	CurrencyCode *string `json:"currencyCode,omitempty"`
	Last4        *string `json:"last4,omitempty"`
	BalanceMinor int64   `json:"balanceMinor"`
}

type AddBankAccountOutput struct {
	BankAccountID string `json:"bankAccountId"`
}

type BankFeedRow struct {
	PostedAt    string `json:"postedAt"`
	AmountMinor int64  `json:"amountMinor"`
	Description string `json:"description"`
}

type ImportBankFeedInput struct {
	BankAccountID *string       `json:"bankAccountId,omitempty"`
	Rows          []BankFeedRow `json:"rows"`
}

type ImportBankFeedOutput struct {
	Inserted int `json:"inserted"`
	Skipped  int `json:"skipped"`
}

type DeleteBankTransactionInput struct {
	TransactionID string `json:"transactionId"`
}

type DeleteBankTransactionOutput struct {
	Deleted bool `json:"deleted"`
}

type MatchBankTransactionInput struct {
	TransactionID   string  `json:"transactionId"`
	PaymentID       *string `json:"paymentId,omitempty"`
	EntryID         *string `json:"entryId,omitempty"`
	AmountMinor     *int64  `json:"amountMinor,omitempty"`
	FeeMinor        *int64  `json:"feeMinor,omitempty"`
	FxGainLossMinor *int64  `json:"fxGainLossMinor,omitempty"`
	Note            *string `json:"note,omitempty"`
}

type MatchBankTransactionOutput struct {
	Status               string `json:"status"`
	AllocatedMinor       int64  `json:"allocatedMinor"`
	LineUnexplainedMinor int64  `json:"lineUnexplainedMinor"`
}

type UnmatchBankTransactionInput struct {
	TransactionID string `json:"transactionId"`
}

type UnmatchBankTransactionOutput struct {
	Status        string `json:"status"`
	ReleasedMinor int64  `json:"releasedMinor"`
}

type BankReconciliationInput struct {
	BankAccountID string  `json:"bankAccountId"`
	From          *string `json:"from,omitempty"`
	To            *string `json:"to,omitempty"`
}

type BankReconciliationTotals struct {
	LinesMinor       int64 `json:"linesMinor"`
	AllocatedMinor   int64 `json:"allocatedMinor"`
	UnexplainedMinor int64 `json:"unexplainedMinor"`
	Reconciled       bool  `json:"reconciled"`
}

type BankReconciliationLine struct {
	ID               string `json:"id"`
	PostedAt         string `json:"postedAt"`
	AmountMinor      int64  `json:"amountMinor"`
	AllocatedMinor   int64  `json:"allocatedMinor"`
	UnexplainedMinor int64  `json:"unexplainedMinor"`
	Status           string `json:"status"`
}

type BankReconciliationOutput struct {
	Totals BankReconciliationTotals `json:"totals"`
	Lines  []BankReconciliationLine `json:"lines"`
}

type ExcludeBankTransactionInput struct {
	TransactionID string `json:"transactionId"`
}

type ExcludeBankTransactionOutput struct {
	Status string `json:"status"`
}

type UnexcludeBankTransactionInput struct {
	TransactionID string `json:"transactionId"`
}

type UnexcludeBankTransactionOutput struct {
	Status string `json:"status"`
}

type BankSummaryInput struct{}

type BankSummaryAccount struct {
	BankAccountID string  `json:"bankAccountId"`
	Name          string  `json:"name"`
	CurrencyCode  string  `json:"currencyCode"`
	Last4         *string `json:"last4"`
	BalanceMinor  int64   `json:"balanceMinor"`
	Count         int64   `json:"count"`
	MoneyInMinor  int64   `json:"moneyInMinor"`
	MoneyOutMinor int64   `json:"moneyOutMinor"`
}

type BankSummaryOutput struct {
	Accounts       []BankSummaryAccount `json:"accounts"`
	UnmatchedCount int64                `json:"unmatchedCount"`
}

func parseBankingInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case addBankAccountCapabilityID:
		return ParseAddBankAccountInput(raw)
	case importBankFeedCapabilityID:
		return ParseImportBankFeedInput(raw)
	case deleteBankTransactionCapabilityID:
		return ParseDeleteBankTransactionInput(raw)
	case matchBankTransactionCapabilityID:
		return ParseMatchBankTransactionInput(raw)
	case unmatchBankTransactionCapabilityID:
		return ParseUnmatchBankTransactionInput(raw)
	case bankReconciliationCapabilityID:
		return ParseBankReconciliationInput(raw)
	case excludeBankTransactionCapabilityID:
		return ParseExcludeBankTransactionInput(raw)
	case unexcludeBankTransactionCapabilityID:
		return ParseUnexcludeBankTransactionInput(raw)
	case bankSummaryCapabilityID:
		return ParseBankSummaryInput(raw)
	default:
		return nil, errors.New("unsupported banking capability")
	}
}

var bankISODatePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
var bankLast4Pattern = regexp.MustCompile(`^[0-9]{4}$`)

func bankOptionalUUID(fields map[string]json.RawMessage, key string) (*string, error) {
	value, err := optionalString(fields, key)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, nil
	}
	if !isZodUUID(*value) {
		return nil, fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

func bankRequiredTransactionID(fields map[string]json.RawMessage) (string, error) {
	value, err := requiredString(fields, "transactionId")
	if err != nil {
		return "", err
	}
	if !isZodUUID(value) {
		return "", errors.New("transactionId must be a UUID")
	}
	return value, nil
}

func bankRequiredInteger(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, fmt.Errorf("%s is required", key)
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || (trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9')) {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return requiredSafeInteger(fields, key)
}

func bankOptionalInteger(fields map[string]json.RawMessage, key string) (*int64, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || (trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9')) {
		return nil, fmt.Errorf("%s must be an integer", key)
	}
	value, err := requiredSafeInteger(fields, key)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func ParseAddBankAccountInput(raw json.RawMessage) (AddBankAccountInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return AddBankAccountInput{}, err
	}
	var input AddBankAccountInput
	if input.Name, err = requiredString(fields, "name"); err != nil {
		return AddBankAccountInput{}, err
	}
	if utf16Length(input.Name) < 1 {
		return AddBankAccountInput{}, errors.New("name must contain at least one character")
	}
	if input.CurrencyCode, err = optionalString(fields, "currencyCode"); err != nil {
		return AddBankAccountInput{}, err
	} else if input.CurrencyCode != nil {
		if utf16Length(*input.CurrencyCode) != 3 {
			return AddBankAccountInput{}, errors.New("currencyCode must contain exactly 3 characters")
		}
		upper := strings.ToUpper(*input.CurrencyCode)
		if _, known := currencyMinorUnits(upper); !known {
			return AddBankAccountInput{}, errors.New("currencyCode must be a known currency code")
		}
		input.CurrencyCode = &upper
	}
	if input.Last4, err = optionalString(fields, "last4"); err != nil {
		return AddBankAccountInput{}, err
	} else if input.Last4 != nil && !bankLast4Pattern.MatchString(*input.Last4) {
		return AddBankAccountInput{}, errors.New("last4 must be exactly 4 digits")
	}
	if value, err := bankOptionalInteger(fields, "balanceMinor"); err != nil {
		return AddBankAccountInput{}, errors.New("balanceMinor must be an integer")
	} else if value != nil {
		input.BalanceMinor = *value
	}
	return input, nil
}

func ParseImportBankFeedInput(raw json.RawMessage) (ImportBankFeedInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ImportBankFeedInput{}, err
	}
	var input ImportBankFeedInput
	if input.BankAccountID, err = bankOptionalUUID(fields, "bankAccountId"); err != nil {
		return ImportBankFeedInput{}, err
	}
	rowsRaw, ok := fields["rows"]
	if !ok || bytes.Equal(bytes.TrimSpace(rowsRaw), []byte("null")) {
		return ImportBankFeedInput{}, errors.New("rows must contain at least one row")
	}
	var rowValues []json.RawMessage
	if err := json.Unmarshal(rowsRaw, &rowValues); err != nil {
		return ImportBankFeedInput{}, errors.New("rows must be an array")
	}
	if len(rowValues) == 0 {
		return ImportBankFeedInput{}, errors.New("rows must contain at least one row")
	}
	if len(rowValues) > 500 {
		return ImportBankFeedInput{}, errors.New("rows must contain at most 500 rows")
	}
	input.Rows = make([]BankFeedRow, 0, len(rowValues))
	for _, rowRaw := range rowValues {
		rowFields, err := decodeJSONObject(rowRaw)
		if err != nil {
			return ImportBankFeedInput{}, errors.New("each feed row must be an object")
		}
		var row BankFeedRow
		if row.PostedAt, err = requiredString(rowFields, "postedAt"); err != nil {
			return ImportBankFeedInput{}, err
		}
		if !bankISODatePattern.MatchString(row.PostedAt) {
			return ImportBankFeedInput{}, errors.New("postedAt must be a YYYY-MM-DD date")
		}
		if row.AmountMinor, err = bankRequiredInteger(rowFields, "amountMinor"); err != nil {
			return ImportBankFeedInput{}, err
		}
		if row.Description, err = requiredString(rowFields, "description"); err != nil {
			return ImportBankFeedInput{}, err
		}
		if utf16Length(row.Description) < 1 {
			return ImportBankFeedInput{}, errors.New("description must contain at least one character")
		}
		input.Rows = append(input.Rows, row)
	}
	return input, nil
}

func ParseDeleteBankTransactionInput(raw json.RawMessage) (DeleteBankTransactionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DeleteBankTransactionInput{}, err
	}
	var input DeleteBankTransactionInput
	if input.TransactionID, err = bankRequiredTransactionID(fields); err != nil {
		return DeleteBankTransactionInput{}, err
	}
	return input, nil
}

func ParseMatchBankTransactionInput(raw json.RawMessage) (MatchBankTransactionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MatchBankTransactionInput{}, err
	}
	var input MatchBankTransactionInput
	if input.TransactionID, err = bankRequiredTransactionID(fields); err != nil {
		return MatchBankTransactionInput{}, err
	}
	if input.PaymentID, err = bankOptionalUUID(fields, "paymentId"); err != nil {
		return MatchBankTransactionInput{}, err
	}
	if input.EntryID, err = bankOptionalUUID(fields, "entryId"); err != nil {
		return MatchBankTransactionInput{}, err
	}
	if input.AmountMinor, err = bankOptionalInteger(fields, "amountMinor"); err != nil {
		return MatchBankTransactionInput{}, errors.New("amountMinor must be an integer")
	} else if input.AmountMinor != nil && *input.AmountMinor <= 0 {
		return MatchBankTransactionInput{}, errors.New("amountMinor must be a positive integer")
	}
	if input.FeeMinor, err = bankOptionalInteger(fields, "feeMinor"); err != nil {
		return MatchBankTransactionInput{}, errors.New("feeMinor must be an integer")
	} else if input.FeeMinor != nil && *input.FeeMinor <= 0 {
		return MatchBankTransactionInput{}, errors.New("feeMinor must be a positive integer")
	}
	if input.FxGainLossMinor, err = bankOptionalInteger(fields, "fxGainLossMinor"); err != nil {
		return MatchBankTransactionInput{}, errors.New("fxGainLossMinor must be an integer")
	}
	if input.Note, err = optionalString(fields, "note"); err != nil {
		return MatchBankTransactionInput{}, err
	} else if input.Note != nil && utf16Length(*input.Note) > 500 {
		return MatchBankTransactionInput{}, errors.New("note must contain at most 500 characters")
	}
	if (input.PaymentID != nil) == (input.EntryID != nil) {
		return MatchBankTransactionInput{}, errors.New("pass exactly one of paymentId or entryId")
	}
	if input.FeeMinor != nil && input.PaymentID == nil {
		return MatchBankTransactionInput{}, errors.New("feeMinor requires paymentId")
	}
	if input.FxGainLossMinor != nil && input.PaymentID == nil {
		return MatchBankTransactionInput{}, errors.New("fxGainLossMinor requires paymentId")
	}
	if input.AmountMinor != nil && (input.FeeMinor != nil || input.FxGainLossMinor != nil) {
		return MatchBankTransactionInput{}, errors.New("amountMinor (partial split) cannot be combined with feeMinor or fxGainLossMinor")
	}
	return input, nil
}

func ParseUnmatchBankTransactionInput(raw json.RawMessage) (UnmatchBankTransactionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return UnmatchBankTransactionInput{}, err
	}
	var input UnmatchBankTransactionInput
	if input.TransactionID, err = bankRequiredTransactionID(fields); err != nil {
		return UnmatchBankTransactionInput{}, err
	}
	return input, nil
}

func ParseBankReconciliationInput(raw json.RawMessage) (BankReconciliationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return BankReconciliationInput{}, err
	}
	var input BankReconciliationInput
	if input.BankAccountID, err = requiredString(fields, "bankAccountId"); err != nil {
		return BankReconciliationInput{}, err
	}
	if !isZodUUID(input.BankAccountID) {
		return BankReconciliationInput{}, errors.New("bankAccountId must be a UUID")
	}
	if input.From, err = optionalString(fields, "from"); err != nil {
		return BankReconciliationInput{}, err
	} else if input.From != nil && !bankISODatePattern.MatchString(*input.From) {
		return BankReconciliationInput{}, errors.New("from must be a YYYY-MM-DD date")
	}
	if input.To, err = optionalString(fields, "to"); err != nil {
		return BankReconciliationInput{}, err
	} else if input.To != nil && !bankISODatePattern.MatchString(*input.To) {
		return BankReconciliationInput{}, errors.New("to must be a YYYY-MM-DD date")
	}
	return input, nil
}

func ParseExcludeBankTransactionInput(raw json.RawMessage) (ExcludeBankTransactionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ExcludeBankTransactionInput{}, err
	}
	var input ExcludeBankTransactionInput
	if input.TransactionID, err = bankRequiredTransactionID(fields); err != nil {
		return ExcludeBankTransactionInput{}, err
	}
	return input, nil
}

func ParseUnexcludeBankTransactionInput(raw json.RawMessage) (UnexcludeBankTransactionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return UnexcludeBankTransactionInput{}, err
	}
	var input UnexcludeBankTransactionInput
	if input.TransactionID, err = bankRequiredTransactionID(fields); err != nil {
		return UnexcludeBankTransactionInput{}, err
	}
	return input, nil
}

func ParseBankSummaryInput(raw json.RawMessage) (BankSummaryInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return BankSummaryInput{}, err
	}
	return BankSummaryInput{}, nil
}

// N14 bank-reconciliation allocation math, ported from erp-core bankrec.ts.
// A statement line is explained when its signed amount is fully covered by
// allocations that share its sign; a statement period is reconciled when the
// unexplained difference is exactly zero. Pure: the caller owns locking and
// persistence.
type bankStatementLine struct {
	id          string
	amountMinor int64
	status      string
}

type bankAllocationProposal struct {
	kind        string
	amountMinor int64
}

type bankReconciliationLineDetail struct {
	line             bankStatementLine
	allocatedMinor   int64
	unexplainedMinor int64
}

type bankTotals struct {
	linesMinor       int64
	allocatedMinor   int64
	unexplainedMinor int64
	reconciled       bool
}

func bankLineUnexplained(line bankStatementLine, allocatedMinor int64) int64 {
	return line.amountMinor - allocatedMinor
}

func planBankLineAllocations(line bankStatementLine, existingAllocatedMinor int64, proposed []bankAllocationProposal) ([]bankAllocationProposal, error) {
	if line.status == "excluded" {
		return nil, errors.New("an excluded statement line cannot take allocations; unexclude it first")
	}
	if len(proposed) == 0 {
		return nil, errors.New("at least one allocation is required")
	}
	running := existingAllocatedMinor
	for _, allocation := range proposed {
		if allocation.amountMinor == 0 {
			return nil, errors.New("allocation amount must be nonzero")
		}
		if line.amountMinor > 0 && allocation.amountMinor < 0 {
			return nil, fmt.Errorf("allocation direction mismatch: line is money in (%d), allocation is %d", line.amountMinor, allocation.amountMinor)
		}
		if line.amountMinor < 0 && allocation.amountMinor > 0 {
			return nil, fmt.Errorf("allocation direction mismatch: line is money out (%d), allocation is %d", line.amountMinor, allocation.amountMinor)
		}
		running += allocation.amountMinor
		if absInt64(running) > absInt64(line.amountMinor) {
			return nil, fmt.Errorf("allocation exceeds the statement line: line is %d, allocations would reach %d", line.amountMinor, running)
		}
	}
	return proposed, nil
}

func bankPaymentRemaining(paymentAmountMinor, allocatedMinor, proposedMinor int64) (int64, error) {
	remaining := paymentAmountMinor - allocatedMinor - proposedMinor
	if remaining < 0 {
		return 0, fmt.Errorf("payment over-allocated: payment is %d, allocations would reach %d", paymentAmountMinor, allocatedMinor+proposedMinor)
	}
	return remaining, nil
}

func bankReconciliationTotals(lines []bankStatementLine, allocatedByLine map[string]int64) ([]bankReconciliationLineDetail, bankTotals, error) {
	detailed := make([]bankReconciliationLineDetail, 0, len(lines))
	var totals bankTotals
	for _, line := range lines {
		if line.status == "excluded" {
			detailed = append(detailed, bankReconciliationLineDetail{line: line})
			continue
		}
		allocated := allocatedByLine[line.id]
		if absInt64(allocated) > absInt64(line.amountMinor) {
			return nil, bankTotals{}, fmt.Errorf("line %s is over-allocated: %d against %d", line.id, allocated, line.amountMinor)
		}
		detailed = append(detailed, bankReconciliationLineDetail{
			line:             line,
			allocatedMinor:   allocated,
			unexplainedMinor: bankLineUnexplained(line, allocated),
		})
		totals.linesMinor += line.amountMinor
		totals.allocatedMinor += allocated
	}
	totals.unexplainedMinor = totals.linesMinor - totals.allocatedMinor
	totals.reconciled = totals.unexplainedMinor == 0
	return detailed, totals, nil
}

func addBankAccount(ctx context.Context, tx pgx.Tx, orgID string, input AddBankAccountInput) (AddBankAccountOutput, error) {
	currency := "USD"
	if input.CurrencyCode != nil {
		currency = *input.CurrencyCode
	} else {
		err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&currency)
		if errors.Is(err, pgx.ErrNoRows) {
			currency = "USD"
		} else if err != nil {
			return AddBankAccountOutput{}, err
		}
	}
	var accountID string
	err := tx.QueryRow(ctx, `
		INSERT INTO bank_accounts (org_id, name, currency_code, last4, balance_minor)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING id::text`, orgID, input.Name, currency, input.Last4, input.BalanceMinor).Scan(&accountID)
	if err != nil {
		return AddBankAccountOutput{}, err
	}
	return AddBankAccountOutput{BankAccountID: accountID}, nil
}

func bankFeedKey(postedAt time.Time, amountMinor int64, description string) string {
	return postedAt.UTC().Format("2006-01-02T15:04:05.000Z07:00") + "|" + strconv.FormatInt(amountMinor, 10) + "|" + description
}

func bankFeedPostedAt(value string) (time.Time, error) {
	postedAt, err := time.Parse("2006-01-02", value)
	if err != nil || postedAt.Format("2006-01-02") != value {
		return time.Time{}, fmt.Errorf("invalid date: %s", value)
	}
	return postedAt, nil
}

func importBankFeed(ctx context.Context, tx pgx.Tx, orgID string, input ImportBankFeedInput) (ImportBankFeedOutput, error) {
	var accountID string
	if input.BankAccountID != nil {
		accountID = *input.BankAccountID
	} else {
		rows, err := tx.Query(ctx, `SELECT id::text FROM bank_accounts WHERE org_id = $1::uuid`, orgID)
		if err != nil {
			return ImportBankFeedOutput{}, err
		}
		accounts := make([]string, 0, 2)
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return ImportBankFeedOutput{}, err
			}
			accounts = append(accounts, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return ImportBankFeedOutput{}, err
		}
		rows.Close()
		if len(accounts) == 0 {
			return ImportBankFeedOutput{}, errors.New("no bank account yet; add one first")
		}
		if len(accounts) > 1 {
			return ImportBankFeedOutput{}, errors.New("several bank accounts exist; pass bankAccountId")
		}
		accountID = accounts[0]
	}
	var found string
	err := tx.QueryRow(ctx, `SELECT id::text FROM bank_accounts WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`, accountID, orgID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return ImportBankFeedOutput{}, errors.New("bank account not found")
	}
	if err != nil {
		return ImportBankFeedOutput{}, err
	}

	seen := make(map[string]struct{})
	rows, err := tx.Query(ctx, `
		SELECT posted_at, amount_minor, description
		FROM bank_transactions
		WHERE org_id = $1::uuid AND bank_account_id = $2::uuid`, orgID, accountID)
	if err != nil {
		return ImportBankFeedOutput{}, err
	}
	for rows.Next() {
		var postedAt time.Time
		var amountMinor int64
		var description string
		if err := rows.Scan(&postedAt, &amountMinor, &description); err != nil {
			rows.Close()
			return ImportBankFeedOutput{}, err
		}
		seen[bankFeedKey(postedAt, amountMinor, description)] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ImportBankFeedOutput{}, err
	}
	rows.Close()

	freshPostedAt := make([]time.Time, 0, len(input.Rows))
	freshAmounts := make([]int64, 0, len(input.Rows))
	freshDescriptions := make([]string, 0, len(input.Rows))
	skipped := 0
	for _, row := range input.Rows {
		postedAt, err := bankFeedPostedAt(row.PostedAt)
		if err != nil {
			return ImportBankFeedOutput{}, err
		}
		key := bankFeedKey(postedAt, row.AmountMinor, row.Description)
		if _, duplicate := seen[key]; duplicate {
			skipped++
			continue
		}
		seen[key] = struct{}{}
		freshPostedAt = append(freshPostedAt, postedAt)
		freshAmounts = append(freshAmounts, row.AmountMinor)
		freshDescriptions = append(freshDescriptions, row.Description)
	}
	if len(freshPostedAt) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO bank_transactions (org_id, bank_account_id, posted_at, amount_minor, description)
			SELECT $1::uuid, $2::uuid, posted_at, amount_minor, description
			FROM unnest($3::timestamptz[], $4::bigint[], $5::text[]) AS f(posted_at, amount_minor, description)`,
			orgID, accountID, freshPostedAt, freshAmounts, freshDescriptions); err != nil {
			return ImportBankFeedOutput{}, err
		}
	}
	return ImportBankFeedOutput{Inserted: len(freshPostedAt), Skipped: skipped}, nil
}

func deleteBankTransaction(ctx context.Context, tx pgx.Tx, orgID string, input DeleteBankTransactionInput) (DeleteBankTransactionOutput, error) {
	tag, err := tx.Exec(ctx, `
		DELETE FROM bank_transactions
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'unmatched'`, input.TransactionID, orgID)
	if err != nil {
		return DeleteBankTransactionOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return DeleteBankTransactionOutput{}, errors.New("transaction not found or already matched/excluded")
	}
	return DeleteBankTransactionOutput{Deleted: true}, nil
}

type pendingBankAllocation struct {
	kind        string
	amountMinor int64
	paymentID   *string
	note        *string
}

func matchBankTransaction(ctx context.Context, tx pgx.Tx, orgID string, input MatchBankTransactionInput, now time.Time) (MatchBankTransactionOutput, error) {
	var lineID, lineStatus, accountCurrency string
	var lineAmountMinor int64
	err := tx.QueryRow(ctx, `
		SELECT bt.id::text, bt.status, bt.amount_minor, ba.currency_code
		FROM bank_transactions bt
		JOIN bank_accounts ba ON ba.id = bt.bank_account_id
		WHERE bt.id = $1::uuid AND bt.org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.TransactionID, orgID).Scan(&lineID, &lineStatus, &lineAmountMinor, &accountCurrency)
	if errors.Is(err, pgx.ErrNoRows) {
		return MatchBankTransactionOutput{}, errors.New("bank transaction not found")
	}
	if err != nil {
		return MatchBankTransactionOutput{}, err
	}
	if lineStatus == "excluded" {
		return MatchBankTransactionOutput{}, errors.New("transaction is excluded; unexclude it before matching")
	}
	var existingAllocated int64
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(sum(amount_minor), 0)
		FROM bank_allocations
		WHERE org_id = $1::uuid AND transaction_id = $2::uuid`, orgID, lineID).Scan(&existingAllocated); err != nil {
		return MatchBankTransactionOutput{}, err
	}
	line := bankStatementLine{id: lineID, amountMinor: lineAmountMinor, status: lineStatus}

	var proposed []pendingBankAllocation
	if input.PaymentID != nil {
		var paymentID string
		var paymentAmountMinor int64
		var invoiceCurrency string
		err := tx.QueryRow(ctx, `
			SELECT p.id::text, p.amount_minor, i.currency
			FROM payments p
			JOIN invoices i ON i.id = p.invoice_id
			WHERE p.id = $1::uuid AND p.org_id = $2::uuid
			FOR UPDATE`, *input.PaymentID, orgID).Scan(&paymentID, &paymentAmountMinor, &invoiceCurrency)
		if errors.Is(err, pgx.ErrNoRows) {
			return MatchBankTransactionOutput{}, errors.New("payment not found")
		}
		if err != nil {
			return MatchBankTransactionOutput{}, err
		}
		if lineAmountMinor <= 0 {
			return MatchBankTransactionOutput{}, fmt.Errorf("direction mismatch: a customer payment is money in, but this statement line is money out (%d)", lineAmountMinor)
		}
		if invoiceCurrency != accountCurrency {
			return MatchBankTransactionOutput{}, fmt.Errorf("currency mismatch: statement account is %s, payment is %s", accountCurrency, invoiceCurrency)
		}
		var paymentAllocated int64
		if err := tx.QueryRow(ctx, `
			SELECT coalesce(sum(amount_minor), 0)
			FROM bank_allocations
			WHERE org_id = $1::uuid AND payment_id = $2::uuid`, orgID, paymentID).Scan(&paymentAllocated); err != nil {
			return MatchBankTransactionOutput{}, err
		}

		if input.AmountMinor != nil {
			proposed = []pendingBankAllocation{{kind: "payment", amountMinor: *input.AmountMinor, paymentID: &paymentID, note: input.Note}}
		} else {
			fee := int64(0)
			if input.FeeMinor != nil {
				fee = *input.FeeMinor
			}
			fx := int64(0)
			if input.FxGainLossMinor != nil {
				fx = *input.FxGainLossMinor
			}
			if paymentAmountMinor+fee+fx != lineAmountMinor-existingAllocated {
				feePart := ""
				if fee != 0 {
					feePart = fmt.Sprintf(", fee %d", fee)
				}
				fxPart := ""
				if fx != 0 {
					fxPart = fmt.Sprintf(", fx %d", fx)
				}
				return MatchBankTransactionOutput{}, fmt.Errorf(
					"amount mismatch: line has %d unexplained, payment is %d%s%s; pass feeMinor, fxGainLossMinor or a partial amountMinor to review the difference explicitly",
					lineAmountMinor-existingAllocated, paymentAmountMinor, feePart, fxPart)
			}
			proposed = append(proposed, pendingBankAllocation{kind: "payment", amountMinor: paymentAmountMinor, paymentID: &paymentID, note: input.Note})
			if fee > 0 {
				proposed = append(proposed, pendingBankAllocation{kind: "fee", amountMinor: fee, note: bankReviewedNote(input.Note, "reviewed bank fee")})
			}
			if fx != 0 {
				proposed = append(proposed, pendingBankAllocation{kind: "fx_difference", amountMinor: fx, note: bankReviewedNote(input.Note, "reviewed FX difference")})
			}
		}

		plannedProposals := make([]bankAllocationProposal, 0, len(proposed))
		for _, allocation := range proposed {
			plannedProposals = append(plannedProposals, bankAllocationProposal{kind: allocation.kind, amountMinor: allocation.amountMinor})
		}
		planned, err := planBankLineAllocations(line, existingAllocated, plannedProposals)
		if err != nil {
			return MatchBankTransactionOutput{}, err
		}
		paymentSlices := int64(0)
		for _, allocation := range planned {
			if allocation.kind == "payment" {
				paymentSlices += allocation.amountMinor
			}
		}
		if _, err := bankPaymentRemaining(paymentAmountMinor, paymentAllocated, paymentSlices); err != nil {
			return MatchBankTransactionOutput{}, err
		}
		for _, allocation := range proposed {
			if _, err := tx.Exec(ctx, `
				INSERT INTO bank_allocations (org_id, transaction_id, kind, payment_id, entry_id, amount_minor, note)
				VALUES ($1::uuid, $2::uuid, $3, $4::uuid, NULL, $5, $6)`,
				orgID, lineID, allocation.kind, allocation.paymentID, allocation.amountMinor, allocation.note); err != nil {
				return MatchBankTransactionOutput{}, err
			}
		}
	} else {
		entryID := *input.EntryID
		var entryCurrency string
		// The TypeScript statement locks the entry row, but chaste_app holds
		// only INSERT and SELECT on the posted ledger, so no row lock is
		// possible. The lock is redundant under this role: UPDATE and DELETE
		// grants are withheld and the immutability trigger refuses repairs
		// outside the ledger-maintenance context, so the entry cannot move
		// or disappear while its cash effect is being claimed.
		err := tx.QueryRow(ctx, `
			SELECT currency
			FROM journal_entries
			WHERE id = $1::uuid AND org_id = $2::uuid`, entryID, orgID).Scan(&entryCurrency)
		if errors.Is(err, pgx.ErrNoRows) {
			return MatchBankTransactionOutput{}, errors.New("journal entry not found")
		}
		if err != nil {
			return MatchBankTransactionOutput{}, err
		}
		if entryCurrency != accountCurrency {
			return MatchBankTransactionOutput{}, fmt.Errorf("currency mismatch: statement account is %s, entry is %s", accountCurrency, entryCurrency)
		}
		var cashNet int64
		if err := tx.QueryRow(ctx, `
			SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
			FROM journal_lines jl
			JOIN accounts a ON a.id = jl.account_id
			WHERE jl.entry_id = $1::uuid AND a.code = $2`, entryID, cashAccountCode).Scan(&cashNet); err != nil {
			return MatchBankTransactionOutput{}, err
		}
		unexplained := bankLineUnexplained(line, existingAllocated)
		if cashNet != unexplained {
			return MatchBankTransactionOutput{}, fmt.Errorf("cash effect mismatch: entry nets %d on account %s, statement line has %d unexplained", cashNet, cashAccountCode, unexplained)
		}
		var entryAllocated int64
		if err := tx.QueryRow(ctx, `
			SELECT coalesce(sum(amount_minor), 0)
			FROM bank_allocations
			WHERE org_id = $1::uuid AND entry_id = $2::uuid`, orgID, entryID).Scan(&entryAllocated); err != nil {
			return MatchBankTransactionOutput{}, err
		}
		if entryAllocated+unexplained > cashNet {
			return MatchBankTransactionOutput{}, fmt.Errorf("entry over-allocated: entry nets %d on account %s, allocations already explain %d", cashNet, cashAccountCode, entryAllocated)
		}
		proposed = []pendingBankAllocation{{kind: "entry", amountMinor: unexplained}}
		if _, err := tx.Exec(ctx, `
			INSERT INTO bank_allocations (org_id, transaction_id, kind, payment_id, entry_id, amount_minor, note)
			VALUES ($1::uuid, $2::uuid, 'entry', NULL, $3::uuid, $4, $5)`,
			orgID, lineID, entryID, unexplained, input.Note); err != nil {
			return MatchBankTransactionOutput{}, err
		}
		var runID string
		runErr := tx.QueryRow(ctx, `
			SELECT id::text
			FROM payment_runs
			WHERE org_id = $1::uuid AND journal_entry_id = $2::uuid AND status = 'instructed'
			LIMIT 1`, orgID, entryID).Scan(&runID)
		if runErr != nil && !errors.Is(runErr, pgx.ErrNoRows) {
			return MatchBankTransactionOutput{}, runErr
		}
		if runErr == nil && cashNet < 0 {
			if _, err := tx.Exec(ctx, `UPDATE payment_runs SET status = 'confirmed', confirmed_at = $2 WHERE id = $1::uuid`, runID, now); err != nil {
				return MatchBankTransactionOutput{}, err
			}
			if _, err := tx.Exec(ctx, `UPDATE vendor_payments SET status = 'settled' WHERE payment_run_id = $1::uuid AND status = 'instructed'`, runID); err != nil {
				return MatchBankTransactionOutput{}, err
			}
		}
	}

	allocatedMinor := existingAllocated
	for _, allocation := range proposed {
		allocatedMinor += allocation.amountMinor
	}
	tag, err := tx.Exec(ctx, `
		UPDATE bank_transactions
		SET status = 'matched'
		WHERE id = $1::uuid AND status <> 'excluded'`, lineID)
	if err != nil {
		return MatchBankTransactionOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return MatchBankTransactionOutput{}, errors.New("transaction was just excluded by someone else")
	}
	return MatchBankTransactionOutput{
		Status:               "matched",
		AllocatedMinor:       allocatedMinor,
		LineUnexplainedMinor: bankLineUnexplained(bankStatementLine{id: lineID, amountMinor: lineAmountMinor, status: "matched"}, allocatedMinor),
	}, nil
}

func bankReviewedNote(override *string, fallback string) *string {
	if override != nil {
		return override
	}
	return &fallback
}

func unmatchBankTransaction(ctx context.Context, tx pgx.Tx, orgID string, input UnmatchBankTransactionInput) (UnmatchBankTransactionOutput, error) {
	var lineID, lineStatus string
	err := tx.QueryRow(ctx, `
		SELECT id::text, status
		FROM bank_transactions
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.TransactionID, orgID).Scan(&lineID, &lineStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return UnmatchBankTransactionOutput{}, errors.New("transaction not found or not matched")
	}
	if err != nil {
		return UnmatchBankTransactionOutput{}, err
	}
	if lineStatus != "matched" {
		return UnmatchBankTransactionOutput{}, errors.New("transaction not found or not matched")
	}
	rows, err := tx.Query(ctx, `
		DELETE FROM bank_allocations
		WHERE org_id = $1::uuid AND transaction_id = $2::uuid
		RETURNING amount_minor`, orgID, lineID)
	if err != nil {
		return UnmatchBankTransactionOutput{}, err
	}
	releasedMinor := int64(0)
	for rows.Next() {
		var amountMinor int64
		if err := rows.Scan(&amountMinor); err != nil {
			rows.Close()
			return UnmatchBankTransactionOutput{}, err
		}
		releasedMinor += amountMinor
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return UnmatchBankTransactionOutput{}, err
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `UPDATE bank_transactions SET status = 'unmatched' WHERE id = $1::uuid`, lineID); err != nil {
		return UnmatchBankTransactionOutput{}, err
	}
	return UnmatchBankTransactionOutput{Status: "unmatched", ReleasedMinor: releasedMinor}, nil
}

func bankDateWindow(fromISO, toISO string) (time.Time, time.Time, error) {
	start, err := time.Parse("2006-01-02", fromISO)
	if err != nil || start.Format("2006-01-02") != fromISO {
		return time.Time{}, time.Time{}, errors.New("dates must be YYYY-MM-DD")
	}
	endExclusive, err := time.Parse("2006-01-02", toISO)
	if err != nil || endExclusive.Format("2006-01-02") != toISO {
		return time.Time{}, time.Time{}, errors.New("dates must be YYYY-MM-DD")
	}
	if endExclusive.Before(start) {
		return time.Time{}, time.Time{}, errors.New("`to` is before `from`")
	}
	return start, endExclusive.AddDate(0, 0, 1), nil
}

func bankReconciliation(ctx context.Context, tx pgx.Tx, orgID string, input BankReconciliationInput) (BankReconciliationOutput, error) {
	query := `
		SELECT id::text, amount_minor, status, posted_at
		FROM bank_transactions
		WHERE org_id = $1::uuid AND bank_account_id = $2::uuid`
	args := []any{orgID, input.BankAccountID}
	if input.From != nil && input.To != nil {
		start, end, err := bankDateWindow(*input.From, *input.To)
		if err != nil {
			return BankReconciliationOutput{}, err
		}
		query += ` AND posted_at >= $3 AND posted_at < $4`
		args = append(args, start, end)
	}
	query += ` ORDER BY posted_at LIMIT 500`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return BankReconciliationOutput{}, err
	}
	lines := make([]bankStatementLine, 0, 8)
	postedAtByLine := make(map[string]time.Time)
	for rows.Next() {
		var line bankStatementLine
		var postedAt time.Time
		if err := rows.Scan(&line.id, &line.amountMinor, &line.status, &postedAt); err != nil {
			rows.Close()
			return BankReconciliationOutput{}, err
		}
		lines = append(lines, line)
		postedAtByLine[line.id] = postedAt
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return BankReconciliationOutput{}, err
	}
	rows.Close()

	allocatedByLine := make(map[string]int64)
	if len(lines) > 0 {
		ids := make([]string, 0, len(lines))
		for _, line := range lines {
			ids = append(ids, line.id)
		}
		allocRows, err := tx.Query(ctx, `
			SELECT transaction_id::text, coalesce(sum(amount_minor), 0)
			FROM bank_allocations
			WHERE org_id = $1::uuid AND transaction_id = ANY($2::uuid[])
			GROUP BY transaction_id`, orgID, ids)
		if err != nil {
			return BankReconciliationOutput{}, err
		}
		for allocRows.Next() {
			var transactionID string
			var allocated int64
			if err := allocRows.Scan(&transactionID, &allocated); err != nil {
				allocRows.Close()
				return BankReconciliationOutput{}, err
			}
			allocatedByLine[transactionID] = allocated
		}
		if err := allocRows.Err(); err != nil {
			allocRows.Close()
			return BankReconciliationOutput{}, err
		}
		allocRows.Close()
	}

	detailed, totals, err := bankReconciliationTotals(lines, allocatedByLine)
	if err != nil {
		return BankReconciliationOutput{}, err
	}
	output := BankReconciliationOutput{Totals: BankReconciliationTotals{
		LinesMinor:       totals.linesMinor,
		AllocatedMinor:   totals.allocatedMinor,
		UnexplainedMinor: totals.unexplainedMinor,
		Reconciled:       totals.reconciled,
	}, Lines: make([]BankReconciliationLine, 0, len(detailed))}
	for _, line := range detailed {
		output.Lines = append(output.Lines, BankReconciliationLine{
			ID:               line.line.id,
			PostedAt:         postedAtByLine[line.line.id].UTC().Format("2006-01-02T15:04:05.000Z07:00"),
			AmountMinor:      line.line.amountMinor,
			AllocatedMinor:   line.allocatedMinor,
			UnexplainedMinor: line.unexplainedMinor,
			Status:           line.line.status,
		})
	}
	return output, nil
}

func excludeBankTransaction(ctx context.Context, tx pgx.Tx, orgID string, input ExcludeBankTransactionInput) (ExcludeBankTransactionOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE bank_transactions
		SET status = 'excluded'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'unmatched'`, input.TransactionID, orgID)
	if err != nil {
		return ExcludeBankTransactionOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return ExcludeBankTransactionOutput{}, errors.New("transaction not found or not unmatched")
	}
	return ExcludeBankTransactionOutput{Status: "excluded"}, nil
}

func unexcludeBankTransaction(ctx context.Context, tx pgx.Tx, orgID string, input UnexcludeBankTransactionInput) (UnexcludeBankTransactionOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE bank_transactions
		SET status = 'unmatched'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'excluded'`, input.TransactionID, orgID)
	if err != nil {
		return UnexcludeBankTransactionOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return UnexcludeBankTransactionOutput{}, errors.New("transaction not found or not excluded")
	}
	return UnexcludeBankTransactionOutput{Status: "unmatched"}, nil
}

func bankSummary(ctx context.Context, tx pgx.Tx, orgID string) (BankSummaryOutput, error) {
	accountRows, err := tx.Query(ctx, `
		SELECT id::text, name, currency_code, last4, balance_minor
		FROM bank_accounts
		WHERE org_id = $1::uuid
		ORDER BY created_at`, orgID)
	if err != nil {
		return BankSummaryOutput{}, err
	}
	accounts := make([]BankSummaryAccount, 0, 4)
	for accountRows.Next() {
		var account BankSummaryAccount
		if err := accountRows.Scan(&account.BankAccountID, &account.Name, &account.CurrencyCode, &account.Last4, &account.BalanceMinor); err != nil {
			accountRows.Close()
			return BankSummaryOutput{}, err
		}
		accounts = append(accounts, account)
	}
	if err := accountRows.Err(); err != nil {
		accountRows.Close()
		return BankSummaryOutput{}, err
	}
	accountRows.Close()

	type bankTransactionStats struct {
		count    int64
		moneyIn  int64
		moneyOut int64
	}
	statsByAccount := make(map[string]bankTransactionStats)
	statsRows, err := tx.Query(ctx, `
		SELECT bank_account_id::text, count(*),
		       coalesce(sum(case when amount_minor > 0 then amount_minor else 0 end), 0),
		       coalesce(sum(case when amount_minor < 0 then -amount_minor else 0 end), 0)
		FROM bank_transactions
		WHERE org_id = $1::uuid
		GROUP BY bank_account_id`, orgID)
	if err != nil {
		return BankSummaryOutput{}, err
	}
	for statsRows.Next() {
		var accountID string
		var stats bankTransactionStats
		if err := statsRows.Scan(&accountID, &stats.count, &stats.moneyIn, &stats.moneyOut); err != nil {
			statsRows.Close()
			return BankSummaryOutput{}, err
		}
		statsByAccount[accountID] = stats
	}
	if err := statsRows.Err(); err != nil {
		statsRows.Close()
		return BankSummaryOutput{}, err
	}
	statsRows.Close()

	var unmatchedCount int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		FROM bank_transactions
		WHERE org_id = $1::uuid AND status = 'unmatched'`, orgID).Scan(&unmatchedCount); err != nil {
		return BankSummaryOutput{}, err
	}
	output := BankSummaryOutput{Accounts: make([]BankSummaryAccount, 0, len(accounts)), UnmatchedCount: unmatchedCount}
	for _, account := range accounts {
		stats := statsByAccount[account.BankAccountID]
		account.Count = stats.count
		account.MoneyInMinor = stats.moneyIn
		account.MoneyOutMinor = stats.moneyOut
		output.Accounts = append(output.Accounts, account)
	}
	return output, nil
}
