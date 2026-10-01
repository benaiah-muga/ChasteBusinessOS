package capability

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

type HRReportInput struct{}

type HRReportEmployee struct {
	ID                    string  `json:"id"`
	Name                  string  `json:"name"`
	Email                 *string `json:"email"`
	Title                 *string `json:"title"`
	Department            *string `json:"department"`
	ManagerEmployeeID     *string `json:"managerEmployeeId"`
	EmergencyContactName  *string `json:"emergencyContactName"`
	EmergencyContactPhone *string `json:"emergencyContactPhone"`
	MonthlySalaryMinor    int64   `json:"monthlySalaryMinor"`
	TaxRateBps            int64   `json:"taxRateBps"`
	Active                bool    `json:"active"`
}

type HRReportLeave struct {
	ID           string `json:"id"`
	EmployeeName string `json:"employeeName"`
	Kind         string `json:"kind"`
	StartDate    string `json:"startDate"`
	EndDate      string `json:"endDate"`
	CalendarDays int64  `json:"calendarDays"`
	Status       string `json:"status"`
}

type HRReportPayrollRun struct {
	ID                  string     `json:"id"`
	OrgID               string     `json:"orgId"`
	Year                int64      `json:"year"`
	Month               int64      `json:"month"`
	Status              string     `json:"status"`
	TotalGrossMinor     int64      `json:"totalGrossMinor"`
	TotalTaxMinor       int64      `json:"totalTaxMinor"`
	TotalNetMinor       int64      `json:"totalNetMinor"`
	Headcount           int64      `json:"headcount"`
	EntryID             *string    `json:"entryId"`
	ExecutedByActorType *string    `json:"executedByActorType"`
	ExecutedByActorID   *string    `json:"executedByActorId"`
	ExecutedAt          *time.Time `json:"executedAt"`
	VoidedAt            *time.Time `json:"voidedAt"`
	ReversedAt          *time.Time `json:"reversedAt"`
	CreatedAt           time.Time  `json:"createdAt"`
}

type HRReportOpening struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Department *string   `json:"department"`
	Note       *string   `json:"note"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"createdAt"`
}

type HRReportApplicant struct {
	ID        string  `json:"id"`
	OpeningID string  `json:"openingId"`
	Name      string  `json:"name"`
	Stage     string  `json:"stage"`
	Note      *string `json:"note"`
}

type HRReportAttendance struct {
	EmployeeID  string    `json:"employeeId"`
	ClockedInAt time.Time `json:"clockedInAt"`
	Late        bool      `json:"late"`
}

type HRReportOutput struct {
	Employees  []HRReportEmployee   `json:"employees"`
	Leave      []HRReportLeave      `json:"leave"`
	Runs       []HRReportPayrollRun `json:"runs"`
	Openings   []HRReportOpening    `json:"openings"`
	Applicants []HRReportApplicant  `json:"applicants"`
	Attendance []HRReportAttendance `json:"attendance"`
}

func ParseHRReportInput(raw json.RawMessage) (HRReportInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return HRReportInput{}, err
	}
	return HRReportInput{}, nil
}

func hrReport(ctx context.Context, tx pgx.Tx, orgID string) (HRReportOutput, error) {
	report := HRReportOutput{
		Employees: make([]HRReportEmployee, 0), Leave: make([]HRReportLeave, 0),
		Runs: make([]HRReportPayrollRun, 0), Openings: make([]HRReportOpening, 0),
		Applicants: make([]HRReportApplicant, 0), Attendance: make([]HRReportAttendance, 0),
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, email, title, department, manager_employee_id::text,
			emergency_contact_name, emergency_contact_phone, monthly_salary_minor,
			tax_rate_bps, deactivated_at IS NULL
		FROM employees WHERE org_id = $1::uuid
		ORDER BY hired_at DESC LIMIT 200`, orgID)
	if err != nil {
		return HRReportOutput{}, err
	}
	for rows.Next() {
		var row HRReportEmployee
		if err := rows.Scan(&row.ID, &row.Name, &row.Email, &row.Title, &row.Department,
			&row.ManagerEmployeeID, &row.EmergencyContactName, &row.EmergencyContactPhone,
			&row.MonthlySalaryMinor, &row.TaxRateBps, &row.Active); err != nil {
			rows.Close()
			return HRReportOutput{}, err
		}
		report.Employees = append(report.Employees, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return HRReportOutput{}, err
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT lr.id::text, e.name, lr.kind, lr.start_date, lr.end_date, lr.calendar_days, lr.status
		FROM leave_requests lr INNER JOIN employees e ON e.id = lr.employee_id
		WHERE lr.org_id = $1::uuid ORDER BY lr.created_at DESC LIMIT 50`, orgID)
	if err != nil {
		return HRReportOutput{}, err
	}
	for rows.Next() {
		var row HRReportLeave
		var start, end time.Time
		if err := rows.Scan(&row.ID, &row.EmployeeName, &row.Kind, &start, &end, &row.CalendarDays, &row.Status); err != nil {
			rows.Close()
			return HRReportOutput{}, err
		}
		row.StartDate, row.EndDate = start.UTC().Format(time.RFC3339Nano), end.UTC().Format(time.RFC3339Nano)
		report.Leave = append(report.Leave, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return HRReportOutput{}, err
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT id::text, org_id::text, year, month, status, total_gross_minor, total_tax_minor,
			total_net_minor, headcount, entry_id::text, executed_by_actor_type, executed_by_actor_id::text,
			executed_at, voided_at, reversed_at, created_at
		FROM payroll_runs WHERE org_id = $1::uuid ORDER BY year DESC, month DESC LIMIT 24`, orgID)
	if err != nil {
		return HRReportOutput{}, err
	}
	for rows.Next() {
		var row HRReportPayrollRun
		if err := rows.Scan(&row.ID, &row.OrgID, &row.Year, &row.Month, &row.Status, &row.TotalGrossMinor,
			&row.TotalTaxMinor, &row.TotalNetMinor, &row.Headcount, &row.EntryID, &row.ExecutedByActorType,
			&row.ExecutedByActorID, &row.ExecutedAt, &row.VoidedAt, &row.ReversedAt, &row.CreatedAt); err != nil {
			rows.Close()
			return HRReportOutput{}, err
		}
		report.Runs = append(report.Runs, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return HRReportOutput{}, err
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT id::text, title, department, note, status, created_at
		FROM job_openings WHERE org_id = $1::uuid ORDER BY created_at DESC LIMIT 50`, orgID)
	if err != nil {
		return HRReportOutput{}, err
	}
	for rows.Next() {
		var row HRReportOpening
		if err := rows.Scan(&row.ID, &row.Title, &row.Department, &row.Note, &row.Status, &row.CreatedAt); err != nil {
			rows.Close()
			return HRReportOutput{}, err
		}
		report.Openings = append(report.Openings, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return HRReportOutput{}, err
	}
	rows.Close()

	for _, opening := range report.Openings {
		if opening.Status != "open" {
			continue
		}
		rows, err = tx.Query(ctx, `
			SELECT id::text, name, stage, note FROM job_applicants
			WHERE org_id = $1::uuid AND opening_id = $2::uuid ORDER BY created_at ASC`, orgID, opening.ID)
		if err != nil {
			return HRReportOutput{}, err
		}
		for rows.Next() {
			var row HRReportApplicant
			row.OpeningID = opening.ID
			if err := rows.Scan(&row.ID, &row.Name, &row.Stage, &row.Note); err != nil {
				rows.Close()
				return HRReportOutput{}, err
			}
			report.Applicants = append(report.Applicants, row)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return HRReportOutput{}, err
		}
		rows.Close()
	}

	rows, err = tx.Query(ctx, `
		SELECT employee_id::text, clocked_in_at, late FROM time_entries
		WHERE org_id = $1::uuid AND clocked_out_at IS NULL AND clocked_in_at IS NOT NULL
		ORDER BY clocked_in_at DESC LIMIT 200`, orgID)
	if err != nil {
		return HRReportOutput{}, err
	}
	for rows.Next() {
		var row HRReportAttendance
		if err := rows.Scan(&row.EmployeeID, &row.ClockedInAt, &row.Late); err != nil {
			rows.Close()
			return HRReportOutput{}, err
		}
		report.Attendance = append(report.Attendance, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return HRReportOutput{}, err
	}
	rows.Close()
	return report, nil
}
