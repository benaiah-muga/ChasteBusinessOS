import { z } from "zod";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

/**
 * Skills: advisory domain playbooks the workmate can consult before running
 * multi-step operations. Skills are knowledge, not rules: they encode familiar
 * ERP practice so the workmate starts from competence, but it may improvise
 * whenever a situation does not fit the pattern.
 *
 * Progressive discovery keeps context small: skills.find returns only
 * one-line summaries; skills.load expands a single skill into its concise
 * steps. Detail is paid for only when the workmate decides the skill helps.
 */

interface Skill {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  steps: string[];
  capabilities: string[];
  notes?: string;
}

const SKILLS: Skill[] = [];

function skill(s: Skill) {
  SKILLS.push(s);
}

skill({
  id: "procure-to-pay",
  name: "Procure to pay",
  summary:
    "Buy from a vendor end to end: vendor on file, purchase order sent, goods received, bill matched and paid.",
  tags: ["purchasing", "vendor", "purchase order", "bill", "payment", "procurement", "buy", "rfq"],
  steps: [
    "Confirm what is being bought, the quantity, and the target vendor. Ask only for what is missing.",
    "If the vendor does not exist, create them with purchasing.createVendor, then continue where you left off.",
    "Create a purchase order with purchasing.createPurchaseOrder; put each distinct item on its own line.",
    "When goods or the service arrive, record them against the order with purchasing.receiveGoods.",
    "When the vendor's invoice arrives, record it with purchasing.createBill referencing the order so three-way matching runs.",
    "Pay with purchasing.payBill when the user says to pay; amounts above policy thresholds queue for approval on their own.",
    "Report back with the order number, received quantities, bill number, and payment status.",
  ],
  capabilities: [
    "purchasing.createVendor",
    "purchasing.createPurchaseOrder",
    "purchasing.receiveGoods",
    "purchasing.createBill",
    "purchasing.payBill",
  ],
  notes:
    "Never pay a bill that failed three-way matching without flagging the mismatch first. Partial deliveries are normal: receive what arrived and leave the order open.",
});

skill({
  id: "quote-to-cash",
  name: "Quote to cash",
  summary:
    "Sell end to end: quote the prospect, convert to an invoice on acceptance, collect the payment.",
  tags: ["sales", "quote", "quotation", "invoice", "payment", "customer", "collect", "receivable", "sell"],
  steps: [
    "Confirm the customer, what they are buying, prices, and any discount. Ask only for what is missing.",
    "If the customer does not exist, create them with crm.createCustomer, then continue where you left off.",
    "Draft a quotation with accounting.createQuote; share it with accounting.shareQuote if the customer wants a link.",
    "On acceptance, mirror the quote into an invoice with accounting.createInvoice, then mark it accepted with accounting.acceptQuote.",
    "Record the payment with accounting.recordPayment when it arrives.",
    "Report the quote number, invoice number, amount, and outstanding balance.",
  ],
  capabilities: [
    "crm.createCustomer",
    "accounting.createQuote",
    "accounting.shareQuote",
    "accounting.acceptQuote",
    "accounting.createInvoice",
    "accounting.recordPayment",
  ],
  notes:
    "If the customer negotiates, issue a new quote rather than editing the old one; quotes are offers, not mutable records.",
});

skill({
  id: "overdue-collections",
  name: "Overdue collections",
  summary:
    "Chase money you are owed: identify overdue invoices, draft a firm but polite chase, record payments as they land.",
  tags: ["collections", "overdue", "aging", "receivables", "chase", "remind", "dunning", "owe"],
  steps: [
    "Pull accounts receivable aging with accounting.arAging; identify the oldest and largest overdue balances.",
    "For each customer to chase, find their contact with crm.listCustomers.",
    "Draft a short chase per customer: invoice number, amount, days overdue, clear payment ask. Show drafts before sending anything.",
    "When payment arrives, record it with accounting.recordPayment.",
    "Summarize what is still outstanding after the round.",
  ],
  capabilities: ["accounting.arAging", "crm.listCustomers", "accounting.recordPayment"],
  notes:
    "Escalate tone gradually: a reminder first, a demand only after 60+ days. Never promise penalties or interest the user has not configured.",
});

skill({
  id: "month-end-close",
  name: "Month-end close",
  summary:
    "Close the books for a month: clear what is unposted, review the reports, then seal the period.",
  tags: ["close", "month end", "period", "reconcile", "books", "seal", "accounting", "reporting"],
  steps: [
    "List what still needs posting: unpaid bills (purchasing.apAging), unposted expense claims (accounting.listExpenseClaims).",
    "Help the user clear or consciously defer each item.",
    "Run accounting.trialBalance and accounting.balanceSheet; confirm the books balance before going further.",
    "Review accounting.incomeStatement with the user; explain surprise movements.",
    "Seal the month with accounting.closePeriod. It is destructive-class, so approval is required; say so.",
  ],
  capabilities: [
    "purchasing.apAging",
    "accounting.listExpenseClaims",
    "accounting.trialBalance",
    "accounting.balanceSheet",
    "accounting.incomeStatement",
    "accounting.closePeriod",
  ],
  notes:
    "If the balance sheet does not balance, stop: that is treated as corruption, not rounding. The year-end retained-earnings roll is separate (accounting.closeYear).",
});

skill({
  id: "stock-reorder",
  name: "Stock reorder",
  summary:
    "Keep shelves full: find items at or below their reorder point and raise purchase orders for the shortfall.",
  tags: ["stock", "reorder", "replenish", "inventory", "low stock", "restock", "purchase", "par"],
  steps: [
    "Pull inventory.stockReport and list items at or below their reorder point.",
    "For each item, suggest an order quantity from the reorder point and recent consumption in the report.",
    "Confirm the list and quantities with the user before ordering.",
    "Group items by the vendor the user prefers; create one purchase order per vendor with purchasing.createPurchaseOrder.",
    "Report the orders raised and what remains below par.",
  ],
  capabilities: ["inventory.stockReport", "purchasing.createPurchaseOrder"],
  notes:
    "If an item has no vendor recorded, ask rather than guessing. Lead times are not modeled yet, so say when something is urgent.",
});

skill({
  id: "payroll-run",
  name: "Payroll run",
  summary:
    "Pay the team for a period: verify time is logged, create the payroll run, execute it on approval.",
  tags: ["payroll", "salary", "wages", "pay team", "hr", "time", "run payroll"],
  steps: [
    "List employees with hr.listEmployees and confirm who should be paid this period.",
    "Check hr.timeReport for the period; chase missing time entries before creating the run.",
    "Create the run with hr.createPayrollRun.",
    "Executing pays real money: hr.executePayrollRun is approval-gated, so tell the user it is waiting in the Approvals inbox.",
    "After approval, confirm net pay per person and the posted journal entry.",
  ],
  capabilities: ["hr.listEmployees", "hr.timeReport", "hr.createPayrollRun", "hr.executePayrollRun"],
  notes:
    "Never create a run for someone deactivated mid-period without asking. A wrong run is voided with hr.voidPayrollRun, not edited.",
});

skill({
  id: "support-triage",
  name: "Customer support triage",
  summary:
    "Handle an inbound customer conversation: understand the issue, resolve what you can, escalate what you cannot.",
  tags: ["support", "customer care", "ticket", "conversation", "escalate", "help", "chat", "widget"],
  steps: [
    "Read the conversation with support.readConversation; restate the customer's problem in one line to confirm understanding.",
    "For order or delivery questions, check support.lookupOrderStatus before asking the customer anything.",
    "Search the knowledge base with support.searchKnowledge for the documented answer.",
    "If the documented answer resolves it, reply with support.postMessage and close it out with support.resolveConversation.",
    "If it needs a human (refunds, complaints, anything undocumented), escalate with support.escalateConversation and tell the customer a person will follow up.",
  ],
  capabilities: [
    "support.readConversation",
    "support.lookupOrderStatus",
    "support.searchKnowledge",
    "support.postMessage",
    "support.resolveConversation",
    "support.escalateConversation",
  ],
  notes:
    "Money promises (refunds, credits) are always human decisions. Never close a conversation the customer has not confirmed is settled.",
});

skill({
  id: "expense-review",
  name: "Expense claim review",
  summary:
    "Move expense claims to a decision: list what is pending, summarize each, then record the decisions.",
  tags: ["expenses", "claim", "reimburse", "approve", "expense", "spend"],
  steps: [
    "List pending claims with accounting.listExpenseClaims.",
    "Summarize each for the approver: who, what, amount, any policy flags you notice.",
    "Collect decisions, then record them with accounting.decideExpenseClaim.",
    "Approved claims are paid with accounting.payExpenseClaim when the user says to pay, not automatically.",
  ],
  capabilities: ["accounting.listExpenseClaims", "accounting.decideExpenseClaim", "accounting.payExpenseClaim"],
});

const findInput = z.object({
  task: z
    .string()
    .min(3)
    .max(500)
    .describe("What the user wants done, in a few words, e.g. 'buy stock from a new vendor'"),
});

const findOutput = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
    }),
  ),
  note: z.string(),
});

const loadInput = z.object({
  id: z.string().min(3).max(80).describe("Skill id returned by skills.find"),
});

const loadOutput = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  steps: z.array(z.string()),
  capabilities: z.array(z.string()),
  notes: z.string().optional(),
});

function searchSkills(task: string): Skill[] {
  const words = task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return SKILLS.map((s) => {
    const haystack = `${s.name} ${s.summary} ${s.tags.join(" ")}`.toLowerCase();
    return { s, score: words.reduce((acc, w) => acc + (haystack.includes(w) ? 1 : 0), 0) };
  })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((m) => m.s);
}

export function registerSkillCapabilities(registry: CapabilityRegistry): void {
  registry.register(
    defineCapability({
      id: "skills.find",
      title: "Find a skill",
      intent:
        "Search advisory playbooks for multi-step operations like buying, selling, collecting overdue invoices, closing the books, running payroll, or handling support, and get back one-line summaries",
      module: "skills",
      risk: "read",
      permission: "documents.read",
      input: findInput,
      output: findOutput,
      execute: async (_ctx, input) => {
        const matches = searchSkills(input.task);
        return {
          skills: matches.map((s) => ({ id: s.id, name: s.name, summary: s.summary })),
          note:
            matches.length > 0
              ? "Advisory playbooks, not rules. Call skills.load with an id to see its steps before acting."
              : "No skill matches. Improvise from the available capabilities, and say what you are doing.",
        };
      },
    }),
  );

  registry.register(
    defineCapability({
      id: "skills.load",
      title: "Load a skill",
      intent: "Expand one skill into its concise step-by-step playbook and the capabilities that execute it",
      module: "skills",
      risk: "read",
      permission: "documents.read",
      input: loadInput,
      output: loadOutput,
      execute: async (_ctx, input) => {
        const s = SKILLS.find((x) => x.id === input.id);
        if (!s) {
          throw new Error(`unknown skill "${input.id}". Call skills.find to see what exists.`);
        }
        return {
          id: s.id,
          name: s.name,
          summary: s.summary,
          steps: s.steps,
          capabilities: s.capabilities,
          notes: s.notes,
        };
      },
    }),
  );
}
