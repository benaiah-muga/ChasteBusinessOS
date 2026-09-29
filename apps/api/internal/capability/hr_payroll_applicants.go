package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	hrCreatePayrollRunCapabilityID      = "hr.createPayrollRun"
	hrExecutePayrollRunCapabilityID     = "hr.executePayrollRun"
	hrVoidPayrollRunCapabilityID        = "hr.voidPayrollRun"
	hrReversePayrollPostingCapabilityID = "hr.reversePayrollPosting"
	hrAddApplicantCapabilityID          = "hr.addApplicant"
	hrMoveApplicantCapabilityID         = "hr.moveApplicant"
	hrHireApplicantCapabilityID         = "hr.hireApplicant"
	hrListApplicantsCapabilityID        = "hr.listApplicants"
)

// PAYROLL_ACCOUNTS in modules/hr: DR expense (gross), CR cash (net),
// CR withholding liability (tax).
const (
	hrPayrollExpenseAccountCode     = "6000"
	hrPayrollCashAccountCode        = "1000"
	hrPayrollWithholdingAccountCode = "2200"
)

type HRCreatePayrollRunInput struct {
	Year  int64 `json:"year"`
	Month int64 `json:"month"`
}

type HRCreatePayrollRunOutput struct {
	RunID           string `json:"runId"`
	Headcount       int    `json:"headcount"`
	TotalGrossMinor int64  `json:"totalGrossMinor"`
	TotalTaxMinor   int64  `json:"totalTaxMinor"`
	TotalNetMinor   int64  `json:"totalNetMinor"`
}

type HRExecutePayrollRunInput struct {
	RunID                 string `json:"runId"`
	ExpectedTotalNetMinor int64  `json:"expectedTotalNetMinor"`
}

type HRExecutePayrollRunOutput struct {
	EntryID         string `json:"entryId"`
	TotalGrossMinor int64  `json:"totalGrossMinor"`
	TotalNetMinor   int64  `json:"totalNetMinor"`
}

type HRVoidPayrollRunInput struct {
	RunID string `json:"runId"`
}

type HRVoidPayrollRunOutput struct {
	Voided bool `json:"voided"`
}

type HRReversePayrollPostingInput struct {
	RunID  string `json:"runId"`
	Reason string `json:"reason"`
}

type HRReversePayrollPostingOutput struct {
	ReversalEntryID  string `json:"reversalEntryId"`
	ReversedNetMinor int64  `json:"reversedNetMinor"`
}

type HRAddApplicantInput struct {
	OpeningID string  `json:"openingId"`
	Name      string  `json:"name"`
	Email     *string `json:"email,omitempty"`
	Note      *string `json:"note,omitempty"`
}

type HRAddApplicantOutput struct {
	ApplicantID string `json:"applicantId"`
}

type HRMoveApplicantInput struct {
	ApplicantID string `json:"applicantId"`
	Stage       string `json:"stage"`
}

type HRMoveApplicantOutput struct {
	Moved bool   `json:"moved"`
	Stage string `json:"stage"`
}

type HRHireApplicantInput struct {
	ApplicantID        string `json:"applicantId"`
	MonthlySalaryMinor int64  `json:"monthlySalaryMinor"`
	AnnualLeaveDays    *int64 `json:"annualLeaveDays,omitempty"`
}

type HRHireApplicantOutput struct {
	EmployeeID  string `json:"employeeId"`
	ApplicantID string `json:"applicantId"`
}

type HRListApplicantsInput struct {
	OpeningID string `json:"openingId"`
}

type HRApplicantSummary struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Stage string  `json:"stage"`
	Note  *string `json:"note"`
}

type HRListApplicantsOutput struct {
	Applicants []HRApplicantSummary `json:"applicants"`
}

func ParseHRCreatePayrollRunInput(raw json.RawMessage) (HRCreatePayrollRunInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRCreatePayrollRunInput{}, err
	}
	var input HRCreatePayrollRunInput
	if input.Year, err = requiredSafeInteger(fields, "year"); err != nil {
		return HRCreatePayrollRunInput{}, err
	}
	if input.Year < 2020 || input.Year > 2100 {
		return HRCreatePayrollRunInput{}, errors.New("year must be between 2020 and 2100")
	}
	if input.Month, err = requiredSafeInteger(fields, "month"); err != nil {
		return HRCreatePayrollRunInput{}, err
	}
	if input.Month < 1 || input.Month > 12 {
		return HRCreatePayrollRunInput{}, errors.New("month must be between 1 and 12")
	}
	return input, nil
}

func ParseHRExecutePayrollRunInput(raw json.RawMessage) (HRExecutePayrollRunInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRExecutePayrollRunInput{}, err
	}
	var input HRExecutePayrollRunInput
	if input.RunID, err = requiredCRMDealString(fields, "runId", 0, 0); err != nil {
		return HRExecutePayrollRunInput{}, err
	}
	if input.ExpectedTotalNetMinor, err = requiredSafeInteger(fields, "expectedTotalNetMinor"); err != nil {
		return HRExecutePayrollRunInput{}, err
	}
	if input.ExpectedTotalNetMinor < 0 {
		return HRExecutePayrollRunInput{}, errors.New("expectedTotalNetMinor must be a non-negative integer")
	}
	return input, nil
}

func ParseHRVoidPayrollRunInput(raw json.RawMessage) (HRVoidPayrollRunInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRVoidPayrollRunInput{}, err
	}
	runID, err := requiredCRMDealString(fields, "runId", 0, 0)
	if err != nil {
		return HRVoidPayrollRunInput{}, err
	}
	return HRVoidPayrollRunInput{RunID: runID}, nil
}

func ParseHRReversePayrollPostingInput(raw json.RawMessage) (HRReversePayrollPostingInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRReversePayrollPostingInput{}, err
	}
	var input HRReversePayrollPostingInput
	if input.RunID, err = requiredCRMDealString(fields, "runId", 0, 0); err != nil {
		return HRReversePayrollPostingInput{}, err
	}
	if input.Reason, err = requiredCRMDealString(fields, "reason", 3, 500); err != nil {
		return HRReversePayrollPostingInput{}, err
	}
	return input, nil
}

func ParseHRAddApplicantInput(raw json.RawMessage) (HRAddApplicantInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRAddApplicantInput{}, err
	}
	var input HRAddApplicantInput
	if input.OpeningID, err = paymentRunIDField(fields, "openingId"); err != nil {
		return HRAddApplicantInput{}, err
	}
	if input.Name, err = requiredCRMDealString(fields, "name", 1, 120); err != nil {
		return HRAddApplicantInput{}, err
	}
	input.Email, err = optionalCRMDealString(fields, "email", 0, false)
	if err != nil {
		return HRAddApplicantInput{}, err
	}
	if input.Email != nil && !validHREmployeeEmail(*input.Email) {
		return HRAddApplicantInput{}, errors.New("email must be a valid email address")
	}
	input.Note, err = optionalCRMDealString(fields, "note", 500, false)
	if err != nil {
		return HRAddApplicantInput{}, err
	}
	return input, nil
}

func ParseHRMoveApplicantInput(raw json.RawMessage) (HRMoveApplicantInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRMoveApplicantInput{}, err
	}
	var input HRMoveApplicantInput
	if input.ApplicantID, err = paymentRunIDField(fields, "applicantId"); err != nil {
		return HRMoveApplicantInput{}, err
	}
	if input.Stage, err = requiredCRMDealString(fields, "stage", 0, 0); err != nil {
		return HRMoveApplicantInput{}, err
	}
	switch input.Stage {
	case "applied", "screening", "interview", "offer", "rejected":
	default:
		return HRMoveApplicantInput{}, errors.New("stage is invalid")
	}
	return input, nil
}

func ParseHRHireApplicantInput(raw json.RawMessage) (HRHireApplicantInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRHireApplicantInput{}, err
	}
	var input HRHireApplicantInput
	if input.ApplicantID, err = paymentRunIDField(fields, "applicantId"); err != nil {
		return HRHireApplicantInput{}, err
	}
	if input.MonthlySalaryMinor, err = requiredSafeInteger(fields, "monthlySalaryMinor"); err != nil {
		return HRHireApplicantInput{}, err
	}
	if input.MonthlySalaryMinor <= 0 {
		return HRHireApplicantInput{}, errors.New("monthlySalaryMinor must be a positive integer")
	}
	if _, ok := fields["annualLeaveDays"]; ok {
		leaveDays, err := optionalSafeInteger(fields, "annualLeaveDays")
		if err != nil {
			return HRHireApplicantInput{}, err
		}
		if leaveDays == nil || *leaveDays <= 0 {
			return HRHireApplicantInput{}, errors.New("annualLeaveDays must be a positive integer")
		}
		input.AnnualLeaveDays = leaveDays
	}
	return input, nil
}

func ParseHRListApplicantsInput(raw json.RawMessage) (HRListApplicantsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRListApplicantsInput{}, err
	}
	openingID, err := paymentRunIDField(fields, "openingId")
	if err != nil {
		return HRListApplicantsInput{}, err
	}
	return HRListApplicantsInput{OpeningID: openingID}, nil
}

type hrPayrollPayslipLine struct {
	employeeRef               string
	monthlySalaryMinor        int64
	workedFractionThousandths int64
	taxRateBps                int64
}

type hrPayrollPayslip struct {
	employeeRef string
	grossMinor  int64
	taxMinor    int64
	netMinor    int64
}

type hrPayrollRunSummary struct {
	totalGrossMinor int64
	totalTaxMinor   int64
	totalNetMinor   int64
	headcount       int
}

// hrPayrollRoundHalfUp mirrors Math.round(numerator / denominator) for
// non-negative integers: floor(numerator/denominator + 1/2), evaluated in
// big.Int so a maximum safe-integer salary cannot overflow before rounding.
func hrPayrollRoundHalfUp(numerator, denominator *big.Int) int64 {
	scaled := new(big.Int).Mul(numerator, big.NewInt(2))
	scaled.Add(scaled, denominator)
	scaled.Div(scaled, new(big.Int).Mul(denominator, big.NewInt(2)))
	return scaled.Int64()
}

func hrPayrollDaysInMonth(year, month int64) int64 {
	return int64(time.Date(int(year), time.Month(month+1), 0, 0, 0, 0, 0, time.UTC).Day())
}

func hrPayrollWorkedFractionThousandths(year, month, unpaidLeaveDays int64) int64 {
	total := hrPayrollDaysInMonth(year, month)
	if total <= 0 {
		return 0
	}
	clamped := min(max(unpaidLeaveDays, 0), total)
	return hrPayrollRoundHalfUp(big.NewInt((total-clamped)*1000), big.NewInt(total))
}

type hrPayrollLeaveSpan struct {
	start time.Time
	end   time.Time
}

// hrPayrollUnpaidLeaveDaysInMonth mirrors erp-core unpaidLeaveDaysInMonth:
// inclusive leave ends, clamped to the month, summed and clamped to the
// month's length.
func hrPayrollUnpaidLeaveDaysInMonth(leaves []hrPayrollLeaveSpan, year, month int64) int64 {
	monthStart := time.Date(int(year), time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	monthEnd := time.Date(int(year), time.Month(month+1), 1, 0, 0, 0, 0, time.UTC)
	total := hrPayrollDaysInMonth(year, month)
	day := 24 * time.Hour
	var sum int64
	for _, leave := range leaves {
		start := leave.start
		if start.Before(monthStart) {
			start = monthStart
		}
		endExclusive := leave.end.Add(day)
		if endExclusive.After(monthEnd) {
			endExclusive = monthEnd
		}
		if endExclusive.After(start) {
			sum += int64(math.Round(float64(endExclusive.Sub(start)) / float64(day)))
		}
	}
	return min(sum, total)
}

func hrPayrollComputePayslip(line hrPayrollPayslipLine) hrPayrollPayslip {
	grossNumerator := new(big.Int).Mul(big.NewInt(line.monthlySalaryMinor), big.NewInt(line.workedFractionThousandths))
	grossMinor := hrPayrollRoundHalfUp(grossNumerator, big.NewInt(1000))
	taxNumerator := new(big.Int).Mul(big.NewInt(grossMinor), big.NewInt(line.taxRateBps))
	taxMinor := hrPayrollRoundHalfUp(taxNumerator, big.NewInt(10_000))
	return hrPayrollPayslip{
		employeeRef: line.employeeRef,
		grossMinor:  grossMinor,
		taxMinor:    taxMinor,
		netMinor:    grossMinor - taxMinor,
	}
}

func hrPayrollSummarizeRun(payslips []hrPayrollPayslip) (hrPayrollRunSummary, error) {
	var summary hrPayrollRunSummary
	summary.headcount = len(payslips)
	for _, payslip := range payslips {
		if payslip.netMinor != payslip.grossMinor-payslip.taxMinor || payslip.grossMinor < 0 || payslip.taxMinor < 0 || payslip.netMinor < 0 {
			return hrPayrollRunSummary{}, fmt.Errorf("corrupt payslip for %s", payslip.employeeRef)
		}
		summary.totalGrossMinor += payslip.grossMinor
		summary.totalTaxMinor += payslip.taxMinor
		summary.totalNetMinor += payslip.netMinor
	}
	return summary, nil
}

func hrCreatePayrollRun(ctx context.Context, tx pgx.Tx, orgID string, input HRCreatePayrollRunInput) (HRCreatePayrollRunOutput, error) {
	var duplicateID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM payroll_runs
		WHERE org_id = $1::uuid AND year = $2 AND month = $3
		LIMIT 1`, orgID, input.Year, input.Month).Scan(&duplicateID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return HRCreatePayrollRunOutput{}, err
	}
	if duplicateID != "" {
		return HRCreatePayrollRunOutput{}, fmt.Errorf("a payroll run for %d-%02d already exists", input.Year, input.Month)
	}

	monthStart := time.Date(int(input.Year), time.Month(input.Month), 1, 0, 0, 0, 0, time.UTC)
	monthEnd := time.Date(int(input.Year), time.Month(input.Month+1), 1, 0, 0, 0, 0, time.UTC)

	type staffRow struct {
		id                 string
		monthlySalaryMinor int64
		taxRateBps         int64
	}
	staffRows, err := tx.Query(ctx, `
		SELECT id::text, monthly_salary_minor, tax_rate_bps
		FROM employees
		WHERE org_id = $1::uuid AND deactivated_at IS NULL
		ORDER BY name ASC`, orgID)
	if err != nil {
		return HRCreatePayrollRunOutput{}, err
	}
	staff := make([]staffRow, 0, 8)
	for staffRows.Next() {
		var employee staffRow
		if err := staffRows.Scan(&employee.id, &employee.monthlySalaryMinor, &employee.taxRateBps); err != nil {
			staffRows.Close()
			return HRCreatePayrollRunOutput{}, err
		}
		staff = append(staff, employee)
	}
	if err := staffRows.Err(); err != nil {
		staffRows.Close()
		return HRCreatePayrollRunOutput{}, err
	}
	staffRows.Close()
	if len(staff) == 0 {
		return HRCreatePayrollRunOutput{}, errors.New("no active employees to pay")
	}

	lines := make([]hrPayrollPayslipLine, 0, len(staff))
	for _, employee := range staff {
		leaveRows, err := tx.Query(ctx, `
			SELECT start_date, end_date
			FROM leave_requests
			WHERE employee_id = $1::uuid AND kind = 'unpaid' AND status = 'approved'
				AND start_date <= $3 AND end_date >= $2`,
			employee.id, monthStart, monthEnd)
		if err != nil {
			return HRCreatePayrollRunOutput{}, err
		}
		leaves := make([]hrPayrollLeaveSpan, 0, 4)
		for leaveRows.Next() {
			var span hrPayrollLeaveSpan
			if err := leaveRows.Scan(&span.start, &span.end); err != nil {
				leaveRows.Close()
				return HRCreatePayrollRunOutput{}, err
			}
			leaves = append(leaves, span)
		}
		if err := leaveRows.Err(); err != nil {
			leaveRows.Close()
			return HRCreatePayrollRunOutput{}, err
		}
		leaveRows.Close()
		lines = append(lines, hrPayrollPayslipLine{
			employeeRef:               employee.id,
			monthlySalaryMinor:        employee.monthlySalaryMinor,
			workedFractionThousandths: hrPayrollWorkedFractionThousandths(input.Year, input.Month, hrPayrollUnpaidLeaveDaysInMonth(leaves, input.Year, input.Month)),
			taxRateBps:                employee.taxRateBps,
		})
	}

	payslips := make([]hrPayrollPayslip, 0, len(lines))
	for _, line := range lines {
		payslips = append(payslips, hrPayrollComputePayslip(line))
	}
	summary, err := hrPayrollSummarizeRun(payslips)
	if err != nil {
		return HRCreatePayrollRunOutput{}, err
	}

	var runID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO payroll_runs (org_id, year, month, total_gross_minor, total_tax_minor, total_net_minor, headcount)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
		RETURNING id::text`,
		orgID, input.Year, input.Month,
		summary.totalGrossMinor, summary.totalTaxMinor, summary.totalNetMinor, summary.headcount).Scan(&runID); err != nil {
		return HRCreatePayrollRunOutput{}, err
	}
	for index, payslip := range payslips {
		if _, err := tx.Exec(ctx, `
			INSERT INTO payslips (org_id, run_id, employee_id, gross_minor, tax_minor, net_minor, worked_fraction_thousandths)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
			orgID, runID, staff[index].id,
			payslip.grossMinor, payslip.taxMinor, payslip.netMinor, lines[index].workedFractionThousandths); err != nil {
			return HRCreatePayrollRunOutput{}, err
		}
	}
	return HRCreatePayrollRunOutput{
		RunID:           runID,
		Headcount:       summary.headcount,
		TotalGrossMinor: summary.totalGrossMinor,
		TotalTaxMinor:   summary.totalTaxMinor,
		TotalNetMinor:   summary.totalNetMinor,
	}, nil
}

func hrExecutePayrollRun(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input HRExecutePayrollRunInput, now time.Time) (HRExecutePayrollRunOutput, error) {
	orgID := claims.OrganizationID
	var runID string
	var year, month int64
	var status string
	var totalGrossMinor, totalTaxMinor, totalNetMinor int64
	var headcount int
	err := tx.QueryRow(ctx, `
		SELECT id::text, year, month, status, total_gross_minor, total_tax_minor, total_net_minor, headcount
		FROM payroll_runs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.RunID, orgID).Scan(&runID, &year, &month, &status, &totalGrossMinor, &totalTaxMinor, &totalNetMinor, &headcount)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRExecutePayrollRunOutput{}, fmt.Errorf("no payroll run %s", input.RunID)
	}
	if err != nil {
		return HRExecutePayrollRunOutput{}, err
	}
	if status != "draft" {
		return HRExecutePayrollRunOutput{}, fmt.Errorf("run is %s, not draft", status)
	}
	if input.ExpectedTotalNetMinor != totalNetMinor {
		return HRExecutePayrollRunOutput{}, fmt.Errorf("total mismatch: draft says %d, caller expected %d", totalNetMinor, input.ExpectedTotalNetMinor)
	}

	var currency string
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&currency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			currency = "USD"
		} else {
			return HRExecutePayrollRunOutput{}, err
		}
	}

	// Payroll posting rule: DR expense (gross), CR cash (net), CR
	// withholding liability (tax).
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:      orgID,
		Memo:       fmt.Sprintf("payroll %d-%02d", year, month),
		SourceType: "payroll_run",
		SourceID:   &runID,
		Currency:   currency,
		PostedAt:   now,
		ActorType:  claims.ActorType,
		ActorID:    claims.ActorID,
		Lines: []JournalEntryLineInput{
			{AccountCode: hrPayrollExpenseAccountCode, DebitMinor: totalGrossMinor},
			{AccountCode: hrPayrollCashAccountCode, CreditMinor: totalNetMinor},
			{AccountCode: hrPayrollWithholdingAccountCode, CreditMinor: totalTaxMinor},
		},
	})
	if err != nil {
		return HRExecutePayrollRunOutput{}, err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE payroll_runs
		SET status = 'executed', entry_id = $2::uuid, executed_by_actor_type = $3, executed_by_actor_id = $4::uuid, executed_at = $5
		WHERE id = $1::uuid`, runID, entryID, claims.ActorType, claims.ActorID, now); err != nil {
		return HRExecutePayrollRunOutput{}, err
	}
	return HRExecutePayrollRunOutput{EntryID: entryID, TotalGrossMinor: totalGrossMinor, TotalNetMinor: totalNetMinor}, nil
}

func hrVoidPayrollRun(ctx context.Context, tx pgx.Tx, orgID string, input HRVoidPayrollRunInput, now time.Time) (HRVoidPayrollRunOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE payroll_runs SET status = 'voided', voided_at = $3
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'draft'`, input.RunID, orgID, now)
	if err != nil {
		return HRVoidPayrollRunOutput{}, err
	}
	if tag.RowsAffected() > 0 {
		return HRVoidPayrollRunOutput{Voided: true}, nil
	}
	var status string
	err = tx.QueryRow(ctx, `
		SELECT status FROM payroll_runs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.RunID, orgID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRVoidPayrollRunOutput{}, errors.New("no draft payroll run with that id")
	}
	if err != nil {
		return HRVoidPayrollRunOutput{}, err
	}
	if status == "executed" {
		return HRVoidPayrollRunOutput{}, errors.New("executed payroll runs are undone with hr.reversePayrollPosting, which reverses the posting and repairs the run lifecycle")
	}
	return HRVoidPayrollRunOutput{}, fmt.Errorf("no draft payroll run with that id (run is %s)", status)
}

func hrReversePayrollPosting(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input HRReversePayrollPostingInput, now time.Time) (HRReversePayrollPostingOutput, error) {
	orgID := claims.OrganizationID
	var runID, status string
	var year, month, totalNetMinor int64
	var entryID *string
	err := tx.QueryRow(ctx, `
		SELECT id::text, year, month, status, entry_id::text, total_net_minor
		FROM payroll_runs
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.RunID, orgID).Scan(&runID, &year, &month, &status, &entryID, &totalNetMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRReversePayrollPostingOutput{}, fmt.Errorf("no payroll run %s", input.RunID)
	}
	if err != nil {
		return HRReversePayrollPostingOutput{}, err
	}
	if status != "executed" {
		return HRReversePayrollPostingOutput{}, fmt.Errorf("run is %s; only executed runs can be reversed", status)
	}
	if entryID == nil {
		return HRReversePayrollPostingOutput{}, errors.New("run has no posting to reverse")
	}

	var alreadyReversed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM journal_entries WHERE org_id = $1::uuid AND reversal_of_id = $2::uuid
		)`, orgID, *entryID).Scan(&alreadyReversed); err != nil {
		return HRReversePayrollPostingOutput{}, err
	}
	if alreadyReversed {
		return HRReversePayrollPostingOutput{}, errors.New("payroll run has already been reversed")
	}

	var originalCurrency string
	if err := tx.QueryRow(ctx, `
		SELECT currency FROM journal_entries
		WHERE id = $1::uuid AND org_id = $2::uuid`, *entryID, orgID).Scan(&originalCurrency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return HRReversePayrollPostingOutput{}, fmt.Errorf("posting %s not found", *entryID)
		}
		return HRReversePayrollPostingOutput{}, err
	}
	lineRows, err := tx.Query(ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl
		JOIN accounts a ON a.id = jl.account_id AND a.org_id = $2::uuid
		WHERE jl.entry_id = $1::uuid
		ORDER BY jl.id`, *entryID, orgID)
	if err != nil {
		return HRReversePayrollPostingOutput{}, err
	}
	lines := make([]JournalEntryLineInput, 0, 4)
	for lineRows.Next() {
		var code string
		var debitMinor, creditMinor int64
		if err := lineRows.Scan(&code, &debitMinor, &creditMinor); err != nil {
			lineRows.Close()
			return HRReversePayrollPostingOutput{}, err
		}
		lines = append(lines, JournalEntryLineInput{AccountCode: code, DebitMinor: creditMinor, CreditMinor: debitMinor})
	}
	if err := lineRows.Err(); err != nil {
		lineRows.Close()
		return HRReversePayrollPostingOutput{}, err
	}
	lineRows.Close()

	// Posted rows stay immutable; the reversal is a new entry linked by
	// reversal_of_id that keeps the original's currency (ADR 0021).
	reversalEntryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:        orgID,
		Memo:         fmt.Sprintf("Reversal of payroll %d-%02d: %s", year, month, input.Reason),
		SourceType:   "payroll_reversal",
		SourceID:     &runID,
		ReversalOfID: entryID,
		Currency:     originalCurrency,
		PostedAt:     now,
		ActorType:    claims.ActorType,
		ActorID:      claims.ActorID,
		Lines:        lines,
	})
	if err != nil {
		return HRReversePayrollPostingOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE payroll_runs SET status = 'reversed', reversed_at = $2
		WHERE id = $1::uuid`, runID, now); err != nil {
		return HRReversePayrollPostingOutput{}, err
	}
	return HRReversePayrollPostingOutput{ReversalEntryID: reversalEntryID, ReversedNetMinor: totalNetMinor}, nil
}

func hrAddApplicant(ctx context.Context, tx pgx.Tx, orgID string, input HRAddApplicantInput) (HRAddApplicantOutput, error) {
	var status string
	err := tx.QueryRow(ctx, `
		SELECT status FROM job_openings
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.OpeningID, orgID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRAddApplicantOutput{}, errors.New("opening not found")
	}
	if err != nil {
		return HRAddApplicantOutput{}, err
	}
	if status != "open" {
		return HRAddApplicantOutput{}, errors.New("opening is closed")
	}
	var applicantID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO job_applicants (org_id, opening_id, name, email, note)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text`, orgID, input.OpeningID, input.Name, input.Email, input.Note).Scan(&applicantID); err != nil {
		return HRAddApplicantOutput{}, err
	}
	return HRAddApplicantOutput{ApplicantID: applicantID}, nil
}

func hrMoveApplicant(ctx context.Context, tx pgx.Tx, orgID string, input HRMoveApplicantInput) (HRMoveApplicantOutput, error) {
	var stage string
	err := tx.QueryRow(ctx, `
		SELECT stage FROM job_applicants
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.ApplicantID, orgID).Scan(&stage)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRMoveApplicantOutput{}, errors.New("applicant not found")
	}
	if err != nil {
		return HRMoveApplicantOutput{}, err
	}
	if stage == "hired" {
		return HRMoveApplicantOutput{}, errors.New("applicant is already hired")
	}
	if stage == "rejected" {
		return HRMoveApplicantOutput{}, errors.New("applicant was rejected; start a new application")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE job_applicants SET stage = $3
		WHERE id = $1::uuid AND org_id = $2::uuid`, input.ApplicantID, orgID, input.Stage); err != nil {
		return HRMoveApplicantOutput{}, err
	}
	return HRMoveApplicantOutput{Moved: true, Stage: input.Stage}, nil
}

func hrHireApplicant(ctx context.Context, tx pgx.Tx, orgID string, input HRHireApplicantInput) (HRHireApplicantOutput, error) {
	var applicantID, name string
	var email *string
	var stage string
	err := tx.QueryRow(ctx, `
		SELECT id::text, name, email, stage
		FROM job_applicants
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.ApplicantID, orgID).Scan(&applicantID, &name, &email, &stage)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRHireApplicantOutput{}, errors.New("applicant not found")
	}
	if err != nil {
		return HRHireApplicantOutput{}, err
	}
	if stage == "hired" {
		return HRHireApplicantOutput{}, errors.New("applicant is already hired")
	}
	if stage == "rejected" {
		return HRHireApplicantOutput{}, errors.New("applicant was rejected")
	}

	var openingTitle, openingDepartment *string
	err = tx.QueryRow(ctx, `
		SELECT jo.title, jo.department
		FROM job_applicants ja
		JOIN job_openings jo ON jo.id = ja.opening_id
		WHERE ja.id = $1::uuid`, applicantID).Scan(&openingTitle, &openingDepartment)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return HRHireApplicantOutput{}, err
	}

	annualLeaveDays := int64(21)
	if input.AnnualLeaveDays != nil {
		annualLeaveDays = *input.AnnualLeaveDays
	}
	var employeeID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO employees (org_id, name, email, title, department, monthly_salary_minor, annual_leave_days)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
		RETURNING id::text`, orgID, name, email, openingTitle, openingDepartment, input.MonthlySalaryMinor, annualLeaveDays).Scan(&employeeID); err != nil {
		return HRHireApplicantOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE job_applicants SET stage = 'hired', hired_employee_id = $2::uuid
		WHERE id = $1::uuid`, applicantID, employeeID); err != nil {
		return HRHireApplicantOutput{}, err
	}
	return HRHireApplicantOutput{EmployeeID: employeeID, ApplicantID: applicantID}, nil
}

func hrListApplicants(ctx context.Context, tx pgx.Tx, orgID string, input HRListApplicantsInput) (HRListApplicantsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, stage, note
		FROM job_applicants
		WHERE org_id = $1::uuid AND opening_id = $2::uuid
		ORDER BY created_at ASC`, orgID, input.OpeningID)
	if err != nil {
		return HRListApplicantsOutput{}, err
	}
	defer rows.Close()
	applicants := make([]HRApplicantSummary, 0)
	for rows.Next() {
		var applicant HRApplicantSummary
		if err := rows.Scan(&applicant.ID, &applicant.Name, &applicant.Stage, &applicant.Note); err != nil {
			return HRListApplicantsOutput{}, err
		}
		applicants = append(applicants, applicant)
	}
	if err := rows.Err(); err != nil {
		return HRListApplicantsOutput{}, err
	}
	return HRListApplicantsOutput{Applicants: applicants}, nil
}

func parseHRPayrollApplicantInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case hrCreatePayrollRunCapabilityID:
		return ParseHRCreatePayrollRunInput(raw)
	case hrExecutePayrollRunCapabilityID:
		return ParseHRExecutePayrollRunInput(raw)
	case hrVoidPayrollRunCapabilityID:
		return ParseHRVoidPayrollRunInput(raw)
	case hrReversePayrollPostingCapabilityID:
		return ParseHRReversePayrollPostingInput(raw)
	case hrAddApplicantCapabilityID:
		return ParseHRAddApplicantInput(raw)
	case hrMoveApplicantCapabilityID:
		return ParseHRMoveApplicantInput(raw)
	case hrHireApplicantCapabilityID:
		return ParseHRHireApplicantInput(raw)
	case hrListApplicantsCapabilityID:
		return ParseHRListApplicantsInput(raw)
	default:
		return nil, errors.New("unsupported HR payroll and applicant capability")
	}
}
