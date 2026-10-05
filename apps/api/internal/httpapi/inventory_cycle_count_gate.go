package httpapi

// InventoryCycleCountDisabledCapabilities keeps the opt-in Go session route
// closed to cycle-count writes until the separate write gate is enabled.
func InventoryCycleCountDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{
		"inventory.createCycleCount":  {},
		"inventory.recordCycleCounts": {},
		"inventory.postCycleCount":    {},
		"inventory.cancelCycleCount":  {},
	}
}
