package capability

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestHRLeaveTimeParsersMatchTSContracts(t *testing.T) {
	full, err := ParseHRRequestLeaveInput(json.RawMessage(`{"employeeId":"worker-1","kind":"sick","startDate":"2026-09-01","endDate":"2026-09-03","unknown":true}`))
	if err != nil || full.EmployeeID != "worker-1" || full.Kind != "sick" || full.StartDate != "2026-09-01" || full.EndDate != "2026-09-03" {
		t.Fatalf("request leave input=%+v err=%v", full, err)
	}
	defaulted, err := ParseHRRequestLeaveInput(json.RawMessage(`{"employeeId":"worker-1","startDate":"2026-01-01","endDate":"2026-01-02"}`))
	if err != nil || defaulted.Kind != "annual" {
		t.Fatalf("request leave default kind input=%+v err=%v, want kind annual", defaulted, err)
	}
	encoded, err := marshalJS(defaulted)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"employeeId":"worker-1","kind":"annual","startDate":"2026-01-01","endDate":"2026-01-02"}` {
		t.Fatalf("request leave input JSON = %s", encoded)
	}
	for _, raw := range []string{
		`{}`,
		`[]`,
		`{"employeeId":null}`,
		`{"employeeId":123}`,
		`{"employeeId":"w"}`,
		`{"employeeId":"w","kind":"vacation"}`,
		`{"employeeId":"w","kind":null}`,
		`{"employeeId":"w","kind":1}`,
		`{"employeeId":"w","startDate":"2026-09-01"}`,
		`{"employeeId":"w","startDate":null,"endDate":"2026-09-01"}`,
		`{"employeeId":"w","startDate":"2026-09-01","endDate":null}`,
	} {
		if _, err := ParseHRRequestLeaveInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRRequestLeaveInput accepted %s", raw)
		}
	}

	if cancelled, err := ParseHRCancelLeaveInput(json.RawMessage(`{"requestId":"plain-any-string"}`)); err != nil || cancelled.RequestID != "plain-any-string" {
		t.Fatalf("cancel leave input=%+v err=%v, want unconstrained string requestId", cancelled, err)
	}
	for _, raw := range []string{`{}`, `{"requestId":null}`, `{"requestId":7}`, `[]`} {
		if _, err := ParseHRCancelLeaveInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRCancelLeaveInput accepted %s", raw)
		}
	}

	decide, err := ParseHRDecideLeaveInput(json.RawMessage(`{"requestId":"r-1","approve":true,"comment":"Looks fine"}`))
	if err != nil || decide.RequestID != "r-1" || !decide.Approve || *decide.Comment != "Looks fine" {
		t.Fatalf("decide leave input=%+v err=%v", decide, err)
	}
	if noComment, err := ParseHRDecideLeaveInput(json.RawMessage(`{"requestId":"r-1","approve":false}`)); err != nil || noComment.Approve || noComment.Comment != nil {
		t.Fatalf("decide leave without comment input=%+v err=%v", noComment, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"requestId":"r-1"}`,
		`{"requestId":"r-1","approve":null}`,
		`{"requestId":"r-1","approve":1}`,
		`{"requestId":"r-1","approve":"true"}`,
		`{"requestId":"r-1","approve":true,"comment":null}`,
		`{"requestId":"r-1","approve":true,"comment":"` + strings.Repeat("c", 501) + `"}`,
	} {
		if _, err := ParseHRDecideLeaveInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRDecideLeaveInput accepted %s", raw)
		}
	}

	if logged, err := ParseHRLogTimeInput(json.RawMessage(`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":480,"note":"Field work"}`)); err != nil ||
		logged.Minutes != 480 || logged.Note == nil || *logged.Note != "Field work" {
		t.Fatalf("log time input=%+v err=%v", logged, err)
	}
	if capped, err := ParseHRLogTimeInput(json.RawMessage(`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":1440}`)); err != nil || capped.Minutes != 1440 {
		t.Fatalf("log time cap input=%+v err=%v, want 1440 accepted", capped, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"employeeId":"not-a-uuid","workDate":"2026-09-01","minutes":60}`,
		`{"employeeId":null,"workDate":"2026-09-01","minutes":60}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":null,"minutes":60}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01"}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":0}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":-30}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":1.5}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":1441}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":60,"note":null}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","workDate":"2026-09-01","minutes":60,"note":"` + strings.Repeat("n", 301) + `"}`,
	} {
		if _, err := ParseHRLogTimeInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRLogTimeInput accepted %s", raw)
		}
	}

	if decided, err := ParseHRDecideTimeEntryInput(json.RawMessage(`{"entryId":"33333333-3333-4333-8333-333333333333","decision":"rejected"}`)); err != nil || decided.Decision != "rejected" {
		t.Fatalf("decide time entry input=%+v err=%v", decided, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"entryId":"not-a-uuid","decision":"approved"}`,
		`{"entryId":"33333333-3333-4333-8333-333333333333","decision":"pending"}`,
		`{"entryId":"33333333-3333-4333-8333-333333333333","decision":null}`,
		`{"entryId":"33333333-3333-4333-8333-333333333333"}`,
	} {
		if _, err := ParseHRDecideTimeEntryInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRDecideTimeEntryInput accepted %s", raw)
		}
	}

	report, err := ParseHRTimeReportInput(json.RawMessage(`{"from":"2026-09-01","to":"2026-09-30","employeeId":"33333333-3333-4333-8333-333333333333"}`))
	if err != nil || report.From != "2026-09-01" || report.To != "2026-09-30" || report.EmployeeID == nil {
		t.Fatalf("time report input=%+v err=%v", report, err)
	}
	if unscoped, err := ParseHRTimeReportInput(json.RawMessage(`{"from":"2026-09-01","to":"2026-09-30"}`)); err != nil || unscoped.EmployeeID != nil {
		t.Fatalf("time report without employee input=%+v err=%v", unscoped, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"from":"2026-09-01"}`,
		`{"from":null,"to":"2026-09-30"}`,
		`{"from":"2026-09-01","to":"2026-09-30","employeeId":"not-a-uuid"}`,
		`{"from":"2026-09-01","to":"2026-09-30","employeeId":null}`,
	} {
		if _, err := ParseHRTimeReportInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRTimeReportInput accepted %s", raw)
		}
	}

	if clocked, err := ParseHRClockInInput(json.RawMessage(`{"employeeId":"33333333-3333-4333-8333-333333333333"}`)); err != nil || clocked.EmployeeID == "" {
		t.Fatalf("clock in input=%+v err=%v", clocked, err)
	}
	for _, raw := range []string{`{}`, `{"employeeId":"not-a-uuid"}`, `{"employeeId":null}`} {
		if _, err := ParseHRClockInInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRClockInInput accepted %s", raw)
		}
		if _, err := ParseHRClockOutInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRClockOutInput accepted %s", raw)
		}
		if _, err := ParseHRLeaveBalanceInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRLeaveBalanceInput accepted %s", raw)
		}
	}

	if calendar, err := ParseHRLeaveCalendarInput(json.RawMessage(`{"year":2026,"month":2}`)); err != nil || calendar.Year != 2026 || calendar.Month != 2 {
		t.Fatalf("leave calendar input=%+v err=%v", calendar, err)
	}
	if negative, err := ParseHRLeaveCalendarInput(json.RawMessage(`{"year":-44,"month":3}`)); err != nil || negative.Year != -44 {
		t.Fatalf("leave calendar negative year input=%+v err=%v, want unbounded zod int accepted", negative, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"month":1}`,
		`{"year":2026}`,
		`{"year":2026,"month":0}`,
		`{"year":2026,"month":13}`,
		`{"year":2026.5,"month":1}`,
		`{"year":2026,"month":1.5}`,
		`{"year":2026,"month":null}`,
	} {
		if _, err := ParseHRLeaveCalendarInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRLeaveCalendarInput accepted %s", raw)
		}
	}
}

func TestHRLeaveTimeOutputsMarshalExactJSON(t *testing.T) {
	requestJSON, err := marshalJS(HRRequestLeaveOutput{RequestID: "r-1", CalendarDays: 3})
	if err != nil || string(requestJSON) != `{"requestId":"r-1","calendarDays":3}` {
		t.Fatalf("request leave output JSON = %s, %v", requestJSON, err)
	}
	cancelJSON, err := marshalJS(HRCancelLeaveOutput{Cancelled: true})
	if err != nil || string(cancelJSON) != `{"cancelled":true}` {
		t.Fatalf("cancel leave output JSON = %s, %v", cancelJSON, err)
	}
	decideJSON, err := marshalJS(HRDecideLeaveOutput{Status: "approved"})
	if err != nil || string(decideJSON) != `{"status":"approved"}` {
		t.Fatalf("decide leave output JSON = %s, %v", decideJSON, err)
	}
	logJSON, err := marshalJS(HRLogTimeOutput{EntryID: "e-1", Status: "submitted"})
	if err != nil || string(logJSON) != `{"entryId":"e-1","status":"submitted"}` {
		t.Fatalf("log time output JSON = %s, %v", logJSON, err)
	}
	decideEntryJSON, err := marshalJS(HRDecideTimeEntryOutput{EntryID: "e-1", Status: "rejected"})
	if err != nil || string(decideEntryJSON) != `{"entryId":"e-1","status":"rejected"}` {
		t.Fatalf("decide time entry output JSON = %s, %v", decideEntryJSON, err)
	}
	emptyReportJSON, err := marshalJS(HRTimeReportOutput{Rows: []HRTimeReportRow{}})
	if err != nil || string(emptyReportJSON) != `{"rows":[]}` {
		t.Fatalf("empty time report output JSON = %s, %v", emptyReportJSON, err)
	}
	reportJSON, err := marshalJS(HRTimeReportOutput{Rows: []HRTimeReportRow{{EmployeeID: "w-1", ApprovedMinutes: 60, PendingMinutes: 30}}})
	if err != nil || string(reportJSON) != `{"rows":[{"employeeId":"w-1","approvedMinutes":60,"pendingMinutes":30}]}` {
		t.Fatalf("time report output JSON = %s, %v", reportJSON, err)
	}
	clockInJSON, err := marshalJS(HRClockInOutput{EntryID: "e-1", Late: true})
	if err != nil || string(clockInJSON) != `{"entryId":"e-1","late":true}` {
		t.Fatalf("clock in output JSON = %s, %v", clockInJSON, err)
	}
	clockOutJSON, err := marshalJS(HRClockOutOutput{EntryID: "e-1", Minutes: 492})
	if err != nil || string(clockOutJSON) != `{"entryId":"e-1","minutes":492}` {
		t.Fatalf("clock out output JSON = %s, %v", clockOutJSON, err)
	}
	balanceJSON, err := marshalJS(HRLeaveBalanceOutput{EntitlementDays: 21, TakenDays: 3, RemainingDays: 18})
	if err != nil || string(balanceJSON) != `{"entitlementDays":21,"takenDays":3,"remainingDays":18}` {
		t.Fatalf("leave balance output JSON = %s, %v", balanceJSON, err)
	}
	emptyCalendarJSON, err := marshalJS(HRLeaveCalendarOutput{Entries: []HRLeaveCalendarEntry{}})
	if err != nil || string(emptyCalendarJSON) != `{"entries":[]}` {
		t.Fatalf("empty leave calendar output JSON = %s, %v", emptyCalendarJSON, err)
	}
	calendarJSON, err := marshalJS(HRLeaveCalendarOutput{Entries: []HRLeaveCalendarEntry{{
		EmployeeName: "Case Worker", Kind: "annual", StartDate: "2026-01-10T00:00:00.000Z", EndDate: "2026-01-12T00:00:00.000Z", Days: 3,
	}}})
	want := `{"entries":[{"employeeName":"Case Worker","kind":"annual","startDate":"2026-01-10T00:00:00.000Z","endDate":"2026-01-12T00:00:00.000Z","days":3}]}`
	if err != nil || string(calendarJSON) != want {
		t.Fatalf("leave calendar output JSON = %s, want %s", calendarJSON, want)
	}
}

func TestHRLeaveTimeDomainMathPure(t *testing.T) {
	jan1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	jan3 := time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC)
	if got := hrCalendarDaysBetween(jan1, jan1); got != 1 {
		t.Fatalf("same-day span = %d, want 1", got)
	}
	if got := hrCalendarDaysBetween(jan1, jan3); got != 3 {
		t.Fatalf("three-day span = %d, want 3", got)
	}
	if got := hrCalendarDaysBetween(jan3, jan1); got != -1 {
		t.Fatalf("reversed span = %d, want -1 like Math.floor semantics", got)
	}
	halfReverse := hrCalendarDaysBetween(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC), jan1)
	if halfReverse != 0 {
		t.Fatalf("half-day reversed span = %d, want 0", halfReverse)
	}

	noonUTC := time.Date(2026, 9, 1, 12, 30, 0, 0, time.UTC)
	if got := hrMinutesOfDay(noonUTC); got != 750 {
		t.Fatalf("minutes of day = %d, want 750", got)
	}
	if got := hrMinutesOfDay(time.Date(2026, 9, 1, 12, 30, 0, 0, time.FixedZone("EAT", 3*60*60))); got != 570 {
		t.Fatalf("offset minutes of day = %d, want UTC 09:30 = 570", got)
	}

	for _, check := range []struct {
		value float64
		want  int64
	}{{0.4, 0}, {0.5, 1}, {1.5, 2}, {2.5, 3}, {-0.5, 0}, {-1.5, -1}, {492, 492}} {
		if got := hrJSMathRound(check.value); got != check.want {
			t.Fatalf("hrJSMathRound(%v) = %d, want %d (JS Math.round)", check.value, got, check.want)
		}
	}

	midnight, err := hrParseISODate("2026-09-01")
	if err != nil || !midnight.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("date-only parse = %s err=%v, want UTC midnight", midnight, err)
	}
	if stamped, err := hrParseISODate("2026-09-01T10:30:00Z"); err != nil || stamped.UTC().Hour() != 10 {
		t.Fatalf("datetime parse = %s err=%v, want 10:30 UTC", stamped, err)
	}
	if shifted, err := hrParseISODate("2026-09-01T10:30:00+03:00"); err != nil || shifted.UTC().Hour() != 7 {
		t.Fatalf("offset datetime parse = %s err=%v, want 07:30 UTC", shifted, err)
	}
	for _, value := range []string{"2026-9-1", "2026-02-30", "garbage", "2026-09-01 ", ""} {
		if _, err := hrParseISODate(value); err == nil {
			t.Errorf("hrParseISODate accepted %q", value)
		}
	}

	if got := hrISOString(time.Date(2026, 9, 1, 8, 0, 0, 123456789, time.UTC)); got != "2026-09-01T08:00:00.123Z" {
		t.Fatalf("ISO string = %s, want millisecond precision", got)
	}
	if got := hrISOString(time.Date(2026, 9, 1, 8, 0, 0, 0, time.FixedZone("EAT", 3*60*60))); got != "2026-09-01T05:00:00.000Z" {
		t.Fatalf("offset ISO string = %s, want UTC normalized", got)
	}
}

func hrLeaveTimeClaims(fx *executorFixture, actorType string) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{
		OrganizationID: fx.orgID,
		ActorType:      actorType,
		ActorID:        &actorID,
	}
}

// hrLeaveTimeCleanup drops time_entries before the fixture's organization
// cascade: time_entries holds an ON DELETE RESTRICT foreign key to employees,
// so it must go first (t.Cleanup runs LIFO).
func hrLeaveTimeCleanup(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := fx.owner.Exec(ctx, `DELETE FROM time_entries WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("cleanup time entries: %v", err)
		}
		if _, err := fx.owner.Exec(ctx, `DELETE FROM leave_requests WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			t.Errorf("cleanup leave requests: %v", err)
		}
	})
}

type seedHRLeaveRequestValues struct {
	EmployeeID   string
	Kind         string
	Status       string
	StartDate    time.Time
	EndDate      time.Time
	CalendarDays int64
}

func seedHRLeaveRequest(t *testing.T, fx *executorFixture, orgID string, values seedHRLeaveRequestValues) string {
	t.Helper()
	var requestID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO leave_requests (org_id, employee_id, kind, start_date, end_date, calendar_days, status, requested_by_actor_type)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'human')
		RETURNING id::text`, orgID, values.EmployeeID, values.Kind, values.StartDate, values.EndDate,
		values.CalendarDays, values.Status).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	return requestID
}

type seedHRTimeEntryValues struct {
	EmployeeID   string
	WorkDate     time.Time
	Minutes      int64
	Status       string
	ClockedInAt  *time.Time
	ClockedOutAt *time.Time
	Late         bool
}

func seedHRTimeEntry(t *testing.T, fx *executorFixture, orgID string, values seedHRTimeEntryValues) string {
	t.Helper()
	var entryID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO time_entries (org_id, employee_id, work_date, minutes, status, clocked_in_at, clocked_out_at, late)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
		RETURNING id::text`, orgID, values.EmployeeID, values.WorkDate, values.Minutes,
		values.Status, values.ClockedInAt, values.ClockedOutAt, values.Late).Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	return entryID
}

func TestHRLeaveTimeRequestLeavePersistsAndStateMachinesGuard(t *testing.T) {
	fx := newExecutorFixture(t)
	hrLeaveTimeCleanup(t, fx)
	employeeID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Case Worker", MonthlySalaryMinor: 400000})
	foreignID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Worker", MonthlySalaryMinor: 100000})
	claims := hrLeaveTimeClaims(fx, "human")

	requested, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRRequestLeaveOutput, error) {
		return hrRequestLeave(fx.ctx, tx, claims, HRRequestLeaveInput{EmployeeID: employeeID, Kind: "annual", StartDate: "2026-09-01", EndDate: "2026-09-03"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !isUUID(requested.RequestID) || requested.CalendarDays != 3 {
		t.Fatalf("request leave output=%+v, want UUID and 3 calendar days", requested)
	}
	var stored struct {
		OrgID       string
		EmployeeID  string
		Kind        string
		Status      string
		CalendarDay int64
		ActorType   string
		ActorID     *string
		DecidedBy   *string
		DecidedAt   *time.Time
		Start       time.Time
		End         time.Time
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, employee_id::text, kind, status, calendar_days,
			requested_by_actor_type, requested_by_actor_id::text, decided_by_user_id::text, decided_at, start_date, end_date
		FROM leave_requests WHERE id = $1::uuid`, requested.RequestID).
		Scan(&stored.OrgID, &stored.EmployeeID, &stored.Kind, &stored.Status, &stored.CalendarDay,
			&stored.ActorType, &stored.ActorID, &stored.DecidedBy, &stored.DecidedAt, &stored.Start, &stored.End); err != nil {
		t.Fatal(err)
	}
	wantStart := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	if stored.OrgID != fx.orgID || stored.EmployeeID != employeeID || stored.Kind != "annual" || stored.Status != "pending" ||
		stored.CalendarDay != 3 || stored.ActorType != "human" || stored.ActorID == nil || *stored.ActorID != fx.userID ||
		stored.DecidedBy != nil || stored.DecidedAt != nil || !stored.Start.Equal(wantStart) || !stored.End.Equal(wantEnd) {
		t.Fatalf("stored leave request=%+v, want exact TS insert mapping", stored)
	}

	now := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	approved, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideLeaveOutput, error) {
		return hrDecideLeave(fx.ctx, tx, claims, HRDecideLeaveInput{RequestID: requested.RequestID, Approve: true, Comment: crmStringPointer("Enjoy")}, now)
	})
	if err != nil || approved.Status != "approved" {
		t.Fatalf("decide leave output=%+v err=%v", approved, err)
	}
	var decidedBy *string
	var decidedAt time.Time
	var status string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, decided_by_user_id::text, decided_at FROM leave_requests WHERE id = $1::uuid`, requested.RequestID).
		Scan(&status, &decidedBy, &decidedAt); err != nil {
		t.Fatal(err)
	}
	if status != "approved" || decidedBy == nil || *decidedBy != fx.userID || !decidedAt.Equal(now) {
		t.Fatalf("decided leave row status=%s decidedBy=%v decidedAt=%s, want human actor and exact now", status, decidedBy, decidedAt)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRCancelLeaveOutput, error) {
		return hrCancelLeave(fx.ctx, tx, fx.orgID, HRCancelLeaveInput{RequestID: requested.RequestID})
	}); err == nil || err.Error() != "no pending leave request with that id" {
		t.Fatalf("cancel approved leave err=%v, want pending-only guard", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideLeaveOutput, error) {
		return hrDecideLeave(fx.ctx, tx, claims, HRDecideLeaveInput{RequestID: requested.RequestID, Approve: false}, now)
	}); err == nil || err.Error() != "no pending leave request with that id" {
		t.Fatalf("re-decide leave err=%v, want single-decision guard", err)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRRequestLeaveOutput, error) {
		return hrRequestLeave(fx.ctx, tx, claims, HRRequestLeaveInput{EmployeeID: employeeID, StartDate: "2026-10-05", EndDate: "2026-10-06"})
	})
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRCancelLeaveOutput, error) {
		return hrCancelLeave(fx.ctx, tx, fx.orgID, HRCancelLeaveInput{RequestID: second.RequestID})
	})
	if err != nil || !cancelled.Cancelled {
		t.Fatalf("cancel leave output=%+v err=%v", cancelled, err)
	}
	if status := fx.count(`SELECT count(*) FROM leave_requests WHERE id = $1::uuid AND status = 'cancelled'`, second.RequestID); status != 1 {
		t.Fatalf("cancelled rows=%d, want status flipped to cancelled", status)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRCancelLeaveOutput, error) {
		return hrCancelLeave(fx.ctx, tx, fx.orgID, HRCancelLeaveInput{RequestID: second.RequestID})
	}); err == nil || err.Error() != "no pending leave request with that id" {
		t.Fatalf("second cancel err=%v, want single-cancel guard", err)
	}

	third, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRRequestLeaveOutput, error) {
		return hrRequestLeave(fx.ctx, tx, claims, HRRequestLeaveInput{EmployeeID: employeeID, Kind: "unpaid", StartDate: "2026-11-02", EndDate: "2026-11-02"})
	})
	if err != nil || third.CalendarDays != 1 {
		t.Fatalf("single-day request output=%+v err=%v, want 1 calendar day", third, err)
	}
	agentClaims := hrLeaveTimeClaims(fx, "agent")
	rejected, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideLeaveOutput, error) {
		return hrDecideLeave(fx.ctx, tx, agentClaims, HRDecideLeaveInput{RequestID: third.RequestID, Approve: false}, now)
	})
	if err != nil || rejected.Status != "rejected" {
		t.Fatalf("agent decide output=%+v err=%v", rejected, err)
	}
	var agentDecidedBy *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT decided_by_user_id::text FROM leave_requests WHERE id = $1::uuid`, third.RequestID).Scan(&agentDecidedBy); err != nil {
		t.Fatal(err)
	}
	if agentDecidedBy != nil {
		t.Fatalf("agent decision decided_by_user_id=%v, want NULL like the TS human-only mapping", agentDecidedBy)
	}

	foreignRequestID := seedHRLeaveRequest(t, fx, fx.otherOrgID, seedHRLeaveRequestValues{
		EmployeeID: foreignID, Kind: "annual", Status: "pending",
		StartDate: time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), EndDate: time.Date(2026, 12, 2, 0, 0, 0, 0, time.UTC), CalendarDays: 2,
	})
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRCancelLeaveOutput, error) {
		return hrCancelLeave(fx.ctx, tx, fx.orgID, HRCancelLeaveInput{RequestID: foreignRequestID})
	}); err == nil || err.Error() != "no pending leave request with that id" {
		t.Fatalf("foreign cancel err=%v, want org-scoped refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideLeaveOutput, error) {
		return hrDecideLeave(fx.ctx, tx, claims, HRDecideLeaveInput{RequestID: foreignRequestID, Approve: true}, now)
	}); err == nil || err.Error() != "no pending leave request with that id" {
		t.Fatalf("foreign decide err=%v, want org-scoped refusal", err)
	}
	if got := fx.count(`SELECT count(*) FROM leave_requests WHERE id = $1::uuid AND status = 'pending'`, foreignRequestID); got != 1 {
		t.Fatalf("foreign request rows=%d, want untouched", got)
	}

	for _, failure := range []struct {
		input HRRequestLeaveInput
		want  string
	}{
		{HRRequestLeaveInput{EmployeeID: foreignID, StartDate: "2026-09-01", EndDate: "2026-09-03"}, "employee not found"},
		{HRRequestLeaveInput{EmployeeID: executorUUID(t), StartDate: "2026-09-01", EndDate: "2026-09-03"}, "employee not found"},
		{HRRequestLeaveInput{EmployeeID: employeeID, StartDate: "2026-13-01", EndDate: "2026-09-05"}, "leave dates must be valid ISO dates (YYYY-MM-DD)"},
		{HRRequestLeaveInput{EmployeeID: employeeID, StartDate: "not-a-date", EndDate: "2026-09-05"}, "leave dates must be valid ISO dates (YYYY-MM-DD)"},
		{HRRequestLeaveInput{EmployeeID: employeeID, StartDate: "2026-09-05", EndDate: "2026-09-04"}, "leave cannot end before it starts"},
	} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRRequestLeaveOutput, error) {
			return hrRequestLeave(fx.ctx, tx, claims, failure.input)
		})
		if err == nil || err.Error() != failure.want {
			t.Fatalf("request leave input=%+v err=%v, want %q", failure.input, err, failure.want)
		}
	}
	if got := fx.count(`SELECT count(*) FROM leave_requests WHERE employee_id = $1::uuid AND start_date = '2026-09-05'`, employeeID); got != 0 {
		t.Fatalf("failed request rows=%d, want rolled back", got)
	}
	if got := fx.count(`SELECT count(*) FROM leave_requests WHERE org_id = $1::uuid AND employee_id = $2::uuid`, fx.orgID, foreignID); got != 0 {
		t.Fatalf("cross-org leave request rows=%d, want no insert", got)
	}
}

func TestHRLeaveTimeLeaveBalanceAndCalendarDerive(t *testing.T) {
	fx := newExecutorFixture(t)
	hrLeaveTimeCleanup(t, fx)
	employeeID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Case Worker", MonthlySalaryMinor: 400000})
	foreignID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Worker", MonthlySalaryMinor: 100000})

	jan10 := time.Date(2026, 1, 10, 0, 0, 0, 0, time.UTC)
	jan12 := time.Date(2026, 1, 12, 0, 0, 0, 0, time.UTC)
	feb1 := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	feb2 := time.Date(2026, 2, 2, 0, 0, 0, 0, time.UTC)
	jan20 := time.Date(2026, 1, 20, 0, 0, 0, 0, time.UTC)
	jan21 := time.Date(2026, 1, 21, 0, 0, 0, 0, time.UTC)
	jan30 := time.Date(2026, 1, 30, 0, 0, 0, 0, time.UTC)
	mar2 := time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)
	mar6 := time.Date(2026, 3, 6, 0, 0, 0, 0, time.UTC)
	dec20 := time.Date(2025, 12, 20, 0, 0, 0, 0, time.UTC)
	dec24 := time.Date(2025, 12, 24, 0, 0, 0, 0, time.UTC)
	seedHRLeaveRequest(t, fx, fx.orgID, seedHRLeaveRequestValues{EmployeeID: employeeID, Kind: "annual", Status: "approved", StartDate: jan10, EndDate: jan12, CalendarDays: 3})
	seedHRLeaveRequest(t, fx, fx.orgID, seedHRLeaveRequestValues{EmployeeID: employeeID, Kind: "annual", Status: "approved", StartDate: jan30, EndDate: feb2, CalendarDays: 4})
	seedHRLeaveRequest(t, fx, fx.orgID, seedHRLeaveRequestValues{EmployeeID: employeeID, Kind: "annual", Status: "approved", StartDate: feb1, EndDate: feb2, CalendarDays: 2})
	seedHRLeaveRequest(t, fx, fx.orgID, seedHRLeaveRequestValues{EmployeeID: employeeID, Kind: "annual", Status: "pending", StartDate: mar2, EndDate: mar6, CalendarDays: 5})
	seedHRLeaveRequest(t, fx, fx.orgID, seedHRLeaveRequestValues{EmployeeID: employeeID, Kind: "annual", Status: "rejected", StartDate: mar2, EndDate: mar6, CalendarDays: 5})
	seedHRLeaveRequest(t, fx, fx.orgID, seedHRLeaveRequestValues{EmployeeID: employeeID, Kind: "sick", Status: "approved", StartDate: jan20, EndDate: jan21, CalendarDays: 2})
	seedHRLeaveRequest(t, fx, fx.orgID, seedHRLeaveRequestValues{EmployeeID: employeeID, Kind: "annual", Status: "approved", StartDate: dec20, EndDate: dec24, CalendarDays: 5})
	seedHRLeaveRequest(t, fx, fx.otherOrgID, seedHRLeaveRequestValues{EmployeeID: foreignID, Kind: "annual", Status: "approved", StartDate: jan10, EndDate: jan12, CalendarDays: 3})

	now := time.Date(2026, 9, 15, 9, 0, 0, 0, time.UTC)
	balance, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLeaveBalanceOutput, error) {
		return hrLeaveBalance(fx.ctx, tx, fx.orgID, HRLeaveBalanceInput{EmployeeID: employeeID}, now)
	})
	if err != nil {
		t.Fatal(err)
	}
	wantBalance := HRLeaveBalanceOutput{EntitlementDays: 21, TakenDays: 9, RemainingDays: 12}
	if balance != wantBalance {
		t.Fatalf("leave balance=%+v, want %+v (prior year and non-annual rows excluded)", balance, wantBalance)
	}

	january, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLeaveCalendarOutput, error) {
		return hrLeaveCalendar(fx.ctx, tx, fx.orgID, HRLeaveCalendarInput{Year: 2026, Month: 1})
	})
	if err != nil {
		t.Fatal(err)
	}
	wantJanuary := []HRLeaveCalendarEntry{
		{EmployeeName: "Case Worker", Kind: "annual", StartDate: "2026-01-10T00:00:00.000Z", EndDate: "2026-01-12T00:00:00.000Z", Days: 3},
		{EmployeeName: "Case Worker", Kind: "sick", StartDate: "2026-01-20T00:00:00.000Z", EndDate: "2026-01-21T00:00:00.000Z", Days: 2},
		{EmployeeName: "Case Worker", Kind: "annual", StartDate: "2026-01-30T00:00:00.000Z", EndDate: "2026-02-02T00:00:00.000Z", Days: 4},
		{EmployeeName: "Case Worker", Kind: "annual", StartDate: "2026-02-01T00:00:00.000Z", EndDate: "2026-02-02T00:00:00.000Z", Days: 2},
	}
	if len(january.Entries) != len(wantJanuary) {
		t.Fatalf("january entries=%+v, want %d rows", january.Entries, len(wantJanuary))
	}
	for index, entry := range january.Entries {
		if entry != wantJanuary[index] {
			t.Fatalf("january entry %d=%+v, want %+v", index, entry, wantJanuary[index])
		}
	}
	february, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLeaveCalendarOutput, error) {
		return hrLeaveCalendar(fx.ctx, tx, fx.orgID, HRLeaveCalendarInput{Year: 2026, Month: 2})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(february.Entries) != 2 ||
		february.Entries[0].StartDate != "2026-01-30T00:00:00.000Z" ||
		february.Entries[1].StartDate != "2026-02-01T00:00:00.000Z" {
		t.Fatalf("february entries=%+v, want both overlapping approved requests", february.Entries)
	}
	empty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLeaveCalendarOutput, error) {
		return hrLeaveCalendar(fx.ctx, tx, fx.orgID, HRLeaveCalendarInput{Year: 2026, Month: 4})
	})
	if err != nil || len(empty.Entries) != 0 {
		t.Fatalf("april entries=%+v err=%v, want none", empty.Entries, err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLeaveBalanceOutput, error) {
		return hrLeaveBalance(fx.ctx, tx, fx.orgID, HRLeaveBalanceInput{EmployeeID: foreignID}, now)
	}); err == nil || err.Error() != "employee not found" {
		t.Fatalf("foreign balance err=%v, want org-scoped refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLeaveBalanceOutput, error) {
		return hrLeaveBalance(fx.ctx, tx, fx.orgID, HRLeaveBalanceInput{EmployeeID: executorUUID(t)}, now)
	}); err == nil || err.Error() != "employee not found" {
		t.Fatalf("unknown balance err=%v, want employee not found", err)
	}
}

func TestHRLeaveTimeTimeEntriesLogDecideAndReport(t *testing.T) {
	fx := newExecutorFixture(t)
	hrLeaveTimeCleanup(t, fx)
	employeeID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Case Worker", MonthlySalaryMinor: 400000})
	teammateID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Second Worker", MonthlySalaryMinor: 300000})
	foreignID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Worker", MonthlySalaryMinor: 100000})
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	claims := hrLeaveTimeClaims(fx, "human")

	logged, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLogTimeOutput, error) {
		return hrLogTime(fx.ctx, tx, fx.orgID, HRLogTimeInput{EmployeeID: employeeID, WorkDate: "2026-09-01", Minutes: 480, Note: crmStringPointer("Site visit")}, now)
	})
	if err != nil || !isUUID(logged.EntryID) || logged.Status != "submitted" {
		t.Fatalf("log time output=%+v err=%v", logged, err)
	}
	var stored struct {
		OrgID     string
		Employee  string
		WorkDate  time.Time
		Minutes   int64
		Note      *string
		Status    string
		ClockedIn *time.Time
		DecidedBy *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, employee_id::text, work_date, minutes, note, status, clocked_in_at, decided_by_actor_id::text
		FROM time_entries WHERE id = $1::uuid`, logged.EntryID).
		Scan(&stored.OrgID, &stored.Employee, &stored.WorkDate, &stored.Minutes, &stored.Note, &stored.Status, &stored.ClockedIn, &stored.DecidedBy); err != nil {
		t.Fatal(err)
	}
	if stored.OrgID != fx.orgID || stored.Employee != employeeID || !stored.WorkDate.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) ||
		stored.Minutes != 480 || stored.Note == nil || *stored.Note != "Site visit" || stored.Status != "submitted" || stored.ClockedIn != nil || stored.DecidedBy != nil {
		t.Fatalf("stored time entry=%+v, want exact TS insert mapping", stored)
	}

	nextDayBoundary := now.Add(24 * time.Hour)
	if !nextDayBoundary.Equal(time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("test setup: future boundary moved to %s", nextDayBoundary)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLogTimeOutput, error) {
		return hrLogTime(fx.ctx, tx, fx.orgID, HRLogTimeInput{EmployeeID: employeeID, WorkDate: "2026-09-16", Minutes: 60}, now)
	}); err != nil {
		t.Fatalf("exactly one day ahead workDate err=%v, want accepted like the TS strict comparison", err)
	}
	for _, failure := range []struct {
		input HRLogTimeInput
		want  string
	}{
		{HRLogTimeInput{EmployeeID: executorUUID(t), WorkDate: "2026-09-01", Minutes: 60}, "employee not found"},
		{HRLogTimeInput{EmployeeID: foreignID, WorkDate: "2026-09-01", Minutes: 60}, "employee not found"},
		{HRLogTimeInput{EmployeeID: employeeID, WorkDate: "2026-09-17", Minutes: 60}, "cannot log time more than a day in the future"},
		{HRLogTimeInput{EmployeeID: employeeID, WorkDate: "2026-09-32", Minutes: 60}, "workDate must be a valid ISO date (YYYY-MM-DD)"},
	} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLogTimeOutput, error) {
			return hrLogTime(fx.ctx, tx, fx.orgID, failure.input, now)
		})
		if err == nil || err.Error() != failure.want {
			t.Fatalf("log time input=%+v err=%v, want %q", failure.input, err, failure.want)
		}
	}

	decided, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideTimeEntryOutput, error) {
		return hrDecideTimeEntry(fx.ctx, tx, claims, HRDecideTimeEntryInput{EntryID: logged.EntryID, Decision: "approved"})
	})
	if err != nil || decided.EntryID != logged.EntryID || decided.Status != "approved" {
		t.Fatalf("decide time entry output=%+v err=%v", decided, err)
	}
	var decidedStatus string
	var decidedType string
	var decidedID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, decided_by_actor_type, decided_by_actor_id::text FROM time_entries WHERE id = $1::uuid`, logged.EntryID).
		Scan(&decidedStatus, &decidedType, &decidedID); err != nil {
		t.Fatal(err)
	}
	if decidedStatus != "approved" || decidedType != "human" || decidedID == nil || *decidedID != fx.userID {
		t.Fatalf("decided entry status=%s actor=(%s,%v), want decision recorded", decidedStatus, decidedType, decidedID)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideTimeEntryOutput, error) {
		return hrDecideTimeEntry(fx.ctx, tx, claims, HRDecideTimeEntryInput{EntryID: logged.EntryID, Decision: "rejected"})
	}); err == nil || err.Error() != "entry not found or already decided" {
		t.Fatalf("re-decide err=%v, want submitted-only guard", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideTimeEntryOutput, error) {
		return hrDecideTimeEntry(fx.ctx, tx, claims, HRDecideTimeEntryInput{EntryID: executorUUID(t), Decision: "approved"})
	}); err == nil || err.Error() != "entry not found or already decided" {
		t.Fatalf("unknown entry decide err=%v", err)
	}

	pending, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRLogTimeOutput, error) {
		return hrLogTime(fx.ctx, tx, fx.orgID, HRLogTimeInput{EmployeeID: employeeID, WorkDate: "2026-09-02", Minutes: 30}, now)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDecideTimeEntryOutput, error) {
		return hrDecideTimeEntry(fx.ctx, tx, claims, HRDecideTimeEntryInput{EntryID: pending.EntryID, Decision: "rejected"})
	}); err != nil {
		t.Fatal(err)
	}
	seedHRTimeEntry(t, fx, fx.orgID, seedHRTimeEntryValues{EmployeeID: teammateID, WorkDate: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), Minutes: 45, Status: "approved"})
	seedHRTimeEntry(t, fx, fx.orgID, seedHRTimeEntryValues{EmployeeID: teammateID, WorkDate: time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC), Minutes: 120, Status: "submitted"})
	seedHRTimeEntry(t, fx, fx.otherOrgID, seedHRTimeEntryValues{EmployeeID: foreignID, WorkDate: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), Minutes: 999, Status: "approved"})

	report, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRTimeReportOutput, error) {
		return hrTimeReport(fx.ctx, tx, fx.orgID, HRTimeReportInput{From: "2026-09-01", To: "2026-09-30"})
	})
	if err != nil {
		t.Fatal(err)
	}
	byEmployee := make(map[string]HRTimeReportRow)
	for _, row := range report.Rows {
		byEmployee[row.EmployeeID] = row
	}
	if len(report.Rows) != 2 {
		t.Fatalf("report rows=%+v, want two local employees", report.Rows)
	}
	if row := byEmployee[employeeID]; row.ApprovedMinutes != 480 || row.PendingMinutes != 60 {
		t.Fatalf("case worker row=%+v, want 480 approved plus the pending boundary entry, rejected and out-of-range minutes excluded", row)
	}
	if row := byEmployee[teammateID]; row.ApprovedMinutes != 45 || row.PendingMinutes != 0 {
		t.Fatalf("teammate row=%+v, want only in-range approved minutes", row)
	}

	scoped, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRTimeReportOutput, error) {
		return hrTimeReport(fx.ctx, tx, fx.orgID, HRTimeReportInput{From: "2026-08-31", To: "2026-09-30", EmployeeID: crmStringPointer(employeeID)})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(scoped.Rows) != 1 || scoped.Rows[0].EmployeeID != employeeID {
		t.Fatalf("scoped report rows=%+v, want only the case worker", scoped.Rows)
	}

	augustReport, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRTimeReportOutput, error) {
		return hrTimeReport(fx.ctx, tx, fx.orgID, HRTimeReportInput{From: "2026-08-01", To: "2026-08-31"})
	})
	if err != nil {
		t.Fatal(err)
	}
	augustByEmployee := make(map[string]HRTimeReportRow)
	for _, row := range augustReport.Rows {
		augustByEmployee[row.EmployeeID] = row
	}
	if row := augustByEmployee[teammateID]; row.ApprovedMinutes != 0 || row.PendingMinutes != 120 {
		t.Fatalf("august teammate row=%+v, want 120 pending with inclusive gte/lte bounds", row)
	}
	for _, failure := range []struct {
		input HRTimeReportInput
		want  string
	}{
		{HRTimeReportInput{From: "yesterday", To: "2026-09-30"}, "from must be a valid ISO date (YYYY-MM-DD)"},
		{HRTimeReportInput{From: "2026-09-01", To: "tomorrow"}, "to must be a valid ISO date (YYYY-MM-DD)"},
	} {
		if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRTimeReportOutput, error) {
			return hrTimeReport(fx.ctx, tx, fx.orgID, failure.input)
		}); err == nil || err.Error() != failure.want {
			t.Fatalf("time report input=%+v err=%v, want %q", failure.input, err, failure.want)
		}
	}
}

func TestHRLeaveTimeAttendanceClockPairingAndLateness(t *testing.T) {
	fx := newExecutorFixture(t)
	hrLeaveTimeCleanup(t, fx)
	employeeID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Case Worker", MonthlySalaryMinor: 400000})
	teammateID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Second Worker", MonthlySalaryMinor: 300000})
	foreignID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Worker", MonthlySalaryMinor: 100000})

	clockInAt := time.Date(2026, 9, 15, 7, 0, 0, 0, time.UTC)
	clockIn, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: employeeID}, clockInAt)
	})
	if err != nil || !isUUID(clockIn.EntryID) || clockIn.Late {
		t.Fatalf("clock in output=%+v err=%v, want on-time entry", clockIn, err)
	}
	var stored struct {
		OrgID      string
		Employee   string
		WorkDate   time.Time
		Minutes    int64
		ClockedIn  time.Time
		ClockedOut *time.Time
		Late       bool
		Note       *string
		Status     string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, employee_id::text, work_date, minutes, clocked_in_at, clocked_out_at, late, note, status
		FROM time_entries WHERE id = $1::uuid`, clockIn.EntryID).
		Scan(&stored.OrgID, &stored.Employee, &stored.WorkDate, &stored.Minutes, &stored.ClockedIn, &stored.ClockedOut, &stored.Late, &stored.Note, &stored.Status); err != nil {
		t.Fatal(err)
	}
	if stored.OrgID != fx.orgID || stored.Employee != employeeID || !stored.WorkDate.Equal(clockInAt) ||
		stored.Minutes != 0 || !stored.ClockedIn.Equal(clockInAt) || stored.ClockedOut != nil || stored.Late ||
		stored.Note != nil || stored.Status != "submitted" {
		t.Fatalf("stored clock-in entry=%+v, want exact TS insert mapping", stored)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: employeeID}, clockInAt.Add(time.Hour))
	}); err == nil || err.Error() != "already clocked in; clock out first" {
		t.Fatalf("double clock in err=%v, want open-entry guard", err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: teammateID}, clockInAt.Add(30*time.Minute))
	}); err != nil {
		t.Fatalf("second employee clock in err=%v, want independent pairing", err)
	}
	clockOutAt := time.Date(2026, 9, 15, 15, 12, 0, 0, time.UTC)
	clockOut, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockOutOutput, error) {
		return hrClockOut(fx.ctx, tx, fx.orgID, HRClockOutInput{EmployeeID: employeeID}, clockOutAt)
	})
	if err != nil || clockOut.EntryID != clockIn.EntryID || clockOut.Minutes != 492 {
		t.Fatalf("clock out output=%+v err=%v, want 492 minutes from 07:00 to 15:12", clockOut, err)
	}
	var closed struct {
		ClockedOut time.Time
		Minutes    int64
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT clocked_out_at, minutes FROM time_entries WHERE id = $1::uuid`, clockIn.EntryID).
		Scan(&closed.ClockedOut, &closed.Minutes); err != nil {
		t.Fatal(err)
	}
	if !closed.ClockedOut.Equal(clockOutAt) || closed.Minutes != 492 {
		t.Fatalf("closed entry=%+v, want settled clock-out and minutes", closed)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockOutOutput, error) {
		return hrClockOut(fx.ctx, tx, fx.orgID, HRClockOutInput{EmployeeID: employeeID}, clockOutAt.Add(time.Minute))
	}); err == nil || err.Error() != "no open clock-in entry" {
		t.Fatalf("second clock out err=%v, want no-open-entry guard", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockOutOutput, error) {
		return hrClockOut(fx.ctx, tx, fx.orgID, HRClockOutInput{EmployeeID: teammateID}, clockOutAt)
	}); err != nil {
		t.Fatalf("teammate still open after other clock-out err=%v, want pairing isolated per employee", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: foreignID}, clockInAt)
	}); err == nil || err.Error() != "employee not found" {
		t.Fatalf("foreign clock in err=%v, want org-scoped refusal", err)
	}

	lateIn := time.Date(2026, 9, 16, 9, 1, 0, 0, time.UTC)
	late, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: employeeID}, lateIn)
	})
	if err != nil || !late.Late {
		t.Fatalf("late clock in output=%+v err=%v, want late flag", late, err)
	}
	var lateNote *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT note FROM time_entries WHERE id = $1::uuid`, late.EntryID).Scan(&lateNote); err != nil {
		t.Fatal(err)
	}
	if lateNote == nil || *lateNote != "clocked in late" {
		t.Fatalf("late note=%v, want %q", lateNote, "clocked in late")
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockOutOutput, error) {
		return hrClockOut(fx.ctx, tx, fx.orgID, HRClockOutInput{EmployeeID: employeeID}, lateIn.Add(time.Minute))
	}); err != nil {
		t.Fatal(err)
	}
	exactThreshold := time.Date(2026, 9, 16, 9, 0, 0, 0, time.UTC)
	onThreshold, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: teammateID}, exactThreshold)
	})
	if err != nil || onThreshold.Late {
		t.Fatalf("09:00 exact clock in output=%+v err=%v, want not late (strict >)", onThreshold, err)
	}

	subMinuteIn := time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC)
	subMinute, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: employeeID}, subMinuteIn)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockOutOutput, error) {
		return hrClockOut(fx.ctx, tx, fx.orgID, HRClockOutInput{EmployeeID: employeeID}, subMinuteIn.Add(400*time.Millisecond))
	}); err != nil {
		t.Fatalf("sub-minute clock out err=%v, want minimum one minute", err)
	}
	var minimumMinutes int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT minutes FROM time_entries WHERE id = $1::uuid`, subMinute.EntryID).Scan(&minimumMinutes); err != nil {
		t.Fatal(err)
	}
	if minimumMinutes != 1 {
		t.Fatalf("sub-minute entry minutes=%d, want clamped to 1", minimumMinutes)
	}

	halfMinuteIn := time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockInOutput, error) {
		return hrClockIn(fx.ctx, tx, fx.orgID, HRClockInInput{EmployeeID: employeeID}, halfMinuteIn)
	}); err != nil {
		t.Fatal(err)
	}
	halfOut, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRClockOutOutput, error) {
		return hrClockOut(fx.ctx, tx, fx.orgID, HRClockOutInput{EmployeeID: employeeID}, halfMinuteIn.Add(90*time.Second))
	})
	if err != nil || halfOut.Minutes != 2 {
		t.Fatalf("90-second clock out=%+v err=%v, want Math.round(1.5)=2", halfOut, err)
	}
}
