package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoWave5TaxMastersGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupTaxMasterFixtures(t, fx)
	grantWavePermission(t, fx, "accounting.admin")

	profileInput := json.RawMessage(`{"jurisdictionCode":"UG-KLA","filingFrequency":"monthly"}`)
	profileClaims := waveModuleClaims(fx, createTaxProfileCapabilityID, "accounting.admin", profileInput, "human", "", "wave5-tax-profile")
	created, err := fx.executor.Execute(fx.ctx, profileClaims, createTaxProfileCapabilityID, profileInput)
	if err != nil || !created.OK {
		t.Fatalf("createTaxProfile result=%+v err=%v", created, err)
	}
	var profile CreateTaxProfileOutput
	if err := json.Unmarshal(created.Data, &profile); err != nil {
		t.Fatal(err)
	}
	if !isUUID(profile.ProfileID) {
		t.Fatalf("createTaxProfile output=%+v, want UUID profileId", profile)
	}
	replay, err := fx.executor.Execute(fx.ctx, profileClaims, createTaxProfileCapabilityID, profileInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createTaxProfile replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createTaxProfileCapabilityID, "crm.write", profileInput, "human", "", "wave5-tax-denied"), createTaxProfileCapabilityID, profileInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.admin") {
		t.Fatalf("createTaxProfile denied result=%+v err=%v, want permission failure", denied, err)
	}

	codeInput := json.RawMessage(`{"jurisdictionCode":"UG-KLA","code":"VAT18","name":"VAT 18","direction":"output","rateBasisPoints":1800}`)
	createdCode, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createTaxCodeCapabilityID, "accounting.admin", codeInput, "human", "", "wave5-tax-code"), createTaxCodeCapabilityID, codeInput)
	if err != nil || !createdCode.OK {
		t.Fatalf("createTaxCode result=%+v err=%v", createdCode, err)
	}
	var code CreateTaxCodeOutput
	if err := json.Unmarshal(createdCode.Data, &code); err != nil {
		t.Fatal(err)
	}

	fx.addAgentSession()
	fx.addPolicy(archiveTaxCodeCapabilityID, "read", nil)
	archiveInput := json.RawMessage(`{"taxCodeId":"` + code.TaxCodeID + `"}`)
	approved := approveModuleWrite(t, fx, archiveTaxCodeCapabilityID, "accounting.admin", archiveInput)
	var archived ArchiveTaxCodeOutput
	if err := json.Unmarshal(approved.Data, &archived); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM tax_codes WHERE org_id=$1::uuid AND id=$2::uuid AND NOT active`, fx.orgID, code.TaxCodeID); got != 1 {
		t.Fatalf("archived tax codes=%d, want one", got)
	}
}

func TestGoWave5TaxReturnsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupTaxReturnFixtures(t, fx)
	grantWavePermission(t, fx, "accounting.write")
	grantWavePermission(t, fx, "accounting.post")
	seedTaxReturnProfile(t, fx, fx.orgID, "UG-KLA", "manual")
	seedTaxReturnTaxCode(t, fx, fx.orgID, "UG-KLA", "VAT18", "VAT on sales", "output", 1800, false)

	returnInput := json.RawMessage(`{"periodFrom":"2026-08-01","periodTo":"2026-08-31"}`)
	returnClaims := waveModuleClaims(fx, createTaxReturnCapabilityID, "accounting.write", returnInput, "human", "", "wave5-return-create")
	created, err := fx.executor.Execute(fx.ctx, returnClaims, createTaxReturnCapabilityID, returnInput)
	if err != nil || !created.OK {
		t.Fatalf("createTaxReturn result=%+v err=%v", created, err)
	}
	var createdReturn CreateTaxReturnOutput
	if err := json.Unmarshal(created.Data, &createdReturn); err != nil {
		t.Fatal(err)
	}
	if !isUUID(createdReturn.TaxReturnID) {
		t.Fatalf("createTaxReturn output=%+v, want UUID taxReturnId", createdReturn)
	}
	replay, err := fx.executor.Execute(fx.ctx, returnClaims, createTaxReturnCapabilityID, returnInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createTaxReturn replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createTaxReturnCapabilityID, "crm.write", returnInput, "human", "", "wave5-return-denied"), createTaxReturnCapabilityID, returnInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.write") {
		t.Fatalf("createTaxReturn denied result=%+v err=%v, want permission failure", denied, err)
	}

	fx.addAgentSession()
	fx.addPolicy(cancelTaxReturnDraftCapabilityID, "read", nil)
	cancelInput := json.RawMessage(`{"taxReturnId":"` + createdReturn.TaxReturnID + `"}`)
	approved := approveModuleWrite(t, fx, cancelTaxReturnDraftCapabilityID, "accounting.write", cancelInput)
	var cancelled TaxReturnIDOutput
	if err := json.Unmarshal(approved.Data, &cancelled); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM tax_returns WHERE org_id=$1::uuid AND id=$2::uuid AND status='cancelled'`, fx.orgID, createdReturn.TaxReturnID); got != 1 {
		t.Fatalf("cancelled returns=%d, want one", got)
	}
}

func TestGoWave5LeaveTimeGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "hr.write")
	grantWavePermission(t, fx, "hr.read")
	employeeID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Wave5 Employee", MonthlySalaryMinor: 4000000, TaxRateBps: 1000})

	leaveInput := json.RawMessage(`{"employeeId":"` + employeeID + `","kind":"annual","startDate":"2026-10-01","endDate":"2026-10-05"}`)
	leaveClaims := waveModuleClaims(fx, hrRequestLeaveCapabilityID, "hr.write", leaveInput, "human", "", "wave5-leave-request")
	requested, err := fx.executor.Execute(fx.ctx, leaveClaims, hrRequestLeaveCapabilityID, leaveInput)
	if err != nil || !requested.OK {
		t.Fatalf("requestLeave result=%+v err=%v", requested, err)
	}
	var request HRRequestLeaveOutput
	if err := json.Unmarshal(requested.Data, &request); err != nil {
		t.Fatal(err)
	}
	if !isUUID(request.RequestID) {
		t.Fatalf("requestLeave output=%+v, want UUID requestId", request)
	}
	replay, err := fx.executor.Execute(fx.ctx, leaveClaims, hrRequestLeaveCapabilityID, leaveInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("requestLeave replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrRequestLeaveCapabilityID, "crm.write", leaveInput, "human", "", "wave5-leave-denied"), hrRequestLeaveCapabilityID, leaveInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: hr.write") {
		t.Fatalf("requestLeave denied result=%+v err=%v, want permission failure", denied, err)
	}

	decideInput := json.RawMessage(`{"requestId":"` + request.RequestID + `","approve":true}`)
	decided, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrDecideLeaveCapabilityID, "hr.write", decideInput, "human", "", "wave5-leave-decide"), hrDecideLeaveCapabilityID, decideInput)
	if err != nil || !decided.OK {
		t.Fatalf("decideLeave result=%+v err=%v", decided, err)
	}
	if got := fx.count(`SELECT count(*) FROM leave_requests WHERE org_id=$1::uuid AND id=$2::uuid AND status='approved'`, fx.orgID, request.RequestID); got != 1 {
		t.Fatalf("approved leave requests=%d, want one", got)
	}

	clockInput := json.RawMessage(`{"employeeId":"` + employeeID + `"}`)
	clockIn, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrClockInCapabilityID, "hr.write", clockInput, "human", "", "wave5-clock-in"), hrClockInCapabilityID, clockInput)
	if err != nil || !clockIn.OK {
		t.Fatalf("clockIn result=%+v err=%v", clockIn, err)
	}
	clockOut, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrClockOutCapabilityID, "hr.write", clockInput, "human", "", "wave5-clock-out"), hrClockOutCapabilityID, clockInput)
	if err != nil || !clockOut.OK {
		t.Fatalf("clockOut result=%+v err=%v", clockOut, err)
	}
	if got := fx.count(`SELECT count(*) FROM time_entries WHERE org_id=$1::uuid AND employee_id=$2::uuid AND clocked_out_at IS NOT NULL`, fx.orgID, employeeID); got != 1 {
		t.Fatalf("closed time entries=%d, want one", got)
	}
}

func TestGoWave5PayrollApplicantsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupHRPayrollApplicantsFixture(t, fx)
	grantWavePermission(t, fx, "hr.write")
	grantWavePermission(t, fx, "hr.read")
	seedHRPayrollAccounts(t, fx)
	seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Wave5 Salaried", MonthlySalaryMinor: 2000000, TaxRateBps: 1000})

	runInput := json.RawMessage(`{"year":2026,"month":8}`)
	runClaims := waveModuleClaims(fx, hrCreatePayrollRunCapabilityID, "hr.write", runInput, "human", "", "wave5-payroll-create")
	created, err := fx.executor.Execute(fx.ctx, runClaims, hrCreatePayrollRunCapabilityID, runInput)
	if err != nil || !created.OK {
		t.Fatalf("createPayrollRun result=%+v err=%v", created, err)
	}
	var run HRCreatePayrollRunOutput
	if err := json.Unmarshal(created.Data, &run); err != nil {
		t.Fatal(err)
	}
	if !isUUID(run.RunID) {
		t.Fatalf("createPayrollRun output=%+v, want UUID runId", run)
	}
	replay, err := fx.executor.Execute(fx.ctx, runClaims, hrCreatePayrollRunCapabilityID, runInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createPayrollRun replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrCreatePayrollRunCapabilityID, "crm.write", runInput, "human", "", "wave5-payroll-denied"), hrCreatePayrollRunCapabilityID, runInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: hr.write") {
		t.Fatalf("createPayrollRun denied result=%+v err=%v, want permission failure", denied, err)
	}

	openingID := seedHRPayrollOpening(t, fx, fx.orgID, "Bookkeeper", "Finance", "open", time.Time{})
	applicantInput := json.RawMessage(`{"openingId":"` + openingID + `","name":"Wave5 Applicant","email":"applicant@fixture.test"}`)
	applicant, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrAddApplicantCapabilityID, "hr.write", applicantInput, "human", "", "wave5-applicant-add"), hrAddApplicantCapabilityID, applicantInput)
	if err != nil || !applicant.OK {
		t.Fatalf("addApplicant result=%+v err=%v", applicant, err)
	}
	reportInput := json.RawMessage(`{}`)
	report, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrReportCapabilityID, "hr.read", reportInput, "human", "", "wave5-hr-report"), hrReportCapabilityID, reportInput)
	if err != nil || !report.OK {
		t.Fatalf("report result=%+v err=%v", report, err)
	}
	var reportOut HRReportOutput
	if err := json.Unmarshal(report.Data, &reportOut); err != nil {
		t.Fatal(err)
	}
	if len(reportOut.Employees) != 1 || reportOut.Employees[0].Name != "Wave5 Salaried" || len(reportOut.Openings) != 1 ||
		len(reportOut.Applicants) != 1 || reportOut.Applicants[0].OpeningID != openingID {
		t.Fatalf("report output=%+v, want seeded employee, opening and applicant", reportOut)
	}
	var added HRAddApplicantOutput
	if err := json.Unmarshal(applicant.Data, &added); err != nil {
		t.Fatal(err)
	}
	hireInput := json.RawMessage(`{"applicantId":"` + added.ApplicantID + `","monthlySalaryMinor":3000000,"annualLeaveDays":21}`)
	hired, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrHireApplicantCapabilityID, "hr.write", hireInput, "human", "", "wave5-applicant-hire"), hrHireApplicantCapabilityID, hireInput)
	if err != nil || !hired.OK {
		t.Fatalf("hireApplicant result=%+v err=%v", hired, err)
	}
	var hiredOut HRHireApplicantOutput
	if err := json.Unmarshal(hired.Data, &hiredOut); err != nil {
		t.Fatal(err)
	}
	if !isUUID(hiredOut.EmployeeID) {
		t.Fatalf("hireApplicant output=%+v, want converted employee", hiredOut)
	}

	fx.addAgentSession()
	fx.addPolicy(hrExecutePayrollRunCapabilityID, "read", nil)
	recreated, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrCreatePayrollRunCapabilityID, "hr.write", json.RawMessage(`{"year":2026,"month":9}`), "human", "", "wave5-payroll-create-2"), hrCreatePayrollRunCapabilityID, json.RawMessage(`{"year":2026,"month":9}`))
	if err != nil || !recreated.OK {
		t.Fatalf("createPayrollRun September result=%+v err=%v", recreated, err)
	}
	var secondRun HRCreatePayrollRunOutput
	if err := json.Unmarshal(recreated.Data, &secondRun); err != nil {
		t.Fatal(err)
	}
	if secondRun.TotalNetMinor <= 0 {
		t.Fatalf("createPayrollRun output=%+v, want a positive net total to execute", secondRun)
	}
	approved := approveModuleWrite(t, fx, hrExecutePayrollRunCapabilityID, "hr.write", json.RawMessage(`{"runId":"`+secondRun.RunID+`","expectedTotalNetMinor":`+itoaHelper(secondRun.TotalNetMinor)+`}`))
	var executed HRExecutePayrollRunOutput
	if err := json.Unmarshal(approved.Data, &executed); err != nil {
		t.Fatal(err)
	}
	if !isUUID(executed.EntryID) {
		t.Fatalf("executePayrollRun output=%+v, want a posted journal entry", executed)
	}
	if got := fx.count(`SELECT count(*) FROM payroll_runs WHERE org_id=$1::uuid AND id=$2::uuid AND status='executed'`, fx.orgID, secondRun.RunID); got != 1 {
		t.Fatalf("executed payroll runs=%d, want one", got)
	}
}

func itoaHelper(v int64) string {
	return json.Number(int64String(v)).String()
}

func int64String(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
