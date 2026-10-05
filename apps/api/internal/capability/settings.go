package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	whatwgurl "github.com/nlnwa/whatwg-url/url"
)

// Port of apps/web/src/server/ai-settings.ts: the workspace model provider
// configuration. The capability is the governed write path for an already
// encrypted credential: encryptProviderKey runs in the route handler, so the
// value crossing this boundary is AES-GCM ciphertext and never a plaintext
// secret. Nothing here decrypts, and no error or output ever widens the
// ciphertext back into a secret.

const (
	settingsConfigureAiProviderCapabilityID = "settings.configureAiProvider"
	settingsRestoreAiProviderCapabilityID   = "settings.restoreAiProvider"
)

var settingsAIProviderIDs = []string{"nvidia", "openrouter", "groq", "mistral", "zai", "openai", "custom"}

// z.string().datetime() accepts a UTC ISO 8601 instant with optional seconds
// and optional fractional digits, and rejects impossible calendar dates. The
// two layouts below reproduce that exactly through time.Parse.
var settingsTimestampLayouts = []string{"2006-01-02T15:04:05Z", "2006-01-02T15:04Z"}

type SettingsAIModels struct {
	Primary    string `json:"primary"`
	Fast       string `json:"fast"`
	Reasoning  string `json:"reasoning"`
	Embeddings string `json:"embeddings"`
}

type SettingsAIProviderConfig struct {
	Provider        string           `json:"provider"`
	BaseURL         string           `json:"baseUrl"`
	Models          SettingsAIModels `json:"models"`
	EncryptedAPIKey *string          `json:"encryptedApiKey"`
	KeyHint         *string          `json:"keyHint"`
	UpdatedAt       string           `json:"updatedAt"`
}

type SettingsConfigureAiProviderInput struct {
	Config *SettingsAIProviderConfig `json:"config"`
}

type SettingsRestoreAiProviderInput struct {
	Config *SettingsAIProviderConfig `json:"config"`
}

type SettingsAIProviderOutput struct {
	Previous *SettingsAIProviderConfig `json:"previous"`
	Current  *SettingsAIProviderConfig `json:"current"`
}

// ── Validation ──

func settingsValidProvider(value string) bool {
	for _, id := range settingsAIProviderIDs {
		if value == id {
			return true
		}
	}
	return false
}

func settingsValidBaseURL(value string) bool {
	// Mirrors z.string().url(), which defers to the WHATWG URL parser: a scheme
	// is required, a bare host is not, and surrounding whitespace is trimmed.
	_, err := whatwgurl.Parse(value)
	return err == nil
}

func settingsValidTimestamp(value string) bool {
	for _, layout := range settingsTimestampLayouts {
		if _, err := time.Parse(layout, value); err == nil {
			return true
		}
	}
	return false
}

// The model roles are the one part of the stored shape Zod transforms, so the
// trimmed value is what gets validated, persisted, and returned.
func settingsTrimmedModel(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("models.%s is required", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("models.%s must be a string", key)
	}
	value = strings.TrimFunc(value, isJSWhitespace)
	if utf16Length(value) < 1 {
		return "", fmt.Errorf("models.%s must be a non-empty string", key)
	}
	if utf16Length(value) > 200 {
		return "", fmt.Errorf("models.%s must be at most 200 characters", key)
	}
	return value, nil
}

func settingsParseStoredConfig(raw json.RawMessage) (*SettingsAIProviderConfig, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return nil, errors.New("config must be an object")
	}
	config := &SettingsAIProviderConfig{}
	if config.Provider, err = requiredCRMDealString(fields, "provider", 0, 0); err != nil {
		return nil, err
	}
	if !settingsValidProvider(config.Provider) {
		return nil, errors.New("provider must be nvidia, openrouter, groq, mistral, zai, openai or custom")
	}
	if config.BaseURL, err = requiredCRMDealString(fields, "baseUrl", 0, 0); err != nil {
		return nil, err
	}
	if utf16Length(config.BaseURL) > 500 {
		return nil, errors.New("baseUrl must be at most 500 characters")
	}
	if !settingsValidBaseURL(config.BaseURL) {
		return nil, errors.New("baseUrl must be a valid URL")
	}
	rawModels, ok := fields["models"]
	if !ok {
		return nil, errors.New("models is required")
	}
	modelFields, err := decodeJSONObject(rawModels)
	if err != nil {
		return nil, errors.New("models must be an object")
	}
	if config.Models.Primary, err = settingsTrimmedModel(modelFields, "primary"); err != nil {
		return nil, err
	}
	if config.Models.Fast, err = settingsTrimmedModel(modelFields, "fast"); err != nil {
		return nil, err
	}
	if config.Models.Reasoning, err = settingsTrimmedModel(modelFields, "reasoning"); err != nil {
		return nil, err
	}
	if config.Models.Embeddings, err = settingsTrimmedModel(modelFields, "embeddings"); err != nil {
		return nil, err
	}
	// The credential is opaque here: bounded length, never inspected, never
	// echoed back into an error message.
	rawKey, ok := fields["encryptedApiKey"]
	if !ok {
		return nil, errors.New("encryptedApiKey is required")
	}
	if !bytes.Equal(bytes.TrimSpace(rawKey), []byte("null")) {
		encrypted, err := readOptionalString(rawKey)
		if err != nil {
			return nil, errors.New("encryptedApiKey must be a string")
		}
		if length := utf16Length(*encrypted); length < 1 || length > 2000 {
			return nil, errors.New("encryptedApiKey must be between 1 and 2000 characters")
		}
		config.EncryptedAPIKey = encrypted
	}
	rawHint, ok := fields["keyHint"]
	if !ok {
		return nil, errors.New("keyHint is required")
	}
	if !bytes.Equal(bytes.TrimSpace(rawHint), []byte("null")) {
		hint, err := readOptionalString(rawHint)
		if err != nil {
			return nil, errors.New("keyHint must be a string")
		}
		if utf16Length(*hint) > 12 {
			return nil, errors.New("keyHint must be at most 12 characters")
		}
		config.KeyHint = hint
	}
	if config.UpdatedAt, err = requiredCRMDealString(fields, "updatedAt", 0, 0); err != nil {
		return nil, err
	}
	if !settingsValidTimestamp(config.UpdatedAt) {
		return nil, errors.New("updatedAt must be an ISO 8601 UTC timestamp")
	}
	return config, nil
}

// ParseStoredAIProviderConfig validates an organization AI provider snapshot
// before a server-side consumer decrypts or uses its credential.
func ParseStoredAIProviderConfig(raw json.RawMessage) (*SettingsAIProviderConfig, error) {
	return settingsParseStoredConfig(raw)
}

func settingsParseConfigInput(raw json.RawMessage) (*SettingsAIProviderConfig, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return nil, err
	}
	rawConfig, ok := fields["config"]
	if !ok {
		return nil, errors.New("config is required")
	}
	if bytes.Equal(bytes.TrimSpace(rawConfig), []byte("null")) {
		return nil, nil
	}
	return settingsParseStoredConfig(rawConfig)
}

// ParseSettingsConfigureAiProviderInput mirrors configureAiProviderInputSchema.
func ParseSettingsConfigureAiProviderInput(raw json.RawMessage) (SettingsConfigureAiProviderInput, error) {
	config, err := settingsParseConfigInput(raw)
	return SettingsConfigureAiProviderInput{Config: config}, err
}

// ParseSettingsRestoreAiProviderInput mirrors the restore capability's input.
func ParseSettingsRestoreAiProviderInput(raw json.RawMessage) (SettingsRestoreAiProviderInput, error) {
	config, err := settingsParseConfigInput(raw)
	return SettingsRestoreAiProviderInput{Config: config}, err
}

func parseSettingsInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case settingsConfigureAiProviderCapabilityID:
		return ParseSettingsConfigureAiProviderInput(raw)
	case settingsRestoreAiProviderCapabilityID:
		return ParseSettingsRestoreAiProviderInput(raw)
	default:
		return nil, errors.New("unsupported settings capability")
	}
}

// ── Persistence ──

// settingsOrgSettings reads the org settings document for a read-modify-write.
// FOR UPDATE keeps a concurrent settings write from silently dropping the
// sibling keys this capability is about to rewrite.
func settingsOrgSettings(ctx context.Context, tx pgx.Tx, orgID string) (map[string]json.RawMessage, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT settings FROM organizations WHERE id=$1::uuid FOR UPDATE`, orgID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("organization not found")
	}
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return map[string]json.RawMessage{}, nil
	}
	settings := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, errors.New("stored organization settings are malformed")
	}
	return settings, nil
}

// settingsStoredConfig mirrors storedAiConfigForOrg: a stored value that does
// not satisfy the schema reads as "no configuration" rather than failing.
func settingsStoredConfig(ctx context.Context, tx pgx.Tx, orgID string) (*SettingsAIProviderConfig, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT settings FROM organizations WHERE id=$1::uuid`, orgID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("organization not found")
	}
	if err != nil {
		return nil, err
	}
	settings := map[string]json.RawMessage{}
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &settings) != nil {
		return nil, nil
	}
	rawConfig, ok := settings["ai"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawConfig), []byte("null")) {
		return nil, nil
	}
	config, err := settingsParseStoredConfig(rawConfig)
	if err != nil {
		return nil, nil
	}
	return config, nil
}

// settingsSaveConfig mirrors saveConfig: it validates the prior snapshot
// strictly, so a malformed stored config blocks the write instead of being
// silently overwritten.
func settingsSaveConfig(ctx context.Context, tx pgx.Tx, orgID string, config *SettingsAIProviderConfig) (*SettingsAIProviderConfig, error) {
	settings, err := settingsOrgSettings(ctx, tx, orgID)
	if err != nil {
		return nil, err
	}
	var previous *SettingsAIProviderConfig
	if rawConfig, ok := settings["ai"]; ok && !bytes.Equal(bytes.TrimSpace(rawConfig), []byte("null")) {
		if previous, err = settingsParseStoredConfig(rawConfig); err != nil {
			return nil, errors.New("stored workspace model provider configuration is invalid")
		}
	}
	if config != nil {
		encoded, err := marshalJS(config)
		if err != nil {
			return nil, err
		}
		settings["ai"] = encoded
	} else {
		delete(settings, "ai")
	}
	encodedSettings, err := marshalJS(settings)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE organizations SET settings=$2::jsonb WHERE id=$1::uuid`, orgID, string(encodedSettings)); err != nil {
		return nil, err
	}
	return previous, nil
}

func settingsConfigureAiProvider(ctx context.Context, tx pgx.Tx, orgID string, input SettingsConfigureAiProviderInput) (SettingsAIProviderOutput, error) {
	previous, err := settingsSaveConfig(ctx, tx, orgID, input.Config)
	if err != nil {
		return SettingsAIProviderOutput{}, err
	}
	return SettingsAIProviderOutput{Previous: previous, Current: input.Config}, nil
}

func settingsRestoreAiProvider(ctx context.Context, tx pgx.Tx, orgID string, input SettingsRestoreAiProviderInput) (SettingsAIProviderOutput, error) {
	previous, err := settingsStoredConfig(ctx, tx, orgID)
	if err != nil {
		return SettingsAIProviderOutput{}, err
	}
	if _, err := settingsSaveConfig(ctx, tx, orgID, input.Config); err != nil {
		return SettingsAIProviderOutput{}, err
	}
	return SettingsAIProviderOutput{Previous: previous, Current: input.Config}, nil
}

// ── Registry wiring ──

func settingsCapabilitySpecEntries() map[string]capabilitySpec {
	return map[string]capabilitySpec{
		settingsConfigureAiProviderCapabilityID: {
			module: "settings", permission: "iam.admin", risk: "secret",
			inverseCapabilityID: settingsRestoreAiProviderCapabilityID,
			inverseInputSource:  "output", inverseFields: []string{"config"},
		},
		settingsRestoreAiProviderCapabilityID: {
			module: "settings", permission: "iam.admin", risk: "secret",
			inverseCapabilityID: settingsConfigureAiProviderCapabilityID,
			inverseInputSource:  "output", inverseFields: []string{"config"},
		},
	}
}

// RegisterSettingsCapabilities publishes the ported settings metadata to the
// executor registry. Safe to call more than once.
func RegisterSettingsCapabilities() {
	for capabilityID, spec := range settingsCapabilitySpecEntries() {
		capabilitySpecs[capabilityID] = spec
	}
}
