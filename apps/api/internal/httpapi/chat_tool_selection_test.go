package httpapi

import (
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

func selectedIDs(message string) map[string]bool {
	all := capability.AgentTools(map[string]bool{"*": true})
	out := map[string]bool{}
	for _, tool := range selectChatToolSpecs(all, message) {
		out[tool.ID] = true
	}
	return out
}

func TestSelectChatToolSpecsBuildsADailyBrief(t *testing.T) {
	ids := selectedIDs("Give me a short brief of what needs my attention today, what changed since yesterday, and what you recommend I do first.")
	for _, want := range []string{"signals.list", "accounting.overview", "documents.searchMemory"} {
		if !ids[want] {
			t.Fatalf("daily brief selection missing %s: %v", want, ids)
		}
	}
	if ids["accounting.createInvoice"] || len(ids) > len(chatCoreToolIDs) {
		t.Fatalf("daily brief should keep the model on daily_brief: %v", ids)
	}
}

func TestSelectChatToolSpecsFollowsTheRequestedJob(t *testing.T) {
	invoice := selectedIDs("Draft an invoice for Acme for three consulting days.")
	if !invoice["accounting.createInvoice"] || !invoice["accounting.listInvoices"] || !invoice["crm.createCustomer"] {
		t.Fatalf("invoice request missing invoice or customer tools: %v", invoice)
	}
	if invoice["inventory.stockReport"] {
		t.Fatalf("invoice request unexpectedly includes stock tools: %v", invoice)
	}

	stock := selectedIDs("Which products are below their reorder point, and should we restock?")
	if !stock["inventory.stockReport"] || !stock["inventory.replenishmentPlan"] {
		t.Fatalf("stock request missing inventory tools: %v", stock)
	}
	if stock["accounting.createInvoice"] {
		t.Fatalf("stock request unexpectedly includes invoicing: %v", stock)
	}
}

func TestSelectChatToolSpecsCapsTheShortlist(t *testing.T) {
	all := capability.AgentTools(map[string]bool{"*": true})
	got := selectChatToolSpecs(all, "brief on invoices, stock, sales, payroll, projects, support, marketing, manufacturing, tax, budgets, documents, and customers")
	if len(got) > chatToolLimit {
		t.Fatalf("selected %d tools, limit is %d", len(got), chatToolLimit)
	}
	for _, tool := range got {
		if tool.ID == "" || tool.Description == "" || len(tool.InputSchema) == 0 {
			t.Fatalf("incomplete selected tool: %+v", tool)
		}
	}
}

func TestSelectChatToolSpecsDefaultsToUsefulReads(t *testing.T) {
	ids := selectedIDs("Hello, what can you help with?")
	if !ids["signals.list"] || !ids["accounting.overview"] || !ids["documents.searchMemory"] {
		t.Fatalf("default selection is not useful: %v", ids)
	}
	if len(ids) > chatToolLimit {
		t.Fatalf("default selection too large: %d", len(ids))
	}
}

func TestSelectChatToolSpecsDoesNotTreatAWriteAsABrief(t *testing.T) {
	ids := selectedIDs("Create a bill for Lamp Parts Ltd for $250.00, due in 30 days. Tell me if it needs approval.")
	if !ids["purchasing.createBill"] || !ids["purchasing.listWorkspace"] {
		t.Fatalf("bill request missing purchasing tools: %v", ids)
	}
	if ids["accounting.overview"] && len(ids) <= len(chatCoreToolIDs) {
		t.Fatalf("bill request was reduced to a brief: %v", ids)
	}
}

func TestSelectChatToolSpecsRecognizesApprovalQuestions(t *testing.T) {
	if isChatBriefRequest("What approvals are waiting on my sign-off right now?") {
		t.Fatal("approval questions need the approvals inbox, not the daily brief")
	}
	ids := selectedIDs("What approvals are waiting on my sign-off right now?")
	if len(ids) <= len(chatCoreToolIDs) {
		t.Fatalf("approval question should keep useful reads available: %v", ids)
	}
}

func TestSelectChatToolSpecsFindsTopCustomerAnalytics(t *testing.T) {
	ids := selectedIDs("Who are our top customers by revenue this quarter?")
	if !ids["analytics.salesByCustomer"] || !ids["crm.listCustomers"] {
		t.Fatalf("top-customer request missing analytics or customer tools: %v", ids)
	}
}

func TestSelectChatToolSpecsPrioritizesCashAndOverdueReads(t *testing.T) {
	cash := selectedIDs("What is our cash position and how long will it last?")
	if !cash["accounting.cashFlow"] || !cash["accounting.cashForecast"] {
		t.Fatalf("cash request missing cash reads: %v", cash)
	}
	overdue := selectedIDs("Show me overdue invoices and who owes us the most.")
	if !overdue["accounting.arAging"] || !overdue["accounting.listInvoices"] {
		t.Fatalf("overdue request missing receivables reads: %v", overdue)
	}
}

func TestChatBriefIntentDoesNotHijackSpecificTodayQuestions(t *testing.T) {
	if isChatBriefRequest("What invoices are due today?") {
		t.Fatal("a specific invoice question should not become a composed brief")
	}
	if isChatBriefRequest("Give me a short brief of what needs my attention today") != true {
		t.Fatal("the actual brief request should stay a brief")
	}
}
func TestSelectChatToolSpecsFindsSavedCustomerViews(t *testing.T) {
	ids := selectedIDs("Show my saved customer views and pin the best one.")
	if !ids["crm.listCustomerViews"] {
		t.Fatalf("saved view request missing listCustomerViews: %v", ids)
	}
}

func TestSelectChatToolSpecsExposesNotificationMarkRead(t *testing.T) {
	ids := selectedIDs("Mark my unread notification as read.")
	if !ids["notifications.markRead"] {
		t.Fatalf("notification request missing notifications.markRead: %v", ids)
	}
}
