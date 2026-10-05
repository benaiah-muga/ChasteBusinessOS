package capability

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	documentsMaxUploadBytes  = 5 * 1024 * 1024
	documentsMaxUploadBase64 = 6_990_507 // Math.ceil(5MiB * 4/3)
	documentsMaxHTMLLength   = 2_000_000
)

var documentsMIMETypePattern = regexp.MustCompile(`^[\w.+-]+/[\w.+-]+$`)

// documentsZodDateTimePattern is the wire shape Zod v4 accepts for
// z.string().datetime(): a calendar date, a T separator, HH:MM with optional
// seconds and optional fraction, and a literal Z. Offsets are refused.
var documentsZodDateTimePattern = regexp.MustCompile(`^(?:` +
	`(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29` +
	`|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8]))` +
	`)T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$`)

// documentsUnbounded marks a field with no length rule. Zod counts UTF-16 code
// units for .min and .max, so a bound of documentsUnbounded is simply skipped.
const documentsUnbounded = -1

// documentsString reads an optional string field with Zod's length rules.
// Length is measured in UTF-16 code units, which is what z.string().max and
// .min count.
func documentsOptionalString(fields map[string]json.RawMessage, key string, minLength, maxLength int) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	if err := documentsCheckStringLength(*value, minLength, maxLength); err != nil {
		return nil, fmt.Errorf("%s %s", key, err)
	}
	return value, nil
}

func documentsRequiredString(fields map[string]json.RawMessage, key string, minLength, maxLength int) (string, error) {
	value, err := documentsOptionalString(fields, key, minLength, maxLength)
	if err != nil {
		return "", err
	}
	if value == nil {
		return "", fmt.Errorf("%s is required", key)
	}
	return *value, nil
}

func documentsCheckStringLength(value string, minLength, maxLength int) error {
	length := utf16Length(value)
	if minLength >= 0 && length < minLength {
		return fmt.Errorf("must contain at least %d characters", minLength)
	}
	if maxLength >= 0 && length > maxLength {
		return fmt.Errorf("must contain at most %d characters", maxLength)
	}
	return nil
}

// documentsPlainString reads a string field that carries no length rule.
func documentsPlainString(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

// documentsRequiredPlainString reads a required string field with no length
// rule. documents.deleteDocument and documents.suggestCoding declare a bare
// z.string() documentId, so only a non-null string is enforced here.
func documentsRequiredPlainString(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := documentsPlainString(fields, key)
	if err != nil {
		return "", err
	}
	if value == nil {
		return "", fmt.Errorf("%s is required", key)
	}
	return *value, nil
}

// documentsReadNullableString reads a `string(nullable)` field, keeping the
// absent, null, and value states apart.
func documentsReadNullableString(fields map[string]json.RawMessage, key string, maxLength int) (*documentsNullableString, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	var value documentsNullableString
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	if value.Nulled {
		return &value, nil
	}
	if err := documentsCheckStringLength(value.Value, 0, maxLength); err != nil {
		return nil, fmt.Errorf("%s %s", key, err)
	}
	return &value, nil
}

// documentsNonNullableString reads a `string` field that is optional but not
// nullable, so an explicit null is a validation error rather than a clear.
func documentsNonNullableString(fields map[string]json.RawMessage, key string, maxLength int) (*documentsNullableString, error) {
	value, err := documentsReadNullableString(fields, key, maxLength)
	if err != nil {
		return nil, err
	}
	if value != nil && value.Nulled {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

// documentsRequiredContentObject validates z.record(z.string(), z.unknown()):
// a non-null JSON object whose keys are strings. The original bytes are kept
// so the stored document and the canonical input hash are unchanged.
func documentsRequiredContentObject(fields map[string]json.RawMessage, key string) (json.RawMessage, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	if err := documentsAssertJSONObject(raw); err != nil {
		return nil, fmt.Errorf("%s must be an object", key)
	}
	return json.RawMessage(bytes.TrimSpace(raw)), nil
}

func documentsOptionalContentObject(fields map[string]json.RawMessage, key string) (json.RawMessage, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if err := documentsAssertJSONObject(raw); err != nil {
		return nil, fmt.Errorf("%s must be an object", key)
	}
	return json.RawMessage(bytes.TrimSpace(raw)), nil
}

func documentsAssertJSONObject(raw json.RawMessage) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("expected an object")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		return errors.New("expected an object")
	}
	return nil
}

// documentsPageSettingsInput validates the page settings object. Zod applies
// every field default, so a partial object is valid and arrives fully
// populated.
func documentsPageSettingsInput(fields map[string]json.RawMessage) (*DocumentsPageSettings, error) {
	raw, ok := fields["pageSettings"]
	if !ok {
		return nil, nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errors.New("pageSettings must be an object")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &object); err != nil || object == nil {
		return nil, errors.New("pageSettings must be an object")
	}
	settings := defaultDocumentsPageSettings()
	for key, allowed := range map[string][]string{
		"size":        {"A4", "Letter"},
		"orientation": {"portrait", "landscape"},
		"margin":      {"compact", "normal", "wide"},
	} {
		value, present := object[key]
		if !present {
			continue
		}
		decoded, err := readOptionalString(value)
		if err != nil {
			return nil, fmt.Errorf("pageSettings %s is invalid", key)
		}
		if !documentsContainsString(allowed, *decoded) {
			return nil, fmt.Errorf("pageSettings %s is invalid", key)
		}
		switch key {
		case "size":
			settings.Size = *decoded
		case "orientation":
			settings.Orientation = *decoded
		case "margin":
			settings.Margin = *decoded
		}
	}
	return &settings, nil
}

func documentsContainsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

// documentsOptionalUUID reads an optional z.string().uuid() field.
func documentsOptionalUUID(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil || value == nil || !isZodUUID(*value) {
		return nil, fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

// documentsRequiredUUID reads a required z.string().uuid() field.
func documentsRequiredUUID(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := projectRequiredUUID(fields, key)
	if err != nil {
		return "", err
	}
	return value, nil
}

// documentsPositiveSafeInteger reads a required int with the given inclusive
// bounds, matching z.number().int().min(n).
func documentsBoundedInteger(fields map[string]json.RawMessage, key string, min, max int64) (int64, error) {
	value, err := requiredSafeInteger(fields, key)
	if err != nil {
		return 0, err
	}
	if value < min || value > max {
		return 0, fmt.Errorf("%s must be between %d and %d", key, min, max)
	}
	return value, nil
}

func documentsDateTime(fields map[string]json.RawMessage, key string) (*string, error) {
	value, err := documentsOptionalString(fields, key, 0, documentsUnbounded)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, nil
	}
	if !documentsZodDateTimePattern.MatchString(*value) {
		return nil, fmt.Errorf("%s must be an ISO datetime", key)
	}
	return value, nil
}

// documentsDateOnly mirrors JavaScript's toISOString().slice(0, 10): the UTC
// calendar date with no separator suffix.
func documentsDateOnly(value time.Time) string {
	return value.UTC().Format("2006-01-02")
}

func documentsDateOnlyPtr(value *time.Time) string {
	if value == nil {
		return ""
	}
	return documentsDateOnly(*value)
}
