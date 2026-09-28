package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	hrHireEmployeeCapabilityID            = "hr.hireEmployee"
	hrDeactivateEmployeeCapabilityID      = "hr.deactivateEmployee"
	hrListEmployeesCapabilityID           = "hr.listEmployees"
	hrUpdateEmployeeStructureCapabilityID = "hr.updateEmployeeStructure"
)

// zod 4.4.3 validates emails with this "practical" pattern plus two negative
// lookaheads (no leading dot, no consecutive dots) that RE2 cannot express;
// validHREmployeeEmail applies them separately.
var hrEmployeeEmailPattern = regexp.MustCompile(`^([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

func validHREmployeeEmail(value string) bool {
	return !strings.HasPrefix(value, ".") && !strings.Contains(value, "..") && hrEmployeeEmailPattern.MatchString(value)
}

type HRHireEmployeeInput struct {
	Name               string  `json:"name"`
	Email              *string `json:"email,omitempty"`
	Title              *string `json:"title,omitempty"`
	MonthlySalaryMinor int64   `json:"monthlySalaryMinor"`
	TaxRateBps         int64   `json:"taxRateBps"`
	AnnualLeaveDays    int64   `json:"annualLeaveDays"`
}

type HRHireEmployeeOutput struct {
	EmployeeID string `json:"employeeId"`
}

type HRDeactivateEmployeeInput struct {
	EmployeeID string `json:"employeeId"`
}

type HRDeactivateEmployeeOutput struct {
	Deactivated bool `json:"deactivated"`
}

type HRListEmployeesInput struct{}

type HREmployeeSummary struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Title              *string `json:"title"`
	MonthlySalaryMinor int64   `json:"monthlySalaryMinor"`
	TaxRateBps         int64   `json:"taxRateBps"`
	Active             bool    `json:"active"`
}

type HRListEmployeesOutput struct {
	Employees []HREmployeeSummary `json:"employees"`
}

type HRUpdateEmployeeStructureInput struct {
	EmployeeID            string  `json:"employeeId"`
	Department            *string `json:"department,omitempty"`
	Position              *string `json:"position,omitempty"`
	ManagerEmployeeID     *string `json:"managerEmployeeId,omitempty"`
	EmergencyContactName  *string `json:"emergencyContactName,omitempty"`
	EmergencyContactPhone *string `json:"emergencyContactPhone,omitempty"`
}

type HRUpdateEmployeeStructureOutput struct {
	Updated bool `json:"updated"`
}

func ParseHRHireEmployeeInput(raw json.RawMessage) (HRHireEmployeeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRHireEmployeeInput{}, err
	}
	name, err := requiredCRMDealString(fields, "name", 1, 120)
	if err != nil {
		return HRHireEmployeeInput{}, err
	}
	input := HRHireEmployeeInput{Name: name}
	input.Email, err = optionalCRMDealString(fields, "email", 0, false)
	if err != nil {
		return HRHireEmployeeInput{}, err
	}
	if input.Email != nil && !validHREmployeeEmail(*input.Email) {
		return HRHireEmployeeInput{}, errors.New("email must be a valid email address")
	}
	input.Title, err = optionalCRMDealString(fields, "title", 80, false)
	if err != nil {
		return HRHireEmployeeInput{}, err
	}
	input.MonthlySalaryMinor, err = requiredSafeInteger(fields, "monthlySalaryMinor")
	if err != nil {
		return HRHireEmployeeInput{}, err
	}
	if input.MonthlySalaryMinor < 0 {
		return HRHireEmployeeInput{}, errors.New("monthlySalaryMinor must be a non-negative integer")
	}
	input.TaxRateBps, err = hrEmployeeDefaultedSafeInteger(fields, "taxRateBps", 0, 5000, 1000)
	if err != nil {
		return HRHireEmployeeInput{}, err
	}
	input.AnnualLeaveDays, err = hrEmployeeDefaultedSafeInteger(fields, "annualLeaveDays", 0, 365, 21)
	if err != nil {
		return HRHireEmployeeInput{}, err
	}
	return input, nil
}

func ParseHRDeactivateEmployeeInput(raw json.RawMessage) (HRDeactivateEmployeeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRDeactivateEmployeeInput{}, err
	}
	employeeID, err := requiredCRMDealString(fields, "employeeId", 0, 0)
	if err != nil {
		return HRDeactivateEmployeeInput{}, err
	}
	return HRDeactivateEmployeeInput{EmployeeID: employeeID}, nil
}

func ParseHRListEmployeesInput(raw json.RawMessage) (HRListEmployeesInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return HRListEmployeesInput{}, err
	}
	return HRListEmployeesInput{}, nil
}

func ParseHRUpdateEmployeeStructureInput(raw json.RawMessage) (HRUpdateEmployeeStructureInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRUpdateEmployeeStructureInput{}, err
	}
	employeeID, err := requiredCRMDealString(fields, "employeeId", 0, 0)
	if err != nil {
		return HRUpdateEmployeeStructureInput{}, err
	}
	if !isZodUUID(employeeID) {
		return HRUpdateEmployeeStructureInput{}, errors.New("employeeId must be a UUID")
	}
	input := HRUpdateEmployeeStructureInput{EmployeeID: employeeID}
	input.Department, err = optionalCRMDealString(fields, "department", 100, false)
	if err != nil {
		return HRUpdateEmployeeStructureInput{}, err
	}
	input.Position, err = optionalCRMDealString(fields, "position", 100, false)
	if err != nil {
		return HRUpdateEmployeeStructureInput{}, err
	}
	input.ManagerEmployeeID, err = optionalCRMDealString(fields, "managerEmployeeId", 0, false)
	if err != nil {
		return HRUpdateEmployeeStructureInput{}, err
	}
	if input.ManagerEmployeeID != nil && !isZodUUID(*input.ManagerEmployeeID) {
		return HRUpdateEmployeeStructureInput{}, errors.New("managerEmployeeId must be a UUID")
	}
	input.EmergencyContactName, err = optionalCRMDealString(fields, "emergencyContactName", 120, false)
	if err != nil {
		return HRUpdateEmployeeStructureInput{}, err
	}
	input.EmergencyContactPhone, err = optionalCRMDealString(fields, "emergencyContactPhone", 40, false)
	if err != nil {
		return HRUpdateEmployeeStructureInput{}, err
	}
	return input, nil
}

func hrEmployeeDefaultedSafeInteger(fields map[string]json.RawMessage, key string, minimum, maximum, fallback int64) (int64, error) {
	if _, ok := fields[key]; !ok {
		return fallback, nil
	}
	value, err := requiredSafeInteger(fields, key)
	if err != nil {
		return 0, err
	}
	if value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minimum, maximum)
	}
	return value, nil
}

func hrHireEmployee(ctx context.Context, tx pgx.Tx, orgID string, input HRHireEmployeeInput) (HRHireEmployeeOutput, error) {
	var employeeID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO employees (
			org_id, name, email, title, monthly_salary_minor, tax_rate_bps, annual_leave_days
		)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
		RETURNING id::text`, orgID, input.Name, input.Email, input.Title,
		input.MonthlySalaryMinor, input.TaxRateBps, input.AnnualLeaveDays).Scan(&employeeID); err != nil {
		return HRHireEmployeeOutput{}, err
	}
	return HRHireEmployeeOutput{EmployeeID: employeeID}, nil
}

func hrDeactivateEmployee(ctx context.Context, tx pgx.Tx, orgID string, input HRDeactivateEmployeeInput, now time.Time) (HRDeactivateEmployeeOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE employees SET deactivated_at = $3
		WHERE id = $1::uuid AND org_id = $2::uuid`, input.EmployeeID, orgID, now)
	if err != nil {
		return HRDeactivateEmployeeOutput{}, err
	}
	return HRDeactivateEmployeeOutput{Deactivated: tag.RowsAffected() > 0}, nil
}

func hrListEmployees(ctx context.Context, tx pgx.Tx, orgID string, _ HRListEmployeesInput) (HRListEmployeesOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, title, monthly_salary_minor, tax_rate_bps, deactivated_at IS NULL
		FROM employees
		WHERE org_id = $1::uuid
		ORDER BY hired_at DESC
		LIMIT 200`, orgID)
	if err != nil {
		return HRListEmployeesOutput{}, err
	}
	defer rows.Close()
	employees := make([]HREmployeeSummary, 0)
	for rows.Next() {
		var employee HREmployeeSummary
		if err := rows.Scan(&employee.ID, &employee.Name, &employee.Title,
			&employee.MonthlySalaryMinor, &employee.TaxRateBps, &employee.Active); err != nil {
			return HRListEmployeesOutput{}, err
		}
		employees = append(employees, employee)
	}
	if err := rows.Err(); err != nil {
		return HRListEmployeesOutput{}, err
	}
	return HRListEmployeesOutput{Employees: employees}, nil
}

func hrUpdateEmployeeStructure(ctx context.Context, tx pgx.Tx, orgID string, input HRUpdateEmployeeStructureInput) (HRUpdateEmployeeStructureOutput, error) {
	if input.ManagerEmployeeID != nil {
		var managerID string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM employees
			WHERE id = $1::uuid AND org_id = $2::uuid
			LIMIT 1`, *input.ManagerEmployeeID, orgID).Scan(&managerID)
		if errors.Is(err, pgx.ErrNoRows) {
			return HRUpdateEmployeeStructureOutput{}, errors.New("manager employee not found in this organization")
		}
		if err != nil {
			return HRUpdateEmployeeStructureOutput{}, err
		}
		if *input.ManagerEmployeeID == input.EmployeeID {
			return HRUpdateEmployeeStructureOutput{}, errors.New("an employee does not report to themselves")
		}
	}
	setClauses := make([]string, 0, 5)
	args := make([]any, 0, 7)
	if input.Department != nil {
		setClauses = append(setClauses, fmt.Sprintf("department = $%d", len(args)+1))
		args = append(args, *input.Department)
	}
	if input.Position != nil {
		setClauses = append(setClauses, fmt.Sprintf("title = $%d", len(args)+1))
		args = append(args, *input.Position)
	}
	if input.ManagerEmployeeID != nil {
		setClauses = append(setClauses, fmt.Sprintf("manager_employee_id = $%d::uuid", len(args)+1))
		args = append(args, *input.ManagerEmployeeID)
	}
	if input.EmergencyContactName != nil {
		setClauses = append(setClauses, fmt.Sprintf("emergency_contact_name = $%d", len(args)+1))
		args = append(args, *input.EmergencyContactName)
	}
	if input.EmergencyContactPhone != nil {
		setClauses = append(setClauses, fmt.Sprintf("emergency_contact_phone = $%d", len(args)+1))
		args = append(args, *input.EmergencyContactPhone)
	}
	if len(setClauses) == 0 {
		// drizzle throws this exact message when an update has no set keys,
		// so a structure input without any field fails the same way.
		return HRUpdateEmployeeStructureOutput{}, errors.New("No values to set")
	}
	args = append(args, input.EmployeeID, orgID)
	query := "UPDATE employees SET " + strings.Join(setClauses, ", ") +
		fmt.Sprintf(" WHERE id = $%d::uuid AND org_id = $%d::uuid", len(args)-1, len(args))
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return HRUpdateEmployeeStructureOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return HRUpdateEmployeeStructureOutput{}, errors.New("employee not found")
	}
	return HRUpdateEmployeeStructureOutput{Updated: true}, nil
}

func parseHREmployeeInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case hrHireEmployeeCapabilityID:
		return ParseHRHireEmployeeInput(raw)
	case hrDeactivateEmployeeCapabilityID:
		return ParseHRDeactivateEmployeeInput(raw)
	case hrListEmployeesCapabilityID:
		return ParseHRListEmployeesInput(raw)
	case hrUpdateEmployeeStructureCapabilityID:
		return ParseHRUpdateEmployeeStructureInput(raw)
	default:
		return nil, errors.New("unsupported HR employee capability")
	}
}
