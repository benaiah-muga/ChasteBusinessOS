package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	hrRequestLeaveCapabilityID    = "hr.requestLeave"
	hrCancelLeaveCapabilityID     = "hr.cancelLeave"
	hrDecideLeaveCapabilityID     = "hr.decideLeave"
	hrLogTimeCapabilityID         = "hr.logTime"
	hrDecideTimeEntryCapabilityID = "hr.decideTimeEntry"
	hrClockInCapabilityID         = "hr.clockIn"
	hrClockOutCapabilityID        = "hr.clockOut"
	hrLeaveBalanceCapabilityID    = "hr.leaveBalance"
	hrLeaveCalendarCapabilityID   = "hr.leaveCalendar"
	hrTimeReportCapabilityID      = "hr.timeReport"
)

// hrMaxMinutesPerDay mirrors MAX_MINUTES_PER_DAY in modules/hr.
const hrMaxMinutesPerDay = 24 * 60

// hrLateThresholdMinutes mirrors LATE_THRESHOLD_MINUTES: 09:00 UTC in
// minutes-of-day.
const hrLateThresholdMinutes = 9 * 60

const hrClockInLateNote = "clocked in late"

var hrLeaveKindValues = []string{"annual", "sick", "unpaid"}

var hrTimeEntryDecisionValues = []string{"approved", "rejected"}

type HRRequestLeaveInput struct {
	EmployeeID string `json:"employeeId"`
	Kind       string `json:"kind"`
	StartDate  string `json:"startDate"`
	EndDate    string `json:"endDate"`
}

type HRRequestLeaveOutput struct {
	RequestID    string `json:"requestId"`
	CalendarDays int64  `json:"calendarDays"`
}

type HRCancelLeaveInput struct {
	RequestID string `json:"requestId"`
}

type HRCancelLeaveOutput struct {
	Cancelled bool `json:"cancelled"`
}

type HRDecideLeaveInput struct {
	RequestID string  `json:"requestId"`
	Approve   bool    `json:"approve"`
	Comment   *string `json:"comment,omitempty"`
}

type HRDecideLeaveOutput struct {
	Status string `json:"status"`
}

type HRLogTimeInput struct {
	EmployeeID string  `json:"employeeId"`
	WorkDate   string  `json:"workDate"`
	Minutes    int64   `json:"minutes"`
	Note       *string `json:"note,omitempty"`
}

type HRLogTimeOutput struct {
	EntryID string `json:"entryId"`
	Status  string `json:"status"`
}

type HRDecideTimeEntryInput struct {
	EntryID  string `json:"entryId"`
	Decision string `json:"decision"`
}

type HRDecideTimeEntryOutput struct {
	EntryID string `json:"entryId"`
	Status  string `json:"status"`
}

type HRTimeReportInput struct {
	From       string  `json:"from"`
	To         string  `json:"to"`
	EmployeeID *string `json:"employeeId,omitempty"`
}

type HRTimeReportRow struct {
	EmployeeID      string `json:"employeeId"`
	ApprovedMinutes int64  `json:"approvedMinutes"`
	PendingMinutes  int64  `json:"pendingMinutes"`
}

type HRTimeReportOutput struct {
	Rows []HRTimeReportRow `json:"rows"`
}

type HRClockInInput struct {
	EmployeeID string `json:"employeeId"`
}

type HRClockInOutput struct {
	EntryID string `json:"entryId"`
	Late    bool   `json:"late"`
}

type HRClockOutInput struct {
	EmployeeID string `json:"employeeId"`
}

type HRClockOutOutput struct {
	EntryID string `json:"entryId"`
	Minutes int64  `json:"minutes"`
}

type HRLeaveBalanceInput struct {
	EmployeeID string `json:"employeeId"`
}

type HRLeaveBalanceOutput struct {
	EntitlementDays int64 `json:"entitlementDays"`
	TakenDays       int64 `json:"takenDays"`
	RemainingDays   int64 `json:"remainingDays"`
}

type HRLeaveCalendarInput struct {
	Year  int64 `json:"year"`
	Month int64 `json:"month"`
}

type HRLeaveCalendarEntry struct {
	EmployeeName string `json:"employeeName"`
	Kind         string `json:"kind"`
	StartDate    string `json:"startDate"`
	EndDate      string `json:"endDate"`
	Days         int64  `json:"days"`
}

type HRLeaveCalendarOutput struct {
	Entries []HRLeaveCalendarEntry `json:"entries"`
}

func ParseHRRequestLeaveInput(raw json.RawMessage) (HRRequestLeaveInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRRequestLeaveInput{}, err
	}
	var input HRRequestLeaveInput
	if input.EmployeeID, err = requiredString(fields, "employeeId"); err != nil {
		return HRRequestLeaveInput{}, err
	}
	input.Kind = "annual"
	if _, ok := fields["kind"]; ok {
		if input.Kind, err = projectRequiredEnum(fields, "kind", hrLeaveKindValues); err != nil {
			return HRRequestLeaveInput{}, err
		}
	}
	if input.StartDate, err = requiredString(fields, "startDate"); err != nil {
		return HRRequestLeaveInput{}, err
	}
	if input.EndDate, err = requiredString(fields, "endDate"); err != nil {
		return HRRequestLeaveInput{}, err
	}
	return input, nil
}

func ParseHRCancelLeaveInput(raw json.RawMessage) (HRCancelLeaveInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRCancelLeaveInput{}, err
	}
	var input HRCancelLeaveInput
	if input.RequestID, err = requiredString(fields, "requestId"); err != nil {
		return HRCancelLeaveInput{}, err
	}
	return input, nil
}

func ParseHRDecideLeaveInput(raw json.RawMessage) (HRDecideLeaveInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRDecideLeaveInput{}, err
	}
	var input HRDecideLeaveInput
	if input.RequestID, err = requiredString(fields, "requestId"); err != nil {
		return HRDecideLeaveInput{}, err
	}
	raw, ok := fields["approve"]
	if !ok || bytesIsNull(raw) {
		return HRDecideLeaveInput{}, errors.New("approve is required")
	}
	if err := json.Unmarshal(raw, &input.Approve); err != nil {
		return HRDecideLeaveInput{}, errors.New("approve must be a boolean")
	}
	if input.Comment, err = optionalString(fields, "comment"); err != nil {
		return HRDecideLeaveInput{}, err
	} else if input.Comment != nil && utf16Length(*input.Comment) > 500 {
		return HRDecideLeaveInput{}, errors.New("comment must be at most 500 characters")
	}
	return input, nil
}

func ParseHRLogTimeInput(raw json.RawMessage) (HRLogTimeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRLogTimeInput{}, err
	}
	var input HRLogTimeInput
	if input.EmployeeID, err = requiredString(fields, "employeeId"); err != nil {
		return HRLogTimeInput{}, err
	}
	if !isZodUUID(input.EmployeeID) {
		return HRLogTimeInput{}, errors.New("employeeId must be a UUID")
	}
	if input.WorkDate, err = requiredString(fields, "workDate"); err != nil {
		return HRLogTimeInput{}, err
	}
	input.Minutes, err = requiredSafeInteger(fields, "minutes")
	if err != nil {
		return HRLogTimeInput{}, err
	}
	if input.Minutes <= 0 {
		return HRLogTimeInput{}, errors.New("minutes must be a positive integer")
	}
	if input.Minutes > hrMaxMinutesPerDay {
		return HRLogTimeInput{}, fmt.Errorf("minutes must be at most %d", hrMaxMinutesPerDay)
	}
	if input.Note, err = optionalString(fields, "note"); err != nil {
		return HRLogTimeInput{}, err
	} else if input.Note != nil && utf16Length(*input.Note) > 300 {
		return HRLogTimeInput{}, errors.New("note must be at most 300 characters")
	}
	return input, nil
}

func ParseHRDecideTimeEntryInput(raw json.RawMessage) (HRDecideTimeEntryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRDecideTimeEntryInput{}, err
	}
	var input HRDecideTimeEntryInput
	if input.EntryID, err = requiredString(fields, "entryId"); err != nil {
		return HRDecideTimeEntryInput{}, err
	}
	if !isZodUUID(input.EntryID) {
		return HRDecideTimeEntryInput{}, errors.New("entryId must be a UUID")
	}
	if input.Decision, err = projectRequiredEnum(fields, "decision", hrTimeEntryDecisionValues); err != nil {
		return HRDecideTimeEntryInput{}, err
	}
	return input, nil
}

func ParseHRTimeReportInput(raw json.RawMessage) (HRTimeReportInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRTimeReportInput{}, err
	}
	var input HRTimeReportInput
	if input.From, err = requiredString(fields, "from"); err != nil {
		return HRTimeReportInput{}, err
	}
	if input.To, err = requiredString(fields, "to"); err != nil {
		return HRTimeReportInput{}, err
	}
	if input.EmployeeID, err = crmTaskOptionalUUID(fields, "employeeId"); err != nil {
		return HRTimeReportInput{}, err
	}
	return input, nil
}

func ParseHRClockInInput(raw json.RawMessage) (HRClockInInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRClockInInput{}, err
	}
	var input HRClockInInput
	if input.EmployeeID, err = requiredString(fields, "employeeId"); err != nil {
		return HRClockInInput{}, err
	}
	if !isZodUUID(input.EmployeeID) {
		return HRClockInInput{}, errors.New("employeeId must be a UUID")
	}
	return input, nil
}

func ParseHRClockOutInput(raw json.RawMessage) (HRClockOutInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRClockOutInput{}, err
	}
	var input HRClockOutInput
	if input.EmployeeID, err = requiredString(fields, "employeeId"); err != nil {
		return HRClockOutInput{}, err
	}
	if !isZodUUID(input.EmployeeID) {
		return HRClockOutInput{}, errors.New("employeeId must be a UUID")
	}
	return input, nil
}

func ParseHRLeaveBalanceInput(raw json.RawMessage) (HRLeaveBalanceInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRLeaveBalanceInput{}, err
	}
	var input HRLeaveBalanceInput
	if input.EmployeeID, err = requiredString(fields, "employeeId"); err != nil {
		return HRLeaveBalanceInput{}, err
	}
	if !isZodUUID(input.EmployeeID) {
		return HRLeaveBalanceInput{}, errors.New("employeeId must be a UUID")
	}
	return input, nil
}

func ParseHRLeaveCalendarInput(raw json.RawMessage) (HRLeaveCalendarInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRLeaveCalendarInput{}, err
	}
	var input HRLeaveCalendarInput
	if input.Year, err = requiredSafeInteger(fields, "year"); err != nil {
		return HRLeaveCalendarInput{}, err
	}
	if input.Month, err = requiredSafeInteger(fields, "month"); err != nil {
		return HRLeaveCalendarInput{}, err
	}
	if input.Month < 1 || input.Month > 12 {
		return HRLeaveCalendarInput{}, errors.New("month must be between 1 and 12")
	}
	return input, nil
}

// hrParseISODate accepts the date forms JavaScript's Date constructor
// resolves deterministically for these inputs: YYYY-MM-DD (UTC midnight) and
// RFC3339 datetimes. Date-only values round-trip through the layout so
// zero-padded shapes stay canonical.
func hrParseISODate(value string) (time.Time, error) {
	if parsed, err := time.Parse("2006-01-02", value); err == nil && parsed.Format("2006-01-02") == value {
		return parsed, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%q is not an ISO date (YYYY-MM-DD)", value)
	}
	return parsed, nil
}

// hrCalendarDaysBetween mirrors calendarDaysBetween in modules/hr: inclusive
// day count with Math.floor semantics, so negative spans round down.
func hrCalendarDaysBetween(start, end time.Time) int64 {
	millis := end.Sub(start).Milliseconds()
	days := millis / (24 * 60 * 60 * 1000)
	if millis%(24*60*60*1000) != 0 && millis < 0 {
		days--
	}
	return days + 1
}

// hrMinutesOfDay mirrors minutesOfDay: UTC hours and minutes only.
func hrMinutesOfDay(at time.Time) int {
	utc := at.UTC()
	return utc.Hour()*60 + utc.Minute()
}

// hrJSMathRound matches JavaScript Math.round, which rounds halfway cases
// toward positive infinity, not away from zero.
func hrJSMathRound(value float64) int64 {
	return int64(math.Floor(value + 0.5))
}

func hrISOString(at time.Time) string {
	return at.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func hrRequestLeave(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input HRRequestLeaveInput) (HRRequestLeaveOutput, error) {
	startDate, err := hrParseISODate(input.StartDate)
	if err != nil {
		return HRRequestLeaveOutput{}, errors.New("leave dates must be valid ISO dates (YYYY-MM-DD)")
	}
	endDate, err := hrParseISODate(input.EndDate)
	if err != nil {
		return HRRequestLeaveOutput{}, errors.New("leave dates must be valid ISO dates (YYYY-MM-DD)")
	}
	if endDate.Before(startDate) {
		return HRRequestLeaveOutput{}, errors.New("leave cannot end before it starts")
	}
	var employeeExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM employees
			WHERE org_id = $1::uuid AND id = $2::uuid
		)`, claims.OrganizationID, input.EmployeeID).Scan(&employeeExists); err != nil {
		return HRRequestLeaveOutput{}, err
	}
	if !employeeExists {
		return HRRequestLeaveOutput{}, errors.New("employee not found")
	}
	calendarDays := hrCalendarDaysBetween(startDate, endDate)
	var requestID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO leave_requests (
			org_id, employee_id, kind, start_date, end_date, calendar_days,
			requested_by_actor_type, requested_by_actor_id
		)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)
		RETURNING id::text`,
		claims.OrganizationID, input.EmployeeID, input.Kind, startDate, endDate, calendarDays,
		claims.ActorType, claims.ActorID).Scan(&requestID); err != nil {
		return HRRequestLeaveOutput{}, err
	}
	return HRRequestLeaveOutput{RequestID: requestID, CalendarDays: calendarDays}, nil
}

func hrCancelLeave(ctx context.Context, tx pgx.Tx, orgID string, input HRCancelLeaveInput) (HRCancelLeaveOutput, error) {
	var requestID string
	err := tx.QueryRow(ctx, `
		UPDATE leave_requests SET status = 'cancelled'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'pending'
		RETURNING id::text`, input.RequestID, orgID).Scan(&requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRCancelLeaveOutput{}, errors.New("no pending leave request with that id")
	}
	if err != nil {
		return HRCancelLeaveOutput{}, err
	}
	return HRCancelLeaveOutput{Cancelled: true}, nil
}

func hrDecideLeave(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input HRDecideLeaveInput, now time.Time) (HRDecideLeaveOutput, error) {
	status := "rejected"
	if input.Approve {
		status = "approved"
	}
	var decidedByUserID *string
	if claims.ActorType == "human" {
		decidedByUserID = claims.ActorID
	}
	var requestID string
	err := tx.QueryRow(ctx, `
		UPDATE leave_requests
		SET status = $3, decided_by_user_id = $4::uuid, decided_at = $5
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'pending'
		RETURNING id::text`, input.RequestID, claims.OrganizationID, status, decidedByUserID, now).Scan(&requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRDecideLeaveOutput{}, errors.New("no pending leave request with that id")
	}
	if err != nil {
		return HRDecideLeaveOutput{}, err
	}
	return HRDecideLeaveOutput{Status: status}, nil
}

func hrLogTime(ctx context.Context, tx pgx.Tx, orgID string, input HRLogTimeInput, now time.Time) (HRLogTimeOutput, error) {
	var employeeID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM employees
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.EmployeeID, orgID).Scan(&employeeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRLogTimeOutput{}, errors.New("employee not found")
	}
	if err != nil {
		return HRLogTimeOutput{}, err
	}
	workDate, err := hrParseISODate(input.WorkDate)
	if err != nil {
		return HRLogTimeOutput{}, errors.New("workDate must be a valid ISO date (YYYY-MM-DD)")
	}
	if workDate.After(now.Add(24 * time.Hour)) {
		return HRLogTimeOutput{}, errors.New("cannot log time more than a day in the future")
	}
	var entryID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO time_entries (org_id, employee_id, work_date, minutes, note)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text`, orgID, employeeID, workDate, input.Minutes, input.Note).Scan(&entryID); err != nil {
		return HRLogTimeOutput{}, err
	}
	return HRLogTimeOutput{EntryID: entryID, Status: "submitted"}, nil
}

func hrDecideTimeEntry(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input HRDecideTimeEntryInput) (HRDecideTimeEntryOutput, error) {
	var entryID string
	err := tx.QueryRow(ctx, `
		UPDATE time_entries
		SET status = $3, decided_by_actor_type = $4, decided_by_actor_id = $5::uuid
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'submitted'
		RETURNING id::text`, input.EntryID, claims.OrganizationID, input.Decision, claims.ActorType, claims.ActorID).Scan(&entryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRDecideTimeEntryOutput{}, errors.New("entry not found or already decided")
	}
	if err != nil {
		return HRDecideTimeEntryOutput{}, err
	}
	return HRDecideTimeEntryOutput{EntryID: input.EntryID, Status: input.Decision}, nil
}

func hrTimeReport(ctx context.Context, tx pgx.Tx, orgID string, input HRTimeReportInput) (HRTimeReportOutput, error) {
	from, err := hrParseISODate(input.From)
	if err != nil {
		return HRTimeReportOutput{}, errors.New("from must be a valid ISO date (YYYY-MM-DD)")
	}
	to, err := hrParseISODate(input.To)
	if err != nil {
		return HRTimeReportOutput{}, errors.New("to must be a valid ISO date (YYYY-MM-DD)")
	}
	query := `
		SELECT employee_id::text, status, coalesce(sum(minutes), 0)
		FROM time_entries
		WHERE org_id = $1::uuid AND work_date >= $2 AND work_date <= $3`
	args := []any{orgID, from, to}
	if input.EmployeeID != nil {
		query += fmt.Sprintf(` AND employee_id = $%d::uuid`, len(args)+1)
		args = append(args, *input.EmployeeID)
	}
	query += ` GROUP BY employee_id, status`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return HRTimeReportOutput{}, err
	}
	defer rows.Close()
	report := HRTimeReportOutput{Rows: make([]HRTimeReportRow, 0)}
	indexes := make(map[string]int)
	for rows.Next() {
		var employeeID, status string
		var minutes int64
		if err := rows.Scan(&employeeID, &status, &minutes); err != nil {
			return HRTimeReportOutput{}, err
		}
		index, seen := indexes[employeeID]
		if !seen {
			// Insertion order of first appearance mirrors the TS Map.
			index = len(report.Rows)
			indexes[employeeID] = index
			report.Rows = append(report.Rows, HRTimeReportRow{EmployeeID: employeeID})
		}
		switch status {
		case "approved":
			report.Rows[index].ApprovedMinutes += minutes
		case "submitted":
			report.Rows[index].PendingMinutes += minutes
		}
	}
	if err := rows.Err(); err != nil {
		return HRTimeReportOutput{}, err
	}
	return report, nil
}

func hrClockIn(ctx context.Context, tx pgx.Tx, orgID string, input HRClockInInput, now time.Time) (HRClockInOutput, error) {
	var employeeID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM employees
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.EmployeeID, orgID).Scan(&employeeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRClockInOutput{}, errors.New("employee not found")
	}
	if err != nil {
		return HRClockInOutput{}, err
	}
	var openEntryID string
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM time_entries
		WHERE org_id = $1::uuid AND employee_id = $2::uuid
			AND clocked_in_at IS NOT NULL AND clocked_out_at IS NULL
		LIMIT 1`, orgID, input.EmployeeID).Scan(&openEntryID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return HRClockInOutput{}, err
	}
	if openEntryID != "" {
		return HRClockInOutput{}, errors.New("already clocked in; clock out first")
	}
	late := hrMinutesOfDay(now) > hrLateThresholdMinutes
	var note *string
	if late {
		lateNote := hrClockInLateNote
		note = &lateNote
	}
	var entryID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO time_entries (org_id, employee_id, work_date, minutes, clocked_in_at, late, note)
		VALUES ($1::uuid, $2::uuid, $3, 0, $3, $4, $5)
		RETURNING id::text`, orgID, input.EmployeeID, now, late, note).Scan(&entryID); err != nil {
		return HRClockInOutput{}, err
	}
	return HRClockInOutput{EntryID: entryID, Late: late}, nil
}

func hrClockOut(ctx context.Context, tx pgx.Tx, orgID string, input HRClockOutInput, now time.Time) (HRClockOutOutput, error) {
	var entryID string
	var clockedInAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT id::text, clocked_in_at FROM time_entries
		WHERE org_id = $1::uuid AND employee_id = $2::uuid
			AND clocked_in_at IS NOT NULL AND clocked_out_at IS NULL
		ORDER BY clocked_in_at DESC
		LIMIT 1`, orgID, input.EmployeeID).Scan(&entryID, &clockedInAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRClockOutOutput{}, errors.New("no open clock-in entry")
	}
	if err != nil {
		return HRClockOutOutput{}, err
	}
	startedAt := now
	if clockedInAt != nil {
		startedAt = *clockedInAt
	}
	minutes := hrJSMathRound(float64(now.Sub(startedAt).Milliseconds()) / 60000.0)
	if minutes < 1 {
		minutes = 1
	}
	if _, err := tx.Exec(ctx, `
		UPDATE time_entries SET clocked_out_at = $2, minutes = $3
		WHERE id = $1::uuid`, entryID, now, minutes); err != nil {
		return HRClockOutOutput{}, err
	}
	return HRClockOutOutput{EntryID: entryID, Minutes: minutes}, nil
}

func hrLeaveBalance(ctx context.Context, tx pgx.Tx, orgID string, input HRLeaveBalanceInput, now time.Time) (HRLeaveBalanceOutput, error) {
	var entitlementDays int64
	err := tx.QueryRow(ctx, `
		SELECT annual_leave_days FROM employees
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1`, input.EmployeeID, orgID).Scan(&entitlementDays)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRLeaveBalanceOutput{}, errors.New("employee not found")
	}
	if err != nil {
		return HRLeaveBalanceOutput{}, err
	}
	yearStart := time.Date(now.UTC().Year(), time.January, 1, 0, 0, 0, 0, time.UTC)
	rows, err := tx.Query(ctx, `
		SELECT start_date, end_date FROM leave_requests
		WHERE org_id = $1::uuid AND employee_id = $2::uuid
			AND kind = 'annual' AND status = 'approved' AND start_date >= $3`,
		orgID, input.EmployeeID, yearStart)
	if err != nil {
		return HRLeaveBalanceOutput{}, err
	}
	defer rows.Close()
	var takenDays int64
	for rows.Next() {
		var startDate, endDate time.Time
		if err := rows.Scan(&startDate, &endDate); err != nil {
			return HRLeaveBalanceOutput{}, err
		}
		takenDays += hrCalendarDaysBetween(startDate, endDate)
	}
	if err := rows.Err(); err != nil {
		return HRLeaveBalanceOutput{}, err
	}
	return HRLeaveBalanceOutput{
		EntitlementDays: entitlementDays,
		TakenDays:       takenDays,
		RemainingDays:   entitlementDays - takenDays,
	}, nil
}

func hrLeaveCalendar(ctx context.Context, tx pgx.Tx, orgID string, input HRLeaveCalendarInput) (HRLeaveCalendarOutput, error) {
	year := int(input.Year)
	monthStart := time.Date(year, time.Month(input.Month), 1, 0, 0, 0, 0, time.UTC)
	monthEnd := time.Date(year, time.Month(input.Month+1), 1, 0, 0, 0, 0, time.UTC)
	rows, err := tx.Query(ctx, `
		SELECT e.name, lr.kind, lr.start_date, lr.end_date
		FROM leave_requests lr
		INNER JOIN employees e ON e.id = lr.employee_id
		WHERE lr.org_id = $1::uuid AND lr.status = 'approved'
			AND lr.end_date >= $2 AND lr.start_date <= $3
		ORDER BY lr.start_date, e.name`, orgID, monthStart, monthEnd)
	if err != nil {
		return HRLeaveCalendarOutput{}, err
	}
	defer rows.Close()
	calendar := HRLeaveCalendarOutput{Entries: make([]HRLeaveCalendarEntry, 0)}
	for rows.Next() {
		var entry HRLeaveCalendarEntry
		var startDate, endDate time.Time
		if err := rows.Scan(&entry.EmployeeName, &entry.Kind, &startDate, &endDate); err != nil {
			return HRLeaveCalendarOutput{}, err
		}
		entry.StartDate = hrISOString(startDate)
		entry.EndDate = hrISOString(endDate)
		entry.Days = hrCalendarDaysBetween(startDate, endDate)
		calendar.Entries = append(calendar.Entries, entry)
	}
	if err := rows.Err(); err != nil {
		return HRLeaveCalendarOutput{}, err
	}
	return calendar, nil
}

func parseHRLeaveTimeInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case hrRequestLeaveCapabilityID:
		return ParseHRRequestLeaveInput(raw)
	case hrCancelLeaveCapabilityID:
		return ParseHRCancelLeaveInput(raw)
	case hrDecideLeaveCapabilityID:
		return ParseHRDecideLeaveInput(raw)
	case hrLogTimeCapabilityID:
		return ParseHRLogTimeInput(raw)
	case hrDecideTimeEntryCapabilityID:
		return ParseHRDecideTimeEntryInput(raw)
	case hrClockInCapabilityID:
		return ParseHRClockInInput(raw)
	case hrClockOutCapabilityID:
		return ParseHRClockOutInput(raw)
	case hrLeaveBalanceCapabilityID:
		return ParseHRLeaveBalanceInput(raw)
	case hrLeaveCalendarCapabilityID:
		return ParseHRLeaveCalendarInput(raw)
	case hrTimeReportCapabilityID:
		return ParseHRTimeReportInput(raw)
	default:
		return nil, errors.New("unsupported HR leave and time capability")
	}
}
