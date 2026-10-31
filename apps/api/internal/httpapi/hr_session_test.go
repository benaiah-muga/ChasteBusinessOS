package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

func TestHRSessionHandlerReturnsReportFromGovernedCapability(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["hr.read"] = true
	report := json.RawMessage(`{"employees":[],"leave":[],"runs":[],"openings":[],"applicants":[],"attendance":[]}`)
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: report}}
	response := httptest.NewRecorder()
	NewHRSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(
		response, timeSessionRequest(http.MethodGet, "/api/hr", ""),
	)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != string(report) || executor.calls != 1 || executor.capID != "hr.report" || string(executor.input) != `{}` {
		t.Fatalf("status=%d calls=%d capability=%q input=%s body=%s", response.Code, executor.calls, executor.capID, executor.input, response.Body.String())
	}
	if executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.CapabilityID != "hr.report" {
		t.Fatalf("claims were not derived from the resolved identity: %+v", executor.claims)
	}
}

func TestHRSessionHandlerDelegatesWritesToGovernedCapabilities(t *testing.T) {
	const (
		employeeID  = "22222222-2222-4222-8222-222222222222"
		requestID   = "44444444-4444-4444-8444-444444444444"
		runID       = "55555555-5555-4555-8555-555555555555"
		openingID   = "66666666-6666-4666-8666-666666666666"
		applicantID = "77777777-7777-4777-8777-777777777777"
	)
	tests := []struct {
		name       string
		body       string
		capability string
		output     string
	}{
		{"hire employee", `{"action":"hireEmployee","name":"Mira Patel","monthlySalaryMinor":100000,"intentId":"hire-1"}`, "hr.hireEmployee", `{"employeeId":"` + employeeID + `"}`},
		{"deactivate employee", `{"action":"deactivateEmployee","employeeId":"` + employeeID + `","intentId":"deactivate-1"}`, "hr.deactivateEmployee", `{"deactivated":true}`},
		{"update structure", `{"action":"updateStructure","employeeId":"` + employeeID + `","department":"Ops","intentId":"structure-1"}`, "hr.updateEmployeeStructure", `{"updated":true}`},
		{"request leave", `{"action":"requestLeave","employeeId":"` + employeeID + `","startDate":"2026-10-20","endDate":"2026-10-21","intentId":"leave-1"}`, "hr.requestLeave", `{"requestId":"` + requestID + `","calendarDays":2}`},
		{"decide leave", `{"action":"decideLeave","requestId":"` + requestID + `","approve":true,"intentId":"decide-1"}`, "hr.decideLeave", `{"status":"approved"}`},
		{"cancel leave", `{"action":"cancelLeave","requestId":"` + requestID + `","intentId":"cancel-1"}`, "hr.cancelLeave", `{"cancelled":true}`},
		{"create payroll", `{"action":"createPayrollRun","year":2026,"month":9,"intentId":"payroll-1"}`, "hr.createPayrollRun", `{"runId":"` + runID + `","headcount":1,"totalGrossMinor":100,"totalTaxMinor":10,"totalNetMinor":90}`},
		{"execute payroll", `{"action":"executePayrollRun","runId":"` + runID + `","expectedTotalNetMinor":90,"intentId":"payroll-execute-1"}`, "hr.executePayrollRun", `{"entryId":"` + requestID + `","totalGrossMinor":100,"totalNetMinor":90}`},
		{"void payroll", `{"action":"voidPayrollRun","runId":"` + runID + `","intentId":"payroll-void-1"}`, "hr.voidPayrollRun", `{"voided":true}`},
		{"reverse payroll", `{"action":"reversePayrollPosting","runId":"` + runID + `","reason":"Correct payroll posting","intentId":"payroll-reverse-1"}`, "hr.reversePayrollPosting", `{"reversalEntryId":"88888888-8888-4888-8888-888888888888","reversedNetMinor":90}`},
		{"clock in", `{"action":"clockIn","employeeId":"` + employeeID + `","intentId":"clock-in-1"}`, "hr.clockIn", `{"entryId":"` + requestID + `","late":false}`},
		{"clock out", `{"action":"clockOut","employeeId":"` + employeeID + `","intentId":"clock-out-1"}`, "hr.clockOut", `{"entryId":"` + requestID + `","minutes":30}`},
		{"create opening", `{"action":"createOpening","title":"Engineer","intentId":"opening-1"}`, "hr.createOpening", `{"openingId":"` + openingID + `"}`},
		{"close opening", `{"action":"closeOpening","openingId":"` + openingID + `","intentId":"opening-close-1"}`, "hr.closeOpening", `{"closed":true}`},
		{"add applicant", `{"action":"addApplicant","openingId":"` + openingID + `","name":"Mira Patel","intentId":"applicant-1"}`, "hr.addApplicant", `{"applicantId":"` + applicantID + `"}`},
		{"move applicant", `{"action":"moveApplicant","applicantId":"` + applicantID + `","stage":"interview","intentId":"applicant-move-1"}`, "hr.moveApplicant", `{"moved":true,"stage":"interview"}`},
		{"hire applicant", `{"action":"hireApplicant","applicantId":"` + applicantID + `","monthlySalaryMinor":100000,"intentId":"applicant-hire-1"}`, "hr.hireApplicant", `{"employeeId":"` + employeeID + `","applicantId":"` + applicantID + `"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			identity := directTestIdentity()
			identity.Permissions["hr.write"] = true
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(test.output)}}
			response := httptest.NewRecorder()
			NewHRSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(
				response, timeSessionRequest(http.MethodPost, "/api/hr", test.body),
			)
			if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != test.capability {
				t.Fatalf("status=%d calls=%d capability=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
			}
			if executor.claims.OrganizationID != *identity.OrgID || executor.claims.Subject != identity.UserID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.IntentID == "" {
				t.Fatalf("claims omitted resolved scope or intent: %+v", executor.claims)
			}
			if executor.claims.InputSHA256 == "" {
				t.Fatal("capability input hash is missing")
			}
		})
	}
}

func TestHRSessionHandlerRejectsUnauthenticatedCrossOriginAndInvalidBodies(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["hr.write"] = true
	newExecutor := func() *fakeDirectCapabilityExecutor {
		return &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"deactivated":true}`)}}
	}
	request := timeSessionRequest(http.MethodPost, "/api/hr", `{"action":"deactivateEmployee","employeeId":"22222222-2222-4222-8222-222222222222","intentId":"attempt-1"}`)
	request.Header.Set("Origin", "https://attacker.example")
	executor := newExecutor()
	response := httptest.NewRecorder()
	NewHRSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("cross-origin status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}

	for _, body := range []string{
		`{"action":"deactivateEmployee","employeeId":"22222222-2222-4222-8222-222222222222"}`,
		`{"action":"deactivateEmployee","employeeId":"not-a-uuid","intentId":"attempt-1"}`,
		`{"action":"deactivateEmployee","employeeId":"22222222-2222-4222-8222-222222222222","intentId":"attempt-1","unexpected":true}`,
		`{"action":"requestLeave","employeeId":"22222222-2222-4222-8222-222222222222","startDate":"2026-02-30","endDate":"2026-03-01","intentId":"leave-invalid-date"}`,
	} {
		executor = newExecutor()
		response = httptest.NewRecorder()
		NewHRSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodPost, "/api/hr", body))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("invalid body %s: status=%d calls=%d body=%s", body, response.Code, executor.calls, response.Body.String())
		}
	}
	request = timeSessionRequest(http.MethodPost, "/api/hr", `{"action":"deactivateEmployee","employeeId":"22222222-2222-4222-8222-222222222222","intentId":"attempt-1"}`)
	request.Header.Set("X-Organization-ID", "99999999-9999-4999-8999-999999999999")
	response = httptest.NewRecorder()
	executor = newExecutor()
	NewHRSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || executor.calls != 0 {
		t.Fatalf("organization mismatch status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
	response = httptest.NewRecorder()
	executor = newExecutor()
	NewHRSessionHandler(&fakeDirectSessionResolver{}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodGet, "/api/hr", ""))
	if response.Code != http.StatusUnauthorized || executor.calls != 0 {
		t.Fatalf("missing identity status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
}

func TestHRSessionHandlerRejectsInvalidReportOutput(t *testing.T) {
	for _, data := range []string{`null`, `{}`, `{"employees":[],"leave":[],"runs":[],"openings":[],"applicants":[]}`} {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(data)}}
		response := httptest.NewRecorder()
		identity := directTestIdentity()
		identity.Permissions["hr.read"] = true
		NewHRSessionHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil).ServeHTTP(response, timeSessionRequest(http.MethodGet, "/api/hr", ""))
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("accepted invalid report %s: status=%d body=%s", data, response.Code, response.Body.String())
		}
	}
}
