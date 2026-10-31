package capability

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

func InputHash(raw json.RawMessage) (string, error) {
	value, err := decodeJSON(raw)
	if err != nil {
		return "", err
	}
	if _, ok := value.(map[string]any); !ok {
		return "", errors.New("capability input must be a JSON object")
	}
	canonical, err := marshalJS(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func CanonicalInputHash(input CreateCustomerInput) (string, error) {
	return canonicalHash(input)
}

func CanonicalDeactivateCustomerInputHash(input DeactivateCustomerInput) (string, error) {
	return canonicalHash(input)
}

func canonicalHash(value any) (string, error) {
	encoded, err := marshalJS(value)
	if err != nil {
		return "", err
	}
	normalized, err := decodeJSON(encoded)
	if err != nil {
		return "", err
	}
	canonical, err := marshalJS(normalized)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}
