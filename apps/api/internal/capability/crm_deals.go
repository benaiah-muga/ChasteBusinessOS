package capability

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createDealCapabilityID            = "crm.createDeal"
	moveDealStageCapabilityID         = "crm.moveDealStage"
	convertLeadCapabilityID           = "crm.convertLead"
	undoLeadConversionCapabilityID    = "crm.undoLeadConversion"
	reapplyLeadConversionCapabilityID = "crm.reapplyLeadConversion"
)

type ListDealsInput struct{}

type CRMDealRow struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Stage        string  `json:"stage"`
	ValueMinor   int64   `json:"valueMinor"`
	Note         *string `json:"note"`
	CustomerID   *string `json:"customerId"`
	CustomerName *string `json:"customerName"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

type ListDealsOutput struct {
	Deals []CRMDealRow `json:"deals"`
}

func ParseListDealsInput(raw json.RawMessage) (ListDealsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListDealsInput{}, err
	}
	return ListDealsInput{}, nil
}

func listDeals(ctx context.Context, tx pgx.Tx, orgID string) (ListDealsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT d.id::text, d.title, d.stage, d.value_minor, d.note,
		       d.customer_id::text, c.name, d.created_at, d.updated_at
		FROM deals d
		LEFT JOIN customers c ON c.id = d.customer_id AND c.org_id = d.org_id
		WHERE d.org_id = $1::uuid
		LIMIT 200`, orgID)
	if err != nil {
		return ListDealsOutput{}, err
	}
	defer rows.Close()
	deals := make([]CRMDealRow, 0)
	for rows.Next() {
		var deal CRMDealRow
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&deal.ID, &deal.Title, &deal.Stage, &deal.ValueMinor, &deal.Note,
			&deal.CustomerID, &deal.CustomerName, &createdAt, &updatedAt); err != nil {
			return ListDealsOutput{}, err
		}
		deal.CreatedAt = createdAt.UTC().Format("2006-01-02T15:04:05.000Z")
		deal.UpdatedAt = updatedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		deals = append(deals, deal)
	}
	return ListDealsOutput{Deals: deals}, rows.Err()
}

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
	DealID             string `json:"dealId"`
	CustomerID         string `json:"customerId"`
	ConversionIntentID string `json:"conversionIntentId"`
	Stage              string `json:"stage"`
}

type leadConversionSnapshot struct {
	DealID                     string          `json:"dealId"`
	CustomerID                 string          `json:"customerId"`
	ConversionIntentID         string          `json:"conversionIntentId"`
	Stage                      string          `json:"stage"`
	PreviousStage              string          `json:"previousStage"`
	PreviousCustomerID         *string         `json:"previousCustomerId"`
	CreatedCustomer            bool            `json:"createdCustomer"`
	CreatedCustomerFingerprint string          `json:"createdCustomerFingerprint,omitempty"`
	CreatedCustomerRow         json.RawMessage `json:"createdCustomerRow,omitempty"`
	ConversionUpdatedAt        time.Time       `json:"conversionUpdatedAt"`
}

type leadConversionUndoSnapshot struct {
	Conversion    leadConversionSnapshot `json:"conversion"`
	UndoUpdatedAt time.Time              `json:"undoUpdatedAt"`
}

type createdCRMCustomerSnapshot struct {
	ID                     string     `json:"id"`
	OrgID                  string     `json:"org_id"`
	Name                   string     `json:"name"`
	Email                  *string    `json:"email"`
	Phone                  *string    `json:"phone"`
	PreferredContactMethod string     `json:"preferred_contact_method"`
	DoNotContact           bool       `json:"do_not_contact"`
	OwnerUserID            *string    `json:"owner_user_id"`
	UpdatedByUserID        *string    `json:"updated_by_user_id"`
	Tags                   []string   `json:"tags"`
	Notes                  *string    `json:"notes"`
	CreditLimitMinor       *int32     `json:"credit_limit_minor"`
	PaymentTermDays        *int32     `json:"payment_term_days"`
	ReminderOptOut         bool       `json:"reminder_opt_out"`
	MarketingOptOut        bool       `json:"marketing_opt_out"`
	MergedIntoCustomerID   *string    `json:"merged_into_customer_id"`
	MergedAt               *time.Time `json:"merged_at"`
	DeactivatedAt          *time.Time `json:"deactivated_at"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

type ReapplyLeadConversionInput struct {
	UndoIntentID string `json:"undoIntentId"`
}

type ReapplyLeadConversionOutput struct {
	Reapplied          bool   `json:"reapplied"`
	DealID             string `json:"dealId"`
	CustomerID         string `json:"customerId"`
	ConversionIntentID string `json:"conversionIntentId"`
}

type UndoLeadConversionInput struct {
	ConversionIntentID string `json:"conversionIntentId"`
}

type UndoLeadConversionOutput struct {
	Undone             bool   `json:"undone"`
	DealID             string `json:"dealId"`
	CustomerDeleted    bool   `json:"customerDeleted"`
	ConversionIntentID string `json:"conversionIntentId"`
	UndoIntentID       string `json:"undoIntentId"`
}

func parseCRMDealInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createDealCapabilityID:
		return ParseCreateDealInput(raw)
	case moveDealStageCapabilityID:
		return ParseMoveDealStageInput(raw)
	case convertLeadCapabilityID:
		return ParseConvertLeadInput(raw)
	case undoLeadConversionCapabilityID:
		return ParseUndoLeadConversionInput(raw)
	case reapplyLeadConversionCapabilityID:
		return ParseReapplyLeadConversionInput(raw)
	default:
		return nil, errors.New("unsupported CRM deal capability")
	}
}

func ParseCreateDealInput(raw json.RawMessage) (CreateDealInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateDealInput{}, err
	}
	title, err := requiredCRMDealString(fields, "title", 1, 120)
	if err != nil {
		return CreateDealInput{}, err
	}
	input := CreateDealInput{Title: title}
	input.CustomerID, err = optionalCRMDealString(fields, "customerId", 0, false)
	if err != nil {
		return CreateDealInput{}, err
	}
	if input.CustomerID != nil && !projectUUIDPattern.MatchString(*input.CustomerID) {
		return CreateDealInput{}, errors.New("customerId must be a valid UUID")
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
	if !projectUUIDPattern.MatchString(dealID) {
		return MoveDealStageInput{}, errors.New("dealId must be a valid UUID")
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
	if !projectUUIDPattern.MatchString(dealID) {
		return ConvertLeadInput{}, errors.New("dealId must be a valid UUID")
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
	input.CustomerName, err = optionalCRMDealString(fields, "customerName", 0, true)
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
	if input.CustomerID != nil && !projectUUIDPattern.MatchString(*input.CustomerID) {
		return ConvertLeadInput{}, errors.New("customerId must be a valid UUID")
	}
	if input.CustomerID != nil {
		if input.CreateCustomer != nil || input.CustomerName != nil {
			return ConvertLeadInput{}, errors.New("choose either customerId or createCustomer with customerName")
		}
	} else if input.CreateCustomer == nil || !*input.CreateCustomer || input.CustomerName == nil || utf16Length(*input.CustomerName) < 1 {
		return ConvertLeadInput{}, errors.New("choose either customerId or createCustomer with customerName")
	}
	return input, nil
}

func ParseUndoLeadConversionInput(raw json.RawMessage) (UndoLeadConversionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return UndoLeadConversionInput{}, err
	}
	intentID, err := requiredCRMDealString(fields, "conversionIntentId", 1, 160)
	if err != nil {
		return UndoLeadConversionInput{}, err
	}
	return UndoLeadConversionInput{ConversionIntentID: intentID}, nil
}

func ParseReapplyLeadConversionInput(raw json.RawMessage) (ReapplyLeadConversionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReapplyLeadConversionInput{}, err
	}
	intentID, err := requiredCRMDealString(fields, "undoIntentId", 1, 160)
	if err != nil {
		return ReapplyLeadConversionInput{}, err
	}
	return ReapplyLeadConversionInput{UndoIntentID: intentID}, nil
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
	if input.OwnerUserID != nil {
		var member bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM memberships WHERE user_id = $1::uuid AND org_id = $2::uuid
			)`, *input.OwnerUserID, claims.OrganizationID).Scan(&member); err != nil {
			return CreateDealOutput{}, err
		}
		if !member {
			return CreateDealOutput{}, errors.New("deal owner not found in this organization")
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
	result, err := tx.Exec(ctx, `
		UPDATE deals
		SET stage = $3, updated_at = $4, lost_reason = $5
		WHERE id = $1::uuid AND org_id = $2::uuid`, input.DealID, orgID, input.Stage, now, lostReason)
	if err != nil {
		return MoveDealStageOutput{}, err
	}
	if result.RowsAffected() == 0 {
		return MoveDealStageOutput{}, errors.New("deal not found")
	}
	return MoveDealStageOutput{Moved: true, Stage: input.Stage}, nil
}

func convertLead(ctx context.Context, tx pgx.Tx, orgID string, intentID string, input ConvertLeadInput, now time.Time) (ConvertLeadOutput, leadConversionSnapshot, error) {
	var dealID, dealTitle, dealStage string
	var previousCustomerID *string
	err := tx.QueryRow(ctx, `
		SELECT id::text, title, stage, customer_id::text
		FROM deals
		WHERE id = $1::uuid AND org_id = $2::uuid
		FOR UPDATE`, input.DealID, orgID).Scan(&dealID, &dealTitle, &dealStage, &previousCustomerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ConvertLeadOutput{}, leadConversionSnapshot{}, errors.New("deal not found")
	}
	if err != nil {
		return ConvertLeadOutput{}, leadConversionSnapshot{}, err
	}
	if dealStage != "lead" {
		return ConvertLeadOutput{}, leadConversionSnapshot{}, fmt.Errorf("deal is %s; only lead-stage deals convert", dealStage)
	}
	var customerID *string
	createdCustomer := false
	createdCustomerFingerprint := ""
	var createdCustomerRow json.RawMessage
	if input.CustomerID != nil {
		var owned bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM customers WHERE id = $1::uuid AND org_id = $2::uuid
			)`, *input.CustomerID, orgID).Scan(&owned); err != nil {
			return ConvertLeadOutput{}, leadConversionSnapshot{}, err
		}
		if !owned {
			return ConvertLeadOutput{}, leadConversionSnapshot{}, errors.New("customer not found in this organization")
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
			return ConvertLeadOutput{}, leadConversionSnapshot{}, err
		}
		customerID = &createdCustomerID
		createdCustomer = true
		var customerSnapshot string
		if err := tx.QueryRow(ctx, `SELECT to_jsonb(c)::text FROM customers c WHERE c.id=$1::uuid AND c.org_id=$2::uuid`, createdCustomerID, orgID).Scan(&customerSnapshot); err != nil {
			return ConvertLeadOutput{}, leadConversionSnapshot{}, err
		}
		createdCustomerFingerprint = customerRowFingerprint(customerSnapshot)
		createdCustomerRow = json.RawMessage(customerSnapshot)
	}
	if customerID == nil {
		return ConvertLeadOutput{}, leadConversionSnapshot{}, errors.New("pass customerId, or createCustomer true, so the deal has a customer to attach to")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE deals
		SET stage = 'qualified', customer_id = $3::uuid, updated_at = $4
		WHERE id = $1::uuid AND org_id = $2::uuid`, dealID, orgID, *customerID, now); err != nil {
		return ConvertLeadOutput{}, leadConversionSnapshot{}, err
	}
	return ConvertLeadOutput{DealID: dealID, CustomerID: *customerID, ConversionIntentID: intentID, Stage: "qualified"}, leadConversionSnapshot{
		DealID: dealID, CustomerID: *customerID, ConversionIntentID: intentID, Stage: "qualified", PreviousStage: dealStage,
		PreviousCustomerID: previousCustomerID, CreatedCustomer: createdCustomer,
		CreatedCustomerFingerprint: createdCustomerFingerprint, CreatedCustomerRow: createdCustomerRow, ConversionUpdatedAt: now,
	}, nil
}

func undoLeadConversion(ctx context.Context, tx pgx.Tx, orgID, undoIntentID string, input UndoLeadConversionInput, now time.Time) (UndoLeadConversionOutput, leadConversionUndoSnapshot, error) {
	receipt, found, err := loadReceipt(ctx, tx, orgID, orgID+":"+input.ConversionIntentID)
	if err != nil {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, err
	}
	if !found || receipt.CapabilityID != convertLeadCapabilityID || !receipt.OK || receipt.Outcome != "known" {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("lead conversion receipt not found")
	}
	var conversion leadConversionSnapshot
	if err := json.Unmarshal(receipt.InverseData, &conversion); err != nil || len(receipt.InverseData) == 0 {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("lead conversion receipt is invalid")
	}
	var publicOutput ConvertLeadOutput
	if err := json.Unmarshal(receipt.Data, &publicOutput); err != nil || publicOutput.ConversionIntentID != input.ConversionIntentID || publicOutput.DealID != conversion.DealID || publicOutput.CustomerID != conversion.CustomerID || publicOutput.Stage != conversion.Stage {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("lead conversion receipt is invalid")
	}
	if !isUUID(conversion.DealID) || !isUUID(conversion.CustomerID) || conversion.ConversionIntentID != input.ConversionIntentID || conversion.Stage != "qualified" || conversion.PreviousStage != "lead" || conversion.ConversionUpdatedAt.IsZero() || conversion.CreatedCustomer && (conversion.CreatedCustomerFingerprint == "" || len(conversion.CreatedCustomerRow) == 0) {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("lead conversion receipt is incomplete")
	}
	var dealID string
	var stage string
	var currentCustomerID *string
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT id::text, stage, customer_id::text, updated_at
		FROM deals WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`, conversion.DealID, orgID).
		Scan(&dealID, &stage, &currentCustomerID, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("converted deal not found")
	}
	if err != nil {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, err
	}
	if stage != conversion.Stage || currentCustomerID == nil || *currentCustomerID != conversion.CustomerID || !updatedAt.Equal(conversion.ConversionUpdatedAt) {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("converted deal changed since conversion")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE deals SET stage=$3, customer_id=$4::uuid, updated_at=$5
		WHERE id=$1::uuid AND org_id=$2::uuid`, conversion.DealID, orgID, conversion.PreviousStage, conversion.PreviousCustomerID, now); err != nil {
		return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, err
	}
	deleted := false
	if conversion.CreatedCustomer {
		var customerSnapshot string
		err := tx.QueryRow(ctx, `
			SELECT to_jsonb(c)::text FROM customers c
			WHERE c.id=$1::uuid AND c.org_id=$2::uuid FOR UPDATE`, conversion.CustomerID, orgID).Scan(&customerSnapshot)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && customerRowFingerprint(customerSnapshot) != conversion.CreatedCustomerFingerprint {
			return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("created customer changed since conversion")
		}
		if err != nil {
			return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, err
		}
		referenced, err := customerHasReferences(ctx, tx, conversion.CustomerID)
		if err != nil {
			return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, err
		}
		if referenced {
			return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("created customer has acquired references")
		}
		result, err := tx.Exec(ctx, `DELETE FROM customers WHERE id=$1::uuid AND org_id=$2::uuid`, conversion.CustomerID, orgID)
		if err != nil {
			return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, err
		}
		if result.RowsAffected() != 1 {
			return UndoLeadConversionOutput{}, leadConversionUndoSnapshot{}, errors.New("created customer changed since conversion")
		}
		deleted = true
	}
	return UndoLeadConversionOutput{Undone: true, DealID: dealID, CustomerDeleted: deleted, ConversionIntentID: input.ConversionIntentID, UndoIntentID: undoIntentID}, leadConversionUndoSnapshot{Conversion: conversion, UndoUpdatedAt: now}, nil
}

func reapplyLeadConversion(ctx context.Context, tx pgx.Tx, orgID string, input ReapplyLeadConversionInput) (ReapplyLeadConversionOutput, error) {
	receipt, found, err := loadReceipt(ctx, tx, orgID, orgID+":"+input.UndoIntentID)
	if err != nil {
		return ReapplyLeadConversionOutput{}, err
	}
	if !found || receipt.CapabilityID != undoLeadConversionCapabilityID || !receipt.OK || receipt.Outcome != "known" || len(receipt.InverseData) == 0 {
		return ReapplyLeadConversionOutput{}, errors.New("lead conversion undo receipt not found")
	}
	var undo leadConversionUndoSnapshot
	if err := json.Unmarshal(receipt.InverseData, &undo); err != nil {
		return ReapplyLeadConversionOutput{}, errors.New("lead conversion undo receipt is invalid")
	}
	conversion := undo.Conversion
	var publicOutput UndoLeadConversionOutput
	if err := json.Unmarshal(receipt.Data, &publicOutput); err != nil || publicOutput.UndoIntentID != input.UndoIntentID || publicOutput.ConversionIntentID != conversion.ConversionIntentID || publicOutput.DealID != conversion.DealID {
		return ReapplyLeadConversionOutput{}, errors.New("lead conversion undo receipt is invalid")
	}
	if !isUUID(conversion.DealID) || !isUUID(conversion.CustomerID) || conversion.Stage != "qualified" || conversion.PreviousStage != "lead" || undo.UndoUpdatedAt.IsZero() || conversion.ConversionUpdatedAt.IsZero() {
		return ReapplyLeadConversionOutput{}, errors.New("lead conversion undo receipt is incomplete")
	}
	var stage string
	var currentCustomerID *string
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT stage, customer_id::text, updated_at FROM deals
		WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`, conversion.DealID, orgID).
		Scan(&stage, &currentCustomerID, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReapplyLeadConversionOutput{}, errors.New("undone deal not found")
	}
	if err != nil {
		return ReapplyLeadConversionOutput{}, err
	}
	if stage != conversion.PreviousStage || !sameOptionalCRMString(currentCustomerID, conversion.PreviousCustomerID) || !updatedAt.Equal(undo.UndoUpdatedAt) {
		return ReapplyLeadConversionOutput{}, errors.New("undone deal changed since undo")
	}
	if conversion.CreatedCustomer {
		createdCustomer, err := parseCreatedCRMCustomerSnapshot(conversion.CreatedCustomerRow)
		if err != nil || createdCustomer.ID != conversion.CustomerID || createdCustomer.OrgID != orgID || strings.TrimSpace(createdCustomer.Name) == "" || customerRowFingerprint(string(conversion.CreatedCustomerRow)) != conversion.CreatedCustomerFingerprint {
			return ReapplyLeadConversionOutput{}, errors.New("created customer snapshot is invalid")
		}
		result, err := tx.Exec(ctx, `INSERT INTO public.customers SELECT (jsonb_populate_record(NULL::public.customers, $1::jsonb)).*`, conversion.CreatedCustomerRow)
		if err != nil {
			return ReapplyLeadConversionOutput{}, err
		}
		if result.RowsAffected() != 1 {
			return ReapplyLeadConversionOutput{}, errors.New("created customer could not be restored")
		}
		var restoredSnapshot string
		if err := tx.QueryRow(ctx, `SELECT to_jsonb(c)::text FROM customers c WHERE c.id=$1::uuid AND c.org_id=$2::uuid`, conversion.CustomerID, orgID).Scan(&restoredSnapshot); err != nil || customerRowFingerprint(restoredSnapshot) != conversion.CreatedCustomerFingerprint {
			return ReapplyLeadConversionOutput{}, errors.New("created customer could not be restored exactly")
		}
	} else {
		var customerExists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM customers WHERE id=$1::uuid AND org_id=$2::uuid)`, conversion.CustomerID, orgID).Scan(&customerExists); err != nil {
			return ReapplyLeadConversionOutput{}, err
		}
		if !customerExists {
			return ReapplyLeadConversionOutput{}, errors.New("previously attached customer is no longer available")
		}
	}
	result, err := tx.Exec(ctx, `UPDATE deals SET stage=$3, customer_id=$4::uuid, updated_at=$5 WHERE id=$1::uuid AND org_id=$2::uuid AND stage=$6 AND updated_at=$7`, conversion.DealID, orgID, conversion.Stage, conversion.CustomerID, conversion.ConversionUpdatedAt, conversion.PreviousStage, undo.UndoUpdatedAt)
	if err != nil {
		return ReapplyLeadConversionOutput{}, err
	}
	if result.RowsAffected() != 1 {
		return ReapplyLeadConversionOutput{}, errors.New("undone deal changed since undo")
	}
	return ReapplyLeadConversionOutput{Reapplied: true, DealID: conversion.DealID, CustomerID: conversion.CustomerID, ConversionIntentID: conversion.ConversionIntentID}, nil
}

func parseCreatedCRMCustomerSnapshot(raw json.RawMessage) (createdCRMCustomerSnapshot, error) {
	var snapshot createdCRMCustomerSnapshot
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&snapshot); err != nil {
		return createdCRMCustomerSnapshot{}, err
	}
	if snapshot.ID == "" || snapshot.OrgID == "" || snapshot.Name == "" || snapshot.PreferredContactMethod == "" || snapshot.Tags == nil || snapshot.CreatedAt.IsZero() || snapshot.UpdatedAt.IsZero() {
		return createdCRMCustomerSnapshot{}, errors.New("customer snapshot is incomplete")
	}
	return snapshot, nil
}

func sameOptionalCRMString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func customerRowFingerprint(snapshot string) string {
	digest := sha256.Sum256([]byte(snapshot))
	return hex.EncodeToString(digest[:])
}

func customerHasReferences(ctx context.Context, tx pgx.Tx, customerID string) (bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT ns.nspname, rel.relname, srcatt.attname
		FROM pg_constraint fk
		JOIN pg_class rel ON rel.oid=fk.conrelid
		JOIN pg_namespace ns ON ns.oid=rel.relnamespace
		JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY src(attnum, ord) ON true
		JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY dst(attnum, ord) ON dst.ord=src.ord
		JOIN pg_attribute srcatt ON srcatt.attrelid=rel.oid AND srcatt.attnum=src.attnum
		JOIN pg_attribute dstatt ON dstatt.attrelid=fk.confrelid AND dstatt.attnum=dst.attnum
		WHERE fk.contype='f' AND fk.confrelid='public.customers'::regclass AND dstatt.attname='id'
		ORDER BY ns.nspname, rel.relname, srcatt.attname`)
	if err != nil {
		return false, err
	}
	type referenceColumn struct{ schema, table, column string }
	var references []referenceColumn
	for rows.Next() {
		var ref referenceColumn
		if err := rows.Scan(&ref.schema, &ref.table, &ref.column); err != nil {
			rows.Close()
			return false, err
		}
		references = append(references, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()
	for _, ref := range references {
		query := "SELECT EXISTS (SELECT 1 FROM " + pgx.Identifier{ref.schema, ref.table}.Sanitize() + " WHERE " + pgx.Identifier{ref.column}.Sanitize() + "=$1::uuid)"
		var found bool
		if err := tx.QueryRow(ctx, query, customerID).Scan(&found); err != nil {
			return false, err
		}
		if found {
			return true, nil
		}
	}
	return false, nil
}
