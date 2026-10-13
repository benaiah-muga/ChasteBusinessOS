package capability

import (
	"encoding/json"
	"sort"
)

type agentToolDefinition struct {
	description string
	schema      string
}

// agentToolDefinitions is deliberately narrower than the capability registry.
// A tool is advertised only after its model-facing contract is documented here.
// Every call is still parsed and authorized by the capability executor.
var agentToolDefinitions = map[string]agentToolDefinition{
	listCustomersCapabilityID: {
		description: "Search organization customers by name, email, or phone. Returns customer IDs, names, and email addresses. Leave query out to list the first matching customers.",
		schema:      `{"type":"object","properties":{"query":{"type":"string","description":"Optional text to match against customer name, email, or phone."}},"additionalProperties":false}`,
	},
	listDealsCapabilityID: {
		description: "List organization CRM deals with their stage, value in minor currency units, and linked customer. This tool takes no input.",
		schema:      `{"type":"object","properties":{},"additionalProperties":false}`,
	},
	listTasksCapabilityID: {
		description: "List organization CRM tasks. Set openOnly to true to omit completed tasks; omit it to include all tasks.",
		schema:      `{"type":"object","properties":{"openOnly":{"type":"boolean","description":"When true, return only unfinished tasks."}},"additionalProperties":false}`,
	},
	pipelineReportCapabilityID: {
		description: "Summarize deal counts and values by pipeline stage, including open and weighted forecast totals. This tool takes no input.",
		schema:      `{"type":"object","properties":{},"additionalProperties":false}`,
	},
	createCustomerCapabilityID: {
		description: "Create a customer in this organization. Provide a name and any known contact details. The result may include a duplicate warning; check it before creating another record.",
		schema:      `{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":120,"description":"Customer or organization name."},"email":{"type":"string","format":"email","description":"Optional valid contact email."},"phone":{"type":"string","maxLength":40,"description":"Optional contact phone number."},"preferredContactMethod":{"type":"string","enum":["email","phone","whatsapp","other"]},"doNotContact":{"type":"boolean"}},"required":["name"],"additionalProperties":false}`,
	},
	createDealCapabilityID: {
		description: "Create a CRM deal in the lead stage. Values use integer minor currency units, for example cents. Link an existing customer by its UUID when known.",
		schema:      `{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":120},"customerId":{"type":"string","format":"uuid"},"valueMinor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Deal value in integer minor currency units."},"source":{"type":"string","maxLength":200},"ownerUserId":{"type":"string","format":"uuid"},"note":{"type":"string","maxLength":2000}},"required":["title"],"additionalProperties":false}`,
	},
	createTaskCapabilityID: {
		description: "Create an organization task. Use an RFC 3339 timestamp for dueAt. Link it to a CRM record with refType and refId when applicable.",
		schema:      `{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":200},"dueAt":{"type":"string","format":"date-time"},"assigneeUserId":{"type":"string","format":"uuid"},"refType":{"type":"string","maxLength":50},"refId":{"type":"string","format":"uuid"},"note":{"type":"string","maxLength":2000}},"required":["title"],"additionalProperties":false}`,
	},
	completeTaskCapabilityID: {
		description: "Mark an existing organization task complete. Requires the task UUID returned by crm.listTasks or crm.createTask.",
		schema:      `{"type":"object","properties":{"taskId":{"type":"string","format":"uuid"}},"required":["taskId"],"additionalProperties":false}`,
	},
}

type AgentToolSpec struct {
	ID          string          `json:"id"`
	Permission  string          `json:"permission"`
	Risk        string          `json:"risk"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// AgentTools returns only Go-executable capabilities that the signed user may
// invoke. The executor still rechecks identity, permission, policy, and input.
func AgentTools(permissions map[string]bool) []AgentToolSpec {
	ids := make([]string, 0, len(agentToolDefinitions))
	for id := range agentToolDefinitions {
		spec, exists := capabilitySpecs[id]
		if !exists || !supportedCapability(id) || spec.humanOnly || (!permissions[spec.permission] && !permissions["*"]) {
			continue
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	tools := make([]AgentToolSpec, 0, len(ids))
	for _, id := range ids {
		spec := capabilitySpecs[id]
		definition := agentToolDefinitions[id]
		tools = append(tools, AgentToolSpec{
			ID: id, Permission: spec.permission, Risk: spec.risk,
			Description: definition.description,
			InputSchema: json.RawMessage(definition.schema),
		})
	}
	return tools
}
