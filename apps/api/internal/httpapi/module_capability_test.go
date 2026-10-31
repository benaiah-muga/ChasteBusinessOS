package httpapi

import (
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

// TestEveryInstalledModuleHasCapabilities prevents a module from appearing on
// the switchboard without a governed way for the agent to see or act in it.
// Read-only modules (analytics, signals, skills) still need at least one
// visible capability; modules with business writes need the write capabilities
// covered by the module matrix in docs/CAPABILITY_COVERAGE.md.
func TestEveryInstalledModuleHasCapabilities(t *testing.T) {
	modules := capability.CapabilityModules()
	visible := capability.CapabilityVisibleModules()
	for _, module := range moduleCatalog {
		if modules[module.Id] == 0 {
			t.Errorf("module %q is installed but has no supported capability", module.Id)
		}
		if visible[module.Id] == 0 {
			t.Errorf("module %q is installed but has no agent-visible capability", module.Id)
		}
	}
}
