package capability

import (
	"encoding/json"
)

// InversePlan is a safe, declared reversal of one executed capability. It is
// used by the session "revert action" path, never by the executor itself.
type InversePlan struct {
	CapabilityID string
	Input        json.RawMessage
}

// PlanInverse builds the inverse input for actions whose output carries enough
// identity to reverse them. Actions without an unambiguous mapping return false
// so the caller can explain that no automatic checkpoint exists.
func PlanInverse(capabilityID string, output json.RawMessage) (InversePlan, bool) {
	var fields map[string]any
	if len(output) == 0 || json.Unmarshal(output, &fields) != nil {
		return InversePlan{}, false
	}
	switch capabilityID {
	case createCustomerCapabilityID:
		if customerID, ok := fields["customerId"].(string); ok && isUUID(customerID) {
			return planJSON(deactivateCustomerCapabilityID, map[string]any{"customerId": customerID})
		}
	case salesCreateOrderCapabilityID:
		if orderID, ok := fields["orderId"].(string); ok && isUUID(orderID) {
			return planJSON(salesCancelOrderCapabilityID, map[string]any{"orderId": orderID})
		}
	case recordPaymentCapabilityID:
		if paymentID, ok := fields["paymentId"].(string); ok && isUUID(paymentID) {
			return planJSON(reversePaymentCapabilityID, map[string]any{"paymentId": paymentID, "reason": "Reverted from a session checkpoint"})
		}
	case payBillCapabilityID:
		if paymentID, ok := fields["paymentId"].(string); ok && isUUID(paymentID) {
			return planJSON(reverseVendorPaymentCapabilityID, map[string]any{"vendorPaymentId": paymentID, "reason": "Reverted from a session checkpoint"})
		}
	case createBillCapabilityID:
		if entryID, ok := fields["entryId"].(string); ok && isUUID(entryID) {
			return planJSON(reverseEntryCapabilityID, map[string]any{"entryId": entryID})
		}
	case salesUpdateDraftOrderCapabilityID, salesRestoreDraftOrderCapabilityID:
		// Editing a draft is reversible from the nested before snapshot. The
		// generic field mapping cannot reach into it, so build the replacement
		// input explicitly.
		orderID, ok := fields["orderId"].(string)
		if !ok || !isUUID(orderID) {
			return InversePlan{}, false
		}
		before, ok := fields["before"].(map[string]any)
		if !ok {
			return InversePlan{}, false
		}
		input := map[string]any{"orderId": orderID}
		for _, key := range []string{"customerId", "note", "lines"} {
			if value, exists := before[key]; exists {
				input[key] = value
			}
		}
		target := salesRestoreDraftOrderCapabilityID
		if capabilityID == salesRestoreDraftOrderCapabilityID {
			target = salesUpdateDraftOrderCapabilityID
		}
		if len(input) < 3 {
			return InversePlan{}, false
		}
		return planJSON(target, input)
	}
	spec, exists := capabilitySpecs[capabilityID]
	if !exists || spec.inverseCapabilityID == "" || spec.inverseInputSource != "output" {
		return InversePlan{}, false
	}
	inverseInput := map[string]any{}
	for _, field := range spec.inverseFields {
		value, ok := fields[field]
		if !ok {
			return InversePlan{}, false
		}
		inverseInput[field] = value
	}
	for _, mapping := range spec.inverseFieldMappings {
		value, ok := fields[mapping.outputField]
		if !ok {
			return InversePlan{}, false
		}
		inverseInput[mapping.inputField] = value
	}
	if len(inverseInput) == 0 {
		return InversePlan{}, false
	}
	return planJSON(spec.inverseCapabilityID, inverseInput)
}

func planJSON(capabilityID string, input map[string]any) (InversePlan, bool) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return InversePlan{}, false
	}
	return InversePlan{CapabilityID: capabilityID, Input: encoded}, true
}
