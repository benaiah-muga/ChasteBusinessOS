package capability

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"time"
)

const (
	documentsMaxUploadBytes   = 5 * 1024 * 1024
	documentsMaxUploadBase64  = 6_990_507 // Math.ceil(5MiB * 4/3)
	documentsMaxHTMLLength    = 2_000_000
	documentsMaxContentBytes  = 1_000_000
	documentsMaxContentDepth  = 64
	documentsMaxContentNodes  = 10_000
	documentsMaxContentValues = 100_000
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

// documentsRequiredContentObject validates bounded ProseMirror JSON. The
// original bytes are kept so the stored content and canonical input hash stay unchanged.
func documentsRequiredContentObject(fields map[string]json.RawMessage, key string) (json.RawMessage, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	if err := documentsValidateDocumentContent(raw); err != nil {
		return nil, fmt.Errorf("%s exceeds the supported structure", key)
	}
	return json.RawMessage(bytes.TrimSpace(raw)), nil
}

func documentsOptionalContentObject(fields map[string]json.RawMessage, key string) (json.RawMessage, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if err := documentsValidateDocumentContent(raw); err != nil {
		return nil, fmt.Errorf("%s exceeds the supported structure", key)
	}
	return json.RawMessage(bytes.TrimSpace(raw)), nil
}

func documentsValidateJSONBounds(raw json.RawMessage) error {
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil || compact.Len() == 0 {
		return errors.New("content JSON is invalid")
	}
	decoder := json.NewDecoder(&compact)
	depth := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return errors.New("content JSON is invalid")
		}
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{', '[':
				depth++
				if depth > documentsMaxContentDepth {
					return errors.New("content JSON is nested too deeply")
				}
			case '}', ']':
				depth--
				if depth < 0 {
					return errors.New("content JSON is invalid")
				}
			}
		}
	}
	if depth != 0 {
		return errors.New("content JSON is invalid")
	}
	return nil
}

type documentsContentValue struct {
	value any
	depth int
}

func documentsValidateDocumentContent(raw json.RawMessage) error {
	if err := documentsValidateJSONBounds(raw); err != nil {
		return err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return errors.New("content JSON is invalid")
	}
	decoder := json.NewDecoder(&compact)
	var root any
	if err := decoder.Decode(&root); err != nil {
		return errors.New("content JSON is invalid")
	}
	rootNode, ok := root.(map[string]any)
	if !ok || rootNode["type"] != "doc" {
		return errors.New("document content must have a doc root")
	}
	values := []documentsContentValue{{value: root, depth: 1}}
	valueCount := 0
	for len(values) > 0 {
		last := len(values) - 1
		entry := values[last]
		values = values[:last]
		valueCount++
		if entry.depth > documentsMaxContentDepth {
			return errors.New("content JSON is nested too deeply")
		}
		if valueCount > documentsMaxContentValues {
			return errors.New("content JSON has too many values")
		}
		switch value := entry.value.(type) {
		case map[string]any:
			for key, nested := range value {
				if number, ok := nested.(float64); ok && number == 0 {
					value[key] = float64(0)
					nested = float64(0)
				}
				depth := entry.depth
				switch nested.(type) {
				case map[string]any, []any:
					depth++
				}
				values = append(values, documentsContentValue{value: nested, depth: depth})
			}
		case []any:
			for index, nested := range value {
				if number, ok := nested.(float64); ok && number == 0 {
					value[index] = float64(0)
					nested = float64(0)
				}
				depth := entry.depth
				switch nested.(type) {
				case map[string]any, []any:
					depth++
				}
				values = append(values, documentsContentValue{value: nested, depth: depth})
			}
		case float64:
			if math.IsInf(value, 0) || math.IsNaN(value) {
				return errors.New("document content numbers must be finite")
			}
		}
	}
	// Match JSON.stringify's UTF-8 byte accounting for the decoded JSON value.
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(root); err != nil {
		return errors.New("content JSON is invalid")
	}
	serialized := documentsJSONStringUTF8(bytes.TrimSuffix(canonical.Bytes(), []byte("\n")))
	if len(serialized) > documentsMaxContentBytes {
		return errors.New("content JSON exceeds the supported size")
	}

	nodes := []any{rootNode}
	nodeCount := 0
	for len(nodes) > 0 {
		last := len(nodes) - 1
		nodeValue := nodes[last]
		nodes = nodes[:last]
		node, ok := nodeValue.(map[string]any)
		if !ok {
			return errors.New("document content nodes must be objects")
		}
		nodeCount++
		if nodeCount > documentsMaxContentNodes {
			return errors.New("document content has too many nodes")
		}
		nodeType, ok := node["type"].(string)
		if !ok || nodeType == "" || utf16Length(nodeType) > 100 {
			return errors.New("document content nodes need a valid type")
		}
		if text, exists := node["text"]; exists {
			if _, ok := text.(string); !ok {
				return errors.New("document text must be a string")
			}
		}
		if attrs, exists := node["attrs"]; exists {
			if _, ok := attrs.(map[string]any); !ok {
				return errors.New("document node attributes must be an object")
			}
		}
		if marks, exists := node["marks"]; exists {
			markList, ok := marks.([]any)
			if !ok {
				return errors.New("document node marks must be an array")
			}
			for _, markValue := range markList {
				mark, ok := markValue.(map[string]any)
				if !ok {
					return errors.New("document marks must be objects")
				}
				markType, ok := mark["type"].(string)
				if !ok || markType == "" || utf16Length(markType) > 100 {
					return errors.New("document marks need a valid type")
				}
				if attrs, exists := mark["attrs"]; exists {
					if _, ok := attrs.(map[string]any); !ok {
						return errors.New("document mark attributes must be an object")
					}
				}
			}
		}
		if content, exists := node["content"]; exists {
			children, ok := content.([]any)
			if !ok {
				return errors.New("document node content must be an array")
			}
			nodes = append(nodes, children...)
		}
	}
	return nil
}

func documentsJSONStringUTF8(serialized []byte) []byte {
	var normalized bytes.Buffer
	inString := false
	for index := 0; index < len(serialized); {
		character := serialized[index]
		if !inString && character == '"' {
			inString = true
		} else if inString && character == '"' {
			inString = false
		}
		if inString && character == '\\' && index+1 < len(serialized) {
			if index+6 <= len(serialized) && serialized[index+1] == 'u' {
				sequence := serialized[index : index+6]
				if bytes.Equal(sequence, []byte(`\u2028`)) {
					normalized.WriteString("\u2028")
					index += 6
					continue
				}
				if bytes.Equal(sequence, []byte(`\u2029`)) {
					normalized.WriteString("\u2029")
					index += 6
					continue
				}
			}
			normalized.Write(serialized[index : index+2])
			index += 2
			continue
		}
		normalized.WriteByte(character)
		index++
	}
	return normalized.Bytes()
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
