package capability

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
)

type CreateCustomerInput struct {
	Name                   string  `json:"name"`
	Email                  *string `json:"email,omitempty"`
	Phone                  *string `json:"phone,omitempty"`
	PreferredContactMethod string  `json:"preferredContactMethod"`
	DoNotContact           bool    `json:"doNotContact"`
}

type CreateCustomerOutput struct {
	CustomerID       string  `json:"customerId"`
	DuplicateWarning *string `json:"duplicateWarning"`
}

type DeactivateCustomerInput struct {
	CustomerID string `json:"customerId"`
}

type DeactivateCustomerOutput struct {
	Deactivated bool `json:"deactivated"`
}

var customerEmailPattern = regexp.MustCompile(`^[A-Za-z0-9_'+.\-]*[A-Za-z0-9_+\-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

func validCustomerEmail(value string) bool {
	separator := strings.LastIndexByte(value, '@')
	if separator < 0 {
		return false
	}
	local := value[:separator]
	return !strings.HasPrefix(local, ".") && !strings.Contains(local, "..") && customerEmailPattern.MatchString(value)
}

func ParseCreateCustomerInput(raw json.RawMessage) (CreateCustomerInput, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return CreateCustomerInput{}, errors.New("expected an object")
	}
	var input CreateCustomerInput
	name, ok := fields["name"]
	if !ok || json.Unmarshal(name, &input.Name) != nil || input.Name == "" || utf16Length(input.Name) > 120 {
		return CreateCustomerInput{}, errors.New("name must be a non-empty string of at most 120 characters")
	}
	if value, exists := fields["email"]; exists {
		email, err := readOptionalString(value)
		if err != nil || email == nil || !validCustomerEmail(*email) {
			return CreateCustomerInput{}, errors.New("email must be a valid email address")
		}
		input.Email = email
	}
	if value, exists := fields["phone"]; exists {
		phone, err := readOptionalString(value)
		if err != nil || phone == nil {
			return CreateCustomerInput{}, errors.New("phone must be a string")
		}
		trimmed := strings.TrimFunc(*phone, isJSWhitespace)
		if utf16Length(trimmed) > 40 {
			return CreateCustomerInput{}, errors.New("phone must be at most 40 characters")
		}
		input.Phone = &trimmed
	}
	input.PreferredContactMethod = "email"
	if value, exists := fields["preferredContactMethod"]; exists {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return CreateCustomerInput{}, errors.New("preferredContactMethod is invalid")
		}
		if err := json.Unmarshal(value, &input.PreferredContactMethod); err != nil {
			return CreateCustomerInput{}, errors.New("preferredContactMethod is invalid")
		}
	}
	switch input.PreferredContactMethod {
	case "email", "phone", "whatsapp", "other":
	default:
		return CreateCustomerInput{}, errors.New("preferredContactMethod is invalid")
	}
	if value, exists := fields["doNotContact"]; exists {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return CreateCustomerInput{}, errors.New("doNotContact must be a boolean")
		}
		if err := json.Unmarshal(value, &input.DoNotContact); err != nil {
			return CreateCustomerInput{}, errors.New("doNotContact must be a boolean")
		}
	}
	return input, nil
}

func ParseDeactivateCustomerInput(raw json.RawMessage) (DeactivateCustomerInput, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return DeactivateCustomerInput{}, errors.New("expected an object")
	}
	customerID, ok := fields["customerId"]
	if !ok {
		return DeactivateCustomerInput{}, errors.New("customerId is required")
	}
	var input DeactivateCustomerInput
	if bytes.Equal(bytes.TrimSpace(customerID), []byte("null")) || json.Unmarshal(customerID, &input.CustomerID) != nil {
		return DeactivateCustomerInput{}, errors.New("customerId must be a string")
	}
	return input, nil
}

func readOptionalString(raw json.RawMessage) (*string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("null is not an optional string")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func isJSWhitespace(r rune) bool {
	return unicode.IsSpace(r) || r == '\ufeff'
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func isUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !strings.ContainsRune("0123456789abcdefABCDEF", char) {
			return false
		}
	}
	return true
}

func marshalJS(value any) ([]byte, error) {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(output.Bytes(), []byte("\n"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2028`), []byte("\u2028"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2029`), []byte("\u2029"))
	return append([]byte(nil), encoded...), nil
}

func decodeJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("contains trailing JSON data")
	}
	return value, nil
}
