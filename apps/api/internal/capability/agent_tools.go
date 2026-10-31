package capability

import (
	_ "embed"
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
	arAgingCapabilityID: {
		description: "Summarize outstanding customer invoices by age, including current, 30, 60, and 90-plus day totals and invoice-level balances. This tool takes no input.",
		schema:      `{"type":"object","properties":{},"additionalProperties":false}`,
	},
	purchasingListVendorsCapabilityID: {
		description: "List this organization's suppliers with their IDs, names, contact email, payment terms, and active state. Use the returned IDs when preparing a purchase order.",
		schema:      `{"type":"object","properties":{"includeInactive":{"type":"boolean","description":"When true, include deactivated suppliers. Defaults to false."}},"additionalProperties":false}`,
	},
	purchasingGetPurchaseOrderCapabilityID: {
		description: "Read one purchase order and its receipts by order number, including status, ordered lines, accepted, rejected, returned and remaining quantities, promised date, and total. Use it to verify what actually happened after an approval.",
		schema:      `{"type":"object","properties":{"poNumber":{"type":"integer","minimum":1,"description":"Purchase order number returned by the approval or purchasing list."}},"required":["poNumber"],"additionalProperties":false}`,
	},
	upsertOperationalRecordCapabilityID: {
		description: "Create or update a persistent operating record: a business objective, a deduplicated exception, or a Decision Record. Use a stable key so repeated detections update the same record instead of duplicating it. Put completion criteria, evidence, alternatives, recommendation, approval, actions, or verified result in details.",
		schema:      `{"type":"object","properties":{"kind":{"type":"string","enum":["objective","exception","decision"]},"stableKey":{"type":"string","minLength":1,"maxLength":200},"status":{"type":"string","minLength":1,"maxLength":40},"title":{"type":"string","minLength":1,"maxLength":200},"summary":{"type":"string","maxLength":2000},"details":{"type":"object","additionalProperties":true},"authorityRef":{"type":"string","maxLength":200},"approvalId":{"type":"string","format":"uuid"},"ownerUserId":{"type":"string","format":"uuid"}},"required":["kind","stableKey","status","title"],"additionalProperties":false}`,
	},
	getOperationalRecordCapabilityID: {
		description: "Read one persistent operating record by UUID, or by kind and stable key, including its card view for the conversation.",
		schema:      `{"type":"object","properties":{"id":{"type":"string","format":"uuid"},"kind":{"type":"string","enum":["objective","exception","decision"]},"stableKey":{"type":"string","maxLength":200}},"additionalProperties":false}`,
	},
	listOperationalRecordsCapabilityID: {
		description: "List persistent operating records, optionally filtered by objective, exception, or decision kind and by status.",
		schema:      `{"type":"object","properties":{"kind":{"type":"string","enum":["objective","exception","decision"]},"status":{"type":"string","maxLength":40},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}`,
	},
	selectWinningQuoteCapabilityID: {
		description: "Award the winning quote on a purchase RFQ. This is a money commitment: an agent call returns a pending human approval with the exact award and does not create a purchase order. Explain the award and the approval before calling it.",
		schema:      `{"type":"object","properties":{"rfqId":{"type":"string","format":"uuid","description":"Purchase RFQ UUID from the purchasing workflow."}},"required":["rfqId"],"additionalProperties":false}`,
	},
	purchasingSupplierPerformanceCapabilityID: {
		description: "Read supplier delivery performance, including average lead time in days, on-time rate, fill rate, order count, and backordered orders. Use it to compare approved suppliers before proposing a purchase.",
		schema:      `{"type":"object","properties":{},"additionalProperties":false}`,
	},
	createPurchaseOrderCapabilityID: {
		description: "Prepare a purchase order commitment for one supplier. This tool does not create the order directly: agent commitments return a pending human approval with the exact lines and total. Use purchasing.listVendors for the supplier ID and explain the proposal before calling it.",
		schema:      `{"type":"object","properties":{"vendorId":{"type":"string","format":"uuid","description":"Supplier UUID from purchasing.listVendors."},"memo":{"type":"string","maxLength":500,"description":"Optional business reason for the order."},"promisedAt":{"type":"string","format":"date-time","description":"Optional RFC 3339 delivery promise."},"lines":{"type":"array","minItems":1,"items":{"type":"object","properties":{"description":{"type":"string","minLength":1,"maxLength":200},"quantity":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"Quantity in thousandths; 1000 is one unit."},"unitPriceMinor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Unit price in integer minor currency units."},"expenseAccountCode":{"type":"string","pattern":"^[0-9]{4}$"},"sku":{"type":"string","maxLength":120}},"required":["description","quantity","unitPriceMinor"],"additionalProperties":false}}},"required":["vendorId","lines"],"additionalProperties":false}`,
	},
	inventoryReplenishmentPlanCapabilityID: {
		description: "Plan inventory replenishment from live stock, open reservations, recent sales demand, open purchase orders, and recorded costs. Returns suggested quantities, cost estimates, assumptions, and warnings. It does not create or reserve anything.",
		schema:      `{"type":"object","properties":{"sku":{"type":"string","minLength":1,"maxLength":120,"description":"Optional exact SKU to plan; omit to plan every active goods item."},"lookbackDays":{"type":"integer","minimum":7,"maximum":365,"description":"Days of sales history used for the demand rate. Defaults to 90."},"reviewDays":{"type":"integer","minimum":0,"maximum":90,"description":"Days of demand the target stock should cover beyond lead time. Defaults to 7."},"leadTimeDays":{"type":"integer","minimum":1,"maximum":365,"description":"Configured supplier lead time in days. Defaults to 14."},"serviceLevel":{"type":"string","enum":["90","95","98","99"],"description":"Service level used for safety stock. Defaults to 95."},"includeSufficient":{"type":"boolean","description":"When true, include items that need no action. Defaults to false."}},"additionalProperties":false}`,
	},
	salesCreateOrderFromQuoteCapabilityID: {
		description: "Award a sent sales quote into a draft sales order. The order keeps the quote lines and links both records; confirm the order separately to run the credit check and reserve stock, then deliver to invoice. This does not post revenue.",
		schema:      `{"type":"object","properties":{"quoteId":{"type":"string","format":"uuid","description":"Sent quote UUID returned by accounting.listQuotes."}},"required":["quoteId"],"additionalProperties":false}`,
	},
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

// agentToolContractsJSON is the reviewed model-facing contract catalog. It is
// generated from the capability manifest and a small hand-written set of empty
// input schemas, then checked in so tool descriptions can be reviewed like code.
//
//go:embed agent_tool_contracts.json
var agentToolContractsJSON []byte

func init() {
	var catalog struct {
		Tools []struct {
			ID          string          `json:"id"`
			Description string          `json:"description"`
			Schema      json.RawMessage `json:"schema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(agentToolContractsJSON, &catalog); err != nil {
		panic("agent tool contracts are not valid JSON: " + err.Error())
	}
	for _, entry := range catalog.Tools {
		if entry.ID == "" || entry.Description == "" || len(entry.Schema) == 0 {
			panic("agent tool contract is missing an id, description, or schema")
		}
		if _, exists := agentToolDefinitions[entry.ID]; exists {
			continue
		}
		agentToolDefinitions[entry.ID] = agentToolDefinition{description: entry.Description, schema: string(entry.Schema)}
	}
	mergeAgentDefinitionsIntoCatalog()
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
	ensureCapabilityCatalog()
	ids := make([]string, 0, len(agentToolDefinitions))
	for id := range agentToolDefinitions {
		spec, exists := capabilitySpecs[id]
		if !exists || !supportedCapability(id) || spec.humanOnly || spec.agentHidden != "" || (!permissions[spec.permission] && !permissions["*"]) {
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
