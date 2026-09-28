package apicontract

import "encoding/json"

// MarshalJSON retains the field order used by the existing policy response.
func (response GoPolicyResponse) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Policy  Policy `json:"policy"`
		CanEdit bool   `json:"canEdit"`
	}{Policy: response.Policy, CanEdit: response.CanEdit})
}
