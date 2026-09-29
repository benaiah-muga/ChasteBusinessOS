package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createTaxProfileCapabilityID = "accounting.createTaxProfile"
	removeTaxProfileCapabilityID = "accounting.removeTaxProfile"
	createTaxCodeCapabilityID    = "accounting.createTaxCode"
	archiveTaxCodeCapabilityID   = "accounting.archiveTaxCode"
	activateTaxCodeCapabilityID  = "accounting.activateTaxCode"
)

var (
	taxJurisdictionPattern = regexp.MustCompile(`^[A-Z]{2}(-[A-Z0-9]{1,8})?$`)
	taxCodeIDPattern       = regexp.MustCompile(`^[A-Z0-9_-]+$`)
)

type CreateTaxProfileInput struct {
	JurisdictionCode   string  `json:"jurisdictionCode"`
	RegistrationNumber *string `json:"registrationNumber,omitempty"`
	FilingFrequency    string  `json:"filingFrequency"`
}

type CreateTaxProfileOutput struct {
	ProfileID          string  `json:"profileId"`
	JurisdictionCode   string  `json:"jurisdictionCode"`
	RegistrationNumber *string `json:"registrationNumber"`
	FilingFrequency    string  `json:"filingFrequency"`
}

type RemoveTaxProfileInput struct {
	ProfileID string `json:"profileId"`
}

type RemoveTaxProfileOutput struct {
	JurisdictionCode   string  `json:"jurisdictionCode"`
	RegistrationNumber *string `json:"registrationNumber"`
	FilingFrequency    string  `json:"filingFrequency"`
}

type CreateTaxCodeInput struct {
	Code             string `json:"code"`
	Name             string `json:"name"`
	Direction        string `json:"direction"`
	RateBasisPoints  int64  `json:"rateBasisPoints"`
	PriceIncludesTax bool   `json:"priceIncludesTax"`
	Recoverable      bool   `json:"recoverable"`
}

type CreateTaxCodeOutput struct {
	TaxCodeID        string `json:"taxCodeId"`
	Code             string `json:"code"`
	JurisdictionCode string `json:"jurisdictionCode"`
	Direction        string `json:"direction"`
	RateBasisPoints  int64  `json:"rateBasisPoints"`
}

type ArchiveTaxCodeInput struct {
	TaxCodeID string `json:"taxCodeId"`
}

type ArchiveTaxCodeOutput struct {
	TaxCodeID string `json:"taxCodeId"`
}

type ActivateTaxCodeInput struct {
	TaxCodeID string `json:"taxCodeId"`
}

type ActivateTaxCodeOutput struct {
	TaxCodeID string `json:"taxCodeId"`
}

func parseAccountingTaxMasterInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createTaxProfileCapabilityID:
		return ParseCreateTaxProfileInput(raw)
	case removeTaxProfileCapabilityID:
		return ParseRemoveTaxProfileInput(raw)
	case createTaxCodeCapabilityID:
		return ParseCreateTaxCodeInput(raw)
	case archiveTaxCodeCapabilityID:
		return ParseArchiveTaxCodeInput(raw)
	case activateTaxCodeCapabilityID:
		return ParseActivateTaxCodeInput(raw)
	default:
		return nil, errors.New("unsupported accounting tax master capability")
	}
}

func ParseCreateTaxProfileInput(raw json.RawMessage) (CreateTaxProfileInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateTaxProfileInput{}, err
	}
	var input CreateTaxProfileInput
	if input.JurisdictionCode, err = requiredString(fields, "jurisdictionCode"); err != nil {
		return CreateTaxProfileInput{}, err
	}
	if !taxJurisdictionPattern.MatchString(input.JurisdictionCode) {
		return CreateTaxProfileInput{}, errors.New("jurisdictionCode must match ^[A-Z]{2}(-[A-Z0-9]{1,8})?$")
	}
	if input.RegistrationNumber, err = optionalString(fields, "registrationNumber"); err != nil {
		return CreateTaxProfileInput{}, err
	} else if input.RegistrationNumber != nil && utf16Length(*input.RegistrationNumber) > 100 {
		return CreateTaxProfileInput{}, errors.New("registrationNumber must contain at most 100 characters")
	}
	if input.FilingFrequency, err = projectRequiredEnum(fields, "filingFrequency", []string{"monthly", "quarterly", "annual"}); err != nil {
		return CreateTaxProfileInput{}, err
	}
	return input, nil
}

func ParseRemoveTaxProfileInput(raw json.RawMessage) (RemoveTaxProfileInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RemoveTaxProfileInput{}, err
	}
	var input RemoveTaxProfileInput
	if input.ProfileID, err = requiredString(fields, "profileId"); err != nil {
		return RemoveTaxProfileInput{}, err
	}
	if !isZodUUID(input.ProfileID) {
		return RemoveTaxProfileInput{}, errors.New("profileId must be a UUID")
	}
	return input, nil
}

func ParseCreateTaxCodeInput(raw json.RawMessage) (CreateTaxCodeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateTaxCodeInput{}, err
	}
	var input CreateTaxCodeInput
	if input.Code, err = requiredString(fields, "code"); err != nil {
		return CreateTaxCodeInput{}, err
	}
	if length := utf16Length(input.Code); length < 1 || length > 24 {
		return CreateTaxCodeInput{}, errors.New("code must contain between 1 and 24 characters")
	}
	if !taxCodeIDPattern.MatchString(input.Code) {
		return CreateTaxCodeInput{}, errors.New("code must match ^[A-Z0-9_-]+$")
	}
	if input.Name, err = requiredString(fields, "name"); err != nil {
		return CreateTaxCodeInput{}, err
	}
	if length := utf16Length(input.Name); length < 2 || length > 100 {
		return CreateTaxCodeInput{}, errors.New("name must contain between 2 and 100 characters")
	}
	if input.Direction, err = projectRequiredEnum(fields, "direction", []string{"output", "input"}); err != nil {
		return CreateTaxCodeInput{}, err
	}
	if input.RateBasisPoints, err = requiredSafeInteger(fields, "rateBasisPoints"); err != nil || input.RateBasisPoints < 0 || input.RateBasisPoints > 1_000_000 {
		return CreateTaxCodeInput{}, errors.New("rateBasisPoints must be an integer between 0 and 1000000")
	}
	if input.PriceIncludesTax, err = taxMasterBooleanWithDefault(fields, "priceIncludesTax", false); err != nil {
		return CreateTaxCodeInput{}, err
	}
	if input.Recoverable, err = taxMasterBooleanWithDefault(fields, "recoverable", true); err != nil {
		return CreateTaxCodeInput{}, err
	}
	return input, nil
}

func ParseArchiveTaxCodeInput(raw json.RawMessage) (ArchiveTaxCodeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ArchiveTaxCodeInput{}, err
	}
	var input ArchiveTaxCodeInput
	if input.TaxCodeID, err = requiredString(fields, "taxCodeId"); err != nil {
		return ArchiveTaxCodeInput{}, err
	}
	if !isZodUUID(input.TaxCodeID) {
		return ArchiveTaxCodeInput{}, errors.New("taxCodeId must be a UUID")
	}
	return input, nil
}

func ParseActivateTaxCodeInput(raw json.RawMessage) (ActivateTaxCodeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ActivateTaxCodeInput{}, err
	}
	var input ActivateTaxCodeInput
	if input.TaxCodeID, err = requiredString(fields, "taxCodeId"); err != nil {
		return ActivateTaxCodeInput{}, err
	}
	if !isZodUUID(input.TaxCodeID) {
		return ActivateTaxCodeInput{}, errors.New("taxCodeId must be a UUID")
	}
	return input, nil
}

func taxMasterBooleanWithDefault(fields map[string]json.RawMessage, key string, fallback bool) (bool, error) {
	raw, ok := fields[key]
	if !ok {
		return fallback, nil
	}
	var value bool
	if bytesIsNull(raw) || json.Unmarshal(raw, &value) != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return value, nil
}

func executeCreateTaxProfile(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateTaxProfileInput) (CreateTaxProfileOutput, error) {
	orgID := claims.OrganizationID
	var existingID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM tax_profiles WHERE org_id = $1::uuid LIMIT 1`, orgID).Scan(&existingID)
	if err == nil {
		return CreateTaxProfileOutput{}, errors.New("a tax profile is already set; use the Settings workflow to change it after existing tax codes and returns are reviewed")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CreateTaxProfileOutput{}, err
	}
	var profileID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO tax_profiles (org_id, jurisdiction_code, registration_number, filing_frequency, provider_mode)
		VALUES ($1::uuid, $2, $3, $4, 'manual')
		RETURNING id::text`, orgID, input.JurisdictionCode, input.RegistrationNumber, input.FilingFrequency).Scan(&profileID); err != nil {
		return CreateTaxProfileOutput{}, err
	}
	return CreateTaxProfileOutput{
		ProfileID:          profileID,
		JurisdictionCode:   input.JurisdictionCode,
		RegistrationNumber: input.RegistrationNumber,
		FilingFrequency:    input.FilingFrequency,
	}, nil
}

func executeRemoveTaxProfile(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RemoveTaxProfileInput) (RemoveTaxProfileOutput, error) {
	orgID := claims.OrganizationID
	var profile RemoveTaxProfileOutput
	err := tx.QueryRow(ctx, `
		SELECT jurisdiction_code, registration_number, filing_frequency
		FROM tax_profiles
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.ProfileID, orgID).Scan(&profile.JurisdictionCode, &profile.RegistrationNumber, &profile.FilingFrequency)
	if errors.Is(err, pgx.ErrNoRows) {
		return RemoveTaxProfileOutput{}, errors.New("tax profile not found")
	}
	if err != nil {
		return RemoveTaxProfileOutput{}, err
	}
	var codeCount, returnCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tax_codes WHERE org_id = $1::uuid`, orgID).Scan(&codeCount); err != nil {
		return RemoveTaxProfileOutput{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tax_returns WHERE org_id = $1::uuid`, orgID).Scan(&returnCount); err != nil {
		return RemoveTaxProfileOutput{}, err
	}
	if codeCount > 0 || returnCount > 0 {
		return RemoveTaxProfileOutput{}, errors.New("tax profiles with codes or return history must be retained for audit")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tax_profiles WHERE id = $1::uuid`, input.ProfileID); err != nil {
		return RemoveTaxProfileOutput{}, err
	}
	return profile, nil
}

func executeCreateTaxCode(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateTaxCodeInput) (CreateTaxCodeOutput, error) {
	orgID := claims.OrganizationID
	var jurisdiction string
	err := tx.QueryRow(ctx, `SELECT jurisdiction_code FROM tax_profiles WHERE org_id = $1::uuid LIMIT 1`, orgID).Scan(&jurisdiction)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateTaxCodeOutput{}, errors.New("set a tax jurisdiction before creating tax codes")
	}
	if err != nil {
		return CreateTaxCodeOutput{}, err
	}
	recoverable := input.Direction == "input" && input.Recoverable
	var taxCodeID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO tax_codes (org_id, jurisdiction_code, code, name, direction, rate_basis_points, price_includes_tax, recoverable)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id::text`, orgID, jurisdiction, input.Code, input.Name, input.Direction, input.RateBasisPoints, input.PriceIncludesTax, recoverable).Scan(&taxCodeID); err != nil {
		return CreateTaxCodeOutput{}, err
	}
	return CreateTaxCodeOutput{
		TaxCodeID:        taxCodeID,
		Code:             input.Code,
		JurisdictionCode: jurisdiction,
		Direction:        input.Direction,
		RateBasisPoints:  input.RateBasisPoints,
	}, nil
}

func executeArchiveTaxCode(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ArchiveTaxCodeInput) (ArchiveTaxCodeOutput, error) {
	var taxCodeID string
	err := tx.QueryRow(ctx, `
		UPDATE tax_codes SET active = false
		WHERE id = $1::uuid AND org_id = $2::uuid AND active = true
		RETURNING id::text`, input.TaxCodeID, claims.OrganizationID).Scan(&taxCodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ArchiveTaxCodeOutput{}, errors.New("active tax code not found")
	}
	if err != nil {
		return ArchiveTaxCodeOutput{}, err
	}
	return ArchiveTaxCodeOutput{TaxCodeID: taxCodeID}, nil
}

func executeActivateTaxCode(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ActivateTaxCodeInput) (ActivateTaxCodeOutput, error) {
	var taxCodeID string
	err := tx.QueryRow(ctx, `
		UPDATE tax_codes SET active = true
		WHERE id = $1::uuid AND org_id = $2::uuid AND active = false
		RETURNING id::text`, input.TaxCodeID, claims.OrganizationID).Scan(&taxCodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ActivateTaxCodeOutput{}, errors.New("archived tax code not found")
	}
	if err != nil {
		return ActivateTaxCodeOutput{}, err
	}
	return ActivateTaxCodeOutput{TaxCodeID: taxCodeID}, nil
}
