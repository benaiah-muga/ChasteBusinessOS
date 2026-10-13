package httpapi

// PurchasingWorkflowDisabledCapabilities remains for call-site compatibility;
// the Go workflow read is now the only supported implementation.
func PurchasingWorkflowDisabledCapabilities(enabled bool) map[string]struct{} {
	return map[string]struct{}{}
}
