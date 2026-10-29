package capability

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSearchAgentCapabilitiesReturnsOnlyAllowedGovernedWork(t *testing.T) {
	results := SearchAgentCapabilities(map[string]bool{"crm.write": true, "crm.read": true}, "create customer", 10)
	found := false
	for _, result := range results {
		if result.ID == "crm.createCustomer" {
			found = true
			if result.Risk == "" || len(result.InputSchema) == 0 {
				t.Fatalf("capability contract incomplete: %+v", result)
			}
		}
		if result.ID == "crm.listCustomerCollection" {
			t.Fatalf("human-only capability leaked into agent discovery: %+v", result)
		}
	}
	if !found {
		t.Fatalf("create customer not found: %+v", results)
	}
}

func TestAgentCapabilityByIDRefusesUnavailableWork(t *testing.T) {
	if _, ok := AgentCapabilityByID(map[string]bool{"*": true}, "crm.listCustomerCollection"); ok {
		t.Fatal("human-only capability must not be invokable by the agent")
	}
	if _, ok := AgentCapabilityByID(map[string]bool{"crm.read": true}, "accounting.createInvoice"); ok {
		t.Fatal("capability must require its own permission")
	}
	if capability, ok := AgentCapabilityByID(map[string]bool{"accounting.write": true}, "accounting.createInvoice"); !ok || capability.Risk == "" {
		t.Fatalf("expected accounting.createInvoice, got %+v %t", capability, ok)
	}
}

func TestCapabilityCatalogCoversTheManifest(t *testing.T) {
	manifestBytes, err := os.ReadFile("../../../../docs/migration/capabilities.json")
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var manifest struct {
		Capabilities []struct {
			ID string `json:"id"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	for _, entry := range manifest.Capabilities {
		if _, exists := capabilityCatalog[entry.ID]; !exists {
			t.Fatalf("catalog is missing %s; run pnpm agents:catalog", entry.ID)
		}
	}
}

func TestSearchAgentCapabilitiesIncludesCuratedToolsNewerThanTheManifest(t *testing.T) {
	found := false
	for _, result := range SearchAgentCapabilities(map[string]bool{"*": true}, "finance overview", 20) {
		if result.ID == "accounting.overview" {
			found = true
			if len(result.InputSchema) == 0 {
				t.Fatalf("accounting.overview is missing its schema: %+v", result)
			}
		}
	}
	if !found {
		t.Fatal("accounting.overview should be discoverable")
	}
}

func TestSearchAgentCapabilitiesFindsNotificationMarkRead(t *testing.T) {
	results := SearchAgentCapabilities(map[string]bool{"notifications.read": true}, "mark notification read", 10)
	for _, result := range results {
		if result.ID == notificationMarkReadCapabilityID {
			return
		}
	}
	t.Fatalf("notifications.markRead missing from capability search: %+v", results)
}

func TestSearchAgentCapabilitiesRanksNaturalLanguageDiscovery(t *testing.T) {
	results := SearchAgentCapabilities(map[string]bool{"*": true}, "find a customer", 8)
	if len(results) == 0 {
		t.Fatal("natural-language discovery returned nothing")
	}
	if results[0].ID != "crm.listCustomers" {
		ids := make([]string, 0, len(results))
		for _, result := range results {
			ids = append(ids, result.ID)
		}
		t.Fatalf("discovery ranked %q first, want crm.listCustomers: %v", results[0].ID, ids)
	}
	if results := SearchAgentCapabilities(map[string]bool{"*": true}, "the a of", 8); results != nil {
		t.Fatalf("a query of filler words should not match the whole catalog: %+v", results)
	}
	if results := SearchAgentCapabilities(map[string]bool{"*": true}, "...", 8); results != nil {
		t.Fatalf("a query of punctuation should not match the whole catalog: %+v", results)
	}
}
