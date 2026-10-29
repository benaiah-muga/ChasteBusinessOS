package httpapi

import (
	"sort"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

// chatToolLimit keeps each provider request small enough for strict gateways
// and keeps the choice set focused. The model can still ask for more work in a
// later turn; a broad catalog is not the same as a useful shortlist.
const chatToolLimit = 12

var chatCoreToolIDs = []string{
	"signals.list",
	"skills.find",
	"skills.load",
	"documents.searchMemory",
	"accounting.overview",
}

var chatDailyBriefToolIDs = []string{
	"accounting.arAging",
	"purchasing.apAging",
	"inventory.stockReport",
	"crm.listTasks",
	"hr.leaveCalendar",
	"support.listConversations",
	"support.listTickets",
	"documents.listIngestedDocuments",
}

type chatToolGroup struct {
	keywords []string
	ids      []string
}

var chatToolGroups = []chatToolGroup{
	{keywords: []string{"invoice", "receivable", "revenue", "profit", "loss", "cash", "finance", "financial", "balance sheet", "ledger", "payment", "paid", "overdue", "margin", "spend", "spent", "cost"}, ids: []string{
		"accounting.createInvoice", "accounting.recordPayment", "accounting.listInvoices",
		"analytics.salesByCustomer", "crm.listCustomers", "crm.createCustomer", "accounting.incomeStatement",
		"accounting.balanceSheet", "accounting.cashFlow", "accounting.cashForecast", "accounting.trialBalance",
	}},
	{keywords: []string{"expense", "reimburse", "claim", "receipt"}, ids: []string{
		"accounting.listExpenseClaims", "accounting.submitExpenseClaim",
	}},
	{keywords: []string{"why", "change", "trend", "report", "compare", "month over month", "explain"}, ids: []string{
		"analytics.revenueByMonth", "analytics.explainChange", "analytics.pipelineByStage", "analytics.invoiceAging",
		"analytics.salesByCustomer", "analytics.stockLevels",
	}},
	{keywords: []string{"bill", "supplier", "vendor", "payable", "purchase", "procure", "pay run"}, ids: []string{
		"purchasing.listWorkspace", "purchasing.listPurchaseWorkflow", "purchasing.createBill", "purchasing.createVendor",
		"purchasing.listPaymentRuns", "purchasing.priceHistory", "purchasing.supplierStatement",
	}},
	{keywords: []string{"stock", "inventory", "reorder", "sku", "warehouse", "lot", "product"}, ids: []string{
		"inventory.createItem", "inventory.adjustStock", "inventory.stockReport", "inventory.itemHistory",
		"inventory.listLots", "inventory.listLocations", "inventory.replenishmentPlan", "analytics.stockLevels",
	}},
	{keywords: []string{"customer", "deal", "pipeline", "crm", "lead", "contact", "saved view", "saved-view", "customer view", "profile", "tags", "notes", "owner"}, ids: []string{
		"crm.listCustomers", "crm.getCustomerProfile", "crm.listCustomerViews", "crm.customerTimeline", "crm.createCustomer", "crm.listDeals", "crm.pipelineReport", "analytics.salesByCustomer",
	}},
	{keywords: []string{"task", "follow up", "follow-up"}, ids: []string{
		"crm.listTasks", "crm.createTask", "crm.completeTask",
	}},
	{keywords: []string{"sales", "order", "sell", "quote", "estimate"}, ids: []string{
		"sales.listOrders", "accounting.listQuotes", "accounting.createQuote", "sales.createOrder",
	}},
	{keywords: []string{"employee", "people", "leave", "payroll", "hire", "applicant", "attendance"}, ids: []string{
		"hr.report", "hr.listEmployees", "hr.leaveCalendar", "hr.requestLeave",
	}},
	{keywords: []string{"project", "kanban", "board"}, ids: []string{
		"projects.list", "projects.listBoard", "projects.createProject", "projects.createTask",
	}},
	{keywords: []string{"support", "ticket", "helpdesk", "customer question", "knowledge"}, ids: []string{
		"support.listConversations", "support.searchKnowledge", "support.createTicket",
	}},
	{keywords: []string{"campaign", "marketing", "segment"}, ids: []string{
		"marketing.overviewSnapshot",
	}},
	{keywords: []string{"manufactur", "bom", "production", "work order", "factory"}, ids: []string{
		"manufacturing.overviewReport",
	}},
	{keywords: []string{"budget", "tax", "close", "period", "recurring"}, ids: []string{
		"accounting.listBudgetScenarios", "accounting.periodCloseWorkbench",
	}},
	{keywords: []string{"policy", "approval threshold", "autonomy", "persona", "soul", "standing instructions"}, ids: []string{
		"iam.getOrgPolicy", "iam.setAgentSoul",
	}},
}

func isChatBriefRequest(message string) bool {
	lower := strings.ToLower(message)
	if containsAny(lower, "notification", "notifications") && containsAny(lower, "mark", "read", "unread") {
		return false
	}
	for _, keyword := range []string{"brief", "attention", "changed", "change since", "recommend", "priority", "needs me", "what happened today", "what happened since", "what should i do", "catch me up", "status update"} {
		if strings.Contains(lower, keyword) {
			return true
		}
	}
	return false
}

// selectChatToolSpecs picks a focused, deterministic toolset for one turn.
// The selection is deliberately transparent: keyword groups cover the jobs a
// workmate is expected to do, and the full catalog remains available to other
// agents such as MCP and scheduled routines.
func selectChatToolSpecs(all []capability.AgentToolSpec, message string) []capability.AgentToolSpec {
	byID := make(map[string]capability.AgentToolSpec, len(all))
	for _, tool := range all {
		byID[tool.ID] = tool
	}
	selected := make(map[string]bool, chatToolLimit)
	add := func(id string) {
		if len(selected) >= chatToolLimit || selected[id] {
			return
		}
		if _, exists := byID[id]; !exists {
			return
		}
		selected[id] = true
	}
	for _, id := range chatCoreToolIDs {
		add(id)
	}
	lower := strings.ToLower(message)
	if isChatBriefRequest(message) {
		// The built-in daily_brief composes the cross-module reads. Keep the
		// selection small so the model has one obvious job, not twenty.
		return sortedChatTools(selected, byID)
	}
	// Prioritize the exact reads and writes a job needs before filling the
	// remaining slots from the broad groups. This keeps "cash position" from
	// being crowded out by invoice-writing tools and vice versa.
	if containsAny(lower, "cash", "runway", "burn", "forecast", "position") {
		add("accounting.cashFlow")
		add("accounting.cashForecast")
	}
	if containsAny(lower, "invoice", "receivable", "overdue", "owes", "unpaid") {
		add("accounting.listInvoices")
		add("accounting.arAging")
		add("analytics.invoiceAging")
		if containsAny(lower, "create", "draft", "issue", "send", "raise", "new") {
			add("accounting.createInvoice")
			add("crm.listCustomers")
			add("crm.createCustomer")
			add("accounting.recordPayment")
		}
	}
	if containsAny(lower, "bill", "supplier", "vendor", "payable") {
		add("purchasing.listWorkspace")
		add("purchasing.apAging")
		if containsAny(lower, "create", "enter", "record", "add", "new") {
			add("purchasing.createBill")
			add("purchasing.createVendor")
		}
	}
	if containsAny(lower, "profit", "revenue", "margin", "income", "loss") {
		add("accounting.incomeStatement")
		add("accounting.balanceSheet")
	}
	if containsAny(lower, "top customer", "best customer", "customer revenue", "sales by customer") {
		add("analytics.salesByCustomer")
		add("crm.listCustomers")
	}
	if containsAny(lower, "stock", "reorder", "out of stock", "restock") {
		add("inventory.stockReport")
		add("inventory.replenishmentPlan")
	}
	if containsAny(lower, "notification", "notifications", "unread") {
		add("notifications.markRead")
	}
	if containsAny(lower, "task", "todo", "follow up", "follow-up") {
		add("crm.listTasks")
	}
	if containsAny(lower, "saved view", "saved-view", "customer view") {
		add("crm.listCustomerViews")
		if containsAny(lower, "save", "create", "pin", "new") {
			add("crm.saveCustomerView")
		}
	}
	for _, group := range chatToolGroups {
		matched := false
		for _, keyword := range group.keywords {
			if strings.Contains(lower, keyword) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		for _, id := range group.ids {
			add(id)
		}
	}
	// No domain keywords and no brief language: keep a useful general read set
	// instead of sending the entire catalog.
	if len(selected) <= len(chatCoreToolIDs)+1 {
		for _, id := range chatDailyBriefToolIDs {
			add(id)
		}
	}
	return sortedChatTools(selected, byID)
}

func sortedChatTools(selected map[string]bool, byID map[string]capability.AgentToolSpec) []capability.AgentToolSpec {
	out := make([]capability.AgentToolSpec, 0, len(selected))
	for id := range selected {
		out = append(out, byID[id])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func containsAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}
