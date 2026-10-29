package capability

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

const (
	skillsFindCapabilityID = "skills.find"
	skillsLoadCapabilityID = "skills.load"
)

type Skill struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Summary      string   `json:"summary"`
	Tags         []string `json:"tags"`
	Steps        []string `json:"steps"`
	Capabilities []string `json:"capabilities"`
	Notes        *string  `json:"notes,omitempty"`
}

var skillsCatalog = []Skill{
	{
		ID: "procure-to-pay", Name: "Procure to pay",
		Summary: "Buy from a vendor end to end: raise the request, get approval, collect quotes, order, receive, match the bill, pay.",
		Tags:    []string{"purchasing", "vendor", "purchase order", "bill", "payment", "procurement", "buy", "rfq", "quote", "approval"},
		Steps: []string{
			"Confirm what is being bought, roughly what it should cost, and why. Ask only for what is missing.",
			"Formal route: raise a purchase request with purchasing.createPurchaseRequest, then have a reviewer approve it with purchasing.decidePurchaseRequest.",
			"For competitive buying, send RFQs with purchasing.createRfq (needs an approved request), record each vendor's bid with purchasing.recordQuote, then award the best one with purchasing.selectWinningQuote - the award creates the PO after the required approval.",
			"Informal route (small or repeat buys): prepare the purchase order with purchasing.createPurchaseOrder; agent and system commitments queue for human approval before any order exists.",
			"If the vendor does not exist, create them with purchasing.createVendor, then continue where you left off.",
			"When goods or the service arrive, record them against the order with purchasing.receiveGoods.",
			"When the vendor's invoice arrives, record it with purchasing.createBill referencing the order so three-way matching runs.",
			"Pay with purchasing.payBill when the user says to pay; amounts above policy thresholds queue for approval on their own.",
			"Report back with the order number, received quantities, bill number, and payment status.",
		},
		Capabilities: []string{
			"purchasing.createVendor", "purchasing.createPurchaseRequest", "purchasing.decidePurchaseRequest",
			"purchasing.createRfq", "purchasing.recordQuote", "purchasing.selectWinningQuote",
			"purchasing.createPurchaseOrder", "purchasing.receiveGoods", "purchasing.createBill", "purchasing.payBill",
		},
		Notes: strPtrSkills("Never pay a bill that failed three-way matching without flagging the mismatch first. Partial deliveries are normal: receive what arrived and leave the order open. Use the formal RFQ route when value is high or vendors should compete; improvise the informal route when speed matters more than process."),
	},
	{
		ID: "quote-to-cash", Name: "Quote to cash",
		Summary: "Sell end to end: quote the prospect, award the quote into an order, ship it, invoice what shipped, collect the payment.",
		Tags:    []string{"sales", "quote", "quotation", "order", "delivery", "invoice", "payment", "customer", "collect", "receivable", "sell"},
		Steps: []string{
			"Confirm the customer, what they are buying, prices, and any discount. Ask only for what is missing.",
			"If the customer does not exist, create them with crm.createCustomer, then continue where you left off.",
			"Draft a quotation with accounting.createQuote - it goes out as sent immediately. Include a sku on stocked lines so fulfilment can reserve the right item.",
			"On acceptance, award it with sales.createOrderFromQuote. It creates a linked draft order and marks the quote accepted; no revenue posts yet.",
			"Confirm the order with sales.confirmOrder. This checks the customer's credit headroom and reserves stock; a shortfall is a backorder, not a silent promise.",
			"Ship with sales.deliverOrder. It consumes reservations, writes the stock legs, and creates the invoice for exactly what was delivered. Partial deliveries are normal.",
			"Record the payment with accounting.recordPayment when it arrives.",
			"Report the quote number, order number, delivered quantities, invoice number and amount, and outstanding balance.",
		},
		Capabilities: []string{"crm.createCustomer", "accounting.createQuote", "sales.createOrderFromQuote", "sales.confirmOrder", "sales.deliverOrder", "accounting.declineQuote", "accounting.recordPayment"},
		Notes:        strPtrSkills("The continuity path is sales.createOrderFromQuote. accounting.acceptQuote exists for deliberate invoice-first service work but skips stock reservation and fulfilment, so prefer the order path whenever goods ship. Quotes are offers, not mutable records: if the customer negotiates, decline the old quote and create a fresh one. Cancelling an untouched order returns its source quote to sent."),
	},
	{
		ID: "overdue-collections", Name: "Overdue collections",
		Summary: "Chase money you are owed: identify overdue invoices, draft a firm but polite chase, record payments as they land.",
		Tags:    []string{"collections", "overdue", "aging", "receivables", "chase", "remind", "dunning", "owe"},
		Steps: []string{
			"Pull accounts receivable aging with accounting.arAging; identify the oldest and largest overdue balances.",
			"For each customer to chase, find their contact with crm.listCustomers.",
			"Draft a short chase per customer: invoice number, amount, days overdue, clear payment ask. Show drafts before sending anything.",
			"When payment arrives, record it with accounting.recordPayment.",
			"Summarize what is still outstanding after the round.",
		},
		Capabilities: []string{"accounting.arAging", "crm.listCustomers", "accounting.recordPayment"},
		Notes:        strPtrSkills("Escalate tone gradually: a reminder first, a demand only after 60+ days. Never promise penalties or interest the user has not configured."),
	},
	{
		ID: "month-end-close", Name: "Month-end close",
		Summary: "Close the books for a month: clear what is unposted, review the reports, then seal the period.",
		Tags:    []string{"close", "month end", "period", "reconcile", "books", "seal", "accounting", "reporting"},
		Steps: []string{
			"List what still needs posting: unpaid bills (purchasing.apAging), unposted expense claims (accounting.listExpenseClaims).",
			"Help the user clear or consciously defer each item.",
			"Run accounting.trialBalance and accounting.balanceSheet; confirm the books balance before going further.",
			"Review accounting.incomeStatement with the user; explain surprise movements.",
			"Seal the month with accounting.closePeriod. It is destructive-class, so approval is required; say so.",
		},
		Capabilities: []string{
			"purchasing.apAging", "accounting.listExpenseClaims", "accounting.trialBalance",
			"accounting.balanceSheet", "accounting.incomeStatement", "accounting.closePeriod",
		},
		Notes: strPtrSkills("If the balance sheet does not balance, stop: that is treated as corruption, not rounding. The year-end retained-earnings roll is separate (accounting.closeYear)."),
	},
	{
		ID: "stock-reorder", Name: "Stock reorder",
		Summary: "Keep shelves full: find items at or below their reorder point and raise purchase orders for the shortfall.",
		Tags:    []string{"stock", "reorder", "replenish", "inventory", "low stock", "restock", "purchase", "par"},
		Steps: []string{
			"Call inventory.replenishmentPlan and explain the items it marks for reorder, including reservations, incoming supply, and the assumptions it returns.",
			"Confirm the suppliers, quantities, and timing with the user before preparing a commitment.",
			"Group items by the vendor the user prefers; prepare one purchase order per vendor with purchasing.createPurchaseOrder.",
			"Tell the user the order is pending approval when the tool returns an approval request, and report what remains below target.",
		},
		Capabilities: []string{"inventory.replenishmentPlan", "inventory.stockReport", "purchasing.createPurchaseOrder"},
		Notes:        strPtrSkills("Lead times are configured, not supplier-derived, and transfers are not modeled yet, so state both limitations when they matter. A prepared order is not a placed order until the approval executes."),
	},
	{
		ID: "replenishment-to-payment", Name: "Replenishment to payment",
		Summary: "Keep stock available without overcommitting cash: plan the shortage, check cash and suppliers, order, receive, match the bill, then pay.",
		Tags:    []string{"replenishment", "reorder", "stock", "supplier", "purchase order", "receipt", "bill", "cash", "payment", "procure"},
		Steps: []string{
			"Call inventory.replenishmentPlan and explain the shortfall, incoming supply, reservations, lead time, and assumptions. Never compute the quantity yourself.",
			"Before proposing a commitment, call accounting.cashForecast and purchasing.apAging. State the estimated cost, the cash it competes with, and any supplier due dates.",
			"Compare approved suppliers with purchasing.listVendors and purchasing.supplierPerformance. Prefer a supplier whose lead time and fill rate support the need.",
			"Prepare the purchase order with purchasing.createPurchaseOrder. Agent and system commitments queue for human approval; a prepared order is not placed.",
			"When a delivery arrives, record accepted and rejected quantities with purchasing.receiveGoods against the order and line.",
			"When the supplier invoice arrives, record it with purchasing.createBill referencing the order and line numbers. Three-way matching must pass before payment.",
			"Review the payable with purchasing.apAging. Pay through a reviewed purchasing.createPaymentRun and purchasing.instructPaymentRun, or purchasing.payBill for a single bill.",
			"Report the plan, the approval, the received quantities, the matched bill, and the payment status. Stop and surface any mismatch instead of paying around it.",
		},
		Capabilities: []string{
			"inventory.replenishmentPlan", "accounting.cashForecast", "purchasing.apAging",
			"purchasing.listVendors", "purchasing.supplierPerformance", "purchasing.createPurchaseOrder",
			"purchasing.receiveGoods", "purchasing.createBill", "purchasing.createPaymentRun",
			"purchasing.instructPaymentRun", "purchasing.payBill",
		},
		Notes: strPtrSkills("The planner is read-only. Cash forecast is a projection, not authority: say that when it drives the recommendation. Never pay a bill that failed three-way matching without a human decision on the mismatch. Receipts and bills stay attached to the purchase order so the next plan sees the incoming supply."),
	},
	{
		ID: "payroll-run", Name: "Payroll run",
		Summary: "Pay the team for a period: verify time is logged, create the payroll run, execute it on approval.",
		Tags:    []string{"payroll", "salary", "wages", "pay team", "hr", "time", "run payroll"},
		Steps: []string{
			"List employees with hr.listEmployees and confirm who should be paid this period.",
			"Check hr.timeReport for the period; chase missing time entries before creating the run.",
			"Create the run with hr.createPayrollRun.",
			"Executing pays real money: hr.executePayrollRun is approval-gated, so tell the user it is waiting in the Approvals inbox.",
			"After approval, confirm net pay per person and the posted journal entry.",
		},
		Capabilities: []string{"hr.listEmployees", "hr.timeReport", "hr.createPayrollRun", "hr.executePayrollRun"},
		Notes:        strPtrSkills("Never create a run for someone deactivated mid-period without asking. A wrong run is voided with hr.voidPayrollRun, not edited."),
	},
	{
		ID: "support-triage", Name: "Customer support triage",
		Summary: "Handle an inbound customer conversation: understand the issue, resolve what you can, escalate what you cannot.",
		Tags:    []string{"support", "customer care", "ticket", "conversation", "escalate", "help", "chat", "widget"},
		Steps: []string{
			"Read the conversation with support.readConversation; restate the customer's problem in one line to confirm understanding.",
			"For order or delivery questions, check support.lookupOrderStatus before asking the customer anything.",
			"Search the knowledge base with support.searchKnowledge for the documented answer.",
			"If the documented answer resolves it, reply with support.postMessage and close it out with support.resolveConversation.",
			"If it needs a human (refunds, complaints, anything undocumented), escalate with support.escalateConversation and tell the customer a person will follow up.",
		},
		Capabilities: []string{
			"support.readConversation", "support.lookupOrderStatus", "support.searchKnowledge",
			"support.postMessage", "support.resolveConversation", "support.escalateConversation",
		},
		Notes: strPtrSkills("Money promises (refunds, credits) are always human decisions. Never close a conversation the customer has not confirmed is settled."),
	},
	{
		ID: "expense-review", Name: "Expense claim review",
		Summary: "Move expense claims to a decision: list what is pending, summarize each, then record the decisions.",
		Tags:    []string{"expenses", "claim", "reimburse", "approve", "expense", "spend"},
		Steps: []string{
			"List pending claims with accounting.listExpenseClaims.",
			"Summarize each for the approver: who, what, amount, any policy flags you notice.",
			"Collect decisions, then record them with accounting.decideExpenseClaim.",
			"Approved claims are paid with accounting.payExpenseClaim when the user says to pay, not automatically.",
		},
		Capabilities: []string{"accounting.listExpenseClaims", "accounting.decideExpenseClaim", "accounting.payExpenseClaim"},
	},
}

func strPtrSkills(v string) *string {
	return &v
}

type SkillsFindInput struct {
	Task string `json:"task"`
}

type SkillsFindMatch struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
}

type SkillsFindOutput struct {
	Skills []SkillsFindMatch `json:"skills"`
	Note   string            `json:"note"`
}

type SkillsLoadInput struct {
	ID string `json:"id"`
}

type SkillsLoadOutput struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Summary      string   `json:"summary"`
	Steps        []string `json:"steps"`
	Capabilities []string `json:"capabilities"`
	Notes        *string  `json:"notes,omitempty"`
}

func ParseSkillsFindInput(raw json.RawMessage) (SkillsFindInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SkillsFindInput{}, err
	}
	var input SkillsFindInput
	if input.Task, err = requiredCRMDealString(fields, "task", 3, 500); err != nil {
		return SkillsFindInput{}, err
	}
	return input, nil
}

func ParseSkillsLoadInput(raw json.RawMessage) (SkillsLoadInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SkillsLoadInput{}, err
	}
	var input SkillsLoadInput
	if input.ID, err = requiredCRMDealString(fields, "id", 3, 80); err != nil {
		return SkillsLoadInput{}, err
	}
	return input, nil
}

func parseSkillsInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case skillsFindCapabilityID:
		return ParseSkillsFindInput(raw)
	case skillsLoadCapabilityID:
		return ParseSkillsLoadInput(raw)
	default:
		return nil, errors.New("unsupported skills capability")
	}
}

func skillsSearch(task string) []Skill {
	words := strings.FieldsFunc(strings.ToLower(task), func(r rune) bool {
		isLower := r >= 'a' && r <= 'z'
		isDigit := r >= '0' && r <= '9'
		return !(isLower || isDigit)
	})
	var filtered []string
	for _, word := range words {
		if len(word) > 2 {
			filtered = append(filtered, word)
		}
	}
	type scored struct {
		skill Skill
		score int
	}
	var matches []scored
	for _, skill := range skillsCatalog {
		haystack := strings.ToLower(skill.Name + " " + skill.Summary + " " + strings.Join(skill.Tags, " "))
		score := 0
		for _, word := range filtered {
			if strings.Contains(haystack, word) {
				score++
			}
		}
		if score > 0 {
			matches = append(matches, scored{skill: skill, score: score})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].score > matches[j].score })
	if len(matches) > 4 {
		matches = matches[:4]
	}
	var out []Skill
	for _, match := range matches {
		out = append(out, match.skill)
	}
	return out
}

func skillsFind(input SkillsFindInput) (SkillsFindOutput, error) {
	matches := skillsSearch(input.Task)
	out := SkillsFindOutput{Skills: []SkillsFindMatch{}}
	for _, match := range matches {
		out.Skills = append(out.Skills, SkillsFindMatch{ID: match.ID, Name: match.Name, Summary: match.Summary})
	}
	if len(matches) > 0 {
		out.Note = "Advisory playbooks, not rules. Call skills.load with an id to see its steps before acting."
	} else {
		out.Note = "No skill matches. Improvise from the available capabilities, and say what you are doing."
	}
	return out, nil
}

func skillsLoad(input SkillsLoadInput) (SkillsLoadOutput, error) {
	for _, skill := range skillsCatalog {
		if skill.ID == input.ID {
			return SkillsLoadOutput{
				ID: skill.ID, Name: skill.Name, Summary: skill.Summary,
				Steps: skill.Steps, Capabilities: skill.Capabilities, Notes: skill.Notes,
			}, nil
		}
	}
	return SkillsLoadOutput{}, errors.New(`unknown skill "` + input.ID + `". Call skills.find to see what exists.`)
}

// SkillReference is the compact form of a playbook that mentions a capability.
// It lets a caller point at the ordered steps without repeating them.
type SkillReference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SkillsForCapability lists the advisory playbooks that include one capability,
// so an agent that discovered a tool can also find the workflow it belongs to.
func SkillsForCapability(capabilityID string) []SkillReference {
	references := make([]SkillReference, 0, 2)
	for _, skill := range skillsCatalog {
		for _, id := range skill.Capabilities {
			if id == capabilityID {
				references = append(references, SkillReference{ID: skill.ID, Name: skill.Name})
				break
			}
		}
	}
	return references
}
