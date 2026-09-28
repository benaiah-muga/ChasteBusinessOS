package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	saveBudgetScenarioCapabilityID           = "accounting.saveBudgetScenario"
	undoBudgetScenarioVersionCapabilityID    = "accounting.undoBudgetScenarioVersion"
	restoreBudgetScenarioVersionCapabilityID = "accounting.restoreBudgetScenarioVersion"
	listBudgetScenariosCapabilityID          = "accounting.listBudgetScenarios"
	budgetActualVsPlanCapabilityID           = "accounting.budgetActualVsPlan"
)

var budgetScenarioKeyPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var budgetCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
var budgetAccountCodePattern = regexp.MustCompile(`^\d{4}$`)

type BudgetScenarioAssumptions struct {
	CollectionDelayDays         int64 `json:"collectionDelayDays"`
	SpendUpliftBasisPoints      int64 `json:"spendUpliftBasisPoints"`
	ExpectedMonthlyInflowMinor  int64 `json:"expectedMonthlyInflowMinor"`
	ExpectedMonthlyOutflowMinor int64 `json:"expectedMonthlyOutflowMinor"`
	MinimumCashBufferMinor      int64 `json:"minimumCashBufferMinor"`
}

type BudgetScenarioLineInput struct {
	Month        int64   `json:"month"`
	AccountCode  string  `json:"accountCode"`
	PlannedMinor int64   `json:"plannedMinor"`
	Note         *string `json:"note,omitempty"`
}

type SaveBudgetScenarioInput struct {
	ScenarioKey string                    `json:"scenarioKey"`
	Name        string                    `json:"name"`
	FiscalYear  int64                     `json:"fiscalYear"`
	Currency    string                    `json:"currency"`
	Assumptions BudgetScenarioAssumptions `json:"assumptions"`
	Lines       []BudgetScenarioLineInput `json:"lines"`
}

type SaveBudgetScenarioOutput struct {
	ScenarioID         string  `json:"scenarioId"`
	Version            int64   `json:"version"`
	PreviousScenarioID *string `json:"previousScenarioId"`
}

type BudgetScenarioVersionInput struct {
	ScenarioID         string  `json:"scenarioId"`
	PreviousScenarioID *string `json:"previousScenarioId"`
}

type BudgetScenarioVersionOutput struct {
	ScenarioID         string  `json:"scenarioId"`
	RestoredScenarioID *string `json:"restoredScenarioId"`
}

type ListBudgetScenariosInput struct {
	FiscalYear *int64 `json:"fiscalYear,omitempty"`
}

type ListBudgetScenarioSummary struct {
	ID          string                    `json:"id"`
	Key         string                    `json:"key"`
	Name        string                    `json:"name"`
	FiscalYear  int64                     `json:"fiscalYear"`
	Version     int64                     `json:"version"`
	Currency    string                    `json:"currency"`
	IsCurrent   bool                      `json:"isCurrent"`
	Assumptions BudgetScenarioAssumptions `json:"assumptions"`
	CreatedAt   string                    `json:"createdAt"`
}

type ListBudgetScenariosOutput struct {
	Scenarios []ListBudgetScenarioSummary `json:"scenarios"`
}

type BudgetActualVsPlanInput struct {
	ScenarioID string `json:"scenarioId"`
}

type BudgetActualVsPlanLine struct {
	AccountCode    string `json:"accountCode"`
	AccountName    string `json:"accountName"`
	AccountType    string `json:"accountType"`
	PlanMinor      int64  `json:"planMinor"`
	ActualMinor    int64  `json:"actualMinor"`
	CommittedMinor int64  `json:"committedMinor"`
	ProjectedMinor int64  `json:"projectedMinor"`
	VarianceMinor  int64  `json:"varianceMinor"`
	UtilizationBps *int64 `json:"utilizationBps"`
}

type BudgetActualVsPlanMonth struct {
	Month int64                    `json:"month"`
	Lines []BudgetActualVsPlanLine `json:"lines"`
}

type BudgetActualVsPlanOutput struct {
	ScenarioID            string                    `json:"scenarioId"`
	Name                  string                    `json:"name"`
	FiscalYear            int64                     `json:"fiscalYear"`
	Currency              string                    `json:"currency"`
	UnconvertedEntryCount int64                     `json:"unconvertedEntryCount"`
	Months                []BudgetActualVsPlanMonth `json:"months"`
}

func ParseSaveBudgetScenarioInput(raw json.RawMessage) (SaveBudgetScenarioInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SaveBudgetScenarioInput{}, err
	}
	var input SaveBudgetScenarioInput
	if input.ScenarioKey, err = requiredString(fields, "scenarioKey"); err != nil {
		return SaveBudgetScenarioInput{}, err
	}
	if !budgetScenarioKeyPattern.MatchString(input.ScenarioKey) {
		return SaveBudgetScenarioInput{}, errors.New("scenarioKey must be lowercase kebab-case")
	}
	if utf16Length(input.ScenarioKey) > 80 {
		return SaveBudgetScenarioInput{}, errors.New("scenarioKey must contain at most 80 characters")
	}
	if input.Name, err = requiredString(fields, "name"); err != nil {
		return SaveBudgetScenarioInput{}, err
	}
	if length := utf16Length(input.Name); length < 2 || length > 100 {
		return SaveBudgetScenarioInput{}, errors.New("name must contain between 2 and 100 characters")
	}
	if input.FiscalYear, err = requiredSafeInteger(fields, "fiscalYear"); err != nil || input.FiscalYear < 2000 || input.FiscalYear > 2100 {
		return SaveBudgetScenarioInput{}, errors.New("fiscalYear must be an integer between 2000 and 2100")
	}
	if input.Currency, err = requiredString(fields, "currency"); err != nil {
		return SaveBudgetScenarioInput{}, err
	}
	if !budgetCurrencyPattern.MatchString(input.Currency) {
		return SaveBudgetScenarioInput{}, errors.New("currency must be a three letter uppercase currency code")
	}
	input.Assumptions = BudgetScenarioAssumptions{}
	if rawAssumptions, ok := fields["assumptions"]; ok {
		assumptionFields, err := decodeJSONObject(rawAssumptions)
		if err != nil {
			return SaveBudgetScenarioInput{}, errors.New("assumptions must be an object")
		}
		if input.Assumptions, err = budgetAssumptionsFromFields(assumptionFields); err != nil {
			return SaveBudgetScenarioInput{}, err
		}
	}
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return SaveBudgetScenarioInput{}, errors.New("lines must contain between 1 and 240 lines")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) < 1 || len(lineValues) > 240 {
		return SaveBudgetScenarioInput{}, errors.New("lines must contain between 1 and 240 lines")
	}
	lines, err := parseBudgetScenarioLines(lineValues)
	if err != nil {
		return SaveBudgetScenarioInput{}, err
	}
	input.Lines = lines
	return input, nil
}

func budgetAssumptionsFromFields(fields map[string]json.RawMessage) (BudgetScenarioAssumptions, error) {
	var assumptions BudgetScenarioAssumptions
	collectionDelayDays, err := budgetAssumptionField(fields, "collectionDelayDays", 180)
	if err != nil {
		return assumptions, err
	}
	assumptions.CollectionDelayDays = collectionDelayDays
	spendUplift, err := budgetAssumptionField(fields, "spendUpliftBasisPoints", 20_000)
	if err != nil {
		return assumptions, err
	}
	assumptions.SpendUpliftBasisPoints = spendUplift
	inflow, err := budgetAssumptionField(fields, "expectedMonthlyInflowMinor", maxSafeInteger)
	if err != nil {
		return assumptions, err
	}
	assumptions.ExpectedMonthlyInflowMinor = inflow
	outflow, err := budgetAssumptionField(fields, "expectedMonthlyOutflowMinor", maxSafeInteger)
	if err != nil {
		return assumptions, err
	}
	assumptions.ExpectedMonthlyOutflowMinor = outflow
	buffer, err := budgetAssumptionField(fields, "minimumCashBufferMinor", maxSafeInteger)
	if err != nil {
		return assumptions, err
	}
	assumptions.MinimumCashBufferMinor = buffer
	return assumptions, nil
}

func budgetAssumptionField(fields map[string]json.RawMessage, key string, maxValue int64) (int64, error) {
	if _, ok := fields[key]; !ok {
		return 0, nil
	}
	value, err := requiredSafeInteger(fields, key)
	if err != nil || value < 0 || value > maxValue {
		if maxValue == maxSafeInteger {
			return 0, fmt.Errorf("%s must be a non-negative safe integer", key)
		}
		return 0, fmt.Errorf("%s must be an integer between 0 and %d", key, maxValue)
	}
	return value, nil
}

func parseBudgetScenarioLines(lineValues []json.RawMessage) ([]BudgetScenarioLineInput, error) {
	lines := make([]BudgetScenarioLineInput, 0, len(lineValues))
	seen := make(map[string]struct{}, len(lineValues))
	for index, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return nil, fmt.Errorf("budget line %d must be an object", index)
		}
		month, err := requiredSafeInteger(lineFields, "month")
		if err != nil || month < 1 || month > 12 {
			return nil, errors.New("month must be an integer between 1 and 12")
		}
		accountCode, err := requiredString(lineFields, "accountCode")
		if err != nil {
			return nil, err
		}
		if !budgetAccountCodePattern.MatchString(accountCode) {
			return nil, errors.New("accountCode must be a four digit account code")
		}
		plannedMinor, err := requiredSafeInteger(lineFields, "plannedMinor")
		if err != nil || plannedMinor < 0 {
			return nil, errors.New("plannedMinor must be a non-negative integer")
		}
		note, err := optionalString(lineFields, "note")
		if err != nil {
			return nil, err
		}
		if note != nil && utf16Length(*note) > 300 {
			return nil, errors.New("note must contain at most 300 characters")
		}
		key := fmt.Sprintf("%d:%s", month, accountCode)
		if _, duplicate := seen[key]; duplicate {
			return nil, errors.New("account and month may appear once per version")
		}
		seen[key] = struct{}{}
		lines = append(lines, BudgetScenarioLineInput{
			Month: month, AccountCode: accountCode, PlannedMinor: plannedMinor, Note: note,
		})
	}
	return lines, nil
}

func parseBudgetScenarioVersionInput(raw json.RawMessage, previousKey string) (BudgetScenarioVersionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return BudgetScenarioVersionInput{}, err
	}
	var input BudgetScenarioVersionInput
	if input.ScenarioID, err = requiredString(fields, "scenarioId"); err != nil {
		return BudgetScenarioVersionInput{}, err
	}
	if !isZodUUID(input.ScenarioID) {
		return BudgetScenarioVersionInput{}, errors.New("scenarioId must be a UUID")
	}
	rawPrevious, ok := fields[previousKey]
	if !ok {
		return BudgetScenarioVersionInput{}, fmt.Errorf("%s is required", previousKey)
	}
	if input.PreviousScenarioID, err = readNullableUUID(rawPrevious); err != nil {
		return BudgetScenarioVersionInput{}, fmt.Errorf("%s must be a UUID or null", previousKey)
	}
	return input, nil
}

func ParseUndoBudgetScenarioVersionInput(raw json.RawMessage) (BudgetScenarioVersionInput, error) {
	return parseBudgetScenarioVersionInput(raw, "previousScenarioId")
}

func ParseRestoreBudgetScenarioVersionInput(raw json.RawMessage) (BudgetScenarioVersionInput, error) {
	return parseBudgetScenarioVersionInput(raw, "previousScenarioId")
}

func ParseListBudgetScenariosInput(raw json.RawMessage) (ListBudgetScenariosInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListBudgetScenariosInput{}, err
	}
	var input ListBudgetScenariosInput
	if raw, ok := fields["fiscalYear"]; ok {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return ListBudgetScenariosInput{}, errors.New("fiscalYear must be an integer between 2000 and 2100")
		}
		value, err := requiredSafeInteger(fields, "fiscalYear")
		if err != nil || value < 2000 || value > 2100 {
			return ListBudgetScenariosInput{}, errors.New("fiscalYear must be an integer between 2000 and 2100")
		}
		input.FiscalYear = &value
	}
	return input, nil
}

func ParseBudgetActualVsPlanInput(raw json.RawMessage) (BudgetActualVsPlanInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return BudgetActualVsPlanInput{}, err
	}
	var input BudgetActualVsPlanInput
	if input.ScenarioID, err = requiredString(fields, "scenarioId"); err != nil {
		return BudgetActualVsPlanInput{}, err
	}
	if !isZodUUID(input.ScenarioID) {
		return BudgetActualVsPlanInput{}, errors.New("scenarioId must be a UUID")
	}
	return input, nil
}

// budgetLineNetMinor mirrors erp-core calculateTaxLine netMinor: quantity in
// thousandths, half-up rounding, tax-inclusive prices back out the net share.
func budgetLineNetMinor(quantityThousandths, unitPriceMinor, rateBasisPoints int64, priceIncludesTax bool) (int64, error) {
	if quantityThousandths <= 0 || quantityThousandths > maxSafeInteger {
		return 0, errors.New("quantity must be positive thousandths")
	}
	if unitPriceMinor < 0 || unitPriceMinor > maxSafeInteger {
		return 0, errors.New("unit price must be a non-negative safe integer")
	}
	if rateBasisPoints < 0 || rateBasisPoints > maxSafeInteger {
		return 0, errors.New("tax rate must be non-negative basis points")
	}
	numerator := new(big.Int).Mul(big.NewInt(quantityThousandths), big.NewInt(unitPriceMinor))
	numerator.Add(numerator, big.NewInt(500))
	numerator.Div(numerator, big.NewInt(1_000))
	if !numerator.IsInt64() || numerator.Int64() > maxSafeInteger {
		return 0, errors.New("line amount exceeds the supported amount range")
	}
	grossOrNet := numerator.Int64()
	if !priceIncludesTax {
		tax := new(big.Int).Mul(big.NewInt(grossOrNet), big.NewInt(rateBasisPoints))
		tax.Add(tax, big.NewInt(5_000))
		tax.Div(tax, big.NewInt(10_000))
		if !tax.IsInt64() || tax.Int64() > maxSafeInteger {
			return 0, errors.New("tax amount exceeds the supported amount range")
		}
		return grossOrNet, nil
	}
	denominator := new(big.Int).Add(big.NewInt(10_000), big.NewInt(rateBasisPoints))
	net := new(big.Int).Mul(big.NewInt(grossOrNet), big.NewInt(10_000))
	net.Mul(net, big.NewInt(2))
	net.Add(net, denominator)
	denominator.Mul(denominator, big.NewInt(2))
	net.Div(net, denominator)
	if !net.IsInt64() || net.Int64() > maxSafeInteger {
		return 0, errors.New("line amount exceeds the supported amount range")
	}
	return net.Int64(), nil
}

func budgetRemainingCommitment(orderedNetMinor, billedNetMinor int64) int64 {
	if orderedNetMinor <= billedNetMinor {
		return 0
	}
	return orderedNetMinor - billedNetMinor
}

type budgetComparison struct {
	projectedMinor int64
	varianceMinor  int64
	utilizationBps *int64
}

// budgetCompare mirrors erp-core compareBudget: positive variance means
// projected spend is over plan and utilization rounds half up away from zero.
func budgetCompare(planMinor, actualMinor, committedMinor int64) (budgetComparison, error) {
	if planMinor < 0 || planMinor > maxSafeInteger {
		return budgetComparison{}, errors.New("plan must be a non-negative safe integer")
	}
	if committedMinor < 0 || committedMinor > maxSafeInteger {
		return budgetComparison{}, errors.New("commitments must be a non-negative safe integer")
	}
	if actualMinor < -maxSafeInteger || actualMinor > maxSafeInteger {
		return budgetComparison{}, errors.New("actual must be a safe integer")
	}
	projected := actualMinor + committedMinor
	remaining := planMinor - actualMinor
	variance := projected - planMinor
	for _, value := range []int64{projected, remaining, variance} {
		if value < -maxSafeInteger || value > maxSafeInteger {
			return budgetComparison{}, errors.New("budget comparison exceeds the supported amount range")
		}
	}
	comparison := budgetComparison{projectedMinor: projected, varianceMinor: variance}
	if planMinor == 0 {
		return comparison, nil
	}
	numerator := new(big.Int).Mul(big.NewInt(projected), big.NewInt(10_000))
	sign := int64(1)
	if numerator.Sign() < 0 {
		sign = -1
		numerator.Neg(numerator)
	}
	numerator.Add(numerator, big.NewInt(planMinor/2))
	numerator.Div(numerator, big.NewInt(planMinor))
	if numerator.IsInt64() {
		rounded := sign * numerator.Int64()
		if rounded >= -maxSafeInteger && rounded <= maxSafeInteger {
			comparison.utilizationBps = &rounded
		}
	}
	return comparison, nil
}

func saveBudgetScenario(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SaveBudgetScenarioInput) (SaveBudgetScenarioOutput, error) {
	orgID := claims.OrganizationID
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, input.ScenarioKey); err != nil {
		return SaveBudgetScenarioOutput{}, err
	}
	var baseCurrency *string
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&baseCurrency); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return SaveBudgetScenarioOutput{}, err
	}
	if baseCurrency != nil && *baseCurrency != input.Currency {
		return SaveBudgetScenarioOutput{}, fmt.Errorf("budget currency must match the organization's base currency (%s)", *baseCurrency)
	}
	uniqueCodes := make([]string, 0, len(input.Lines))
	seenCodes := make(map[string]struct{}, len(input.Lines))
	for _, line := range input.Lines {
		if _, ok := seenCodes[line.AccountCode]; ok {
			continue
		}
		seenCodes[line.AccountCode] = struct{}{}
		uniqueCodes = append(uniqueCodes, line.AccountCode)
	}
	rows, err := tx.Query(ctx, `SELECT code, type FROM accounts WHERE org_id = $1::uuid AND code = ANY($2::text[])`, orgID, uniqueCodes)
	if err != nil {
		return SaveBudgetScenarioOutput{}, err
	}
	valid := make(map[string]struct{}, len(uniqueCodes))
	for rows.Next() {
		var code, accountType string
		if err := rows.Scan(&code, &accountType); err != nil {
			rows.Close()
			return SaveBudgetScenarioOutput{}, err
		}
		if accountType == "income" || accountType == "expense" {
			valid[code] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SaveBudgetScenarioOutput{}, err
	}
	rows.Close()
	missing := make([]string, 0)
	for _, code := range uniqueCodes {
		if _, ok := valid[code]; !ok {
			missing = append(missing, code)
		}
	}
	if len(missing) > 0 {
		return SaveBudgetScenarioOutput{}, fmt.Errorf("budget lines must reference income or expense accounts: %s", strings.Join(missing, ", "))
	}
	var previousID *string
	var previousVersion int64
	err = tx.QueryRow(ctx, `
		SELECT id::text, version FROM budget_scenarios
		WHERE org_id = $1::uuid AND scenario_key = $2 AND is_current
		ORDER BY version DESC LIMIT 1
		FOR UPDATE`, orgID, input.ScenarioKey).Scan(&previousID, &previousVersion)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return SaveBudgetScenarioOutput{}, err
	}
	version := previousVersion + 1
	if previousID != nil {
		if _, err := tx.Exec(ctx, `UPDATE budget_scenarios SET is_current = false WHERE id = $1::uuid`, *previousID); err != nil {
			return SaveBudgetScenarioOutput{}, err
		}
	}
	assumptionsJSON, err := json.Marshal(input.Assumptions)
	if err != nil {
		return SaveBudgetScenarioOutput{}, err
	}
	var scenarioID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO budget_scenarios (org_id, scenario_key, name, fiscal_year, version, currency, assumptions, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::uuid)
		RETURNING id::text`, orgID, input.ScenarioKey, input.Name, input.FiscalYear, version, input.Currency, string(assumptionsJSON), claims.ActorType, claims.ActorID).Scan(&scenarioID); err != nil {
		return SaveBudgetScenarioOutput{}, err
	}
	for _, line := range input.Lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO budget_lines (org_id, scenario_id, month, account_code, planned_minor, note)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`, orgID, scenarioID, line.Month, line.AccountCode, line.PlannedMinor, line.Note); err != nil {
			return SaveBudgetScenarioOutput{}, err
		}
	}
	return SaveBudgetScenarioOutput{ScenarioID: scenarioID, Version: version, PreviousScenarioID: previousID}, nil
}

func undoBudgetScenarioVersion(ctx context.Context, tx pgx.Tx, orgID string, input BudgetScenarioVersionInput) (BudgetScenarioVersionOutput, error) {
	var scenarioKey string
	err := tx.QueryRow(ctx, `SELECT scenario_key FROM budget_scenarios WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`, input.ScenarioID, orgID).Scan(&scenarioKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetScenarioVersionOutput{}, errors.New("budget version not found")
	}
	if err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, scenarioKey); err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	var scenarioID, lockedKey string
	var isCurrent bool
	err = tx.QueryRow(ctx, `
		SELECT id::text, scenario_key, is_current FROM budget_scenarios
		WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1
		FOR UPDATE`, input.ScenarioID, orgID).Scan(&scenarioID, &lockedKey, &isCurrent)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetScenarioVersionOutput{}, errors.New("budget version not found")
	}
	if err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	if !isCurrent {
		return BudgetScenarioVersionOutput{}, errors.New("the saved version is no longer current")
	}
	if _, err := tx.Exec(ctx, `UPDATE budget_scenarios SET is_current = false WHERE id = $1::uuid`, scenarioID); err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	if input.PreviousScenarioID != nil {
		rows, err := tx.Query(ctx, `
			UPDATE budget_scenarios SET is_current = true
			WHERE id = $1::uuid AND org_id = $2::uuid AND scenario_key = $3 AND is_current = false
			RETURNING id::text`, *input.PreviousScenarioID, orgID, lockedKey)
		if err != nil {
			return BudgetScenarioVersionOutput{}, err
		}
		restored := 0
		for rows.Next() {
			restored++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return BudgetScenarioVersionOutput{}, err
		}
		rows.Close()
		if restored == 0 {
			return BudgetScenarioVersionOutput{}, errors.New("the prior budget version is no longer available")
		}
	}
	return BudgetScenarioVersionOutput{ScenarioID: scenarioID, RestoredScenarioID: input.PreviousScenarioID}, nil
}

func restoreBudgetScenarioVersion(ctx context.Context, tx pgx.Tx, orgID string, input BudgetScenarioVersionInput) (BudgetScenarioVersionOutput, error) {
	var scenarioKey string
	err := tx.QueryRow(ctx, `SELECT scenario_key FROM budget_scenarios WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`, input.ScenarioID, orgID).Scan(&scenarioKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetScenarioVersionOutput{}, errors.New("budget version not found")
	}
	if err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, scenarioKey); err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	var scenarioID, lockedKey string
	err = tx.QueryRow(ctx, `
		SELECT id::text, scenario_key FROM budget_scenarios
		WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1
		FOR UPDATE`, input.ScenarioID, orgID).Scan(&scenarioID, &lockedKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetScenarioVersionOutput{}, errors.New("budget version not found")
	}
	if err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE budget_scenarios SET is_current = false WHERE org_id = $1::uuid AND scenario_key = $2`, orgID, lockedKey); err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE budget_scenarios SET is_current = true WHERE id = $1::uuid`, scenarioID); err != nil {
		return BudgetScenarioVersionOutput{}, err
	}
	return BudgetScenarioVersionOutput{ScenarioID: scenarioID, RestoredScenarioID: input.PreviousScenarioID}, nil
}

func listBudgetScenarios(ctx context.Context, tx pgx.Tx, orgID string, input ListBudgetScenariosInput) (ListBudgetScenariosOutput, error) {
	query := `
		SELECT id::text, scenario_key, name, fiscal_year, version, currency, is_current, assumptions, created_at
		FROM budget_scenarios
		WHERE org_id = $1::uuid`
	args := []any{orgID}
	if input.FiscalYear != nil {
		query += ` AND fiscal_year = $2`
		args = append(args, *input.FiscalYear)
	}
	query += ` ORDER BY scenario_key ASC, version DESC`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return ListBudgetScenariosOutput{}, err
	}
	defer rows.Close()
	scenarios := make([]ListBudgetScenarioSummary, 0)
	for rows.Next() {
		var scenario ListBudgetScenarioSummary
		var assumptionsRaw []byte
		var createdAt time.Time
		if err := rows.Scan(&scenario.ID, &scenario.Key, &scenario.Name, &scenario.FiscalYear, &scenario.Version, &scenario.Currency, &scenario.IsCurrent, &assumptionsRaw, &createdAt); err != nil {
			return ListBudgetScenariosOutput{}, err
		}
		if err := json.Unmarshal(assumptionsRaw, &scenario.Assumptions); err != nil {
			return ListBudgetScenariosOutput{}, err
		}
		scenario.CreatedAt = createdAt.Truncate(time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z")
		scenarios = append(scenarios, scenario)
	}
	if err := rows.Err(); err != nil {
		return ListBudgetScenariosOutput{}, err
	}
	return ListBudgetScenariosOutput{Scenarios: scenarios}, nil
}

func budgetActualVsPlan(ctx context.Context, tx pgx.Tx, orgID string, input BudgetActualVsPlanInput) (BudgetActualVsPlanOutput, error) {
	var scenario struct {
		ID         string
		Name       string
		FiscalYear int64
		Currency   string
	}
	err := tx.QueryRow(ctx, `
		SELECT id::text, name, fiscal_year, currency FROM budget_scenarios
		WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`, input.ScenarioID, orgID).
		Scan(&scenario.ID, &scenario.Name, &scenario.FiscalYear, &scenario.Currency)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetActualVsPlanOutput{}, errors.New("budget scenario not found")
	}
	if err != nil {
		return BudgetActualVsPlanOutput{}, err
	}
	yearStart := time.Date(int(scenario.FiscalYear), 1, 1, 0, 0, 0, 0, time.UTC)
	nextYearStart := time.Date(int(scenario.FiscalYear)+1, 1, 1, 0, 0, 0, 0, time.UTC)

	planByMonthCode := make(map[string]int64)
	planRows, err := tx.Query(ctx, `
		SELECT month, account_code, planned_minor FROM budget_lines
		WHERE org_id = $1::uuid AND scenario_id = $2::uuid`, orgID, scenario.ID)
	if err != nil {
		return BudgetActualVsPlanOutput{}, err
	}
	for planRows.Next() {
		var month int64
		var accountCode string
		var plannedMinor int64
		if err := planRows.Scan(&month, &accountCode, &plannedMinor); err != nil {
			planRows.Close()
			return BudgetActualVsPlanOutput{}, err
		}
		planByMonthCode[fmt.Sprintf("%d:%s", month, accountCode)] = plannedMinor
	}
	if err := planRows.Err(); err != nil {
		planRows.Close()
		return BudgetActualVsPlanOutput{}, err
	}
	planRows.Close()

	type budgetActualRow struct {
		month       int64
		accountCode string
		accountType string
		debitMinor  int64
		creditMinor int64
	}
	actualRows := make([]budgetActualRow, 0, 8)
	actualScan, err := tx.Query(ctx, `
		SELECT extract(month FROM je.posted_at)::integer, a.code, a.type,
		       coalesce(sum(jl.debit_minor), 0)::text, coalesce(sum(jl.credit_minor), 0)::text
		FROM journal_lines jl
		JOIN journal_entries je ON je.id = jl.entry_id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid
		  AND je.currency = $2
		  AND je.posted_at >= $3::timestamptz
		  AND je.posted_at < $4::timestamptz
		  AND a.type IN ('income', 'expense')
		  AND je.entry_kind <> 'year_end_close'
		GROUP BY extract(month FROM je.posted_at), a.code, a.name, a.type`,
		orgID, scenario.Currency, yearStart, nextYearStart)
	if err != nil {
		return BudgetActualVsPlanOutput{}, err
	}
	for actualScan.Next() {
		var row budgetActualRow
		var debitText, creditText string
		if err := actualScan.Scan(&row.month, &row.accountCode, &row.accountType, &debitText, &creditText); err != nil {
			actualScan.Close()
			return BudgetActualVsPlanOutput{}, err
		}
		if row.debitMinor, err = strconv.ParseInt(debitText, 10, 64); err != nil {
			actualScan.Close()
			return BudgetActualVsPlanOutput{}, err
		}
		if row.creditMinor, err = strconv.ParseInt(creditText, 10, 64); err != nil {
			actualScan.Close()
			return BudgetActualVsPlanOutput{}, err
		}
		actualRows = append(actualRows, row)
	}
	if err := actualScan.Err(); err != nil {
		actualScan.Close()
		return BudgetActualVsPlanOutput{}, err
	}
	actualScan.Close()
	actualByMonthCode := make(map[string]int64, len(actualRows))
	for _, row := range actualRows {
		amount := row.debitMinor - row.creditMinor
		if row.accountType == "income" {
			amount = row.creditMinor - row.debitMinor
		}
		actualByMonthCode[fmt.Sprintf("%d:%s", row.month, row.accountCode)] = amount
	}

	var unconvertedEntryCount int64
	if err := tx.QueryRow(ctx, `
		SELECT count(DISTINCT je.id)::integer
		FROM journal_entries je
		JOIN journal_lines jl ON jl.entry_id = je.id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid
		  AND je.currency <> $2
		  AND je.posted_at >= $3::timestamptz
		  AND je.posted_at < $4::timestamptz
		  AND a.type IN ('income', 'expense')`,
		orgID, scenario.Currency, yearStart, nextYearStart).Scan(&unconvertedEntryCount); err != nil {
		return BudgetActualVsPlanOutput{}, err
	}

	type budgetCommitmentRow struct {
		id          string
		monthAt     time.Time
		accountCode string
		quantity    int64
		unitPrice   int64
	}
	commitmentRows := make([]budgetCommitmentRow, 0)
	poRows, err := tx.Query(ctx, `
		SELECT pl.id::text, coalesce(po.promised_at, po.ordered_at, po.created_at),
		       pl.expense_account_code, pl.quantity, pl.unit_price_minor
		FROM po_lines pl
		JOIN purchase_orders po ON po.id = pl.po_id
		WHERE po.org_id = $1::uuid
		  AND po.status IN ('ordered', 'partial', 'received')
		  AND po.voided_at IS NULL
		  AND coalesce(po.promised_at, po.ordered_at, po.created_at) >= $2::timestamptz
		  AND coalesce(po.promised_at, po.ordered_at, po.created_at) < $3::timestamptz`,
		orgID, yearStart, nextYearStart)
	if err != nil {
		return BudgetActualVsPlanOutput{}, err
	}
	for poRows.Next() {
		var row budgetCommitmentRow
		if err := poRows.Scan(&row.id, &row.monthAt, &row.accountCode, &row.quantity, &row.unitPrice); err != nil {
			poRows.Close()
			return BudgetActualVsPlanOutput{}, err
		}
		commitmentRows = append(commitmentRows, row)
	}
	if err := poRows.Err(); err != nil {
		poRows.Close()
		return BudgetActualVsPlanOutput{}, err
	}
	poRows.Close()

	billedByLine := make(map[string]*big.Int, len(commitmentRows))
	if len(commitmentRows) > 0 {
		lineIDs := make([]string, 0, len(commitmentRows))
		for _, row := range commitmentRows {
			lineIDs = append(lineIDs, row.id)
		}
		billRows, err := tx.Query(ctx, `
			SELECT vbl.po_line_id::text, vbl.quantity, vbl.unit_price_minor, vbl.tax_rate_basis_points, vbl.price_includes_tax
			FROM vendor_bill_lines vbl
			JOIN vendor_bills vb ON vb.id = vbl.bill_id
			WHERE vbl.po_line_id = ANY($1::uuid[]) AND vb.org_id = $2::uuid AND vb.status <> 'void'`,
			lineIDs, orgID)
		if err != nil {
			return BudgetActualVsPlanOutput{}, err
		}
		for billRows.Next() {
			var poLineID string
			var quantity, unitPrice int64
			var rateBasisPoints *int64
			var priceIncludesTax bool
			if err := billRows.Scan(&poLineID, &quantity, &unitPrice, &rateBasisPoints, &priceIncludesTax); err != nil {
				billRows.Close()
				return BudgetActualVsPlanOutput{}, err
			}
			rate := int64(0)
			if rateBasisPoints != nil {
				rate = *rateBasisPoints
			}
			net, err := budgetLineNetMinor(quantity, unitPrice, rate, priceIncludesTax)
			if err != nil {
				billRows.Close()
				return BudgetActualVsPlanOutput{}, err
			}
			total := billedByLine[poLineID]
			if total == nil {
				total = new(big.Int)
				billedByLine[poLineID] = total
			}
			total.Add(total, big.NewInt(net))
			if !total.IsInt64() || total.Int64() > maxSafeInteger {
				billRows.Close()
				return BudgetActualVsPlanOutput{}, errors.New("billed purchase commitment exceeds the supported amount range")
			}
		}
		if err := billRows.Err(); err != nil {
			billRows.Close()
			return BudgetActualVsPlanOutput{}, err
		}
		billRows.Close()
	}

	committedByMonthCode := make(map[string]int64)
	committedCodes := make(map[string]struct{})
	for _, row := range commitmentRows {
		ordered, err := budgetLineNetMinor(row.quantity, row.unitPrice, 0, false)
		if err != nil {
			return BudgetActualVsPlanOutput{}, err
		}
		var billed int64
		if total := billedByLine[row.id]; total != nil && total.IsInt64() {
			billed = total.Int64()
		}
		remaining := budgetRemainingCommitment(ordered, billed)
		if remaining == 0 {
			continue
		}
		month := int64(row.monthAt.UTC().Month())
		key := fmt.Sprintf("%d:%s", month, row.accountCode)
		next := new(big.Int).Add(big.NewInt(committedByMonthCode[key]), big.NewInt(remaining))
		if !next.IsInt64() || next.Int64() > maxSafeInteger {
			return BudgetActualVsPlanOutput{}, errors.New("purchase commitments exceed the supported amount range")
		}
		committedByMonthCode[key] = next.Int64()
		committedCodes[row.accountCode] = struct{}{}
	}

	accountCodes := make([]string, 0, len(planByMonthCode)+len(committedCodes))
	seenCodes := make(map[string]struct{}, len(planByMonthCode)+len(committedCodes))
	for key := range planByMonthCode {
		code := key[strings.IndexByte(key, ':')+1:]
		if _, ok := seenCodes[code]; !ok {
			seenCodes[code] = struct{}{}
			accountCodes = append(accountCodes, code)
		}
	}
	for code := range committedCodes {
		if _, ok := seenCodes[code]; !ok {
			seenCodes[code] = struct{}{}
			accountCodes = append(accountCodes, code)
		}
	}
	type budgetAccountRef struct {
		name string
		kind string
	}
	accountByCode := make(map[string]budgetAccountRef, len(accountCodes))
	if len(accountCodes) > 0 {
		accountRows, err := tx.Query(ctx, `
			SELECT code, name, type FROM accounts
			WHERE org_id = $1::uuid AND code = ANY($2::text[])`, orgID, accountCodes)
		if err != nil {
			return BudgetActualVsPlanOutput{}, err
		}
		for accountRows.Next() {
			var code, name, kind string
			if err := accountRows.Scan(&code, &name, &kind); err != nil {
				accountRows.Close()
				return BudgetActualVsPlanOutput{}, err
			}
			accountByCode[code] = budgetAccountRef{name: name, kind: kind}
		}
		if err := accountRows.Err(); err != nil {
			accountRows.Close()
			return BudgetActualVsPlanOutput{}, err
		}
		accountRows.Close()
	}

	months := make([]BudgetActualVsPlanMonth, 0, 12)
	for month := int64(1); month <= 12; month++ {
		prefix := fmt.Sprintf("%d:", month)
		keySet := make(map[string]struct{})
		for key := range planByMonthCode {
			if strings.HasPrefix(key, prefix) {
				keySet[key[len(prefix):]] = struct{}{}
			}
		}
		for key := range committedByMonthCode {
			if strings.HasPrefix(key, prefix) {
				keySet[key[len(prefix):]] = struct{}{}
			}
		}
		for key := range actualByMonthCode {
			if strings.HasPrefix(key, prefix) {
				keySet[key[len(prefix):]] = struct{}{}
			}
		}
		codes := make([]string, 0, len(keySet))
		for code := range keySet {
			codes = append(codes, code)
		}
		sort.Strings(codes)
		lines := make([]BudgetActualVsPlanLine, 0, len(codes))
		for _, code := range codes {
			key := prefix + code
			account, ok := accountByCode[code]
			accountName := code
			accountType := "expense"
			if ok {
				accountName = account.name
				accountType = account.kind
			}
			comparison, err := budgetCompare(planByMonthCode[key], actualByMonthCode[key], committedByMonthCode[key])
			if err != nil {
				return BudgetActualVsPlanOutput{}, err
			}
			lines = append(lines, BudgetActualVsPlanLine{
				AccountCode:    code,
				AccountName:    accountName,
				AccountType:    accountType,
				PlanMinor:      planByMonthCode[key],
				ActualMinor:    actualByMonthCode[key],
				CommittedMinor: committedByMonthCode[key],
				ProjectedMinor: comparison.projectedMinor,
				VarianceMinor:  comparison.varianceMinor,
				UtilizationBps: comparison.utilizationBps,
			})
		}
		months = append(months, BudgetActualVsPlanMonth{Month: month, Lines: lines})
	}
	return BudgetActualVsPlanOutput{
		ScenarioID:            scenario.ID,
		Name:                  scenario.Name,
		FiscalYear:            scenario.FiscalYear,
		Currency:              scenario.Currency,
		UnconvertedEntryCount: unconvertedEntryCount,
		Months:                months,
	}, nil
}

func parseAccountingBudgetInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case saveBudgetScenarioCapabilityID:
		return ParseSaveBudgetScenarioInput(raw)
	case undoBudgetScenarioVersionCapabilityID:
		return ParseUndoBudgetScenarioVersionInput(raw)
	case restoreBudgetScenarioVersionCapabilityID:
		return ParseRestoreBudgetScenarioVersionInput(raw)
	case listBudgetScenariosCapabilityID:
		return ParseListBudgetScenariosInput(raw)
	case budgetActualVsPlanCapabilityID:
		return ParseBudgetActualVsPlanInput(raw)
	default:
		return nil, errors.New("unsupported accounting budget capability")
	}
}
