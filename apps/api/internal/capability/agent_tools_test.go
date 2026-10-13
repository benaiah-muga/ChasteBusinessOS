package capability

import (
	"encoding/json"
	"testing"
)

func TestAgentToolsAreGoSupportedPermissionScopedAndSorted(t *testing.T) {
	tools := AgentTools(map[string]bool{"crm.read": true})
	if len(tools) == 0 {
		t.Fatal("expected tools for CRM read permission")
	}
	previous := ""
	for _, tool := range tools {
		if tool.ID <= previous {
			t.Fatalf("agent tools are not sorted: %q after %q", tool.ID, previous)
		}
		previous = tool.ID
		if tool.Permission != "crm.read" || !supportedCapability(tool.ID) || tool.Risk == "" {
			t.Fatalf("invalid permission-filtered tool: %+v", tool)
		}
		assertUsefulAgentToolContract(t, tool)
	}
	for _, tool := range tools {
		if tool.ID == listCRMCustomerCollectionCapabilityID {
			t.Fatalf("human-only capability was exposed to agent: %s", tool.ID)
		}
	}
	if got := AgentTools(nil); len(got) != 0 {
		t.Fatalf("no-permission user received %d tools", len(got))
	}
	if got := AgentTools(map[string]bool{"*": true}); len(got) <= len(tools) {
		t.Fatalf("wildcard permission did not expose additional supported capabilities: %d vs %d", len(got), len(tools))
	}
}

func TestAgentToolsExposeOnlyAuthoredContracts(t *testing.T) {
	tools := AgentTools(map[string]bool{"*": true})
	if len(tools) != len(agentToolDefinitions) {
		t.Fatalf("advertised %d tools for %d authored contracts", len(tools), len(agentToolDefinitions))
	}
	for _, tool := range tools {
		assertUsefulAgentToolContract(t, tool)
	}
}

func assertUsefulAgentToolContract(t *testing.T, tool AgentToolSpec) {
	t.Helper()
	var schema struct {
		Type                 string                     `json:"type"`
		Properties           map[string]json.RawMessage `json:"properties"`
		Required             []string                   `json:"required"`
		AdditionalProperties *bool                      `json:"additionalProperties"`
	}
	if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
		t.Fatalf("%s has invalid schema: %v", tool.ID, err)
	}
	if schema.Type != "object" || schema.AdditionalProperties == nil || *schema.AdditionalProperties {
		t.Fatalf("%s must advertise a closed object schema: %s", tool.ID, tool.InputSchema)
	}
	if len(tool.Description) < 40 {
		t.Fatalf("%s description does not explain the operation: %q", tool.ID, tool.Description)
	}
	for _, required := range schema.Required {
		if _, exists := schema.Properties[required]; !exists {
			t.Fatalf("%s requires undeclared property %q", tool.ID, required)
		}
	}
	fieldTypes := map[string]map[string]string{
		"crm.listCustomers":  {"query": "string"},
		"crm.listTasks":      {"openOnly": "boolean"},
		"crm.createCustomer": {"name": "string"},
		"crm.createDeal":     {"title": "string"},
		"crm.createTask":     {"title": "string"},
		"crm.completeTask":   {"taskId": "string"},
	}
	for field, wantType := range fieldTypes[tool.ID] {
		var property struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(schema.Properties[field], &property); err != nil || property.Type != wantType {
			t.Fatalf("%s.%s type=%q err=%v, want %q", tool.ID, field, property.Type, err, wantType)
		}
	}
	if tool.ID == createDealCapabilityID {
		var valueMinor struct {
			Minimum *int64 `json:"minimum"`
			Maximum *int64 `json:"maximum"`
		}
		if err := json.Unmarshal(schema.Properties["valueMinor"], &valueMinor); err != nil {
			t.Fatalf("crm.createDeal.valueMinor has invalid schema: %v", err)
		}
		if valueMinor.Minimum == nil || *valueMinor.Minimum != 0 || valueMinor.Maximum == nil || *valueMinor.Maximum != 9007199254740991 {
			t.Fatalf("crm.createDeal.valueMinor bounds min=%v max=%v, want [0, 9007199254740991]", valueMinor.Minimum, valueMinor.Maximum)
		}
	}
}
