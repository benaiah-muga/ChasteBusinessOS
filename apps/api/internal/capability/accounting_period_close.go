package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	periodCloseWorkbenchCapabilityID    = "accounting.periodCloseWorkbench"
	updatePeriodCloseCheckCapabilityID  = "accounting.updatePeriodCloseCheck"
	restorePeriodCloseCheckCapabilityID = "accounting.restorePeriodCloseCheck"
	closePeriodCapabilityID             = "accounting.closePeriod"
	reopenPeriodCapabilityID            = "accounting.reopenPeriod"
	closeYearCapabilityID               = "accounting.closeYear"
)

type ClosePeriodInput struct {
	Year  int64 `json:"year"`
	Month int64 `json:"month"`
}

type PeriodCloseTask struct {
	Key       string  `json:"key"`
	Label     string  `json:"label"`
	Detail    string  `json:"detail"`
	Completed bool    `json:"completed"`
	Note      *string `json:"note"`
	Blocking  bool    `json:"blocking"`
	Status    string  `json:"status"`
}

type PeriodCloseWorkbenchOutput struct {
	Year                   int64             `json:"year"`
	Month                  int64             `json:"month"`
	Start                  string            `json:"start"`
	End                    string            `json:"end"`
	Tasks                  []PeriodCloseTask `json:"tasks"`
	Blockers               []string          `json:"blockers"`
	ReadyToClose           bool              `json:"readyToClose"`
	UnmatchedLineCount     int64             `json:"unmatchedLineCount"`
	CurrenciesWithExposure []string          `json:"currenciesWithExposure"`
}

type PeriodCloseCheckInput struct {
	Year      int64   `json:"year"`
	Month     int64   `json:"month"`
	TaskKey   string  `json:"taskKey"`
	Completed bool    `json:"completed"`
	Note      *string `json:"note,omitempty"`
}

type PeriodCloseCheckOutput struct {
	Updated           bool    `json:"updated"`
	PreviousCompleted bool    `json:"previousCompleted"`
	PreviousNote      *string `json:"previousNote"`
}

type ClosePeriodOutput struct {
	Closed bool `json:"closed"`
}

type ReopenPeriodOutput struct {
	Reopened bool `json:"reopened"`
}

type CloseYearInput struct {
	Year int64 `json:"year"`
}

type CloseYearOutput struct {
	ClosingEntryID        string  `json:"closingEntryId"`
	ReplacedEntryID       *string `json:"replacedEntryId"`
	NetIncomeMinor        int64   `json:"netIncomeMinor"`
	RetainedEarningsMinor int64   `json:"retainedEarningsMinor"`
}

var periodCloseCheckTaskKeys = []string{"review_journal", "review_receivables", "review_payables", "review_tax"}

var periodCloseTaskDefinitions = []struct {
	Key    string
	Label  string
	Detail string
}{
	{"review_journal", "Review journal activity", "Scan unusual entries and confirm corrections are posted in the right period."},
	{"review_receivables", "Review receivables", "Check aged invoices, credits, and expected collections."},
	{"review_payables", "Review payables", "Check supplier bills, purchase commitments, and payment instructions."},
	{"review_tax", "Review tax position", "Confirm output and recoverable input tax are complete for the period."},
}

func parsePeriodCloseYearMonth(fields map[string]json.RawMessage) (int64, int64, error) {
	year, err := requiredSafeInteger(fields, "year")
	if err != nil || year < 2000 || year > 2100 {
		return 0, 0, errors.New("year must be an integer between 2000 and 2100")
	}
	month, err := requiredSafeInteger(fields, "month")
	if err != nil || month < 1 || month > 12 {
		return 0, 0, errors.New("month must be an integer between 1 and 12")
	}
	return year, month, nil
}

func parseClosePeriodInput(raw json.RawMessage) (ClosePeriodInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ClosePeriodInput{}, err
	}
	year, month, err := parsePeriodCloseYearMonth(fields)
	if err != nil {
		return ClosePeriodInput{}, err
	}
	return ClosePeriodInput{Year: year, Month: month}, nil
}

func ParsePeriodCloseWorkbenchInput(raw json.RawMessage) (ClosePeriodInput, error) {
	return parseClosePeriodInput(raw)
}

func ParseClosePeriodInput(raw json.RawMessage) (ClosePeriodInput, error) {
	return parseClosePeriodInput(raw)
}

func ParseReopenPeriodInput(raw json.RawMessage) (ClosePeriodInput, error) {
	return parseClosePeriodInput(raw)
}

func ParseCloseYearInput(raw json.RawMessage) (CloseYearInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CloseYearInput{}, err
	}
	year, err := requiredSafeInteger(fields, "year")
	if err != nil || year < 2000 || year > 2100 {
		return CloseYearInput{}, errors.New("year must be an integer between 2000 and 2100")
	}
	return CloseYearInput{Year: year}, nil
}

func parsePeriodCloseCheckInput(raw json.RawMessage) (PeriodCloseCheckInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PeriodCloseCheckInput{}, err
	}
	year, month, err := parsePeriodCloseYearMonth(fields)
	if err != nil {
		return PeriodCloseCheckInput{}, err
	}
	taskKey, err := projectRequiredEnum(fields, "taskKey", periodCloseCheckTaskKeys)
	if err != nil {
		return PeriodCloseCheckInput{}, err
	}
	completed, err := requiredBoolean(fields, "completed")
	if err != nil {
		return PeriodCloseCheckInput{}, err
	}
	note, err := optionalString(fields, "note")
	if err != nil {
		return PeriodCloseCheckInput{}, err
	} else if note != nil && utf16Length(*note) > 500 {
		return PeriodCloseCheckInput{}, errors.New("note must contain at most 500 characters")
	}
	return PeriodCloseCheckInput{Year: year, Month: month, TaskKey: taskKey, Completed: completed, Note: note}, nil
}

func ParseUpdatePeriodCloseCheckInput(raw json.RawMessage) (PeriodCloseCheckInput, error) {
	return parsePeriodCloseCheckInput(raw)
}

func ParseRestorePeriodCloseCheckInput(raw json.RawMessage) (PeriodCloseCheckInput, error) {
	return parsePeriodCloseCheckInput(raw)
}

// periodCloseWindow returns [start of month, start of next month) in UTC,
// matching Date.UTC(year, month - 1, 1) and Date.UTC(year, month, 1).
func periodCloseWindow(year, month int64) (time.Time, time.Time) {
	start := time.Date(int(year), time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(int(year), time.Month(month)+1, 1, 0, 0, 0, 0, time.UTC)
	return start, end
}

func formatPeriodCloseDay(day time.Time) string {
	return day.UTC().Format("2006-01-02T15:04:05.000Z")
}

func periodCloseBaseCurrency(ctx context.Context, tx pgx.Tx, orgID string) (string, error) {
	var base string
	err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&base)
	if errors.Is(err, pgx.ErrNoRows) {
		return "USD", nil
	} else if err != nil {
		return "", err
	}
	return base, nil
}

type periodCloseSavedCheck struct {
	completed bool
	note      *string
}

func loadPeriodCloseReadiness(ctx context.Context, tx pgx.Tx, orgID string, year, month int64) (PeriodCloseWorkbenchOutput, error) {
	start, end := periodCloseWindow(year, month)
	var unmatched int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM bank_transactions
		WHERE org_id = $1::uuid AND posted_at >= $2 AND posted_at < $3 AND status = 'unmatched'`,
		orgID, start, end).Scan(&unmatched); err != nil {
		return PeriodCloseWorkbenchOutput{}, err
	}
	base, err := periodCloseBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return PeriodCloseWorkbenchOutput{}, err
	}
	currenciesWithExposure := []string{}
	exposureRows, err := tx.Query(ctx, `
		SELECT currency, coalesce(sum(greatest(total_minor - paid_minor - credited_minor, 0)), 0)::bigint
		FROM invoices
		WHERE org_id = $1::uuid AND currency <> $2 AND issued_at < $3 AND issued_at IS NOT NULL
		  AND status <> 'void' AND voided_at IS NULL
		GROUP BY currency
		ORDER BY currency`, orgID, base, end)
	if err != nil {
		return PeriodCloseWorkbenchOutput{}, err
	}
	for exposureRows.Next() {
		var currency string
		var outstanding int64
		if err := exposureRows.Scan(&currency, &outstanding); err != nil {
			exposureRows.Close()
			return PeriodCloseWorkbenchOutput{}, err
		}
		if outstanding > 0 {
			currenciesWithExposure = append(currenciesWithExposure, currency)
		}
	}
	if err := exposureRows.Err(); err != nil {
		exposureRows.Close()
		return PeriodCloseWorkbenchOutput{}, err
	}
	exposureRows.Close()
	var revaluationEntryID *string
	var revaluationReversedAt *time.Time
	revaluationExists := false
	err = tx.QueryRow(ctx, `
		SELECT entry_id::text, reversed_at FROM period_fx_revaluations
		WHERE org_id = $1::uuid AND year = $2 AND month = $3
		LIMIT 1`, orgID, year, month).Scan(&revaluationEntryID, &revaluationReversedAt)
	if err == nil {
		revaluationExists = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return PeriodCloseWorkbenchOutput{}, err
	}
	// Reviewed means no open foreign exposure, or a live (not reversed, not
	// itself reversed) revaluation for this month.
	fxReviewed := len(currenciesWithExposure) == 0
	if !fxReviewed && revaluationExists && revaluationReversedAt == nil {
		var reversals int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM journal_entries
			WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid`, orgID, revaluationEntryID).Scan(&reversals); err != nil {
			return PeriodCloseWorkbenchOutput{}, err
		}
		fxReviewed = reversals == 0
	}
	checkRows, err := tx.Query(ctx, `
		SELECT task_key, completed, note FROM period_close_checks
		WHERE org_id = $1::uuid AND year = $2 AND month = $3`, orgID, year, month)
	if err != nil {
		return PeriodCloseWorkbenchOutput{}, err
	}
	savedByTask := make(map[string]periodCloseSavedCheck, len(periodCloseCheckTaskKeys))
	for checkRows.Next() {
		var saved periodCloseSavedCheck
		var taskKey string
		if err := checkRows.Scan(&taskKey, &saved.completed, &saved.note); err != nil {
			checkRows.Close()
			return PeriodCloseWorkbenchOutput{}, err
		}
		savedByTask[taskKey] = saved
	}
	if err := checkRows.Err(); err != nil {
		checkRows.Close()
		return PeriodCloseWorkbenchOutput{}, err
	}
	checkRows.Close()
	tasks := make([]PeriodCloseTask, 0, len(periodCloseTaskDefinitions)+2)
	blockers := []string{}
	appendTask := func(task PeriodCloseTask) {
		if task.Blocking {
			blockers = append(blockers, task.Key)
		}
		tasks = append(tasks, task)
	}
	for _, definition := range periodCloseTaskDefinitions {
		saved := savedByTask[definition.Key]
		task := PeriodCloseTask{
			Key: definition.Key, Label: definition.Label, Detail: definition.Detail,
			Completed: saved.completed, Note: saved.note, Blocking: !saved.completed,
			Status: "needs_review",
		}
		if saved.completed {
			task.Status = "complete"
		}
		appendTask(task)
	}
	bankDetail := "No unmatched statement lines in this period."
	bankStatus := "complete"
	bankBlocking := false
	if unmatched > 0 {
		bankDetail = fmt.Sprintf("%d statement line(s) remain unmatched.", unmatched)
		bankStatus = "blocked"
		bankBlocking = true
	}
	appendTask(PeriodCloseTask{
		Key: "bank_reconciliation", Label: "Reconcile bank activity", Detail: bankDetail,
		Completed: unmatched == 0, Note: nil, Blocking: bankBlocking, Status: bankStatus,
	})
	fxDetail := "No open foreign receivables need period-end revaluation."
	fxStatus := "complete"
	if !fxReviewed {
		fxDetail = "Open foreign receivables: " + strings.Join(currenciesWithExposure, ", ") + "."
		fxStatus = "needs_revaluation"
	}
	appendTask(PeriodCloseTask{
		Key: "fx_revaluation", Label: "Revalue foreign receivables", Detail: fxDetail,
		Completed: fxReviewed, Note: nil, Blocking: !fxReviewed, Status: fxStatus,
	})
	return PeriodCloseWorkbenchOutput{
		Year: year, Month: month,
		Start: formatPeriodCloseDay(start), End: formatPeriodCloseDay(end.Add(-time.Millisecond)),
		Tasks: tasks, Blockers: blockers, ReadyToClose: len(blockers) == 0,
		UnmatchedLineCount: unmatched, CurrenciesWithExposure: currenciesWithExposure,
	}, nil
}

func periodCloseWorkbench(ctx context.Context, tx pgx.Tx, orgID string, input ClosePeriodInput) (PeriodCloseWorkbenchOutput, error) {
	return loadPeriodCloseReadiness(ctx, tx, orgID, input.Year, input.Month)
}

// persistPeriodCloseCheck backs both update and restore: the inverse of one is
// the other, and both write the same checklist row while the receipt records
// the state that preceded the change.
func persistPeriodCloseCheck(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PeriodCloseCheckInput, now time.Time) (PeriodCloseCheckOutput, error) {
	orgID := claims.OrganizationID
	var previousCompleted bool
	var previousNote *string
	err := tx.QueryRow(ctx, `
		SELECT completed, note FROM period_close_checks
		WHERE org_id = $1::uuid AND year = $2 AND month = $3 AND task_key = $4
		LIMIT 1 FOR UPDATE`, orgID, input.Year, input.Month, input.TaskKey).Scan(&previousCompleted, &previousNote)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return PeriodCloseCheckOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO period_close_checks (org_id, year, month, task_key, completed, note, updated_by_actor_type, updated_by_actor_id, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9)
		ON CONFLICT (org_id, year, month, task_key) DO UPDATE SET
			completed = EXCLUDED.completed,
			note = EXCLUDED.note,
			updated_by_actor_type = EXCLUDED.updated_by_actor_type,
			updated_by_actor_id = EXCLUDED.updated_by_actor_id,
			updated_at = EXCLUDED.updated_at`,
		orgID, input.Year, input.Month, input.TaskKey, input.Completed, input.Note, claims.ActorType, claims.ActorID, now); err != nil {
		return PeriodCloseCheckOutput{}, err
	}
	return PeriodCloseCheckOutput{Updated: true, PreviousCompleted: previousCompleted, PreviousNote: previousNote}, nil
}

// lockPeriodsForOrg takes the same transaction-scoped advisory lock the
// posting door holds in lockAccountingPeriod, so a close or reopen always
// commits in one serial order with concurrent postings: either the posting
// landed first or it refuses the sealed month.
func lockPeriodsForOrg(ctx context.Context, tx pgx.Tx, orgID string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, int64(7_362_911), orgID); err != nil {
		return fmt.Errorf("lock accounting periods: %w", err)
	}
	return nil
}

func closePeriod(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ClosePeriodInput) (ClosePeriodOutput, error) {
	orgID := claims.OrganizationID
	if err := lockPeriodsForOrg(ctx, tx, orgID); err != nil {
		return ClosePeriodOutput{}, err
	}
	readiness, err := loadPeriodCloseReadiness(ctx, tx, orgID, input.Year, input.Month)
	if err != nil {
		return ClosePeriodOutput{}, err
	}
	if !readiness.ReadyToClose {
		return ClosePeriodOutput{}, fmt.Errorf("complete the close checklist first: %s", strings.Join(readiness.Blockers, ", "))
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO periods (org_id, year, month, closed_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4::uuid)
		ON CONFLICT DO NOTHING`, orgID, input.Year, input.Month, claims.ActorID); err != nil {
		return ClosePeriodOutput{}, err
	}
	return ClosePeriodOutput{Closed: true}, nil
}

func reopenPeriod(ctx context.Context, tx pgx.Tx, orgID string, input ClosePeriodInput) (ReopenPeriodOutput, error) {
	if err := lockPeriodsForOrg(ctx, tx, orgID); err != nil {
		return ReopenPeriodOutput{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM periods WHERE org_id = $1::uuid AND year = $2 AND month = $3`, orgID, input.Year, input.Month); err != nil {
		return ReopenPeriodOutput{}, err
	}
	return ReopenPeriodOutput{Reopened: true}, nil
}

type periodCloseAccountBalance struct {
	Code        string
	Name        string
	Type        string
	DebitMinor  int64
	CreditMinor int64
}

type yearEndClosingLine struct {
	AccountCode string
	DebitMinor  int64
	CreditMinor int64
}

type yearEndClosePlan struct {
	ClosingLines         []yearEndClosingLine
	RetainedEarningsLine yearEndClosingLine
	NetIncomeMinor       int64
	TotalDebitMinor      int64
	TotalCreditMinor     int64
}

// computeYearEndClose mirrors erp-core computeYearEndClose: income accounts
// are debited their credit-natural balance, expense accounts credited their
// debit-natural balance, and the difference lands on retained earnings, so
// the entry balances by construction.
func computeYearEndClose(balances []periodCloseAccountBalance, retainedEarningsCode string) yearEndClosePlan {
	plan := yearEndClosePlan{ClosingLines: []yearEndClosingLine{}}
	var net int64
	for _, balance := range balances {
		natural := balance.CreditMinor - balance.DebitMinor
		if balance.Type == "asset" || balance.Type == "expense" {
			natural = balance.DebitMinor - balance.CreditMinor
		}
		if (balance.Type != "income" && balance.Type != "expense") || natural == 0 {
			continue
		}
		if balance.Type == "income" {
			net += natural
			plan.ClosingLines = append(plan.ClosingLines, yearEndClosingLine{AccountCode: balance.Code, DebitMinor: natural})
		} else {
			net -= natural
			plan.ClosingLines = append(plan.ClosingLines, yearEndClosingLine{AccountCode: balance.Code, CreditMinor: natural})
		}
	}
	if net >= 0 {
		plan.RetainedEarningsLine = yearEndClosingLine{AccountCode: retainedEarningsCode, CreditMinor: net}
	} else {
		plan.RetainedEarningsLine = yearEndClosingLine{AccountCode: retainedEarningsCode, DebitMinor: -net}
	}
	for _, line := range plan.ClosingLines {
		plan.TotalDebitMinor += line.DebitMinor
		plan.TotalCreditMinor += line.CreditMinor
	}
	plan.TotalDebitMinor += plan.RetainedEarningsLine.DebitMinor
	plan.TotalCreditMinor += plan.RetainedEarningsLine.CreditMinor
	plan.NetIncomeMinor = net
	return plan
}

// accountBalancesForYearEnd mirrors accountBalances({excludeClosingInYear}):
// base-currency lines only, with the closing year's own rolls (and their
// in-year reversals) excluded so a re-close never re-rolls income a prior
// close already zeroed, while other years' rolls stay included.
func accountBalancesForYearEnd(ctx context.Context, tx pgx.Tx, orgID string, excludeYear int64) ([]periodCloseAccountBalance, error) {
	base, err := periodCloseBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT a.code, a.name, a.type,
			coalesce(sum(jl.debit_minor), 0), coalesce(sum(jl.credit_minor), 0)
		FROM accounts a
		LEFT JOIN journal_lines jl ON jl.account_id = a.id
		LEFT JOIN journal_entries je ON je.id = jl.entry_id
		WHERE a.org_id = $1::uuid AND je.org_id = $1::uuid
		  AND (je.currency IS NULL OR je.currency = $2)
		  AND NOT (je.entry_kind = 'year_end_close' AND extract(year from je.posted_at) = $3)
		GROUP BY a.code, a.name, a.type
		ORDER BY a.code`, orgID, base, excludeYear)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	balances := []periodCloseAccountBalance{}
	for rows.Next() {
		var balance periodCloseAccountBalance
		if err := rows.Scan(&balance.Code, &balance.Name, &balance.Type, &balance.DebitMinor, &balance.CreditMinor); err != nil {
			return nil, err
		}
		balances = append(balances, balance)
	}
	return balances, rows.Err()
}

// formatPeriodCloseMinor renders integer minor units as the decimal string
// the TypeScript memo builds with (minor / 100).toFixed(2), without going
// through floats.
func formatPeriodCloseMinor(minor int64) string {
	sign := ""
	if minor < 0 {
		sign = "-"
		minor = -minor
	}
	return fmt.Sprintf("%s%d.%02d", sign, minor/100, minor%100)
}

// closeYear rolls the fiscal year's operating result into retained earnings
// with one balanced year_end_close entry and seals December. At most one live
// roll exists per sealed year; re-closing after a reopen replaces the live
// roll, reversed at the old roll's own posted moment (which requires December
// to be open again, because the posting door refuses closed-period postings),
// before the fresh roll lands.
func closeYear(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CloseYearInput) (CloseYearOutput, error) {
	orgID := claims.OrganizationID
	base, err := periodCloseBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return CloseYearOutput{}, err
	}
	balances, err := accountBalancesForYearEnd(ctx, tx, orgID, input.Year)
	if err != nil {
		return CloseYearOutput{}, err
	}
	plan := computeYearEndClose(balances, "3100")
	if len(plan.ClosingLines) == 0 && plan.NetIncomeMinor == 0 {
		return CloseYearOutput{}, fmt.Errorf("fiscal year %d has no income or expense activity to close", input.Year)
	}
	var liveRollID string
	var liveRollPostedAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT id::text, posted_at FROM journal_entries je
		WHERE je.org_id = $1::uuid AND je.entry_kind = 'year_end_close' AND je.reversal_of_id IS NULL
		  AND extract(year from je.posted_at) = $2
		  AND NOT EXISTS (
			SELECT 1 FROM journal_entries prior
			WHERE prior.reversal_of_id = je.id AND prior.entry_kind = 'year_end_close'
		  )
		LIMIT 1`, orgID, input.Year).Scan(&liveRollID, &liveRollPostedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CloseYearOutput{}, err
	}
	var replacedEntryID *string
	if err == nil {
		priorRows, err := tx.Query(ctx, `
			SELECT a.code, jl.debit_minor, jl.credit_minor
			FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
			WHERE jl.entry_id = $1::uuid ORDER BY a.code`, liveRollID)
		if err != nil {
			return CloseYearOutput{}, err
		}
		mirror := []JournalEntryLineInput{}
		for priorRows.Next() {
			var code string
			var debitMinor, creditMinor int64
			if err := priorRows.Scan(&code, &debitMinor, &creditMinor); err != nil {
				priorRows.Close()
				return CloseYearOutput{}, err
			}
			mirror = append(mirror, JournalEntryLineInput{AccountCode: code, DebitMinor: creditMinor, CreditMinor: debitMinor})
		}
		if err := priorRows.Err(); err != nil {
			priorRows.Close()
			return CloseYearOutput{}, err
		}
		priorRows.Close()
		if _, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
			OrgID:        orgID,
			Memo:         fmt.Sprintf("Reversal of year-end close %d (replaced by re-close)", input.Year),
			SourceType:   "reversal",
			ReversalOfID: &liveRollID,
			EntryKind:    "year_end_close",
			Currency:     base,
			PostedAt:     liveRollPostedAt,
			ActorType:    claims.ActorType,
			ActorID:      claims.ActorID,
			Lines:        mirror,
		}); err != nil {
			return CloseYearOutput{}, err
		}
		replacedEntryID = &liveRollID
	}
	lines := make([]JournalEntryLineInput, 0, len(plan.ClosingLines)+1)
	for _, line := range plan.ClosingLines {
		lines = append(lines, JournalEntryLineInput{AccountCode: line.AccountCode, DebitMinor: line.DebitMinor, CreditMinor: line.CreditMinor})
	}
	lines = append(lines, JournalEntryLineInput{
		AccountCode: plan.RetainedEarningsLine.AccountCode,
		DebitMinor:  plan.RetainedEarningsLine.DebitMinor,
		CreditMinor: plan.RetainedEarningsLine.CreditMinor,
	})
	closingEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:      orgID,
		Memo:       fmt.Sprintf("Year-end close %d: net income %s rolled to retained earnings", input.Year, formatPeriodCloseMinor(plan.NetIncomeMinor)),
		SourceType: "manual",
		EntryKind:  "year_end_close",
		Currency:   base,
		PostedAt:   time.Date(int(input.Year), time.December, 31, 23, 59, 59, 0, time.UTC),
		ActorType:  claims.ActorType,
		ActorID:    claims.ActorID,
		Lines:      lines,
	})
	if err != nil {
		return CloseYearOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO periods (org_id, year, month, closed_by_actor_id)
		VALUES ($1::uuid, $2, 12, $3::uuid)
		ON CONFLICT DO NOTHING`, orgID, input.Year, claims.ActorID); err != nil {
		return CloseYearOutput{}, err
	}
	return CloseYearOutput{
		ClosingEntryID:        closingEntryID,
		ReplacedEntryID:       replacedEntryID,
		NetIncomeMinor:        plan.NetIncomeMinor,
		RetainedEarningsMinor: absInt64(plan.NetIncomeMinor),
	}, nil
}

func parseAccountingPeriodCloseInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case periodCloseWorkbenchCapabilityID:
		return ParsePeriodCloseWorkbenchInput(raw)
	case updatePeriodCloseCheckCapabilityID:
		return ParseUpdatePeriodCloseCheckInput(raw)
	case restorePeriodCloseCheckCapabilityID:
		return ParseRestorePeriodCloseCheckInput(raw)
	case closePeriodCapabilityID:
		return ParseClosePeriodInput(raw)
	case reopenPeriodCapabilityID:
		return ParseReopenPeriodInput(raw)
	case closeYearCapabilityID:
		return ParseCloseYearInput(raw)
	default:
		return nil, errors.New("unsupported accounting period close capability")
	}
}
