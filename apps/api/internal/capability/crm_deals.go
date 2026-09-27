package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createDealCapabilityID    = "crm.createDeal"
	moveDealStageCapabilityID = "crm.moveDealStage"
	convertLeadCapabilityID   = "crm.convertLead"
)

var crmDealStages = map[string]struct{}{
	"lead": {}, "qualified": {}, "proposal": {}, "negotiation": {}, "won": {}, "lost": {},
}

type CreateDealInput struct {
	Title       string  `json:"title"`
	CustomerID  *string `json:"customerId,omitempty"`
	ValueMinor  int64   `json:"valueMinor"`
	Source      *string `json:"source,omitempty"`
	OwnerUserID *string `json:"ownerUserId,omitempty"`
	Note        *string `json:"note,omitempty"`
}

type CreateDealOutput struct {
	DealID string `json:"dealId"`
}

type MoveDealStageInput struct {
	DealID     string  `json:"dealId"`
	Stage      string  `json:"stage"`
	LostReason *string `json:"lostReason,omitempty"`
}

type MoveDealStageOutput struct {
	Moved bool   `json:"moved"`
	Stage string `json:"stage"`
}

type ConvertLeadInput struct {
	DealID         string  `json:"dealId"`
	CreateCustomer *bool   `json:"createCustomer,omitempty"`
	CustomerName   *string `json:"customerName,omitempty"`
	CustomerID     *string `json:"customerId,omitempty"`
}

type ConvertLeadOutput struct {
	DealID     string `json:"dealId"`
	CustomerID string `json:"customerId"`
	Stage      string `json:"stage"`
}

func parseCRMDealInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createDealCapabilityID:
		return ParseCreateDealInput(raw)
	case moveDealStageCapabilityID:
		return ParseMoveDealStageInput(raw)
	case convertLeadCapabilityID:
		return ParseConvertLeadInput(raw)
	default:
		return nil, errors.New("unsupported CRM deal capability")
	}
}

func ParseCreateDealInput(raw json.RawMessage) (CreateDealInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateDealInput{}, err
	}
	title, err := requiredCRMDealString(fields, "title", 1, 0)
	if err != nil {
		return CreateDealInput{}, err
	}
	input := CreateDealInput{Title: title}
	input.CustomerID, err = optionalCRMDealString(fields, "customerId", 0, false)
	if err != nil {
		return CreateDealInput{}, err
	}
	if _, ok := fields["valueMinor"]; ok {
		input.ValueMinor, err = requiredSafeInteger(fields, "valueMinor")
		if err != nil || input.ValueMinor < 0 {
			return CreateDealInput{}, errors.New("valueMinor must be a non-negative integer")
		}
	}
	input.Source, err = optionalCRMDealString(fields, "source", 200, false)
	if err != nil {
		return CreateDealInput{}, err
	}
	input.OwnerUserID, err = optionalCRMDealString(fields, "ownerUserId", 0, false)
	if err != nil {
		return CreateDealInput{}, err
	}
	if input.OwnerUserID != nil && !projectUUIDPattern.MatchString(*input.OwnerUserID) {
		return CreateDealInput{}, errors.New("ownerUserId must be a valid UUID")
	}
	input.Note, err = optionalCRMDealString(fields, "note", 2000, false)
	if err != nil {
		return CreateDealInput{}, err
	}
	return input, nil
}

func ParseMoveDealStageInput(raw json.RawMessage) (MoveDealStageInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MoveDealStageInput{}, err
	}
	dealID, err := requiredCRMDealString(fields, "dealId", 0, 0)
	if err != nil {
		return MoveDealStageInput{}, err
	}
	stage, err := requiredCRMDealString(fields, "stage", 1, 0)
	if err != nil {
		return MoveDealStageInput{}, err
	}
	if _, ok := crmDealStages[stage]; !ok {
		return MoveDealStageInput{}, errors.New("stage is invalid")
	}
	lostReason, err := optionalCRMDealString(fields, "lostReason", 500, true)
	if err != nil {
		return MoveDealStageInput{}, err
	}
	if lostReason != nil && utf16Length(*lostReason) < 3 {
		return MoveDealStageInput{}, errors.New("lostReason must contain at least 3 characters")
	}
	if stage == "lost" && (lostReason == nil || utf16Length(*lostReason) < 3) {
		return MoveDealStageInput{}, errors.New("Add a short reason before marking this deal lost")
	}
	return MoveDealStageInput{DealID: dealID, Stage: stage, LostReason: lostReason}, nil
}

func ParseConvertLeadInput(raw json.RawMessage) (ConvertLeadInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ConvertLeadInput{}, err
	}
	dealID, err := requiredCRMDealString(fields, "dealId", 0, 0)
	if err != nil {
		return ConvertLeadInput{}, err
	}
	input := ConvertLeadInput{DealID: dealID}
	if rawCreateCustomer, ok := fields["createCustomer"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawCreateCustomer), []byte("null")) {
			return ConvertLeadInput{}, errors.New("createCustomer must be a boolean")
		}
		var createCustomer bool
		if err := json.Unmarshal(rawCreateCustomer, &createCustomer); err != nil {
			return ConvertLeadInput{}, errors.New("createCustomer must be a boolean")
		}
		input.CreateCustomer = &createCustomer
	}
	input.CustomerName, err = optionalCRMDealString(fields, "customerName", 0, false)
	if err != nil {
		return ConvertLeadInput{}, err
	}
	if input.CustomerName != nil && utf16Length(*input.CustomerName) < 1 {
		return ConvertLeadInput{}, errors.New("customerName must contain at least 1 character")
	}
	input.CustomerID, err = optionalCRMDealString(fields, "customerId", 0, false)
	if err != nil {
		return ConvertLeadInput{}, err
	}
	return input, nil
}

func requiredCRMDealString(fields map[string]json.RawMessage, key string, minLength, maxLength int) (string, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", fmt.Errorf("%s is required", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	length := utf16Length(value)
	if length < minLength {
		return "", fmt.Errorf("%s must contain at least %d character(s)", key, minLength)
	}
	if maxLength > 0 && length > maxLength {
		return "", fmt.Errorf("%s must be at most %d characters", key, maxLength)
	}
	return value, nil
}

func optionalCRMDealString(fields map[string]json.RawMessage, key string, maxLength int, trim bool) (*string, error) {
	value, err := optionalString(fields, key)
	if err != nil || value == nil {
		return value, err
	}
	if trim {
		trimmed := strings.TrimFunc(*value, isJSWhitespace)
		value = &trimmed
	}
	if maxLength > 0 && utf16Length(*value) > maxLength {
		return nil, fmt.Errorf("%s must be at most %d characters", key, maxLength)
	}
	return value, nil
}

func createDeal(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateDealInput) (CreateDealOutput, error) {
	if input.CustomerID != nil {
		var owned bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM customers WHERE id = $1::uuid AND org_id = $2::uuid
			)`, *input.CustomerID, claims.OrganizationID).Scan(&owned); err != nil {
			return CreateDealOutput{}, err
		}
		if !owned {
			return CreateDealOutput{}, errors.New("customer not found in this organization")
		}
	}
	var createdByUserID *string
	if claims.ActorType == "human" {
		createdByUserID = claims.ActorID
	}
	var dealID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO deals (
			org_id, title, customer_id, value_minor, source, owner_user_id,
			note, created_by_user_id
		)
		VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7, $8::uuid)
		RETURNING id::text`, claims.OrganizationID, input.Title, input.CustomerID,
		input.ValueMinor, input.Source, input.OwnerUserID, input.Note, createdByUserID).Scan(&dealID); err != nil {
		return CreateDealOutput{}, err
	}
	return CreateDealOutput{DealID: dealID}, nil
}

func moveDealStage(ctx context.Context, tx pgx.Tx, orgID string, input MoveDealStageInput, now time.Time) (MoveDealStageOutput, error) {
	var lostReason *string
	if input.Stage == "lost" {
		lostReason = input.LostReason
	}
	_, err := tx.Exec(ctx, `
		UPDATE deals
		SET stage = $3, updated_at = $4, lost_reason = $5
		WHERE id = $1::uuid AND org_id = $2::uuid`, input.DealID, orgID, input.Stage, now, lostReason)
	if err != nil {
		return MoveDealStageOutput{}, err
	}
	return MoveDealStageOutput{Moved: true, Stage: input.Stage}, nil
}

func convertLead(ctx context.Context, tx pgx.Tx, orgID string, input ConvertLeadInput, now time.Time) (ConvertLeadOutput, error) {
	var dealID, dealTitle, dealStage string
	err := tx.QueryRow(ctx, `
		SELECT id::text, title, stage
		FROM deals
		WHERE id = $1::uuid AND org_id = $2::uuid
		FOR UPDATE`, input.DealID, orgID).Scan(&dealID, &dealTitle, &dealStage)
	if errors.Is(err, pgx.ErrNoRows) {
		return ConvertLeadOutput{}, errors.New("deal not found")
	}
	if err != nil {
		return ConvertLeadOutput{}, err
	}
	if dealStage != "lead" {
		return ConvertLeadOutput{}, fmt.Errorf("deal is %s; only lead-stage deals convert", dealStage)
	}
	var customerID *string
	if input.CustomerID != nil {
		var owned bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM customers WHERE id = $1::uuid AND org_id = $2::uuid
			)`, *input.CustomerID, orgID).Scan(&owned); err != nil {
			return ConvertLeadOutput{}, err
		}
		if !owned {
			return ConvertLeadOutput{}, errors.New("customer not found in this organization")
		}
		customerID = input.CustomerID
	} else if input.CustomerName != nil || input.CreateCustomer != nil && *input.CreateCustomer {
		customerName := dealTitle
		if input.CustomerName != nil {
			customerName = *input.CustomerName
		}
		var createdCustomerID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO customers (org_id, name)
			VALUES ($1::uuid, $2)
			RETURNING id::text`, orgID, customerName).Scan(&createdCustomerID); err != nil {
			return ConvertLeadOutput{}, err
		}
		customerID = &createdCustomerID
	}
	if customerID == nil {
		return ConvertLeadOutput{}, errors.New("pass customerId, or createCustomer true, so the deal has a customer to attach to")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE deals
		SET stage = 'qualified', customer_id = $3::uuid, updated_at = $4
		WHERE id = $1::uuid AND org_id = $2::uuid`, dealID, orgID, *customerID, now); err != nil {
		return ConvertLeadOutput{}, err
	}
	return ConvertLeadOutput{DealID: dealID, CustomerID: *customerID, Stage: "qualified"}, nil
}
