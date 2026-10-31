package apicontract

// CapabilityExecutionRequest keeps the generic Go decoder shape while the
// OpenAPI contract publishes capability-specific request variants to clients.
type CapabilityExecutionRequest struct {
	CapabilityId string  `json:"capabilityId"`
	Input        RawJSON `json:"input"`
	IntentId     *string `json:"intentId,omitempty"`
}
