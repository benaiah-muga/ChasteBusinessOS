package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	iamSetModulesCapabilityID      = "iam.setModules"
	iamRestoreModulesCapabilityID  = "iam.restoreModules"
	iamSetModuleConfigCapabilityID = "iam.setModuleConfig"
	iamSetOrgPolicyCapabilityID    = "iam.setOrgPolicy"
	iamSetOrgBrandingCapabilityID  = "iam.setOrgBranding"
)

var iamProtectedModuleIDs = []string{"iam", "signals", "routines"}

var (
	iamLogoDataURLPattern = regexp.MustCompile(`^data:image/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$`)
	iamAccentColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

type IAMModulesInput struct {
	Modules []string `json:"modules"`
}

type IAMSetModulesOutput struct {
	EnabledModules  []string `json:"enabledModules"`
	PreviousModules []string `json:"previousModules"`
}

type IAMRestoreModulesOutput struct {
	EnabledModules []string `json:"enabledModules"`
}

type IAMSetModuleConfigInput struct {
	Module   string          `json:"module"`
	Settings json.RawMessage `json:"settings"`
}

type IAMSetModuleConfigOutput struct {
	Module   string          `json:"module"`
	Settings json.RawMessage `json:"settings"`
}

type IAMSetOrgPolicyInput struct {
	MaxRiskAutonomous   string   `json:"maxRiskAutonomous"`
	MoneyThresholdMinor *int64   `json:"moneyThresholdMinor"`
	RequiresApprovalFor []string `json:"requiresApprovalFor"`
}

type IAMSetOrgPolicyOutput struct {
	Saved bool `json:"saved"`
}

type IAMSetOrgBrandingInput struct {
	LogoDataURL   *string `json:"logoDataUrl,omitempty"`
	AccentColor   *string `json:"accentColor,omitempty"`
	InvoiceFooter *string `json:"invoiceFooter,omitempty"`
	Layout        *string `json:"layout,omitempty"`
}

type IAMSetOrgBrandingOutput struct {
	Saved bool `json:"saved"`
}

func iamModulesUnion(requested []string) []string {
	seen := map[string]bool{}
	merged := make([]string, 0, len(requested)+len(iamProtectedModuleIDs))
	for _, module := range append(append([]string{}, iamProtectedModuleIDs...), requested...) {
		if seen[module] {
			continue
		}
		seen[module] = true
		merged = append(merged, module)
	}
	return merged
}

func iamParseModulesArray(fields map[string]json.RawMessage) ([]string, error) {
	rawModules, ok := fields["modules"]
	if !ok {
		return nil, errors.New("modules is required")
	}
	var modules []string
	if err := json.Unmarshal(rawModules, &modules); err != nil {
		return nil, errors.New("modules must be an array of strings")
	}
	if len(modules) < 1 {
		return nil, errors.New("modules must have at least 1 items")
	}
	for _, module := range modules {
		if len(module) < 1 || len(module) > 40 {
			return nil, errors.New("each module must be between 1 and 40 characters")
		}
	}
	return modules, nil
}

func ParseIAMSetModulesInput(raw json.RawMessage) (IAMModulesInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IAMModulesInput{}, err
	}
	modules, err := iamParseModulesArray(fields)
	if err != nil {
		return IAMModulesInput{}, err
	}
	return IAMModulesInput{Modules: modules}, nil
}

func ParseIAMRestoreModulesInput(raw json.RawMessage) (IAMModulesInput, error) {
	return ParseIAMSetModulesInput(raw)
}

func ParseIAMSetModuleConfigInput(raw json.RawMessage) (IAMSetModuleConfigInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IAMSetModuleConfigInput{}, err
	}
	var input IAMSetModuleConfigInput
	if input.Module, err = requiredCRMDealString(fields, "module", 1, 40); err != nil {
		return IAMSetModuleConfigInput{}, err
	}
	rawSettings, ok := fields["settings"]
	if !ok {
		return IAMSetModuleConfigInput{}, errors.New("settings is required")
	}
	var settingsObject map[string]json.RawMessage
	if err := json.Unmarshal(rawSettings, &settingsObject); err != nil || settingsObject == nil {
		return IAMSetModuleConfigInput{}, errors.New("settings must be an object")
	}
	if input.Settings, err = parseIAMModuleSettings(input.Module, settingsObject); err != nil {
		return IAMSetModuleConfigInput{}, err
	}
	return input, nil
}

func parseIAMModuleSettings(module string, fields map[string]json.RawMessage) (json.RawMessage, error) {
	if module != "inventory" {
		return json.Marshal(fields)
	}

	settings := make(map[string]any, 2)
	if raw, ok := fields["defaultUnitLabel"]; ok {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, errors.New("defaultUnitLabel must be a string")
		}
		value = strings.TrimSpace(value)
		if utf16Length(value) < 1 || utf16Length(value) > 20 {
			return nil, errors.New("defaultUnitLabel must contain between 1 and 20 characters")
		}
		settings["defaultUnitLabel"] = value
	}
	if raw, ok := fields["defaultReorderPointUnits"]; ok {
		value, err := requiredSafeInteger(map[string]json.RawMessage{"value": raw}, "value")
		if err != nil || value < 0 || value > 1_000_000 {
			return nil, errors.New("defaultReorderPointUnits must be an integer between 0 and 1000000")
		}
		settings["defaultReorderPointUnits"] = value
	}
	return json.Marshal(settings)
}

func ParseIAMSetOrgPolicyInput(raw json.RawMessage) (IAMSetOrgPolicyInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IAMSetOrgPolicyInput{}, err
	}
	input := IAMSetOrgPolicyInput{RequiresApprovalFor: []string{}}
	if input.MaxRiskAutonomous, err = projectRequiredEnum(fields, "maxRiskAutonomous", []string{"read", "write", "money", "identity", "destructive"}); err != nil {
		return IAMSetOrgPolicyInput{}, err
	}
	if rawThreshold, ok := fields["moneyThresholdMinor"]; ok && string(rawThreshold) != "null" {
		threshold, err := requiredSafeInteger(fields, "moneyThresholdMinor")
		if err != nil {
			return IAMSetOrgPolicyInput{}, err
		}
		if threshold < 0 || threshold > 1_000_000_000 {
			return IAMSetOrgPolicyInput{}, errors.New("moneyThresholdMinor must be between 0 and 1000000000")
		}
		input.MoneyThresholdMinor = &threshold
	}
	if rawRequires, ok := fields["requiresApprovalFor"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawRequires), []byte("null")) {
			return IAMSetOrgPolicyInput{}, errors.New("requiresApprovalFor must be an array of strings")
		}
		var requires []string
		if err := json.Unmarshal(rawRequires, &requires); err != nil {
			return IAMSetOrgPolicyInput{}, errors.New("requiresApprovalFor must be an array of strings")
		}
		if len(requires) > 4 {
			return IAMSetOrgPolicyInput{}, errors.New("requiresApprovalFor must have at most 4 items")
		}
		for _, entry := range requires {
			switch entry {
			case "identity", "destructive", "money", "*":
			default:
				return IAMSetOrgPolicyInput{}, errors.New("requiresApprovalFor accepts identity, destructive, money or *")
			}
		}
		input.RequiresApprovalFor = requires
	}
	return input, nil
}

func ParseIAMSetOrgBrandingInput(raw json.RawMessage) (IAMSetOrgBrandingInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IAMSetOrgBrandingInput{}, err
	}
	var input IAMSetOrgBrandingInput
	if rawLogo, ok := fields["logoDataUrl"]; ok && string(rawLogo) != "null" {
		var logo string
		if err := json.Unmarshal(rawLogo, &logo); err != nil {
			return IAMSetOrgBrandingInput{}, errors.New("logoDataUrl must be a string")
		}
		if len(logo) > 300_000 {
			return IAMSetOrgBrandingInput{}, errors.New("logoDataUrl must be at most 300000 characters")
		}
		if !iamLogoDataURLPattern.MatchString(logo) {
			return IAMSetOrgBrandingInput{}, errors.New("logoDataUrl must be a base64 image data URL")
		}
		input.LogoDataURL = &logo
	}
	if rawAccent, ok := fields["accentColor"]; ok && string(rawAccent) != "null" {
		var accent string
		if err := json.Unmarshal(rawAccent, &accent); err != nil {
			return IAMSetOrgBrandingInput{}, errors.New("accentColor must be a string")
		}
		if !iamAccentColorPattern.MatchString(accent) {
			return IAMSetOrgBrandingInput{}, errors.New("accentColor must be a hex color")
		}
		input.AccentColor = &accent
	}
	if rawFooter, ok := fields["invoiceFooter"]; ok && string(rawFooter) != "null" {
		var footer string
		if err := json.Unmarshal(rawFooter, &footer); err != nil {
			return IAMSetOrgBrandingInput{}, errors.New("invoiceFooter must be a string")
		}
		if len(footer) > 300 {
			return IAMSetOrgBrandingInput{}, errors.New("invoiceFooter must be at most 300 characters")
		}
		input.InvoiceFooter = &footer
	}
	if rawLayout, ok := fields["layout"]; ok && string(rawLayout) != "null" {
		var layout string
		if err := json.Unmarshal(rawLayout, &layout); err != nil {
			return IAMSetOrgBrandingInput{}, errors.New("layout must be a string")
		}
		if layout != "classic" && layout != "modern" {
			return IAMSetOrgBrandingInput{}, errors.New("layout must be classic or modern")
		}
		input.Layout = &layout
	}
	return input, nil
}

func parseIAMOrgSettingsInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case iamSetModulesCapabilityID:
		return ParseIAMSetModulesInput(raw)
	case iamRestoreModulesCapabilityID:
		return ParseIAMRestoreModulesInput(raw)
	case iamSetModuleConfigCapabilityID:
		return ParseIAMSetModuleConfigInput(raw)
	case iamSetOrgPolicyCapabilityID:
		return ParseIAMSetOrgPolicyInput(raw)
	case iamSetOrgBrandingCapabilityID:
		return ParseIAMSetOrgBrandingInput(raw)
	default:
		return nil, errors.New("unsupported IAM org settings capability")
	}
}

func iamCurrentEnabledModules(ctx context.Context, tx pgx.Tx, orgID string) ([]string, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT enabled_modules FROM organizations WHERE id=$1::uuid`, orgID).Scan(&raw)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return []string{}, nil
	}
	var modules []string
	if err := json.Unmarshal(raw, &modules); err != nil {
		return []string{}, nil
	}
	return modules, nil
}

func iamSetEnabledModules(ctx context.Context, tx pgx.Tx, orgID string, modules []string) error {
	encoded, err := json.Marshal(modules)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE organizations SET enabled_modules=$2::jsonb WHERE id=$1::uuid`, orgID, string(encoded))
	return err
}

func iamSetModules(ctx context.Context, tx pgx.Tx, orgID string, input IAMModulesInput) (IAMSetModulesOutput, error) {
	previous, err := iamCurrentEnabledModules(ctx, tx, orgID)
	if err != nil {
		return IAMSetModulesOutput{}, err
	}
	next := iamModulesUnion(input.Modules)
	if err := iamSetEnabledModules(ctx, tx, orgID, next); err != nil {
		return IAMSetModulesOutput{}, err
	}
	return IAMSetModulesOutput{EnabledModules: next, PreviousModules: previous}, nil
}

func iamRestoreModules(ctx context.Context, tx pgx.Tx, orgID string, input IAMModulesInput) (IAMRestoreModulesOutput, error) {
	next := iamModulesUnion(input.Modules)
	if err := iamSetEnabledModules(ctx, tx, orgID, next); err != nil {
		return IAMRestoreModulesOutput{}, err
	}
	return IAMRestoreModulesOutput{EnabledModules: next}, nil
}

func iamSetModuleConfig(ctx context.Context, tx pgx.Tx, orgID string, input IAMSetModuleConfigInput) (IAMSetModuleConfigOutput, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO module_settings (org_id, module, settings, updated_at)
		VALUES ($1::uuid, $2, $3::jsonb, $4)
		ON CONFLICT (org_id, module) DO UPDATE SET settings=$3::jsonb, updated_at=$4`,
		orgID, input.Module, string(input.Settings), time.Now()); err != nil {
		return IAMSetModuleConfigOutput{}, err
	}
	return IAMSetModuleConfigOutput{Module: input.Module, Settings: input.Settings}, nil
}

func iamSetOrgPolicy(ctx context.Context, tx pgx.Tx, orgID string, input IAMSetOrgPolicyInput) (IAMSetOrgPolicyOutput, error) {
	requiresJSON, err := json.Marshal(input.RequiresApprovalFor)
	if err != nil {
		return IAMSetOrgPolicyOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for, updated_at)
		VALUES ($1::uuid, '*', $2, $3, $4::jsonb, $5)
		ON CONFLICT (org_id, capability_pattern) DO UPDATE SET
			max_risk_autonomous=$2, money_threshold_minor=$3, requires_approval_for=$4::jsonb, updated_at=$5`,
		orgID, input.MaxRiskAutonomous, input.MoneyThresholdMinor, string(requiresJSON), time.Now()); err != nil {
		return IAMSetOrgPolicyOutput{}, err
	}
	return IAMSetOrgPolicyOutput{Saved: true}, nil
}

func iamSetOrgBranding(ctx context.Context, tx pgx.Tx, orgID string, input IAMSetOrgBrandingInput, now time.Time) (IAMSetOrgBrandingOutput, error) {
	var existingLogo, existingAccent, existingFooter *string
	var existingLayout *string
	err := tx.QueryRow(ctx, `
		SELECT logo_data_url, accent_color, invoice_footer, layout FROM org_branding WHERE org_id=$1::uuid LIMIT 1`,
		orgID).Scan(&existingLogo, &existingAccent, &existingFooter, &existingLayout)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return IAMSetOrgBrandingOutput{}, err
	}
	merge := func(incoming *string, existing *string) *string {
		if incoming != nil {
			return incoming
		}
		return existing
	}
	logo := merge(input.LogoDataURL, existingLogo)
	accent := merge(input.AccentColor, existingAccent)
	footer := merge(input.InvoiceFooter, existingFooter)
	layout := merge(input.Layout, existingLayout)
	if layout == nil {
		classic := "classic"
		layout = &classic
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO org_branding (org_id, logo_data_url, accent_color, invoice_footer, layout, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6)
		ON CONFLICT (org_id) DO UPDATE SET
			logo_data_url=$2, accent_color=$3, invoice_footer=$4, layout=$5, updated_at=$6`,
		orgID, logo, accent, footer, layout, now); err != nil {
		return IAMSetOrgBrandingOutput{}, err
	}
	return IAMSetOrgBrandingOutput{Saved: true}, nil
}
