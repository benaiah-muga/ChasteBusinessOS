package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func hrPayrollApplicantsInOrgTx[T any](t *testing.T, fx *executorFixture, orgID string, run func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, run)
	if err != nil {
		t.Fatalf("HR payroll applicants transaction: %v", err)
	}
	return output
}

func hrPayrollApplicantsExpectError(t *testing.T, fx *executorFixture, orgID, wantErr string, run func(tx pgx.Tx) error) {
	t.Helper()
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, run(tx)
	}); err == nil || err.Error() != wantErr {
		t.Fatalf("HR payroll applicants error = %v, want %q", err, wantErr)
	}
}

func cleanupHRPayrollApplicantsFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin HR payroll applicants fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable HR payroll applicants fixture ledger cleanup: %v", err)
			return
		}
		steps := []string{
			`DELETE FROM payslips WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM payroll_runs WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM leave_requests WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM job_applicants WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM job_openings WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM employees WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, step := range steps {
			if _, err := tx.Exec(fx.ctx, step, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("HR payroll applicants fixture cleanup step failed: %v", err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit HR payroll applicants fixture cleanup: %v", err)
		}
	})
}

func seedHRPayrollAccounts(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash', 'asset'),
		($1::uuid, '2200', 'Withholding Payable', 'liability'),
		($1::uuid, '6000', 'Salary Expense', 'expense')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func seedHRPayrollOpening(t *testing.T, fx *executorFixture, orgID, title, department, status string, createdAt time.Time) string {
	t.Helper()
	var openingID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO job_openings (org_id, title, department, status, created_at)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING id::text`, orgID, title, department, status, createdAt).Scan(&openingID); err != nil {
		t.Fatal(err)
	}
	return openingID
}

func seedHRPayrollApplicant(t *testing.T, fx *executorFixture, orgID, openingID, name string, email, note *string, stage string, createdAt time.Time) string {
	t.Helper()
	var applicantID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO job_applicants (org_id, opening_id, name, email, note, stage, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
		RETURNING id::text`, orgID, openingID, name, email, note, stage, createdAt).Scan(&applicantID); err != nil {
		t.Fatal(err)
	}
	return applicantID
}

func seedHRPayrollRun(t *testing.T, fx *executorFixture, orgID string, year, month int, status string, totalGrossMinor, totalTaxMinor, totalNetMinor int64, headcount int) string {
	t.Helper()
	var runID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payroll_runs (org_id, year, month, status, total_gross_minor, total_tax_minor, total_net_minor, headcount)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id::text`, orgID, year, month, status, totalGrossMinor, totalTaxMinor, totalNetMinor, headcount).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	return runID
}

func seedHRPayrollLeave(t *testing.T, fx *executorFixture, orgID, employeeID, kind, status string, start, end time.Time) string {
	t.Helper()
	days := int(end.Sub(start).Hours()/24) + 1
	var leaveID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO leave_requests (org_id, employee_id, kind, start_date, end_date, calendar_days, status, requested_by_actor_type)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'human')
		RETURNING id::text`, orgID, employeeID, kind, start, end, days, status).Scan(&leaveID); err != nil {
		t.Fatal(err)
	}
	return leaveID
}

func TestHRPayrollApplicantsParsersMirrorZodContracts(t *testing.T) {
	created, err := ParseHRCreatePayrollRunInput(json.RawMessage(`{"year":2026,"month":8,"unknown":true}`))
	if err != nil || created.Year != 2026 || created.Month != 8 {
		t.Fatalf("ParseHRCreatePayrollRunInput() = %+v, %v", created, err)
	}
	if encoded, err := marshalJS(created); err != nil || string(encoded) != `{"year":2026,"month":8}` {
		t.Fatalf("createPayrollRun input JSON = %s, %v", encoded, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"year":2026}`,
		`{"month":8}`,
		`{"year":2019,"month":8}`,
		`{"year":2101,"month":8}`,
		`{"year":2026.5,"month":8}`,
		`{"year":2026,"month":0}`,
		`{"year":2026,"month":13}`,
		`{"year":2026,"month":8.5}`,
		`{"year":null,"month":8}`,
		`[]`,
	} {
		if _, err := ParseHRCreatePayrollRunInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRCreatePayrollRunInput accepted %s", raw)
		}
	}

	executed, err := ParseHRExecutePayrollRunInput(json.RawMessage(`{"runId":"run-1","expectedTotalNetMinor":96000,"unknown":1}`))
	if err != nil || executed.RunID != "run-1" || executed.ExpectedTotalNetMinor != 96000 {
		t.Fatalf("ParseHRExecutePayrollRunInput() = %+v, %v", executed, err)
	}
	if empty, err := ParseHRExecutePayrollRunInput(json.RawMessage(`{"runId":"","expectedTotalNetMinor":0}`)); err != nil || empty.RunID != "" {
		t.Fatalf("empty runId input=%+v err=%v, want z.string() accepting the empty string", empty, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"runId":"run-1"}`,
		`{"expectedTotalNetMinor":5}`,
		`{"runId":null,"expectedTotalNetMinor":5}`,
		`{"runId":"run-1","expectedTotalNetMinor":-1}`,
		`{"runId":"run-1","expectedTotalNetMinor":1.5}`,
		`{"runId":"run-1","expectedTotalNetMinor":9007199254740992}`,
	} {
		if _, err := ParseHRExecutePayrollRunInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRExecutePayrollRunInput accepted %s", raw)
		}
	}

	if voided, err := ParseHRVoidPayrollRunInput(json.RawMessage(`{"runId":"any-run","unknown":true}`)); err != nil || voided.RunID != "any-run" {
		t.Fatalf("ParseHRVoidPayrollRunInput() = %+v, %v", voided, err)
	}
	for _, raw := range []string{`{}`, `{"runId":null}`, `{"runId":5}`} {
		if _, err := ParseHRVoidPayrollRunInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRVoidPayrollRunInput accepted %s", raw)
		}
	}

	astral := "a\U0001F600"
	reversed, err := ParseHRReversePayrollPostingInput(json.RawMessage(`{"runId":"run-1","reason":"` + astral + `","unknown":true}`))
	if err != nil || reversed.RunID != "run-1" || reversed.Reason != astral {
		t.Fatalf("ParseHRReversePayrollPostingInput() = %+v, %v", reversed, err)
	}
	if _, err := ParseHRReversePayrollPostingInput(json.RawMessage(`{"runId":"run-1","reason":"` + strings.Repeat("x", 500) + `"}`)); err != nil {
		t.Fatalf("ParseHRReversePayrollPostingInput(500 chars) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`{}`,
		`{"runId":"run-1"}`,
		`{"runId":"run-1","reason":"ab"}`,
		`{"runId":"run-1","reason":"` + strings.Repeat("x", 501) + `"}`,
		`{"runId":"run-1","reason":null}`,
	} {
		if _, err := ParseHRReversePayrollPostingInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRReversePayrollPostingInput accepted %s", raw)
		}
	}

	openingUUID := "11111111-1111-4111-8111-111111111111"
	applicantUUID := "22222222-2222-4222-8222-222222222222"
	added, err := ParseHRAddApplicantInput(json.RawMessage(`{"openingId":"` + openingUUID + `","name":"Grace Njeri","email":"grace@example.com","note":"Referred","unknown":true}`))
	if err != nil || added.OpeningID != openingUUID || added.Name != "Grace Njeri" || *added.Email != "grace@example.com" || *added.Note != "Referred" {
		t.Fatalf("ParseHRAddApplicantInput() = %+v, %v", added, err)
	}
	if encoded, err := marshalJS(added); err != nil || string(encoded) != `{"openingId":"`+openingUUID+`","name":"Grace Njeri","email":"grace@example.com","note":"Referred"}` {
		t.Fatalf("addApplicant input JSON = %s, %v", encoded, err)
	}
	minimal, err := ParseHRAddApplicantInput(json.RawMessage(`{"openingId":"` + openingUUID + `","name":"Min"}`))
	if err != nil || minimal.Email != nil || minimal.Note != nil {
		t.Fatalf("minimal addApplicant input=%+v err=%v, want absent optional fields", minimal, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"openingId":"nope","name":"N"}`,
		`{"openingId":null,"name":"N"}`,
		`{"openingId":"` + openingUUID + `"}`,
		`{"openingId":"` + openingUUID + `","name":""}`,
		`{"openingId":"` + openingUUID + `","name":"` + strings.Repeat("n", 121) + `"}`,
		`{"openingId":"` + openingUUID + `","name":null}`,
		`{"openingId":"` + openingUUID + `","name":"N","email":"not-an-email"}`,
		`{"openingId":"` + openingUUID + `","name":"N","email":"user@localhost"}`,
		`{"openingId":"` + openingUUID + `","name":"N","email":"double..dot@example.com"}`,
		`{"openingId":"` + openingUUID + `","name":"N","note":"` + strings.Repeat("n", 501) + `"}`,
		`{"openingId":"` + openingUUID + `","name":"N","note":null}`,
	} {
		if _, err := ParseHRAddApplicantInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRAddApplicantInput accepted %s", raw)
		}
	}

	moved, err := ParseHRMoveApplicantInput(json.RawMessage(`{"applicantId":"` + applicantUUID + `","stage":"interview","unknown":1}`))
	if err != nil || moved.ApplicantID != applicantUUID || moved.Stage != "interview" {
		t.Fatalf("ParseHRMoveApplicantInput() = %+v, %v", moved, err)
	}
	for _, stage := range []string{"applied", "screening", "interview", "offer", "rejected"} {
		if _, err := ParseHRMoveApplicantInput(json.RawMessage(`{"applicantId":"` + applicantUUID + `","stage":"` + stage + `"}`)); err != nil {
			t.Errorf("ParseHRMoveApplicantInput(stage=%s) err = %v", stage, err)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"applicantId":"nope","stage":"offer"}`,
		`{"applicantId":"` + applicantUUID + `"}`,
		`{"applicantId":"` + applicantUUID + `","stage":"hired"}`,
		`{"applicantId":"` + applicantUUID + `","stage":"nope"}`,
		`{"applicantId":"` + applicantUUID + `","stage":null}`,
	} {
		if _, err := ParseHRMoveApplicantInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRMoveApplicantInput accepted %s", raw)
		}
	}

	hired, err := ParseHRHireApplicantInput(json.RawMessage(`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":450000,"annualLeaveDays":24,"unknown":true}`))
	if err != nil || hired.ApplicantID != applicantUUID || hired.MonthlySalaryMinor != 450000 || *hired.AnnualLeaveDays != 24 {
		t.Fatalf("ParseHRHireApplicantInput() = %+v, %v", hired, err)
	}
	if minimal, err := ParseHRHireApplicantInput(json.RawMessage(`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":1}`)); err != nil || minimal.AnnualLeaveDays != nil {
		t.Fatalf("minimal hire input=%+v err=%v, want absent annualLeaveDays", minimal, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"applicantId":"` + applicantUUID + `"}`,
		`{"applicantId":"nope","monthlySalaryMinor":1}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":0}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":-5}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":1.5}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":null}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":1,"annualLeaveDays":0}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":1,"annualLeaveDays":-1}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":1,"annualLeaveDays":2.5}`,
		`{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":1,"annualLeaveDays":null}`,
	} {
		if _, err := ParseHRHireApplicantInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRHireApplicantInput accepted %s", raw)
		}
	}

	if listed, err := ParseHRListApplicantsInput(json.RawMessage(`{"openingId":"` + openingUUID + `","unknown":1}`)); err != nil || listed.OpeningID != openingUUID {
		t.Fatalf("ParseHRListApplicantsInput() = %+v, %v", listed, err)
	}
	for _, raw := range []string{`{}`, `{"openingId":"nope"}`, `{"openingId":null}`, `[]`} {
		if _, err := ParseHRListApplicantsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRListApplicantsInput accepted %s", raw)
		}
	}

	if _, err := parseHRPayrollApplicantInput("hr.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported HR payroll and applicant capability" {
		t.Fatalf("parseHRPayrollApplicantInput(unknown) err = %v, want dispatcher refusal", err)
	}
	for capabilityID, raw := range map[string]string{
		hrCreatePayrollRunCapabilityID:      `{"year":2026,"month":8}`,
		hrExecutePayrollRunCapabilityID:     `{"runId":"r","expectedTotalNetMinor":5}`,
		hrVoidPayrollRunCapabilityID:        `{"runId":"r"}`,
		hrReversePayrollPostingCapabilityID: `{"runId":"r","reason":"undo it"}`,
		hrAddApplicantCapabilityID:          `{"openingId":"` + openingUUID + `","name":"N"}`,
		hrMoveApplicantCapabilityID:         `{"applicantId":"` + applicantUUID + `","stage":"offer"}`,
		hrHireApplicantCapabilityID:         `{"applicantId":"` + applicantUUID + `","monthlySalaryMinor":1}`,
		hrListApplicantsCapabilityID:        `{"openingId":"` + openingUUID + `"}`,
	} {
		if _, err := parseHRPayrollApplicantInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseHRPayrollApplicantInput(%s) err = %v", capabilityID, err)
		}
	}
}

func TestHRPayrollApplicantsDomainMathMirrorsErpCore(t *testing.T) {
	if got := hrPayrollDaysInMonth(2026, 8); got != 31 {
		t.Fatalf("hrPayrollDaysInMonth(2026, 8) = %d, want 31", got)
	}
	if got := hrPayrollDaysInMonth(2026, 2); got != 28 {
		t.Fatalf("hrPayrollDaysInMonth(2026, 2) = %d, want 28", got)
	}
	if got := hrPayrollDaysInMonth(2024, 2); got != 29 {
		t.Fatalf("hrPayrollDaysInMonth(2024, 2) = %d, want 29", got)
	}
	if got := hrPayrollDaysInMonth(2026, 12); got != 31 {
		t.Fatalf("hrPayrollDaysInMonth(2026, 12) = %d, want 31", got)
	}

	for _, testCase := range []struct {
		year, month, unpaid, want int64
	}{
		{2026, 8, 0, 1000},
		{2026, 8, 6, 806},
		{2026, 2, 3, 893},
		{2026, 2, 99, 0},
		{2026, 8, -4, 1000},
	} {
		if got := hrPayrollWorkedFractionThousandths(testCase.year, testCase.month, testCase.unpaid); got != testCase.want {
			t.Fatalf("hrPayrollWorkedFractionThousandths(%d, %d, %d) = %d, want %d", testCase.year, testCase.month, testCase.unpaid, got, testCase.want)
		}
	}

	for _, testCase := range []struct {
		line            hrPayrollPayslipLine
		gross, tax, net int64
	}{
		{hrPayrollPayslipLine{employeeRef: "full", monthlySalaryMinor: 120_000, workedFractionThousandths: 1000, taxRateBps: 2000}, 120_000, 24_000, 96_000},
		{hrPayrollPayslipLine{employeeRef: "prorated", monthlySalaryMinor: 62_000, workedFractionThousandths: 806, taxRateBps: 2000}, 49_972, 9_994, 39_978},
		{hrPayrollPayslipLine{employeeRef: "half-up", monthlySalaryMinor: 5, workedFractionThousandths: 500, taxRateBps: 1000}, 3, 0, 3},
		{hrPayrollPayslipLine{employeeRef: "tax-half-up", monthlySalaryMinor: 50, workedFractionThousandths: 1000, taxRateBps: 100}, 50, 1, 49},
		{hrPayrollPayslipLine{employeeRef: "no-tax", monthlySalaryMinor: 50_000, workedFractionThousandths: 1000, taxRateBps: 0}, 50_000, 0, 50_000},
		{hrPayrollPayslipLine{employeeRef: "zero", monthlySalaryMinor: 0, workedFractionThousandths: 1000, taxRateBps: 2000}, 0, 0, 0},
	} {
		payslip := hrPayrollComputePayslip(testCase.line)
		if payslip.grossMinor != testCase.gross || payslip.taxMinor != testCase.tax || payslip.netMinor != testCase.net {
			t.Fatalf("hrPayrollComputePayslip(%+v) = %+v, want gross %d tax %d net %d", testCase.line, payslip, testCase.gross, testCase.tax, testCase.net)
		}
	}

	summary, err := hrPayrollSummarizeRun([]hrPayrollPayslip{
		{employeeRef: "a", grossMinor: 120_000, taxMinor: 24_000, netMinor: 96_000},
		{employeeRef: "b", grossMinor: 49_972, taxMinor: 9_994, netMinor: 39_978},
	})
	if err != nil || summary.totalGrossMinor != 169_972 || summary.totalTaxMinor != 33_994 || summary.totalNetMinor != 135_978 || summary.headcount != 2 {
		t.Fatalf("hrPayrollSummarizeRun() = %+v, %v", summary, err)
	}
	if _, err := hrPayrollSummarizeRun([]hrPayrollPayslip{{employeeRef: "bad", grossMinor: 100, taxMinor: 10, netMinor: 91}}); err == nil || err.Error() != "corrupt payslip for bad" {
		t.Fatalf("hrPayrollSummarizeRun(corrupt) err = %v, want corrupt payslip refusal", err)
	}

	august := func(day int) time.Time { return time.Date(2026, 8, day, 0, 0, 0, 0, time.UTC) }
	for _, testCase := range []struct {
		name   string
		leaves []hrPayrollLeaveSpan
		want   int64
	}{
		{name: "inside month", leaves: []hrPayrollLeaveSpan{{start: august(20), end: august(25)}}, want: 6},
		{name: "spilling in", leaves: []hrPayrollLeaveSpan{{start: time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC), end: august(3)}}, want: 3},
		{name: "spilling out", leaves: []hrPayrollLeaveSpan{{start: august(25), end: time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)}}, want: 7},
		{name: "outside month", leaves: []hrPayrollLeaveSpan{{start: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC), end: time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)}}, want: 0},
		{name: "whole month", leaves: []hrPayrollLeaveSpan{{start: august(1), end: august(31)}}, want: 31},
		{name: "clamped overlap", leaves: []hrPayrollLeaveSpan{{start: august(1), end: august(20)}, {start: august(15), end: august(31)}}, want: 31},
	} {
		if got := hrPayrollUnpaidLeaveDaysInMonth(testCase.leaves, 2026, 8); got != testCase.want {
			t.Fatalf("hrPayrollUnpaidLeaveDaysInMonth(%s) = %d, want %d", testCase.name, got, testCase.want)
		}
	}
}

func TestHRExecutePayrollMoneyAmountIsKnownBeforeExecution(t *testing.T) {
	want := int64(40_000)
	amount, known := moneyAmount(HRExecutePayrollRunInput{ExpectedTotalNetMinor: want})
	if !known || amount == nil || *amount != want {
		t.Fatalf("moneyAmount(payroll) = (%v, %t), want (%d, true)", amount, known, want)
	}
}

func TestHRPayrollApplicantsCreateDraftsProratedPayslips(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)
	alphaID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Alpha", MonthlySalaryMinor: 31_000, TaxRateBps: 1000})
	bravoID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Bravo", MonthlySalaryMinor: 62_000, TaxRateBps: 2000})
	charlieID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Charlie", MonthlySalaryMinor: 50_000, TaxRateBps: 0})
	deltaID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Delta", MonthlySalaryMinor: 40_000, TaxRateBps: 5000})
	seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Zed", MonthlySalaryMinor: 999_999, TaxRateBps: 1000, DeactivatedAt: hrPayrollApplicantsTimePointer(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))})
	foreignID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Worker", MonthlySalaryMinor: 888_888, TaxRateBps: 1000, DeactivatedAt: hrPayrollApplicantsTimePointer(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))})

	seedHRPayrollLeave(t, fx, fx.orgID, alphaID, "unpaid", "approved", time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC), time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC))
	seedHRPayrollLeave(t, fx, fx.orgID, bravoID, "unpaid", "approved", time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC))
	seedHRPayrollLeave(t, fx, fx.orgID, charlieID, "annual", "approved", time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC))
	seedHRPayrollLeave(t, fx, fx.orgID, deltaID, "unpaid", "pending", time.Date(2026, 8, 10, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC))

	created := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCreatePayrollRunOutput, error) {
		return hrCreatePayrollRun(fx.ctx, tx, fx.orgID, HRCreatePayrollRunInput{Year: 2026, Month: 8})
	})
	if !isUUID(created.RunID) || created.Headcount != 4 || created.TotalGrossMinor != 170_972 || created.TotalTaxMinor != 33_094 || created.TotalNetMinor != 137_878 {
		t.Fatalf("hrCreatePayrollRun output = %+v, want four prorated payslips totaling 170972 gross", created)
	}
	if encoded, err := marshalJS(created); err != nil || string(encoded) != fmt.Sprintf(
		`{"runId":%q,"headcount":4,"totalGrossMinor":170972,"totalTaxMinor":33094,"totalNetMinor":137878}`, created.RunID) {
		t.Fatalf("hrCreatePayrollRun output JSON = %s, %v", encoded, err)
	}

	payslipRows, err := fx.owner.Query(fx.ctx, `
		SELECT employee_id::text, gross_minor, tax_minor, net_minor, worked_fraction_thousandths
		FROM payslips WHERE run_id = $1::uuid`, created.RunID)
	if err != nil {
		t.Fatal(err)
	}
	type storedPayslip struct {
		grossMinor, taxMinor, netMinor, worked int64
	}
	byEmployee := make(map[string]storedPayslip, 4)
	for payslipRows.Next() {
		var employeeID string
		var payslip storedPayslip
		if err := payslipRows.Scan(&employeeID, &payslip.grossMinor, &payslip.taxMinor, &payslip.netMinor, &payslip.worked); err != nil {
			payslipRows.Close()
			t.Fatal(err)
		}
		byEmployee[employeeID] = payslip
	}
	if err := payslipRows.Err(); err != nil {
		payslipRows.Close()
		t.Fatal(err)
	}
	payslipRows.Close()
	want := map[string]storedPayslip{
		alphaID:   {31_000, 3_100, 27_900, 1000},
		bravoID:   {49_972, 9_994, 39_978, 806},
		charlieID: {50_000, 0, 50_000, 1000},
		deltaID:   {40_000, 20_000, 20_000, 1000},
	}
	if len(byEmployee) != len(want) {
		t.Fatalf("stored payslips = %+v, want one per active employee", byEmployee)
	}
	for employeeID, expected := range want {
		if byEmployee[employeeID] != expected {
			t.Fatalf("payslip for %s = %+v, want %+v", employeeID, byEmployee[employeeID], expected)
		}
	}
	if got := fx.count(`SELECT count(*) FROM payslips WHERE run_id = $1::uuid AND employee_id = $2::uuid`, created.RunID, foreignID); got != 0 {
		t.Fatalf("foreign employee payslips = %d, want 0", got)
	}
	var status string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM payroll_runs WHERE id = $1::uuid`, created.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "draft" {
		t.Fatalf("created run status = %s, want draft", status)
	}

	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "a payroll run for 2026-08 already exists", func(tx pgx.Tx) error {
		_, err := hrCreatePayrollRun(fx.ctx, tx, fx.orgID, HRCreatePayrollRunInput{Year: 2026, Month: 8})
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.otherOrgID, "no active employees to pay", func(tx pgx.Tx) error {
		_, err := hrCreatePayrollRun(fx.ctx, tx, fx.otherOrgID, HRCreatePayrollRunInput{Year: 2026, Month: 8})
		return err
	})
}

func TestHRPayrollApplicantsExecutePostsBalancedEntry(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)
	seedHRPayrollAccounts(t, fx)
	seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Probe Employee", MonthlySalaryMinor: 120_000, TaxRateBps: 2000})
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	created := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCreatePayrollRunOutput, error) {
		return hrCreatePayrollRun(fx.ctx, tx, fx.orgID, HRCreatePayrollRunInput{Year: 2026, Month: 8})
	})
	if created.TotalNetMinor != 96_000 {
		t.Fatalf("draft net = %d, want 96000", created.TotalNetMinor)
	}

	unknownRunID := executorUUID(t)
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, fmt.Sprintf("no payroll run %s", unknownRunID), func(tx pgx.Tx) error {
		_, err := hrExecutePayrollRun(fx.ctx, tx, claims, HRExecutePayrollRunInput{RunID: unknownRunID, ExpectedTotalNetMinor: 96_000}, now)
		return err
	})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE payroll_runs SET status = 'voided' WHERE id = $1::uuid`, created.RunID); err != nil {
		t.Fatal(err)
	}
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "run is voided, not draft", func(tx pgx.Tx) error {
		_, err := hrExecutePayrollRun(fx.ctx, tx, claims, HRExecutePayrollRunInput{RunID: created.RunID, ExpectedTotalNetMinor: 96_000}, now)
		return err
	})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE payroll_runs SET status = 'draft' WHERE id = $1::uuid`, created.RunID); err != nil {
		t.Fatal(err)
	}
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "total mismatch: draft says 96000, caller expected 1", func(tx pgx.Tx) error {
		_, err := hrExecutePayrollRun(fx.ctx, tx, claims, HRExecutePayrollRunInput{RunID: created.RunID, ExpectedTotalNetMinor: 1}, now)
		return err
	})

	executed := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRExecutePayrollRunOutput, error) {
		return hrExecutePayrollRun(fx.ctx, tx, claims, HRExecutePayrollRunInput{RunID: created.RunID, ExpectedTotalNetMinor: 96_000}, now)
	})
	if !isUUID(executed.EntryID) || executed.TotalGrossMinor != 120_000 || executed.TotalNetMinor != 96_000 {
		t.Fatalf("hrExecutePayrollRun output = %+v, want a posted entry at 120000 gross", executed)
	}
	if encoded, err := marshalJS(executed); err != nil || string(encoded) != fmt.Sprintf(`{"entryId":%q,"totalGrossMinor":120000,"totalNetMinor":96000}`, executed.EntryID) {
		t.Fatalf("hrExecutePayrollRun output JSON = %s, %v", encoded, err)
	}
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "run is executed, not draft", func(tx pgx.Tx) error {
		_, err := hrExecutePayrollRun(fx.ctx, tx, claims, HRExecutePayrollRunInput{RunID: created.RunID, ExpectedTotalNetMinor: 96_000}, now)
		return err
	})

	var memo, sourceType, currency string
	var sourceID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, currency
		FROM journal_entries WHERE id = $1::uuid`, executed.EntryID).Scan(&memo, &sourceType, &sourceID, &currency); err != nil {
		t.Fatal(err)
	}
	if memo != "payroll 2026-08" || sourceType != "payroll_run" || sourceID == nil || *sourceID != created.RunID || currency != "USD" {
		t.Fatalf("payroll entry = %q %s source=%v currency=%s", memo, sourceType, sourceID, currency)
	}
	assertPurchasingJournalLines(t, purchasingJournalLines(t, fx, executed.EntryID), []JournalEntryLineInput{
		{AccountCode: "6000", DebitMinor: 120_000},
		{AccountCode: "1000", CreditMinor: 96_000},
		{AccountCode: "2200", CreditMinor: 24_000},
	})

	var runStatus, runEntryID, actorType string
	var actorID *string
	var executedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, entry_id::text, executed_by_actor_type, executed_by_actor_id::text, executed_at
		FROM payroll_runs WHERE id = $1::uuid`, created.RunID).Scan(&runStatus, &runEntryID, &actorType, &actorID, &executedAt); err != nil {
		t.Fatal(err)
	}
	if runStatus != "executed" || runEntryID != executed.EntryID || actorType != "human" || actorID == nil || *actorID != fx.userID || !executedAt.Equal(now) {
		t.Fatalf("run after execution = %s entry=%s actor=%s/%v at=%v", runStatus, runEntryID, actorType, actorID, executedAt)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after execution = %d, want balanced books", drift)
	}
}

func TestHRPayrollApplicantsVoidGuardsLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)
	now := time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)
	draftRunID := seedHRPayrollRun(t, fx, fx.orgID, 2026, 3, "draft", 1_000, 100, 900, 1)
	executedRunID := seedHRPayrollRun(t, fx, fx.orgID, 2026, 4, "executed", 1_000, 100, 900, 1)
	foreignRunID := seedHRPayrollRun(t, fx, fx.otherOrgID, 2026, 3, "draft", 5_000, 500, 4_500, 1)

	voided := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRVoidPayrollRunOutput, error) {
		return hrVoidPayrollRun(fx.ctx, tx, fx.orgID, HRVoidPayrollRunInput{RunID: draftRunID}, now)
	})
	if !voided.Voided {
		t.Fatalf("hrVoidPayrollRun output = %+v, want voided", voided)
	}
	if encoded, err := marshalJS(voided); err != nil || string(encoded) != `{"voided":true}` {
		t.Fatalf("hrVoidPayrollRun output JSON = %s, %v", encoded, err)
	}
	var runStatus string
	var voidedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, voided_at FROM payroll_runs WHERE id = $1::uuid`, draftRunID).Scan(&runStatus, &voidedAt); err != nil {
		t.Fatal(err)
	}
	if runStatus != "voided" {
		t.Fatalf("voided run status = %s, want voided", runStatus)
	}
	if !voidedAt.Equal(now) {
		t.Fatalf("voided_at = %s, want %s", voidedAt, now)
	}

	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "no draft payroll run with that id (run is voided)", func(tx pgx.Tx) error {
		_, err := hrVoidPayrollRun(fx.ctx, tx, fx.orgID, HRVoidPayrollRunInput{RunID: draftRunID}, now)
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "executed payroll runs are undone with hr.reversePayrollPosting, which reverses the posting and repairs the run lifecycle", func(tx pgx.Tx) error {
		_, err := hrVoidPayrollRun(fx.ctx, tx, fx.orgID, HRVoidPayrollRunInput{RunID: executedRunID}, now)
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "no draft payroll run with that id", func(tx pgx.Tx) error {
		_, err := hrVoidPayrollRun(fx.ctx, tx, fx.orgID, HRVoidPayrollRunInput{RunID: executorUUID(t)}, now)
		return err
	})
	foreignVoided := hrPayrollApplicantsInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (HRVoidPayrollRunOutput, error) {
		return hrVoidPayrollRun(fx.ctx, tx, fx.otherOrgID, HRVoidPayrollRunInput{RunID: foreignRunID}, now)
	})
	if !foreignVoided.Voided {
		t.Fatalf("foreign draft void = %+v, want voided in its own organization", foreignVoided)
	}
	hrPayrollApplicantsExpectError(t, fx, fx.otherOrgID, "no draft payroll run with that id", func(tx pgx.Tx) error {
		_, err := hrVoidPayrollRun(fx.ctx, tx, fx.otherOrgID, HRVoidPayrollRunInput{RunID: executedRunID}, now)
		return err
	})
}

func TestHRPayrollApplicantsReverseMirrorsPostingAndRepairsLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)
	seedHRPayrollAccounts(t, fx)
	seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Probe Employee", MonthlySalaryMinor: 120_000, TaxRateBps: 2000})
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	later := now.Add(2 * time.Hour)

	created := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRCreatePayrollRunOutput, error) {
		return hrCreatePayrollRun(fx.ctx, tx, fx.orgID, HRCreatePayrollRunInput{Year: 2026, Month: 8})
	})
	executed := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRExecutePayrollRunOutput, error) {
		return hrExecutePayrollRun(fx.ctx, tx, claims, HRExecutePayrollRunInput{RunID: created.RunID, ExpectedTotalNetMinor: 96_000}, now)
	})

	draftRunID := seedHRPayrollRun(t, fx, fx.orgID, 2026, 9, "draft", 0, 0, 0, 0)
	noPostingRunID := seedHRPayrollRun(t, fx, fx.orgID, 2026, 10, "executed", 0, 0, 0, 0)
	unknownRunID := executorUUID(t)

	hrPayrollApplicantsExpectError(t, fx, fx.orgID, fmt.Sprintf("no payroll run %s", unknownRunID), func(tx pgx.Tx) error {
		_, err := hrReversePayrollPosting(fx.ctx, tx, claims, HRReversePayrollPostingInput{RunID: unknownRunID, Reason: "nothing there"}, later)
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "run is draft; only executed runs can be reversed", func(tx pgx.Tx) error {
		_, err := hrReversePayrollPosting(fx.ctx, tx, claims, HRReversePayrollPostingInput{RunID: draftRunID, Reason: "still a draft"}, later)
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "run has no posting to reverse", func(tx pgx.Tx) error {
		_, err := hrReversePayrollPosting(fx.ctx, tx, claims, HRReversePayrollPostingInput{RunID: noPostingRunID, Reason: "no entry"}, later)
		return err
	})

	reversed := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRReversePayrollPostingOutput, error) {
		return hrReversePayrollPosting(fx.ctx, tx, claims, HRReversePayrollPostingInput{RunID: created.RunID, Reason: "wrong month drafted"}, later)
	})
	if !isUUID(reversed.ReversalEntryID) || reversed.ReversedNetMinor != 96_000 {
		t.Fatalf("hrReversePayrollPosting output = %+v, want a mirror entry at 96000 net", reversed)
	}
	if encoded, err := marshalJS(reversed); err != nil || string(encoded) != fmt.Sprintf(`{"reversalEntryId":%q,"reversedNetMinor":96000}`, reversed.ReversalEntryID) {
		t.Fatalf("hrReversePayrollPosting output JSON = %s, %v", encoded, err)
	}

	var memo, sourceType, currency string
	var sourceID, reversalOfID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, reversal_of_id::text, currency
		FROM journal_entries WHERE id = $1::uuid`, reversed.ReversalEntryID).Scan(&memo, &sourceType, &sourceID, &reversalOfID, &currency); err != nil {
		t.Fatal(err)
	}
	if memo != "Reversal of payroll 2026-08: wrong month drafted" || sourceType != "payroll_reversal" ||
		sourceID == nil || *sourceID != created.RunID || reversalOfID == nil || *reversalOfID != executed.EntryID || currency != "USD" {
		t.Fatalf("reversal entry = %q %s source=%v reversal_of=%v currency=%s", memo, sourceType, sourceID, reversalOfID, currency)
	}
	assertPurchasingJournalLines(t, purchasingJournalLines(t, fx, reversed.ReversalEntryID), []JournalEntryLineInput{
		{AccountCode: "6000", CreditMinor: 120_000},
		{AccountCode: "1000", DebitMinor: 96_000},
		{AccountCode: "2200", DebitMinor: 24_000},
	})
	originalLines := fx.count(`SELECT count(*) FROM journal_lines WHERE entry_id = $1::uuid`, executed.EntryID)
	if originalLines != 3 {
		t.Fatalf("original posting lines = %d, want the immutable three untouched", originalLines)
	}
	var runStatus string
	var reversedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, reversed_at FROM payroll_runs WHERE id = $1::uuid`, created.RunID).Scan(&runStatus, &reversedAt); err != nil {
		t.Fatal(err)
	}
	if runStatus != "reversed" || !reversedAt.Equal(later) {
		t.Fatalf("run after reversal = %s at %v, want repaired lifecycle", runStatus, reversedAt)
	}

	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "run is reversed; only executed runs can be reversed", func(tx pgx.Tx) error {
		_, err := hrReversePayrollPosting(fx.ctx, tx, claims, HRReversePayrollPostingInput{RunID: created.RunID, Reason: "replayed reversal"}, later)
		return err
	})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE payroll_runs SET status = 'executed', reversed_at = NULL WHERE id = $1::uuid`, created.RunID); err != nil {
		t.Fatal(err)
	}
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "payroll run has already been reversed", func(tx pgx.Tx) error {
		_, err := hrReversePayrollPosting(fx.ctx, tx, claims, HRReversePayrollPostingInput{RunID: created.RunID, Reason: "replayed reversal"}, later)
		return err
	})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE payroll_runs SET status = 'reversed', reversed_at = $2 WHERE id = $1::uuid`, created.RunID, later); err != nil {
		t.Fatal(err)
	}

	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after reversal = %d, want balanced books", drift)
	}
}

func TestHRPayrollApplicantsPipelineMovesAndListShape(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)
	openingID := seedHRPayrollOpening(t, fx, fx.orgID, "Field Technician", "Field Ops", "open", time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC))
	closedOpeningID := seedHRPayrollOpening(t, fx, fx.orgID, "Closed Role", "", "closed", time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC))
	foreignOpeningID := seedHRPayrollOpening(t, fx, fx.otherOrgID, "Foreign Role", "", "open", time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC))

	added := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRAddApplicantOutput, error) {
		return hrAddApplicant(fx.ctx, tx, fx.orgID, HRAddApplicantInput{OpeningID: openingID, Name: "Grace Njeri", Email: crmStringPointer("grace@example.com"), Note: crmStringPointer("Referred")})
	})
	if !isUUID(added.ApplicantID) {
		t.Fatalf("hrAddApplicant output = %+v, want an applicant id", added)
	}
	if encoded, err := marshalJS(added); err != nil || string(encoded) != fmt.Sprintf(`{"applicantId":%q}`, added.ApplicantID) {
		t.Fatalf("hrAddApplicant output JSON = %s, %v", encoded, err)
	}
	var stage string
	var email, note *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage, email, note FROM job_applicants WHERE id = $1::uuid`, added.ApplicantID).Scan(&stage, &email, &note); err != nil {
		t.Fatal(err)
	}
	if stage != "applied" || email == nil || *email != "grace@example.com" || note == nil || *note != "Referred" {
		t.Fatalf("stored applicant = %s %v %v, want applied stage with email and note", stage, email, note)
	}

	minimal := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRAddApplicantOutput, error) {
		return hrAddApplicant(fx.ctx, tx, fx.orgID, HRAddApplicantInput{OpeningID: openingID, Name: "Min Applicant"})
	})
	if err := fx.owner.QueryRow(fx.ctx, `SELECT email, note FROM job_applicants WHERE id = $1::uuid`, minimal.ApplicantID).Scan(&email, &note); err != nil {
		t.Fatal(err)
	}
	if email != nil || note != nil {
		t.Fatalf("minimal applicant = %v %v, want null email and note", email, note)
	}

	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "opening is closed", func(tx pgx.Tx) error {
		_, err := hrAddApplicant(fx.ctx, tx, fx.orgID, HRAddApplicantInput{OpeningID: closedOpeningID, Name: "Late Applicant"})
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "opening not found", func(tx pgx.Tx) error {
		_, err := hrAddApplicant(fx.ctx, tx, fx.orgID, HRAddApplicantInput{OpeningID: executorUUID(t), Name: "Ghost Applicant"})
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "opening not found", func(tx pgx.Tx) error {
		_, err := hrAddApplicant(fx.ctx, tx, fx.orgID, HRAddApplicantInput{OpeningID: foreignOpeningID, Name: "Foreign Applicant"})
		return err
	})

	moved := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRMoveApplicantOutput, error) {
		return hrMoveApplicant(fx.ctx, tx, fx.orgID, HRMoveApplicantInput{ApplicantID: added.ApplicantID, Stage: "interview"})
	})
	if !moved.Moved || moved.Stage != "interview" {
		t.Fatalf("hrMoveApplicant output = %+v, want moved to interview", moved)
	}
	if encoded, err := marshalJS(moved); err != nil || string(encoded) != `{"moved":true,"stage":"interview"}` {
		t.Fatalf("hrMoveApplicant output JSON = %s, %v", encoded, err)
	}
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "applicant not found", func(tx pgx.Tx) error {
		_, err := hrMoveApplicant(fx.ctx, tx, fx.orgID, HRMoveApplicantInput{ApplicantID: executorUUID(t), Stage: "offer"})
		return err
	})
	hiredSeedID := seedHRPayrollApplicant(t, fx, fx.orgID, openingID, "Already Hired", nil, nil, "hired", time.Date(2026, 9, 2, 8, 0, 0, 0, time.UTC))
	rejectedSeedID := seedHRPayrollApplicant(t, fx, fx.orgID, openingID, "Rejected Early", nil, nil, "rejected", time.Date(2026, 9, 3, 8, 0, 0, 0, time.UTC))
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "applicant is already hired", func(tx pgx.Tx) error {
		_, err := hrMoveApplicant(fx.ctx, tx, fx.orgID, HRMoveApplicantInput{ApplicantID: hiredSeedID, Stage: "screening"})
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "applicant was rejected; start a new application", func(tx pgx.Tx) error {
		_, err := hrMoveApplicant(fx.ctx, tx, fx.orgID, HRMoveApplicantInput{ApplicantID: rejectedSeedID, Stage: "screening"})
		return err
	})

	// The two capability-created rows share one transaction timestamp, so
	// pin explicit created_at values to make the created_at ordering assertable.
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE job_applicants SET created_at = $2 WHERE id = $1::uuid`,
		added.ApplicantID, time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE job_applicants SET created_at = $2 WHERE id = $1::uuid`,
		minimal.ApplicantID, time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	listed := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRListApplicantsOutput, error) {
		return hrListApplicants(fx.ctx, tx, fx.orgID, HRListApplicantsInput{OpeningID: openingID})
	})
	if len(listed.Applicants) != 4 || listed.Applicants[0].ID != added.ApplicantID || listed.Applicants[1].ID != minimal.ApplicantID ||
		listed.Applicants[2].ID != hiredSeedID || listed.Applicants[3].ID != rejectedSeedID {
		t.Fatalf("hrListApplicants rows = %+v, want four applicants in created order", listed.Applicants)
	}
	if listed.Applicants[0].Name != "Grace Njeri" || listed.Applicants[0].Stage != "interview" || listed.Applicants[0].Note == nil || *listed.Applicants[0].Note != "Referred" {
		t.Fatalf("first applicant row = %+v, want the moved candidate with a note", listed.Applicants[0])
	}
	firstJSON, err := marshalJS(listed.Applicants[0])
	if err != nil || string(firstJSON) != fmt.Sprintf(`{"id":%q,"name":"Grace Njeri","stage":"interview","note":"Referred"}`, added.ApplicantID) {
		t.Fatalf("first applicant JSON = %s, %v", firstJSON, err)
	}
	if listed.Applicants[1].Note != nil {
		t.Fatalf("second applicant note = %v, want null", listed.Applicants[1].Note)
	}
	foreignListed := hrPayrollApplicantsInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (HRListApplicantsOutput, error) {
		return hrListApplicants(fx.ctx, tx, fx.otherOrgID, HRListApplicantsInput{OpeningID: openingID})
	})
	if len(foreignListed.Applicants) != 0 {
		t.Fatalf("foreign organization applicants = %+v, want none", foreignListed.Applicants)
	}
	if encoded, err := marshalJS(foreignListed); err != nil || string(encoded) != `{"applicants":[]}` {
		t.Fatalf("empty list JSON = %s, %v", encoded, err)
	}
}

func TestHRPayrollApplicantsHireConvertsApplicantToEmployee(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)
	openingID := seedHRPayrollOpening(t, fx, fx.orgID, "Field Technician", "Field Ops", "open", time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC))
	offerApplicantID := seedHRPayrollApplicant(t, fx, fx.orgID, openingID, "Grace Njeri", crmStringPointer("grace@example.com"), crmStringPointer("Strong references"), "offer", time.Date(2026, 9, 2, 8, 0, 0, 0, time.UTC))
	defaultLeaveApplicantID := seedHRPayrollApplicant(t, fx, fx.orgID, openingID, "Default Leaves", nil, nil, "screening", time.Date(2026, 9, 3, 8, 0, 0, 0, time.UTC))
	rejectedApplicantID := seedHRPayrollApplicant(t, fx, fx.orgID, openingID, "Rejected Candidate", nil, nil, "rejected", time.Date(2026, 9, 4, 8, 0, 0, 0, time.UTC))

	hired := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRHireApplicantOutput, error) {
		return hrHireApplicant(fx.ctx, tx, fx.orgID, HRHireApplicantInput{ApplicantID: offerApplicantID, MonthlySalaryMinor: 450_000, AnnualLeaveDays: crmInt64Pointer(24)})
	})
	if !isUUID(hired.EmployeeID) || hired.ApplicantID != offerApplicantID {
		t.Fatalf("hrHireApplicant output = %+v, want a linked employee", hired)
	}
	if encoded, err := marshalJS(hired); err != nil || string(encoded) != fmt.Sprintf(`{"employeeId":%q,"applicantId":%q}`, hired.EmployeeID, hired.ApplicantID) {
		t.Fatalf("hrHireApplicant output JSON = %s, %v", encoded, err)
	}
	var stored struct {
		OrgID              string
		Name               string
		Email              *string
		Title              *string
		Department         *string
		MonthlySalaryMinor int64
		TaxRateBps         int64
		AnnualLeaveDays    int64
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, name, email, title, department, monthly_salary_minor, tax_rate_bps, annual_leave_days
		FROM employees WHERE id = $1::uuid`, hired.EmployeeID).
		Scan(&stored.OrgID, &stored.Name, &stored.Email, &stored.Title, &stored.Department, &stored.MonthlySalaryMinor, &stored.TaxRateBps, &stored.AnnualLeaveDays); err != nil {
		t.Fatal(err)
	}
	if stored.OrgID != fx.orgID || stored.Name != "Grace Njeri" || stored.Email == nil || *stored.Email != "grace@example.com" ||
		stored.Title == nil || *stored.Title != "Field Technician" || stored.Department == nil || *stored.Department != "Field Ops" ||
		stored.MonthlySalaryMinor != 450_000 || stored.TaxRateBps != 1000 || stored.AnnualLeaveDays != 24 {
		t.Fatalf("hired employee = %+v, want the opening title and department with schema default tax", stored)
	}
	var applicantStage string
	var hiredEmployeeID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage, hired_employee_id::text FROM job_applicants WHERE id = $1::uuid`, offerApplicantID).Scan(&applicantStage, &hiredEmployeeID); err != nil {
		t.Fatal(err)
	}
	if applicantStage != "hired" || hiredEmployeeID == nil || *hiredEmployeeID != hired.EmployeeID {
		t.Fatalf("hired applicant = %s -> %v, want the pipeline closed with the employee link", applicantStage, hiredEmployeeID)
	}

	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "applicant is already hired", func(tx pgx.Tx) error {
		_, err := hrHireApplicant(fx.ctx, tx, fx.orgID, HRHireApplicantInput{ApplicantID: offerApplicantID, MonthlySalaryMinor: 450_000})
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "applicant was rejected", func(tx pgx.Tx) error {
		_, err := hrHireApplicant(fx.ctx, tx, fx.orgID, HRHireApplicantInput{ApplicantID: rejectedApplicantID, MonthlySalaryMinor: 100_000})
		return err
	})
	hrPayrollApplicantsExpectError(t, fx, fx.orgID, "applicant not found", func(tx pgx.Tx) error {
		_, err := hrHireApplicant(fx.ctx, tx, fx.orgID, HRHireApplicantInput{ApplicantID: executorUUID(t), MonthlySalaryMinor: 100_000})
		return err
	})

	defaultHired := hrPayrollApplicantsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (HRHireApplicantOutput, error) {
		return hrHireApplicant(fx.ctx, tx, fx.orgID, HRHireApplicantInput{ApplicantID: defaultLeaveApplicantID, MonthlySalaryMinor: 200_000})
	})
	var defaultLeaveDays int64
	var defaultEmail *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT annual_leave_days, email FROM employees WHERE id = $1::uuid`, defaultHired.EmployeeID).Scan(&defaultLeaveDays, &defaultEmail); err != nil {
		t.Fatal(err)
	}
	if defaultLeaveDays != 21 || defaultEmail != nil {
		t.Fatalf("default hire = %d leave days, %v email, want 21 and null", defaultLeaveDays, defaultEmail)
	}
}

func hrPayrollApplicantsTimePointer(value time.Time) *time.Time {
	return &value
}
