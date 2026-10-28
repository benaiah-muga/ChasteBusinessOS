package capability

import "testing"

func TestWorkflowSkillsReferenceExecutableCapabilities(t *testing.T) {
	byID := make(map[string]Skill, len(skillsCatalog))
	for _, skill := range skillsCatalog {
		byID[skill.ID] = skill
		for _, capabilityID := range skill.Capabilities {
			spec, exists := capabilitySpecs[capabilityID]
			if !exists || !supportedCapability(capabilityID) {
				t.Errorf("skill %s references unsupported capability %s", skill.ID, capabilityID)
				continue
			}
			if spec.humanOnly || spec.agentHidden != "" {
				t.Errorf("skill %s references hidden capability %s", skill.ID, capabilityID)
			}
		}
		if len(skill.Steps) == 0 || len(skill.Capabilities) == 0 {
			t.Errorf("skill %s has no steps or capabilities", skill.ID)
		}
	}

	quote, exists := byID["quote-to-cash"]
	if !exists {
		t.Fatal("quote-to-cash skill is missing")
	}
	for _, required := range []string{"sales.createOrderFromQuote", "sales.confirmOrder", "sales.deliverOrder", "accounting.recordPayment"} {
		if !skillHasCapability(quote, required) {
			t.Errorf("quote-to-cash does not continue through %s", required)
		}
	}
	replenish, exists := byID["replenishment-to-payment"]
	if !exists {
		t.Fatal("replenishment-to-payment skill is missing")
	}
	for _, required := range []string{"inventory.replenishmentPlan", "accounting.cashForecast", "purchasing.receiveGoods", "purchasing.createBill", "purchasing.createPaymentRun"} {
		if !skillHasCapability(replenish, required) {
			t.Errorf("replenishment-to-payment does not continue through %s", required)
		}
	}
}

func skillHasCapability(skill Skill, capabilityID string) bool {
	for _, candidate := range skill.Capabilities {
		if candidate == capabilityID {
			return true
		}
	}
	return false
}
