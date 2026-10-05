package httpapi

import "testing"

func TestInventoryCycleCountDisabledCapabilitiesRequiresExplicitEnablement(t *testing.T) {
	want := []string{
		"inventory.createCycleCount",
		"inventory.recordCycleCounts",
		"inventory.postCycleCount",
		"inventory.cancelCycleCount",
	}
	for _, capabilityID := range want {
		if _, disabled := InventoryCycleCountDisabledCapabilities(false)[capabilityID]; !disabled {
			t.Errorf("default-off gate did not disable %s", capabilityID)
		}
		if _, disabled := InventoryCycleCountDisabledCapabilities(true)[capabilityID]; disabled {
			t.Errorf("enabled gate still disables %s", capabilityID)
		}
	}
	if got := InventoryCycleCountDisabledCapabilities(true); len(got) != 0 {
		t.Fatalf("enabled gate returned unrelated disabled capabilities: %v", got)
	}
}
