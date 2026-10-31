package capability

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

const (
	hrCreateOpeningCapabilityID = "hr.createOpening"
	hrCloseOpeningCapabilityID  = "hr.closeOpening"
)

type HRCreateOpeningInput struct {
	Title      string  `json:"title"`
	Department *string `json:"department,omitempty"`
	Note       *string `json:"note,omitempty"`
}

type HRCreateOpeningOutput struct {
	OpeningID string `json:"openingId"`
}

type HRCloseOpeningInput struct {
	OpeningID string `json:"openingId"`
}

type HRCloseOpeningOutput struct {
	Closed bool `json:"closed"`
}

func ParseHRCreateOpeningInput(raw json.RawMessage) (HRCreateOpeningInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRCreateOpeningInput{}, err
	}
	var input HRCreateOpeningInput
	if input.Title, err = requiredCRMDealString(fields, "title", 1, 120); err != nil {
		return HRCreateOpeningInput{}, err
	}
	if input.Department, err = optionalCRMDealString(fields, "department", 100, false); err != nil {
		return HRCreateOpeningInput{}, err
	}
	if input.Note, err = optionalCRMDealString(fields, "note", 500, false); err != nil {
		return HRCreateOpeningInput{}, err
	}
	return input, nil
}

func ParseHRCloseOpeningInput(raw json.RawMessage) (HRCloseOpeningInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HRCloseOpeningInput{}, err
	}
	openingID, err := paymentRunIDField(fields, "openingId")
	if err != nil {
		return HRCloseOpeningInput{}, err
	}
	return HRCloseOpeningInput{OpeningID: openingID}, nil
}

func hrCreateOpening(ctx context.Context, tx pgx.Tx, orgID string, input HRCreateOpeningInput) (HRCreateOpeningOutput, error) {
	var openingID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO job_openings (org_id, title, department, note)
		VALUES ($1::uuid, $2, $3, $4)
		RETURNING id::text`, orgID, input.Title, input.Department, input.Note).Scan(&openingID); err != nil {
		return HRCreateOpeningOutput{}, err
	}
	return HRCreateOpeningOutput{OpeningID: openingID}, nil
}

func hrCloseOpening(ctx context.Context, tx pgx.Tx, orgID string, input HRCloseOpeningInput) (HRCloseOpeningOutput, error) {
	var openingID string
	err := tx.QueryRow(ctx, `
		UPDATE job_openings SET status = 'closed'
		WHERE id = $1::uuid AND org_id = $2::uuid
		RETURNING id::text`, input.OpeningID, orgID).Scan(&openingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HRCloseOpeningOutput{}, errors.New("opening not found")
	}
	if err != nil {
		return HRCloseOpeningOutput{}, err
	}
	return HRCloseOpeningOutput{Closed: true}, nil
}

func parseHROpeningInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case hrCreateOpeningCapabilityID:
		return ParseHRCreateOpeningInput(raw)
	case hrCloseOpeningCapabilityID:
		return ParseHRCloseOpeningInput(raw)
	default:
		return nil, errors.New("unsupported HR opening capability")
	}
}
