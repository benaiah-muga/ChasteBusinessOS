package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const hrSessionBodyLimit = 64 << 10

type HRSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewHRSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &HRSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (handler *HRSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "HR service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, handler.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Method == http.MethodPost && strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "hr") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "People module is disabled"})
		return
	}
	if r.Method == http.MethodGet {
		handler.get(w, r, resolved)
		return
	}
	handler.post(w, r, resolved)
}

func (handler *HRSessionHandler) get(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	result, err := handler.execute(r.Context(), resolved, "hr.report", json.RawMessage(`{}`), "")
	if handler.writeExecutionError(w, result, err) {
		return
	}
	if err := validateHRReportOutput(result.Data); err != nil {
		handler.logInvalidOutput("hr.report")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, result.Data)
}

func (handler *HRSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, hrSessionBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	var fields map[string]json.RawMessage
	if decoder.Decode(&fields) != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var action, intentID string
	if json.Unmarshal(fields["action"], &action) != nil || action == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action required"})
		return
	}
	if raw, exists := fields["intentId"]; !exists || json.Unmarshal(raw, &intentID) != nil || strings.TrimSpace(intentID) == "" ||
		len(utf16.Encode([]rune(intentID))) > 160 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intentId is required"})
		return
	}
	capabilityID, input, err := hrActionCapabilityInput(action, fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := handler.execute(r.Context(), resolved, capabilityID, input, intentID)
	if handler.writeExecutionError(w, result, err) {
		return
	}
	if err := validateHRActionOutput(capabilityID, result.Data); err != nil {
		handler.logInvalidOutput(capabilityID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result.Data})
}

func hrActionCapabilityInput(action string, fields map[string]json.RawMessage) (string, json.RawMessage, error) {
	var capabilityID string
	var names []string
	switch action {
	case "hireEmployee":
		capabilityID, names = "hr.hireEmployee", []string{"name", "email", "title", "monthlySalaryMinor", "taxRateBps", "annualLeaveDays"}
	case "deactivateEmployee":
		capabilityID, names = "hr.deactivateEmployee", []string{"employeeId"}
	case "updateStructure":
		capabilityID, names = "hr.updateEmployeeStructure", []string{"employeeId", "department", "position", "managerEmployeeId", "emergencyContactName", "emergencyContactPhone"}
	case "requestLeave":
		capabilityID, names = "hr.requestLeave", []string{"employeeId", "kind", "startDate", "endDate"}
	case "decideLeave":
		capabilityID, names = "hr.decideLeave", []string{"requestId", "approve"}
	case "cancelLeave":
		capabilityID, names = "hr.cancelLeave", []string{"requestId"}
	case "createPayrollRun":
		capabilityID, names = "hr.createPayrollRun", []string{"year", "month"}
	case "executePayrollRun":
		capabilityID, names = "hr.executePayrollRun", []string{"runId", "expectedTotalNetMinor"}
	case "voidPayrollRun":
		capabilityID, names = "hr.voidPayrollRun", []string{"runId"}
	case "reversePayrollPosting":
		capabilityID, names = "hr.reversePayrollPosting", []string{"runId", "reason"}
	case "clockIn":
		capabilityID, names = "hr.clockIn", []string{"employeeId"}
	case "clockOut":
		capabilityID, names = "hr.clockOut", []string{"employeeId"}
	case "createOpening":
		capabilityID, names = "hr.createOpening", []string{"title", "department", "note"}
	case "closeOpening":
		capabilityID, names = "hr.closeOpening", []string{"openingId"}
	case "addApplicant":
		capabilityID, names = "hr.addApplicant", []string{"openingId", "name", "email", "note"}
	case "moveApplicant":
		capabilityID, names = "hr.moveApplicant", []string{"applicantId", "stage"}
	case "hireApplicant":
		capabilityID, names = "hr.hireApplicant", []string{"applicantId", "monthlySalaryMinor", "annualLeaveDays"}
	default:
		return "", nil, errors.New("invalid action")
	}
	allowed := make(map[string]struct{}, len(names)+2)
	allowed["action"], allowed["intentId"] = struct{}{}, struct{}{}
	for _, name := range names {
		allowed[name] = struct{}{}
	}
	for name := range fields {
		if _, ok := allowed[name]; !ok {
			return "", nil, errors.New("unexpected field")
		}
	}
	selected := make(map[string]json.RawMessage, len(names))
	for _, name := range names {
		if raw, exists := fields[name]; exists {
			selected[name] = raw
		}
	}
	for _, name := range hrLegacyOptionalStringFields(action) {
		if raw, exists := selected[name]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte(`""`)) {
			delete(selected, name)
		}
	}
	if action == "decideLeave" {
		if _, exists := selected["approve"]; !exists {
			selected["approve"] = json.RawMessage("false")
		}
	}
	if action == "hireEmployee" {
		if _, exists := selected["name"]; !exists {
			selected["name"] = json.RawMessage(`""`)
		}
		if _, exists := selected["monthlySalaryMinor"]; !exists {
			selected["monthlySalaryMinor"] = json.RawMessage("0")
		}
	}
	if action == "hireApplicant" {
		if raw, exists := selected["annualLeaveDays"]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("0")) {
			delete(selected, "annualLeaveDays")
		}
	}
	input, err := json.Marshal(selected)
	if err != nil {
		return "", nil, err
	}
	switch capabilityID {
	case "hr.hireEmployee":
		_, err = capability.ParseHRHireEmployeeInput(input)
	case "hr.deactivateEmployee":
		parsed, parseErr := capability.ParseHRDeactivateEmployeeInput(input)
		err = parseErr
		if err == nil && !isUUID(parsed.EmployeeID) {
			err = errors.New("employeeId must be a UUID")
		}
	case "hr.updateEmployeeStructure":
		parsed, parseErr := capability.ParseHRUpdateEmployeeStructureInput(input)
		err = parseErr
		if err == nil && parsed.Department == nil && parsed.Position == nil && parsed.ManagerEmployeeID == nil && parsed.EmergencyContactName == nil && parsed.EmergencyContactPhone == nil {
			err = errors.New("at least one employee field is required")
		}
	case "hr.requestLeave":
		parsed, parseErr := capability.ParseHRRequestLeaveInput(input)
		err = parseErr
		if err == nil {
			if !isUUID(parsed.EmployeeID) {
				err = errors.New("employeeId must be a UUID")
			}
			_, startErr := parseHRSessionISODate(parsed.StartDate)
			_, endErr := parseHRSessionISODate(parsed.EndDate)
			if err == nil && (startErr != nil || endErr != nil) {
				err = errors.New("leave dates must be ISO dates or RFC3339 timestamps")
			}
		}
	case "hr.decideLeave":
		parsed, parseErr := capability.ParseHRDecideLeaveInput(input)
		err = parseErr
		if err == nil && !isUUID(parsed.RequestID) {
			err = errors.New("requestId must be a UUID")
		}
	case "hr.cancelLeave":
		parsed, parseErr := capability.ParseHRCancelLeaveInput(input)
		err = parseErr
		if err == nil && !isUUID(parsed.RequestID) {
			err = errors.New("requestId must be a UUID")
		}
	case "hr.createPayrollRun":
		_, err = capability.ParseHRCreatePayrollRunInput(input)
	case "hr.executePayrollRun":
		parsed, parseErr := capability.ParseHRExecutePayrollRunInput(input)
		err = parseErr
		if err == nil && !isUUID(parsed.RunID) {
			err = errors.New("runId must be a UUID")
		}
	case "hr.voidPayrollRun":
		_, err = capability.ParseHRVoidPayrollRunInput(input)
	case "hr.clockIn":
		_, err = capability.ParseHRClockInInput(input)
	case "hr.clockOut":
		_, err = capability.ParseHRClockOutInput(input)
	case "hr.createOpening":
		_, err = capability.ParseHRCreateOpeningInput(input)
	case "hr.closeOpening":
		_, err = capability.ParseHRCloseOpeningInput(input)
	case "hr.addApplicant":
		_, err = capability.ParseHRAddApplicantInput(input)
	case "hr.moveApplicant":
		_, err = capability.ParseHRMoveApplicantInput(input)
	case "hr.hireApplicant":
		_, err = capability.ParseHRHireApplicantInput(input)
	}
	if err != nil {
		return "", nil, err
	}
	return capabilityID, input, nil
}

func hrLegacyOptionalStringFields(action string) []string {
	switch action {
	case "hireEmployee":
		return []string{"email", "title"}
	case "createOpening":
		return []string{"department", "note"}
	case "addApplicant":
		return []string{"email", "note"}
	default:
		return nil
	}
}

func parseHRSessionISODate(value string) (time.Time, error) {
	if parsed, err := time.Parse(time.DateOnly, value); err == nil && parsed.Format(time.DateOnly) == value {
		return parsed, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

func (handler *HRSessionHandler) execute(ctx context.Context, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
	inputHash, err := capability.InputHash(input)
	if err != nil {
		return capability.Result{}, err
	}
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := resolved.UserID
	now := time.Now().UTC()
	claims := authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID,
		ActorType: "human", Permissions: permissions, AuthSessionID: resolved.AuthSessionID,
		IntentID: intentID, IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	return handler.executor.Execute(ctx, claims, capabilityID, input)
}

func (handler *HRSessionHandler) writeExecutionError(w http.ResponseWriter, result capability.Result, err error) bool {
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			handler.logError("HR capability execution failed", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return true
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
		return true
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return true
	}
	if !json.Valid(result.Data) {
		handler.logInvalidOutput("unknown")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return true
	}
	return false
}

func validateHRReportOutput(data json.RawMessage) error {
	var output capability.HRReportOutput
	if !hrHasExactJSONKeys(data, "employees", "leave", "runs", "openings", "applicants", "attendance") ||
		json.Unmarshal(data, &output) != nil || output.Employees == nil || output.Leave == nil || output.Runs == nil || output.Openings == nil || output.Applicants == nil || output.Attendance == nil {
		return errors.New("invalid HR report")
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil {
		return errors.New("invalid HR report")
	}
	for _, spec := range []struct {
		key      string
		keys     []string
		nullable []string
	}{
		{"employees", []string{"id", "name", "email", "title", "department", "managerEmployeeId", "emergencyContactName", "emergencyContactPhone", "monthlySalaryMinor", "taxRateBps", "active"}, []string{"email", "title", "department", "managerEmployeeId", "emergencyContactName", "emergencyContactPhone"}},
		{"leave", []string{"id", "employeeName", "kind", "startDate", "endDate", "calendarDays", "status"}, nil},
		{"runs", []string{"id", "orgId", "year", "month", "status", "totalGrossMinor", "totalTaxMinor", "totalNetMinor", "headcount", "entryId", "executedByActorType", "executedByActorId", "executedAt", "voidedAt", "reversedAt", "createdAt"}, []string{"entryId", "executedByActorType", "executedByActorId", "executedAt", "voidedAt", "reversedAt"}},
		{"openings", []string{"id", "title", "department", "note", "status", "createdAt"}, []string{"department", "note"}},
		{"applicants", []string{"id", "openingId", "name", "stage", "note"}, []string{"note"}},
		{"attendance", []string{"employeeId", "clockedInAt", "late"}, nil},
	} {
		var items []json.RawMessage
		if json.Unmarshal(root[spec.key], &items) != nil {
			return errors.New("invalid HR report collection")
		}
		for _, item := range items {
			if !hrHasExactJSONKeys(item, spec.keys...) || !hrHasNonNullJSONFields(item, spec.nullable...) {
				return errors.New("invalid HR report row")
			}
		}
	}
	for _, employee := range output.Employees {
		if !isUUID(employee.ID) || employee.Name == "" || (employee.ManagerEmployeeID != nil && !isUUID(*employee.ManagerEmployeeID)) {
			return errors.New("invalid employee report row")
		}
	}
	for _, leave := range output.Leave {
		if !isUUID(leave.ID) || leave.EmployeeName == "" || leave.Kind == "" || leave.CalendarDays < 0 || leave.Status == "" || !hrValidTimestamp(leave.StartDate) || !hrValidTimestamp(leave.EndDate) {
			return errors.New("invalid leave report row")
		}
	}
	for _, run := range output.Runs {
		if !isUUID(run.ID) || !isUUID(run.OrgID) || run.Year < 2020 || run.Month < 1 || run.Month > 12 || run.Status == "" || run.Headcount < 0 || !hrValidTimestamp(run.CreatedAt.Format(time.RFC3339Nano)) {
			return errors.New("invalid payroll report row")
		}
	}
	for _, opening := range output.Openings {
		if !isUUID(opening.ID) || opening.Title == "" || opening.Status == "" || !hrValidTimestamp(opening.CreatedAt.Format(time.RFC3339Nano)) {
			return errors.New("invalid opening report row")
		}
	}
	for _, applicant := range output.Applicants {
		if !isUUID(applicant.ID) || !isUUID(applicant.OpeningID) || applicant.Name == "" || applicant.Stage == "" {
			return errors.New("invalid applicant report row")
		}
	}
	for _, attendance := range output.Attendance {
		if !isUUID(attendance.EmployeeID) || !hrValidTimestamp(attendance.ClockedInAt.Format(time.RFC3339Nano)) {
			return errors.New("invalid attendance report row")
		}
	}
	return nil
}

func validateHRActionOutput(capabilityID string, data json.RawMessage) error {
	if !hrHasNonNullJSONFields(data) {
		return errors.New("HR output contains null fields")
	}
	switch capabilityID {
	case "hr.hireEmployee":
		var value capability.HRHireEmployeeOutput
		if !hrHasExactJSONKeys(data, "employeeId") || json.Unmarshal(data, &value) != nil || !isUUID(value.EmployeeID) {
			return errors.New("invalid hire output")
		}
	case "hr.deactivateEmployee":
		var value capability.HRDeactivateEmployeeOutput
		if !hrHasExactJSONKeys(data, "deactivated") || json.Unmarshal(data, &value) != nil {
			return errors.New("invalid deactivate output")
		}
	case "hr.updateEmployeeStructure":
		var value capability.HRUpdateEmployeeStructureOutput
		if !hrHasExactJSONKeys(data, "updated") || json.Unmarshal(data, &value) != nil {
			return errors.New("invalid structure output")
		}
	case "hr.requestLeave":
		var value capability.HRRequestLeaveOutput
		if !hrHasExactJSONKeys(data, "requestId", "calendarDays") || json.Unmarshal(data, &value) != nil || !isUUID(value.RequestID) || value.CalendarDays < 1 {
			return errors.New("invalid leave request output")
		}
	case "hr.decideLeave":
		var value capability.HRDecideLeaveOutput
		if !hrHasExactJSONKeys(data, "status") || json.Unmarshal(data, &value) != nil || (value.Status != "approved" && value.Status != "rejected") {
			return errors.New("invalid leave decision output")
		}
	case "hr.cancelLeave":
		var value capability.HRCancelLeaveOutput
		if !hrHasExactJSONKeys(data, "cancelled") || json.Unmarshal(data, &value) != nil {
			return errors.New("invalid leave cancellation output")
		}
	case "hr.createPayrollRun":
		var value capability.HRCreatePayrollRunOutput
		if !hrHasExactJSONKeys(data, "runId", "headcount", "totalGrossMinor", "totalTaxMinor", "totalNetMinor") || json.Unmarshal(data, &value) != nil || !isUUID(value.RunID) || value.Headcount < 0 {
			return errors.New("invalid payroll creation output")
		}
	case "hr.executePayrollRun":
		var value capability.HRExecutePayrollRunOutput
		if !hrHasExactJSONKeys(data, "entryId", "totalGrossMinor", "totalNetMinor") || json.Unmarshal(data, &value) != nil || !isUUID(value.EntryID) {
			return errors.New("invalid payroll execution output")
		}
	case "hr.voidPayrollRun":
		var value capability.HRVoidPayrollRunOutput
		if !hrHasExactJSONKeys(data, "voided") || json.Unmarshal(data, &value) != nil {
			return errors.New("invalid payroll void output")
		}
	case "hr.reversePayrollPosting":
		var value capability.HRReversePayrollPostingOutput
		if !hrHasExactJSONKeys(data, "reversalEntryId", "reversedNetMinor") || json.Unmarshal(data, &value) != nil || !isUUID(value.ReversalEntryID) || value.ReversedNetMinor < 0 || value.ReversedNetMinor > 9007199254740991 {
			return errors.New("invalid payroll reversal output")
		}
	case "hr.clockIn":
		var value capability.HRClockInOutput
		if !hrHasExactJSONKeys(data, "entryId", "late") || json.Unmarshal(data, &value) != nil || !isUUID(value.EntryID) {
			return errors.New("invalid clock-in output")
		}
	case "hr.clockOut":
		var value capability.HRClockOutOutput
		if !hrHasExactJSONKeys(data, "entryId", "minutes") || json.Unmarshal(data, &value) != nil || !isUUID(value.EntryID) || value.Minutes < 0 {
			return errors.New("invalid clock-out output")
		}
	case "hr.createOpening":
		var value capability.HRCreateOpeningOutput
		if !hrHasExactJSONKeys(data, "openingId") || json.Unmarshal(data, &value) != nil || !isUUID(value.OpeningID) {
			return errors.New("invalid opening output")
		}
	case "hr.closeOpening":
		var value capability.HRCloseOpeningOutput
		if !hrHasExactJSONKeys(data, "closed") || json.Unmarshal(data, &value) != nil || !value.Closed {
			return errors.New("invalid close opening output")
		}
	case "hr.addApplicant":
		var value capability.HRAddApplicantOutput
		if !hrHasExactJSONKeys(data, "applicantId") || json.Unmarshal(data, &value) != nil || !isUUID(value.ApplicantID) {
			return errors.New("invalid applicant output")
		}
	case "hr.moveApplicant":
		var value capability.HRMoveApplicantOutput
		if !hrHasExactJSONKeys(data, "moved", "stage") || json.Unmarshal(data, &value) != nil || !value.Moved || !slices.Contains([]string{"applied", "screening", "interview", "offer", "rejected"}, value.Stage) {
			return errors.New("invalid applicant movement output")
		}
	case "hr.hireApplicant":
		var value capability.HRHireApplicantOutput
		if !hrHasExactJSONKeys(data, "employeeId", "applicantId") || json.Unmarshal(data, &value) != nil || !isUUID(value.EmployeeID) || !isUUID(value.ApplicantID) {
			return errors.New("invalid applicant hire output")
		}
	default:
		return errors.New("unsupported HR capability output")
	}
	return nil
}

func hrHasExactJSONKeys(raw json.RawMessage, required ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != len(required) {
		return false
	}
	for _, name := range required {
		if _, exists := fields[name]; !exists {
			return false
		}
	}
	return true
}

func hrHasNonNullJSONFields(raw json.RawMessage, nullable ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return false
	}
	nullableFields := make(map[string]struct{}, len(nullable))
	for _, name := range nullable {
		nullableFields[name] = struct{}{}
	}
	for name, value := range fields {
		if _, mayBeNull := nullableFields[name]; !mayBeNull && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}

func hrValidTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func (handler *HRSessionHandler) logError(message string, err error) {
	if handler.logger != nil {
		handler.logger.Error(message, "error", err)
	}
}

func (handler *HRSessionHandler) logInvalidOutput(capabilityID string) {
	if handler.logger != nil {
		handler.logger.Error("HR capability returned invalid output", "capabilityId", capabilityID)
	}
}

var _ http.Handler = (*HRSessionHandler)(nil)
