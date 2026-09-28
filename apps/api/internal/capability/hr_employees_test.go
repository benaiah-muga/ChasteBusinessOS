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

func TestGoHREmployeesParsersMatchHRContracts(t *testing.T) {
	hired, err := ParseHRHireEmployeeInput(json.RawMessage(`{"name":"Grace Njeri","email":"grace@example.com","title":"Senior Technician","monthlySalaryMinor":450000,"taxRateBps":1250,"annualLeaveDays":24,"unknown":true}`))
	if err != nil || hired.Name != "Grace Njeri" || *hired.Email != "grace@example.com" || *hired.Title != "Senior Technician" ||
		hired.MonthlySalaryMinor != 450000 || hired.TaxRateBps != 1250 || hired.AnnualLeaveDays != 24 {
		t.Fatalf("hire input=%+v err=%v", hired, err)
	}
	encoded, err := marshalJS(hired)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"name":"Grace Njeri","email":"grace@example.com","title":"Senior Technician","monthlySalaryMinor":450000,"taxRateBps":1250,"annualLeaveDays":24}`
	if string(encoded) != wantJSON {
		t.Fatalf("hire input JSON = %s, want %s", encoded, wantJSON)
	}

	minimal, err := ParseHRHireEmployeeInput(json.RawMessage(`{"name":"Min Hire","monthlySalaryMinor":0}`))
	if err != nil || minimal.Email != nil || minimal.Title != nil || minimal.TaxRateBps != 1000 || minimal.AnnualLeaveDays != 21 {
		t.Fatalf("minimal hire input=%+v err=%v, want defaulted tax rate and leave days", minimal, err)
	}
	minimalJSON, err := marshalJS(minimal)
	if err != nil {
		t.Fatal(err)
	}
	if string(minimalJSON) != `{"name":"Min Hire","monthlySalaryMinor":0,"taxRateBps":1000,"annualLeaveDays":21}` {
		t.Fatalf("minimal hire input JSON = %s", minimalJSON)
	}
	integral, err := ParseHRHireEmployeeInput(json.RawMessage(`{"name":"Exponent","monthlySalaryMinor":1e3,"taxRateBps":2e3,"annualLeaveDays":3.0}`))
	if err != nil || integral.MonthlySalaryMinor != 1000 || integral.TaxRateBps != 2000 || integral.AnnualLeaveDays != 3 {
		t.Fatalf("integral hire input=%+v err=%v, want JS number semantics", integral, err)
	}

	for _, raw := range []string{
		`{}`,
		`{"name":null}`,
		`{"name":""}`,
		`{"name":"` + strings.Repeat("n", 121) + `"}`,
		`{"name":"X"}`,
		`{"name":"X","monthlySalaryMinor":null}`,
		`{"name":"X","monthlySalaryMinor":-1}`,
		`{"name":"X","monthlySalaryMinor":1.5}`,
		`{"name":"X","monthlySalaryMinor":9007199254740992}`,
		`{"name":"X","monthlySalaryMinor":0,"email":null}`,
		`{"name":"X","monthlySalaryMinor":0,"email":"not-an-email"}`,
		`{"name":"X","monthlySalaryMinor":0,"email":"user@localhost"}`,
		`{"name":"X","monthlySalaryMinor":0,"email":"double..dot@example.com"}`,
		`{"name":"X","monthlySalaryMinor":0,"email":".leading@example.com"}`,
		`{"name":"X","monthlySalaryMinor":0,"email":"trailing.@example.com"}`,
		`{"name":"X","monthlySalaryMinor":0,"email":"user@exa_mple.com"}`,
		`{"name":"X","monthlySalaryMinor":0,"email":"user@example.c"}`,
		`{"name":"X","monthlySalaryMinor":0,"email":"user@example.com."}`,
		`{"name":"X","monthlySalaryMinor":0,"title":"` + strings.Repeat("t", 81) + `"}`,
		`{"name":"X","monthlySalaryMinor":0,"taxRateBps":-1}`,
		`{"name":"X","monthlySalaryMinor":0,"taxRateBps":5001}`,
		`{"name":"X","monthlySalaryMinor":0,"taxRateBps":1.5}`,
		`{"name":"X","monthlySalaryMinor":0,"taxRateBps":null}`,
		`{"name":"X","monthlySalaryMinor":0,"annualLeaveDays":-1}`,
		`{"name":"X","monthlySalaryMinor":0,"annualLeaveDays":366}`,
		`[]`,
	} {
		if _, err := ParseHRHireEmployeeInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRHireEmployeeInput accepted %s", raw)
		}
	}

	deactivated, err := ParseHRDeactivateEmployeeInput(json.RawMessage(`{"employeeId":"plain-any-string"}`))
	if err != nil || deactivated.EmployeeID != "plain-any-string" {
		t.Fatalf("deactivate input=%+v err=%v, want unconstrained string employeeId", deactivated, err)
	}
	for _, raw := range []string{`{}`, `{"employeeId":null}`, `{"employeeId":123}`} {
		if _, err := ParseHRDeactivateEmployeeInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRDeactivateEmployeeInput accepted %s", raw)
		}
	}

	if list, err := ParseHRListEmployeesInput(json.RawMessage(`{"ignored":"value"}`)); err != nil {
		t.Fatalf("list input err=%v", err)
	} else if encoded, err := marshalJS(list); err != nil || string(encoded) != `{}` {
		t.Fatalf("list input JSON = %s, %v", encoded, err)
	}
	for _, raw := range []string{`[]`, `null`, `"x"`, ``} {
		if _, err := ParseHRListEmployeesInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRListEmployeesInput accepted %s", raw)
		}
	}

	structure, err := ParseHRUpdateEmployeeStructureInput(json.RawMessage(`{"employeeId":"33333333-3333-4333-8333-333333333333","department":"Field Ops","position":"Senior Technician","managerEmployeeId":"44444444-4444-4444-8444-444444444444","emergencyContactName":"Sam Case","emergencyContactPhone":"+254700000001","unknown":true}`))
	if err != nil || *structure.Department != "Field Ops" || *structure.Position != "Senior Technician" ||
		*structure.ManagerEmployeeID != "44444444-4444-4444-8444-444444444444" || *structure.EmergencyContactName != "Sam Case" || *structure.EmergencyContactPhone != "+254700000001" {
		t.Fatalf("structure input=%+v err=%v", structure, err)
	}
	structureJSON, err := marshalJS(structure)
	if err != nil {
		t.Fatal(err)
	}
	wantStructureJSON := `{"employeeId":"33333333-3333-4333-8333-333333333333","department":"Field Ops","position":"Senior Technician","managerEmployeeId":"44444444-4444-4444-8444-444444444444","emergencyContactName":"Sam Case","emergencyContactPhone":"+254700000001"}`
	if string(structureJSON) != wantStructureJSON {
		t.Fatalf("structure input JSON = %s, want %s", structureJSON, wantStructureJSON)
	}
	if cleared, err := ParseHRUpdateEmployeeStructureInput(json.RawMessage(`{"employeeId":"33333333-3333-4333-8333-333333333333","department":""}`)); err != nil || cleared.Department == nil || *cleared.Department != "" {
		t.Fatalf("empty department input=%+v err=%v, want zero-length string accepted", cleared, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"employeeId":"not-a-uuid"}`,
		`{"employeeId":null}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","department":null}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","department":"` + strings.Repeat("d", 101) + `"}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","position":"` + strings.Repeat("p", 101) + `"}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","managerEmployeeId":"not-a-uuid"}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","managerEmployeeId":null}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","emergencyContactName":"` + strings.Repeat("c", 121) + `"}`,
		`{"employeeId":"33333333-3333-4333-8333-333333333333","emergencyContactPhone":"` + strings.Repeat("1", 41) + `"}`,
	} {
		if _, err := ParseHRUpdateEmployeeStructureInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseHRUpdateEmployeeStructureInput accepted %s", raw)
		}
	}
}

func TestGoHREmployeesOutputsMarshalExactJSON(t *testing.T) {
	hireJSON, err := marshalJS(HRHireEmployeeOutput{EmployeeID: "33333333-3333-4333-8333-333333333333"})
	if err != nil || string(hireJSON) != `{"employeeId":"33333333-3333-4333-8333-333333333333"}` {
		t.Fatalf("hire output JSON = %s, %v", hireJSON, err)
	}
	deactivatedJSON, err := marshalJS(HRDeactivateEmployeeOutput{Deactivated: true})
	if err != nil || string(deactivatedJSON) != `{"deactivated":true}` {
		t.Fatalf("deactivate output JSON = %s, %v", deactivatedJSON, err)
	}
	absentJSON, err := marshalJS(HRDeactivateEmployeeOutput{Deactivated: false})
	if err != nil || string(absentJSON) != `{"deactivated":false}` {
		t.Fatalf("absent deactivate output JSON = %s, %v", absentJSON, err)
	}
	structureJSON, err := marshalJS(HRUpdateEmployeeStructureOutput{Updated: true})
	if err != nil || string(structureJSON) != `{"updated":true}` {
		t.Fatalf("structure output JSON = %s, %v", structureJSON, err)
	}
	emptyJSON, err := marshalJS(HRListEmployeesOutput{Employees: []HREmployeeSummary{}})
	if err != nil || string(emptyJSON) != `{"employees":[]}` {
		t.Fatalf("empty list output JSON = %s, %v", emptyJSON, err)
	}
	title := "Senior Technician"
	listJSON, err := marshalJS(HRListEmployeesOutput{Employees: []HREmployeeSummary{
		{ID: "33333333-3333-4333-8333-333333333333", Name: "Grace Njeri", Title: &title, MonthlySalaryMinor: 450000, TaxRateBps: 1250, Active: true},
		{ID: "44444444-4444-4444-8444-444444444444", Name: "Former Staff", Title: nil, MonthlySalaryMinor: 100000, TaxRateBps: 1000, Active: false},
	}})
	want := `{"employees":[{"id":"33333333-3333-4333-8333-333333333333","name":"Grace Njeri","title":"Senior Technician","monthlySalaryMinor":450000,"taxRateBps":1250,"active":true},` +
		`{"id":"44444444-4444-4444-8444-444444444444","name":"Former Staff","title":null,"monthlySalaryMinor":100000,"taxRateBps":1000,"active":false}]}`
	if err != nil || string(listJSON) != want {
		t.Fatalf("list output JSON = %s, want %s", listJSON, want)
	}
}

func TestGoHREmployeesHirePersistsAllFieldsWithDefaults(t *testing.T) {
	fx := newExecutorFixture(t)
	input, err := ParseHRHireEmployeeInput(json.RawMessage(`{"name":"Grace Njeri","email":"grace@example.com","title":"Senior Technician","monthlySalaryMinor":450000,"taxRateBps":1250,"annualLeaveDays":24}`))
	if err != nil {
		t.Fatal(err)
	}
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRHireEmployeeOutput, error) {
		return hrHireEmployee(fx.ctx, tx, fx.orgID, input)
	})
	if err != nil {
		t.Fatal(err)
	}
	if !isUUID(output.EmployeeID) {
		t.Fatalf("hire output=%+v, want UUID employeeId", output)
	}
	var stored struct {
		OrgID              string
		Name               string
		Email              *string
		Title              *string
		MonthlySalaryMinor int64
		TaxRateBps         int64
		AnnualLeaveDays    int64
		Department         *string
		ManagerID          *string
		EmergencyName      *string
		EmergencyPhone     *string
		HiredAt            time.Time
		DeactivatedAt      *time.Time
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, name, email, title, monthly_salary_minor, tax_rate_bps, annual_leave_days,
			department, manager_employee_id::text, emergency_contact_name, emergency_contact_phone, hired_at, deactivated_at
		FROM employees WHERE id = $1::uuid`, output.EmployeeID).
		Scan(&stored.OrgID, &stored.Name, &stored.Email, &stored.Title, &stored.MonthlySalaryMinor, &stored.TaxRateBps, &stored.AnnualLeaveDays,
			&stored.Department, &stored.ManagerID, &stored.EmergencyName, &stored.EmergencyPhone, &stored.HiredAt, &stored.DeactivatedAt); err != nil {
		t.Fatal(err)
	}
	if stored.OrgID != fx.orgID || stored.Name != "Grace Njeri" || stored.Email == nil || *stored.Email != "grace@example.com" ||
		stored.Title == nil || *stored.Title != "Senior Technician" || stored.MonthlySalaryMinor != 450000 || stored.TaxRateBps != 1250 || stored.AnnualLeaveDays != 24 ||
		stored.Department != nil || stored.ManagerID != nil || stored.EmergencyName != nil || stored.EmergencyPhone != nil ||
		stored.HiredAt.IsZero() || stored.DeactivatedAt != nil {
		t.Fatalf("stored employee=%+v, want exact hire mapping and defaulted columns", stored)
	}

	minimal, err := ParseHRHireEmployeeInput(json.RawMessage(`{"name":"Min Hire","monthlySalaryMinor":0}`))
	if err != nil {
		t.Fatal(err)
	}
	minimalOutput, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRHireEmployeeOutput, error) {
		return hrHireEmployee(fx.ctx, tx, fx.orgID, minimal)
	})
	if err != nil {
		t.Fatal(err)
	}
	var minimalTaxRate int64
	var minimalLeaveDays int64
	var minimalEmail, minimalTitle *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT tax_rate_bps, annual_leave_days, email, title FROM employees WHERE id = $1::uuid`, minimalOutput.EmployeeID).
		Scan(&minimalTaxRate, &minimalLeaveDays, &minimalEmail, &minimalTitle); err != nil {
		t.Fatal(err)
	}
	if minimalTaxRate != 1000 || minimalLeaveDays != 21 || minimalEmail != nil || minimalTitle != nil {
		t.Fatalf("minimal hire row = %d/%d/%v/%v, want schema defaults 1000/21 and null email and title", minimalTaxRate, minimalLeaveDays, minimalEmail, minimalTitle)
	}
}

func TestGoHREmployeesDeactivateEffectsAndTenancy(t *testing.T) {
	fx := newExecutorFixture(t)
	employeeID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Case Worker", MonthlySalaryMinor: 400000})
	foreignID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Worker", MonthlySalaryMinor: 100000})
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	later := now.Add(2 * time.Hour)

	absent, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDeactivateEmployeeOutput, error) {
		return hrDeactivateEmployee(fx.ctx, tx, fx.orgID, HRDeactivateEmployeeInput{EmployeeID: executorUUID(t)}, now)
	})
	if err != nil || absent.Deactivated {
		t.Fatalf("unknown employee deactivate=%+v err=%v, want false", absent, err)
	}
	foreign, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDeactivateEmployeeOutput, error) {
		return hrDeactivateEmployee(fx.ctx, tx, fx.orgID, HRDeactivateEmployeeInput{EmployeeID: foreignID}, now)
	})
	if err != nil || foreign.Deactivated {
		t.Fatalf("foreign employee deactivate=%+v err=%v, want false", foreign, err)
	}
	if got := fx.count(`SELECT count(*) FROM employees WHERE id = $1::uuid AND deactivated_at IS NULL`, foreignID); got != 1 {
		t.Fatalf("foreign employee deactivated rows=%d, want untouched", got)
	}

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDeactivateEmployeeOutput, error) {
		return hrDeactivateEmployee(fx.ctx, tx, fx.orgID, HRDeactivateEmployeeInput{EmployeeID: employeeID}, now)
	})
	if err != nil || !first.Deactivated {
		t.Fatalf("first deactivate=%+v err=%v, want true", first, err)
	}
	var deactivatedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT deactivated_at FROM employees WHERE id = $1::uuid`, employeeID).Scan(&deactivatedAt); err != nil {
		t.Fatal(err)
	}
	if !deactivatedAt.Equal(now) {
		t.Fatalf("deactivated_at = %s, want %s", deactivatedAt, now)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRDeactivateEmployeeOutput, error) {
		return hrDeactivateEmployee(fx.ctx, tx, fx.orgID, HRDeactivateEmployeeInput{EmployeeID: employeeID}, later)
	})
	if err != nil || !second.Deactivated {
		t.Fatalf("second deactivate=%+v err=%v, want true like the TS update without a guard", second, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT deactivated_at FROM employees WHERE id = $1::uuid`, employeeID).Scan(&deactivatedAt); err != nil {
		t.Fatal(err)
	}
	if !deactivatedAt.Equal(later) {
		t.Fatalf("re-deactivated_at = %s, want %s", deactivatedAt, later)
	}
}

func TestGoHREmployeesListOrderShapeAndTenancy(t *testing.T) {
	fx := newExecutorFixture(t)
	older := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	mid := time.Date(2023, 6, 15, 0, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	deactivated := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	title := "Case Worker"
	newestID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Newest Hire", MonthlySalaryMinor: 300000, TaxRateBps: 1100, Title: &title, HiredAt: &newer})
	midID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Middle Hire", MonthlySalaryMinor: 200000, TaxRateBps: 1000, HiredAt: &mid})
	oldestID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Old Guard", MonthlySalaryMinor: 100000, TaxRateBps: 1000, HiredAt: &older, DeactivatedAt: &deactivated})
	seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Invisible Foreign", MonthlySalaryMinor: 999999, HiredAt: &newer})

	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRListEmployeesOutput, error) {
		return hrListEmployees(fx.ctx, tx, fx.orgID, HRListEmployeesInput{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(output.Employees) != 3 {
		t.Fatalf("employees=%d, want only the three local rows", len(output.Employees))
	}
	first, second, third := output.Employees[0], output.Employees[1], output.Employees[2]
	if first.ID != newestID || second.ID != midID || third.ID != oldestID {
		t.Fatalf("list order = %s,%s,%s, want hired_at descending", first.ID, second.ID, third.ID)
	}
	if first.Name != "Newest Hire" || first.Title == nil || *first.Title != "Case Worker" || first.MonthlySalaryMinor != 300000 || first.TaxRateBps != 1100 || !first.Active {
		t.Fatalf("newest row=%+v, want exact shape", first)
	}
	if second.Title != nil || !second.Active {
		t.Fatalf("middle row=%+v, want null title and active", second)
	}
	if third.Active {
		t.Fatalf("oldest row=%+v, want inactive", third)
	}
	encoded, err := marshalJS(output)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"employees":[{"id":%q,"name":"Newest Hire","title":"Case Worker","monthlySalaryMinor":300000,"taxRateBps":1100,"active":true},`+
		`{"id":%q,"name":"Middle Hire","title":null,"monthlySalaryMinor":200000,"taxRateBps":1000,"active":true},`+
		`{"id":%q,"name":"Old Guard","title":null,"monthlySalaryMinor":100000,"taxRateBps":1000,"active":false}]}`, newestID, midID, oldestID)
	if string(encoded) != want {
		t.Fatalf("list output JSON = %s, want %s", encoded, want)
	}
}

func TestGoHREmployeesListCapsAtTwoHundredRows(t *testing.T) {
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO employees (org_id, name, monthly_salary_minor, hired_at)
		SELECT $1::uuid, 'Bulk ' || g, 1000, now() - (g * interval '1 minute')
		FROM generate_series(1, 205) g`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRListEmployeesOutput, error) {
		return hrListEmployees(fx.ctx, tx, fx.orgID, HRListEmployeesInput{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(output.Employees) != 200 {
		t.Fatalf("employees=%d, want the 200-row cap", len(output.Employees))
	}
	if output.Employees[0].Name != "Bulk 1" || output.Employees[199].Name != "Bulk 200" {
		t.Fatalf("capped order = %s..%s, want newest first", output.Employees[0].Name, output.Employees[199].Name)
	}
}

func TestGoHREmployeesUpdateStructureWritesOnlyProvidedFields(t *testing.T) {
	fx := newExecutorFixture(t)
	employeeID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Case Worker", MonthlySalaryMinor: 400000})
	managerID := seedHREmployee(t, fx, fx.orgID, seedHREmployeeValues{Name: "Ops Manager", MonthlySalaryMinor: 600000})
	foreignManagerID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Manager", MonthlySalaryMinor: 500000})
	foreignEmployeeID := seedHREmployee(t, fx, fx.otherOrgID, seedHREmployeeValues{Name: "Foreign Employee", MonthlySalaryMinor: 100000})

	input, err := ParseHRUpdateEmployeeStructureInput(json.RawMessage(fmt.Sprintf(
		`{"employeeId":%q,"department":"Field Ops","position":"Senior Technician","managerEmployeeId":%q,"emergencyContactName":"Sam Case","emergencyContactPhone":"+254700000001"}`,
		employeeID, managerID)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRUpdateEmployeeStructureOutput, error) {
		return hrUpdateEmployeeStructure(fx.ctx, tx, fx.orgID, input)
	}); err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Department     *string
		Title          *string
		ManagerID      *string
		EmergencyName  *string
		EmergencyPhone *string
	}
	readStored := func() {
		t.Helper()
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT department, title, manager_employee_id::text, emergency_contact_name, emergency_contact_phone
			FROM employees WHERE id = $1::uuid`, employeeID).
			Scan(&stored.Department, &stored.Title, &stored.ManagerID, &stored.EmergencyName, &stored.EmergencyPhone); err != nil {
			t.Fatal(err)
		}
	}
	readStored()
	if stored.Department == nil || *stored.Department != "Field Ops" || stored.Title == nil || *stored.Title != "Senior Technician" ||
		stored.ManagerID == nil || *stored.ManagerID != managerID || stored.EmergencyName == nil || *stored.EmergencyName != "Sam Case" ||
		stored.EmergencyPhone == nil || *stored.EmergencyPhone != "+254700000001" {
		t.Fatalf("structure row=%+v, want every provided column written", stored)
	}

	partial := HRUpdateEmployeeStructureInput{EmployeeID: employeeID, Position: crmStringPointer("Lead Technician")}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRUpdateEmployeeStructureOutput, error) {
		return hrUpdateEmployeeStructure(fx.ctx, tx, fx.orgID, partial)
	}); err != nil {
		t.Fatal(err)
	}
	readStored()
	if stored.Title == nil || *stored.Title != "Lead Technician" || stored.Department == nil || *stored.Department != "Field Ops" ||
		stored.ManagerID == nil || *stored.ManagerID != managerID || stored.EmergencyName == nil || stored.EmergencyPhone == nil {
		t.Fatalf("partial row=%+v, want untouched columns preserved", stored)
	}

	clear := HRUpdateEmployeeStructureInput{EmployeeID: employeeID, Department: crmStringPointer("")}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRUpdateEmployeeStructureOutput, error) {
		return hrUpdateEmployeeStructure(fx.ctx, tx, fx.orgID, clear)
	}); err != nil {
		t.Fatal(err)
	}
	readStored()
	if stored.Department == nil || *stored.Department != "" {
		t.Fatalf("cleared department=%v, want empty string not null", stored.Department)
	}

	for _, failure := range []struct {
		input HRUpdateEmployeeStructureInput
		want  string
	}{
		{HRUpdateEmployeeStructureInput{EmployeeID: employeeID, ManagerEmployeeID: &foreignManagerID}, "manager employee not found in this organization"},
		{HRUpdateEmployeeStructureInput{EmployeeID: employeeID, ManagerEmployeeID: &employeeID}, "an employee does not report to themselves"},
		{HRUpdateEmployeeStructureInput{EmployeeID: employeeID, Position: crmStringPointer("Nope"), ManagerEmployeeID: &employeeID}, "an employee does not report to themselves"},
		{HRUpdateEmployeeStructureInput{EmployeeID: executorUUID(t), Position: crmStringPointer("Ghost"), ManagerEmployeeID: &managerID}, "employee not found"},
		{HRUpdateEmployeeStructureInput{EmployeeID: foreignEmployeeID, Position: crmStringPointer("Foreign")}, "employee not found"},
		{HRUpdateEmployeeStructureInput{EmployeeID: employeeID}, "No values to set"},
	} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (HRUpdateEmployeeStructureOutput, error) {
			return hrUpdateEmployeeStructure(fx.ctx, tx, fx.orgID, failure.input)
		})
		if err == nil || err.Error() != failure.want {
			t.Fatalf("structure update error=%v, want %q", err, failure.want)
		}
	}
	readStored()
	if stored.Title == nil || *stored.Title != "Lead Technician" || stored.Department == nil || *stored.Department != "" ||
		stored.ManagerID == nil || *stored.ManagerID != managerID {
		t.Fatalf("post-failure row=%+v, want failed updates rolled back", stored)
	}
}

type seedHREmployeeValues struct {
	Name               string
	MonthlySalaryMinor int64
	TaxRateBps         int64
	Title              *string
	HiredAt            *time.Time
	DeactivatedAt      *time.Time
}

func seedHREmployee(t *testing.T, fx *executorFixture, orgID string, values seedHREmployeeValues) string {
	t.Helper()
	var employeeID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO employees (org_id, name, monthly_salary_minor, tax_rate_bps, title, hired_at, deactivated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7)
		RETURNING id::text`, orgID, values.Name, values.MonthlySalaryMinor, values.TaxRateBps, values.Title, values.HiredAt, values.DeactivatedAt).
		Scan(&employeeID); err != nil {
		t.Fatal(err)
	}
	return employeeID
}
