package httpapi

// PurchasingWorkflowDisabledCapabilities keeps the direct session route closed
// for workflow reads until the Go Purchasing workflow selector is enabled.
func PurchasingWorkflowDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"purchasing.listPurchaseWorkflow": {}}
}
