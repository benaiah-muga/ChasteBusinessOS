package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

const (
	iamSetAgentSoulCapabilityID     = "iam.setAgentSoul"
	iamRestoreAgentSoulCapabilityID = "iam.restoreAgentSoul"
)

// IAMSetAgentSoulCapabilityID exposes the governed persona write to the HTTP
// adapter without duplicating the id string.
const IAMSetAgentSoulCapabilityID = iamSetAgentSoulCapabilityID

const iamMaxAgentSoulUnits = 8000

type IAMSetAgentSoulInput struct {
	AgentSoul string `json:"agentSoul"`
}

type IAMSetAgentSoulOutput struct {
	AgentSoul         string `json:"agentSoul"`
	PreviousAgentSoul string `json:"previousAgentSoul"`
}

func ParseIAMSetAgentSoulInput(raw json.RawMessage) (IAMSetAgentSoulInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IAMSetAgentSoulInput{}, err
	}
	rawSoul, ok := fields["agentSoul"]
	if !ok || string(rawSoul) == "null" {
		return IAMSetAgentSoulInput{}, errors.New("agentSoul is required")
	}
	var soul string
	if err := json.Unmarshal(rawSoul, &soul); err != nil {
		return IAMSetAgentSoulInput{}, errors.New("agentSoul must be a string")
	}
	if utf16Length(soul) > iamMaxAgentSoulUnits {
		return IAMSetAgentSoulInput{}, errors.New("agentSoul must be at most 8000 UTF-16 code units")
	}
	return IAMSetAgentSoulInput{AgentSoul: strings.TrimSpace(soul)}, nil
}

func iamSetAgentSoul(ctx context.Context, tx pgx.Tx, orgID string, input IAMSetAgentSoulInput) (IAMSetAgentSoulOutput, error) {
	var previous *string
	if err := tx.QueryRow(ctx, `SELECT agent_soul FROM organizations WHERE id=$1::uuid FOR UPDATE`, orgID).Scan(&previous); err != nil {
		return IAMSetAgentSoulOutput{}, err
	}
	var value any
	if input.AgentSoul != "" {
		value = input.AgentSoul
	}
	if _, err := tx.Exec(ctx, `UPDATE organizations SET agent_soul=$2 WHERE id=$1::uuid`, orgID, value); err != nil {
		return IAMSetAgentSoulOutput{}, err
	}
	previousSoul := ""
	if previous != nil {
		previousSoul = *previous
	}
	return IAMSetAgentSoulOutput{AgentSoul: input.AgentSoul, PreviousAgentSoul: previousSoul}, nil
}
