package capability

import (
	"encoding/json"
	"os"
	"testing"
)

func TestGoCapabilitySpecsCoverMigrationManifest(t *testing.T) {
	manifestBytes, err := os.ReadFile("../../../../docs/migration/capabilities.json")
	if err != nil {
		t.Fatalf("read capability manifest: %v", err)
	}
	var manifest struct {
		Capabilities []struct {
			ID                  string  `json:"id"`
			Module              string  `json:"module"`
			Permission          string  `json:"permission"`
			Risk                string  `json:"risk"`
			MoneyThresholdMinor *int64  `json:"moneyThresholdMinor"`
			InverseCapabilityID *string `json:"inverseCapabilityId"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode capability manifest: %v", err)
	}
	if len(manifest.Capabilities) == 0 {
		t.Fatal("capability manifest is empty")
	}

	seen := make(map[string]struct{}, len(manifest.Capabilities))
	for _, entry := range manifest.Capabilities {
		entry := entry
		t.Run(entry.ID, func(t *testing.T) {
			if _, exists := seen[entry.ID]; exists {
				t.Fatalf("duplicate capability %q in manifest", entry.ID)
			}
			seen[entry.ID] = struct{}{}

			if !supportedCapability(entry.ID) {
				t.Errorf("Go executor does not support manifest capability %q", entry.ID)
			}
			spec, exists := capabilitySpecs[entry.ID]
			if !exists {
				t.Errorf("Go executor has no spec for manifest capability %q", entry.ID)
				return
			}
			if spec.module != entry.Module || spec.permission != entry.Permission || spec.risk != entry.Risk {
				t.Errorf("Go spec for %s = module %q, permission %q, risk %q; manifest wants %q, %q, %q",
					entry.ID, spec.module, spec.permission, spec.risk, entry.Module, entry.Permission, entry.Risk)
			}
			var moneyThreshold int64
			if entry.MoneyThresholdMinor != nil {
				moneyThreshold = *entry.MoneyThresholdMinor
			}
			if spec.moneyThresholdMinor != moneyThreshold {
				t.Errorf("Go money threshold for %s = %d, manifest wants %d", entry.ID, spec.moneyThresholdMinor, moneyThreshold)
			}
			var inverse string
			if entry.InverseCapabilityID != nil {
				inverse = *entry.InverseCapabilityID
			}
			if spec.inverseCapabilityID != inverse {
				t.Errorf("Go inverse for %s = %q, manifest wants %q", entry.ID, spec.inverseCapabilityID, inverse)
			}
		})
	}
}
