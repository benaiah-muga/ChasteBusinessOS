package capability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

const (
	supportUpdateChannelSettingsCapabilityID  = "support.updateChannelSettings"
	supportRestoreChannelSettingsCapabilityID = "support.restoreChannelSettings"
	supportChannelsDefaultGreeting            = "Hi - ask us anything and we'll get right back to you."
)

// SupportChannelSettingsSnapshot is the persisted state needed to reverse a
// settings update. The embed token is included because regenerating it revokes
// the previous public widget credential.
type SupportChannelSettingsSnapshot struct {
	AutoReplyEnabled bool   `json:"autoReplyEnabled"`
	Greeting         string `json:"greeting"`
	EmbedToken       string `json:"embedToken"`
}

type SupportUpdateChannelSettingsInput struct {
	AutoReplyEnabled *bool   `json:"autoReplyEnabled,omitempty"`
	Greeting         *string `json:"greeting,omitempty"`
	RegenerateToken  bool    `json:"regenerateToken,omitempty"`
}

type SupportRestoreChannelSettingsInput struct {
	Target          *SupportChannelSettingsSnapshot `json:"target"`
	ExpectedCurrent *SupportChannelSettingsSnapshot `json:"expectedCurrent"`
}

type SupportChannelSettingsOutput struct {
	Previous *SupportChannelSettingsSnapshot `json:"previous"`
	Current  *SupportChannelSettingsSnapshot `json:"current"`
}

func ParseSupportUpdateChannelSettingsInput(raw json.RawMessage) (SupportUpdateChannelSettingsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportUpdateChannelSettingsInput{}, err
	}
	var input SupportUpdateChannelSettingsInput
	for key := range fields {
		if key != "autoReplyEnabled" && key != "greeting" && key != "regenerateToken" {
			return SupportUpdateChannelSettingsInput{}, fmt.Errorf("unexpected field %q", key)
		}
	}
	if rawValue, ok := fields["autoReplyEnabled"]; ok {
		var value bool
		if err := json.Unmarshal(rawValue, &value); err != nil || bytesIsNull(rawValue) {
			return SupportUpdateChannelSettingsInput{}, errors.New("autoReplyEnabled must be a boolean")
		}
		input.AutoReplyEnabled = &value
	}
	if rawValue, ok := fields["greeting"]; ok {
		var value string
		if err := json.Unmarshal(rawValue, &value); err != nil || bytesIsNull(rawValue) {
			return SupportUpdateChannelSettingsInput{}, errors.New("greeting must be a string")
		}
		value = strings.TrimSpace(value)
		length := len(utf16.Encode([]rune(value)))
		if length < 1 || length > 300 {
			return SupportUpdateChannelSettingsInput{}, errors.New("greeting must be between 1 and 300 characters")
		}
		input.Greeting = &value
	}
	if rawValue, ok := fields["regenerateToken"]; ok {
		if err := json.Unmarshal(rawValue, &input.RegenerateToken); err != nil || bytesIsNull(rawValue) || !input.RegenerateToken {
			return SupportUpdateChannelSettingsInput{}, errors.New("regenerateToken must be true when provided")
		}
	}
	if input.AutoReplyEnabled == nil && input.Greeting == nil && !input.RegenerateToken {
		return SupportUpdateChannelSettingsInput{}, errors.New("at least one setting must be provided")
	}
	return input, nil
}

func ParseSupportRestoreChannelSettingsInput(raw json.RawMessage) (SupportRestoreChannelSettingsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportRestoreChannelSettingsInput{}, err
	}
	for key := range fields {
		if key != "target" && key != "expectedCurrent" {
			return SupportRestoreChannelSettingsInput{}, fmt.Errorf("unexpected field %q", key)
		}
	}
	targetRaw, hasTarget := fields["target"]
	currentRaw, hasCurrent := fields["expectedCurrent"]
	if !hasTarget || !hasCurrent {
		return SupportRestoreChannelSettingsInput{}, errors.New("target and expectedCurrent are required")
	}
	target, err := parseSupportChannelSettingsSnapshot(targetRaw)
	if err != nil {
		return SupportRestoreChannelSettingsInput{}, fmt.Errorf("target: %w", err)
	}
	current, err := parseSupportChannelSettingsSnapshot(currentRaw)
	if err != nil {
		return SupportRestoreChannelSettingsInput{}, fmt.Errorf("expectedCurrent: %w", err)
	}
	return SupportRestoreChannelSettingsInput{Target: target, ExpectedCurrent: current}, nil
}

func parseSupportChannelSettingsSnapshot(raw json.RawMessage) (*SupportChannelSettingsSnapshot, error) {
	if bytesIsNull(raw) {
		return nil, nil
	}
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return nil, errors.New("must be an object or null")
	}
	for key := range fields {
		if key != "autoReplyEnabled" && key != "greeting" && key != "embedToken" {
			return nil, fmt.Errorf("unexpected field %q", key)
		}
	}
	var snapshot SupportChannelSettingsSnapshot
	if err := json.Unmarshal(fields["autoReplyEnabled"], &snapshot.AutoReplyEnabled); err != nil || bytesIsNull(fields["autoReplyEnabled"]) {
		return nil, errors.New("autoReplyEnabled must be a boolean")
	}
	if err := json.Unmarshal(fields["greeting"], &snapshot.Greeting); err != nil || bytesIsNull(fields["greeting"]) {
		return nil, errors.New("greeting must be a string")
	}
	if length := len(utf16.Encode([]rune(snapshot.Greeting))); length < 1 || length > 300 {
		return nil, errors.New("greeting must be between 1 and 300 characters")
	}
	if err := json.Unmarshal(fields["embedToken"], &snapshot.EmbedToken); err != nil || bytesIsNull(fields["embedToken"]) {
		return nil, errors.New("embedToken must be a string")
	}
	if len(snapshot.EmbedToken) < 1 || len(snapshot.EmbedToken) > 512 {
		return nil, errors.New("embedToken must be between 1 and 512 characters")
	}
	return &snapshot, nil
}

func supportUpdateChannelSettings(ctx context.Context, tx pgx.Tx, orgID string, input SupportUpdateChannelSettingsInput) (SupportChannelSettingsOutput, error) {
	// Locking the organization serializes first-time inserts as well as updates
	// because SELECT FOR UPDATE on an absent support_settings row locks nothing.
	var lockedOrgID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM organizations WHERE id=$1::uuid FOR UPDATE`, orgID).Scan(&lockedOrgID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SupportChannelSettingsOutput{}, errors.New("organization not found")
		}
		return SupportChannelSettingsOutput{}, err
	}
	previous, err := loadSupportChannelSettings(ctx, tx, orgID, true)
	if err != nil {
		return SupportChannelSettingsOutput{}, err
	}
	current := SupportChannelSettingsSnapshot{AutoReplyEnabled: true, Greeting: supportChannelsDefaultGreeting}
	if previous != nil {
		current = *previous
	}
	if input.AutoReplyEnabled != nil {
		current.AutoReplyEnabled = *input.AutoReplyEnabled
	}
	if input.Greeting != nil {
		current.Greeting = *input.Greeting
	}
	if previous == nil || input.RegenerateToken {
		current.EmbedToken, err = newSupportChannelSettingsToken()
		if err != nil {
			return SupportChannelSettingsOutput{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO support_settings (org_id, embed_token, auto_reply_enabled, greeting)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (org_id) DO UPDATE SET embed_token=EXCLUDED.embed_token,
			auto_reply_enabled=EXCLUDED.auto_reply_enabled, greeting=EXCLUDED.greeting, updated_at=now()`,
		orgID, current.EmbedToken, current.AutoReplyEnabled, current.Greeting); err != nil {
		return SupportChannelSettingsOutput{}, err
	}
	return SupportChannelSettingsOutput{Previous: previous, Current: &current}, nil
}

func supportRestoreChannelSettings(ctx context.Context, tx pgx.Tx, orgID string, input SupportRestoreChannelSettingsInput) (SupportChannelSettingsOutput, error) {
	var lockedOrgID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM organizations WHERE id=$1::uuid FOR UPDATE`, orgID).Scan(&lockedOrgID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SupportChannelSettingsOutput{}, errors.New("organization not found")
		}
		return SupportChannelSettingsOutput{}, err
	}
	actual, err := loadSupportChannelSettings(ctx, tx, orgID, true)
	if err != nil {
		return SupportChannelSettingsOutput{}, err
	}
	if !sameSupportChannelSettings(actual, input.ExpectedCurrent) {
		return SupportChannelSettingsOutput{}, errors.New("support channel settings changed since the action; reload before restoring")
	}
	if input.Target == nil {
		if _, err := tx.Exec(ctx, `DELETE FROM support_settings WHERE org_id=$1::uuid`, orgID); err != nil {
			return SupportChannelSettingsOutput{}, err
		}
	} else if _, err := tx.Exec(ctx, `
		INSERT INTO support_settings (org_id, embed_token, auto_reply_enabled, greeting)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (org_id) DO UPDATE SET embed_token=EXCLUDED.embed_token,
			auto_reply_enabled=EXCLUDED.auto_reply_enabled, greeting=EXCLUDED.greeting, updated_at=now()`,
		orgID, input.Target.EmbedToken, input.Target.AutoReplyEnabled, input.Target.Greeting); err != nil {
		return SupportChannelSettingsOutput{}, err
	}
	return SupportChannelSettingsOutput{Previous: actual, Current: input.Target}, nil
}

func loadSupportChannelSettings(ctx context.Context, tx pgx.Tx, orgID string, lock bool) (*SupportChannelSettingsSnapshot, error) {
	query := `SELECT auto_reply_enabled, greeting, embed_token FROM support_settings WHERE org_id=$1::uuid`
	if lock {
		query += ` FOR UPDATE`
	}
	var snapshot SupportChannelSettingsSnapshot
	err := tx.QueryRow(ctx, query, orgID).Scan(&snapshot.AutoReplyEnabled, &snapshot.Greeting, &snapshot.EmbedToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func sameSupportChannelSettings(left, right *SupportChannelSettingsSnapshot) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.AutoReplyEnabled == right.AutoReplyEnabled && left.Greeting == right.Greeting && left.EmbedToken == right.EmbedToken
}

func newSupportChannelSettingsToken() (string, error) {
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", fmt.Errorf("generate support embed token: %w", err)
	}
	return hex.EncodeToString(entropy[:]), nil
}
