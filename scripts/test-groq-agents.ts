/* eslint-disable no-console */
/**
 * Groq agentic benchmark: 10 end-to-end, verifiable multi-step business
 * processes driven through the REAL capability pipeline (registry +
 * executor + runAgentLoop + Postgres ledgers), model = openai/gpt-oss-120b
 * on Groq. Each task gets a fresh org; the org policy's money threshold is
 * raised so known-amount money steps run autonomously (only null-amount and
 * identity/destructive gates would require a human).
 */
import { and, asc, eq } from "drizzle-orm";
import {
  deals,
  documents,
  employees,
  invoices,
  items,
  ledgerEvents,
  memories,
  payments,
  payrollRuns,
  payslips,
  policies,
  posSessions,
  purchaseOrders,
  purchaseRequests,
  rfqs,
  stockMovements,
  supportConversations,
  supportMessages,
  users,
  vendorBills,
} from "@chaste/db";
import { getDb } from "@chaste/db";
import { OpenAiCompatAdapter, resolveClient, stripProviderPrefix } from "@chaste/ai";
import { GENESIS, CapabilityRegistry, runAgentLoop } from "@chaste/kernel";
import type { ModelAdapter } from "@chaste/kernel";
import { registerAccountingCapabilities } from "@chaste/module-accounting";
import { registerAnalyticsCapabilities } from "@chaste/module-analytics";
import { registerCrmCapabilities } from "@chaste/module-crm";
import { registerDocumentCapabilities } from "@chaste/module-documents";
import { registerHrCapabilities } from "@chaste/module-hr";
import { registerInventoryCapabilities } from "@chaste/module-inventory";
import { registerManufacturingCapabilities } from "@chaste/module-manufacturing";
import { registerPosCapabilities } from "@chaste/module-pos";
import { registerPurchasingCapabilities } from "@chaste/module-purchasing";
import { registerSkillCapabilities } from "../modules/skills/src/index";
import { registerSupportCapabilities } from "@chaste/module-support";
import { buildExecutor } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

/** Provider from env: groq | mistral | openrouter | nim (default nim). */
const PROVIDER = process.env.MODEL_PROVIDER ?? "groq";
const MODEL = stripProviderPrefix(process.env.MODEL_PRIMARY ?? "openai/gpt-oss-120b");
/** $18M minor — every known-amount test payment runs autonomously (int32-safe). */
const MONEY_THRESHOLD_MINOR = 1_800_000_000;

type Db = ReturnType<typeof getDb>["db"];

interface Task {
  key: string;
  modules: string[];
  orgName: string;
  goal: string;
  hints: string;
  maxSteps: number;
  expectedCaps: string[];
  verify: (db: Db, orgId: string) => Promise<{ ok: boolean; detail: string }>;
}

const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

const REGISTRARS: Record<string, (registry: CapabilityRegistry, db: Db) => void> = {
  accounting: (r, db) => registerAccountingCapabilities(r, { db }),
  analytics: (r, db) => registerAnalyticsCapabilities(r, { db }),
  crm: (r, db) => registerCrmCapabilities(r, { db }),
  documents: (r, db) => registerDocumentCapabilities(r, { db }),
  hr: (r, db) => registerHrCapabilities(r, { db }),
  inventory: (r, db) => registerInventoryCapabilities(r, { db }),
  manufacturing: (r, db) => registerManufacturingCapabilities(r, { db }),
  pos: (r, db) => registerPosCapabilities(r, { db }),
  purchasing: (r, db) => registerPurchasingCapabilities(r, { db }),
  skills: (r) => registerSkillCapabilities(r),
  support: (r, db) => registerSupportCapabilities(r, { db }),
};

/**
 * Groq caps a request at 128 tools. Like the production support agent, scope
 * the tool universe to the modules the task needs; the registry, executor,
 * policy engine and hash-chained ledger stay the real kernel pipeline.
 */
function buildScopedRegistry(db: Db, modules: string[]): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const m of modules) REGISTRARS[m]?.(registry, db);
  // A scoped registry is by construction an incomplete view: cross-module
  // inverses (purchasing.createBill -> accounting.reverseEntry) are absent
  // when the task scope omits their home module. Warn, then proceed; the
  // full registry still validates at boot.
  const fatal = registry.validateAll().filter((i) => i.level === "error");
  if (fatal.length) {
    console.warn("[scope] ignoring scoped conformance: " + fatal.map((f) => `${f.capabilityId} [${f.rule}]`).join(", "));
  }
  return registry;
}

const TASKS: Task[] = [
  {
    key: "quote-to-cash",
    modules: ['crm', 'accounting'],
    orgName: "Groq Retail Co",
    goal:
      "Sell to a new customer end to end. Create customer Acme Boutique, quote them 2 items (deluxe chair 5 x 25000 minor; oak table 1 x 90000 minor), convert the accepted quote into an invoice, record the customer paying the full invoice total, then use a read-only view to confirm the invoice is fully paid. Report invoice number, total in dollars and payment amount.",
    hints:
      "Sales: crm for the customer, accounting for quote/accept/payment/list. Minor units; quantities in thousandths (5000 = 5 units). Payment uses the total the quote/invoice tool actually returned.",
    maxSteps: 14,
    expectedCaps: ["crm.createCustomer", "accounting.createQuote", "accounting.acceptQuote", "accounting.recordPayment", "accounting.listInvoices"],
    verify: async (db, orgId) => {
      const inv = await db.select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.status, "paid")));
      const pay = await db.select().from(payments).where(eq(payments.orgId, orgId));
      if (inv.length !== 1) return { ok: false, detail: `expected 1 paid invoice, got ${inv.length}` };
      return { ok: pay.length === 1 && inv[0]!.totalMinor === pay[0]!.amountMinor, detail: `invoice ${inv[0]!.number} total=${inv[0]!.totalMinor} paid=${pay[0]!.amountMinor}` };
    },
  },
  {
    key: "pipeline-report",
    modules: ['crm', 'analytics'],
    orgName: "Groq SaaS Pipeline",
    goal:
      "Run the sales pipeline and report it. Create customer Lighthouse Labs, create 2 deals (Enterprise annual 150_000_00 minor; Starter monthly 2_000_00 minor), win the Enterprise deal, produce a pipeline report with stage counts and totals, then render an analytics report titled 'Pipeline Q3' with a narrative covering the won value. Report the metrics.",
    hints: "crm for customer/deal/move/pipeline report; then analytics.renderReport (give it title + narrative + sections with columns/rows).",
    maxSteps: 14,
    expectedCaps: ["crm.createCustomer", "crm.createDeal", "crm.moveDealStage", "crm.pipelineReport", "analytics.renderReport"],
    verify: async (db, orgId) => {
      const ds = await db.select().from(deals).where(eq(deals.orgId, orgId));
      const won = ds.filter((d) => d.stage === "won");
      if (ds.length !== 2) return { ok: false, detail: `expected 2 deals, got ${ds.length}` };
      return { ok: won.length === 1, detail: `${ds.length} deals, ${won.length} won (${won[0]?.valueMinor} minor)` };
    },
  },
  {
    key: "procure-to-pay",
    modules: ['inventory', 'purchasing', 'accounting'],
    orgName: "Groq Manufacturing Supply",
    goal:
      "Buy and pay for a component. Create inventory item 'Steel bracket' sku BRK-100 (sale price 2500 minor, reorder 500_000 thousandths), create vendor Northwind Metals, create a purchase order for 1,000_000 thousandths of brackets at 800 minor each, receive the full PO, then create and pay the matching bill in full. Confirm bracket stock on hand and that the bill is fully paid.",
    hints:
      "inventory for the item, purchasing for vendor → PO → receive → bill → pay. Match bill to the PO and received quantity. Read back inventory stock or AP state to confirm.",
    maxSteps: 18,
    expectedCaps: ["inventory.createItem", "purchasing.createVendor", "purchasing.createPurchaseOrder", "purchasing.receiveGoods", "purchasing.createBill", "purchasing.payBill"],
    verify: async (db, orgId) => {
      const [it] = await db.select().from(items).where(and(eq(items.orgId, orgId), eq(items.sku, "BRK-100")));
      if (!it) return { ok: false, detail: "item BRK-100 not found" };
      const moves = await db.select().from(stockMovements).where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, it.id)));
      const onHand = moves.reduce((s, m) => s + (m.quantityDelta ?? 0), 0);
      const bills = await db.select().from(vendorBills).where(eq(vendorBills.orgId, orgId));
      if (bills.length !== 1) return { ok: false, detail: `expected 1 bill, got ${bills.length}` };
      return {
        ok: onHand === 1_000_000 && bills[0]!.status === "paid",
        detail: `onHand=${onHand}, bill ${bills[0]!.number} ${bills[0]!.status} ${bills[0]!.paidMinor}/${bills[0]!.totalMinor}`,
      };
    },
  },
  {
    key: "inventory-reorder",
    modules: ['inventory', 'purchasing'],
    orgName: "Groq Bike Shop",
    goal:
      "Restock a low item. Create inventory item 'Road tire' sku TIRE-27 (reorder point 200_000 thousandths), run a stock report filtered to items below their reorder point, note the tire is short, create a PO to vendor Conti Trading for 500_000 thousandths at 1200 minor each, receive the full PO, then re-run the below-reorder report to prove tires are now covered. Report before/after.",
    hints: "inventory and purchasing only. stockReport(belowReorderOnly) before and after. Quantities in thousandths.",
    maxSteps: 16,
    expectedCaps: ["inventory.createItem", "inventory.stockReport", "purchasing.createVendor", "purchasing.createPurchaseOrder", "purchasing.receiveGoods"],
    verify: async (db, orgId) => {
      const [it] = await db.select().from(items).where(and(eq(items.orgId, orgId), eq(items.sku, "TIRE-27")));
      if (!it) return { ok: false, detail: "item TIRE-27 not found" };
      const moves = await db.select().from(stockMovements).where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, it.id)));
      const onHand = moves.reduce((s, m) => s + (m.quantityDelta ?? 0), 0);
      return { ok: onHand === 500_000 && onHand >= (it.reorderPointThousandths ?? 0), detail: `onHand=${onHand} reorder=${it.reorderPointThousandths}` };
    },
  },
  {
    key: "manufacturing-bom",
    modules: ['inventory', 'manufacturing'],
    orgName: "Groq Assembly Works",
    goal:
      "Run a small manufacturing batch. Items: 'Widget' sku WID-1 (assembly), 'Gear' sku GR-1, 'Screw' sku SC-1. Bring 2_000 gears and 4_000 screws into stock (quantities are thousandths: 2000 = 2.0 units, 4000 = 4.0 units). Define the BOM for WID-1 (1 gear + 4 screws per widget, 0% scrap), preview its cost, create a work order for exactly 1000 thousandths (1 widget) at 100% yield, release it, and produce it with lot code B1. Then read back stock: widget stock rose, gear and screw stock fell. Report produced quantity and ending stock.",
    hints:
      "inventory: createItem (type assembly/component) then adjustStock for GR-1=2000 and SC-1=4000 (note ≥3 chars). manufacturing: defineBom → costPreview → createWorkOrder → releaseWorkOrder (REUSE the exact workOrderId createWorkOrder returned, never an invented one) → produceFromBom. Use inventory stockReport/listItems to confirm.",
    maxSteps: 20,
    expectedCaps: ["inventory.createItem", "inventory.adjustStock", "manufacturing.defineBom", "manufacturing.createWorkOrder", "manufacturing.releaseWorkOrder", "manufacturing.produceFromBom"],
    verify: async (db, orgId) => {
      const its = await db.select().from(items).where(eq(items.orgId, orgId));
      const bySku = new Map(its.map((i) => [i.sku, i.id]));
      if (!bySku.has("WID-1") || !bySku.has("GR-1") || !bySku.has("SC-1")) return { ok: false, detail: "items missing" };
      const moves = await db.select().from(stockMovements).where(eq(stockMovements.orgId, orgId));
      const sum = (id: string) => moves.filter((m) => m.itemId === id).reduce((s, m) => s + (m.quantityDelta ?? 0), 0);
      const wid = sum(bySku.get("WID-1")!);
      const gr = sum(bySku.get("GR-1")!);
      const sc = sum(bySku.get("SC-1")!);
      return {
        ok: wid > 0 && (gr >= 0 && gr <= 2_000) && (sc >= 0 && sc <= 4_000),
        detail: `WID-1→${wid} GR-1→${gr} SC-1→${sc} (thousandths)`,
      };
    },
  },
  {
    key: "payroll-leave",
    modules: ['hr'],
    orgName: "Groq HR Co",
    goal:
      `Run payroll for the current month. Hire Ada (monthly salary 5_000_00 minor, taxRate 1000 bps) and Grace (4_000_00 minor), request UNPAID leave for Ada starting today for 2 calendar days and approve it, draft a payroll run for the current year/month, and execute it for the exact total net the run reports. Report net total and headcount.`,
    hints:
      "hr: hireEmployee ×2 → requestLeave(kind=unpaid, ISO YYYY-MM-DD dates) → decideLeave(approve) → createPayrollRun(year,month) → executePayrollRun with the run's own totalNetMinor as the expected amount.",
    maxSteps: 16,
    expectedCaps: ["hr.hireEmployee", "hr.requestLeave", "hr.decideLeave", "hr.createPayrollRun", "hr.executePayrollRun"],
    verify: async (db, orgId) => {
      const emp = await db.select().from(employees).where(eq(employees.orgId, orgId));
      const runs = await db.select().from(payrollRuns).where(eq(payrollRuns.orgId, orgId));
      if (runs.length !== 1) return { ok: false, detail: `expected 1 payroll run, got ${runs.length}` };
      const slips = await db.select().from(payslips).where(eq(payslips.runId, runs[0]!.id));
      return {
        ok: emp.length === 2 && runs[0]!.status === "executed" && runs[0]!.headcount === 2 && slips.length === 2,
        detail: `run ${runs[0]!.status} headcount=${runs[0]!.headcount} slips=${slips.length} net=${runs[0]!.totalNetMinor}`,
      };
    },
  },
  {
    key: "pos-shift",
    modules: ['inventory', 'pos'],
    orgName: "Groq Corner Store",
    goal:
      "Run a cash register shift. Create item 'Espresso beans' sku COF-500 (sale price 1800 minor), stock 100_000 thousandths into inventory, open a POS session with a 5000 minor float, sell 2_000 thousandths for cash, then close the session counting exactly the expected cash. Confirm the session closed with zero variance and stock decreased to 98_000.",
    hints: "inventory (createItem, adjustStock) then pos: openSession → completeSale(cash, with sku on the line) → closeSession. Counted cash = opening float + sale total.",
    maxSteps: 14,
    expectedCaps: ["inventory.createItem", "inventory.adjustStock", "pos.openSession", "pos.completeSale", "pos.closeSession"],
    verify: async (db, orgId) => {
      const [it] = await db.select().from(items).where(and(eq(items.orgId, orgId), eq(items.sku, "COF-500")));
      if (!it) return { ok: false, detail: "item COF-500 not found" };
      const moves = await db.select().from(stockMovements).where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, it.id)));
      const onHand = moves.reduce((s, m) => s + (m.quantityDelta ?? 0), 0);
      const s = await db.select().from(posSessions).where(eq(posSessions.orgId, orgId));
      if (s.length !== 1) return { ok: false, detail: `expected 1 session, got ${s.length}` };
      const closed = s[0]!.status === "closed" && s[0]!.varianceMinor === 0;
      return { ok: closed && onHand === 98_000, detail: `session ${s[0]!.status} variance=${s[0]!.varianceMinor} expected=${s[0]!.expectedCashMinor} onHand=${onHand}` };
    },
  },
  {
    key: "support-triage",
    modules: ['crm', 'accounting', 'skills', 'support'],
    orgName: "Groq Support Desk",
    goal:
      "Triage a support case. Create customer Fern Nursery, give them an UNPAID invoice for 12_000 thousandths of landscaping services at 1500 minor each, search the skills library for the support triage playbook and load it, open a support conversation for their overdue invoice, post a status reply, look up the order status via the conversation, then resolve the conversation. Report the final status.",
    hints:
      "crm customer → accounting invoice → skills.find(task) then skills.load(id) → support: startConversation → postMessage → lookupOrderStatus → resolveConversation.",
    maxSteps: 18,
    expectedCaps: ["crm.createCustomer", "accounting.createInvoice", "skills.find", "skills.load", "support.startConversation", "support.postMessage", "support.lookupOrderStatus", "support.resolveConversation"],
    verify: async (db, orgId) => {
      const convos = await db.select().from(supportConversations).where(eq(supportConversations.orgId, orgId));
      const msgs = await db.select().from(supportMessages).where(eq(supportMessages.orgId, orgId));
      if (convos.length !== 1) return { ok: false, detail: `expected 1 conversation, got ${convos.length}` };
      return { ok: convos[0]!.status === "resolved" && msgs.length >= 1, detail: `conversation ${convos[0]!.status}, ${msgs.length} message(s)` };
    },
  },
  {
    key: "source-to-po",
    modules: ['purchasing'],
    orgName: "Groq Procurement Hub",
    goal:
      "Source a purchase competitively. Create vendors 'Bright Sheet' and 'Iron & Co', raise a purchase request for 'Mild steel plate 3mm' estimated at 20_000_000 minor, approve it, issue an RFQ to both vendors, record a quote per vendor (Bright 21_000_000, Iron 18_500_000 minor), award to the lower quote, and confirm the system minted a purchase order from the award. Report the winning vendor and PO number.",
    hints:
      "purchasing only: createVendor ×2 → createPurchaseRequest → decidePurchaseRequest(approved) → createRfq(vendorIds:[both]) → recordQuote per vendor → selectWinningQuote.",
    maxSteps: 16,
    expectedCaps: ["purchasing.createVendor", "purchasing.createPurchaseRequest", "purchasing.decidePurchaseRequest", "purchasing.createRfq", "purchasing.recordQuote", "purchasing.selectWinningQuote"],
    verify: async (db, orgId) => {
      const prs = await db.select().from(purchaseRequests).where(eq(purchaseRequests.orgId, orgId));
      const quotes = await db.select().from(rfqs).where(eq(rfqs.orgId, orgId));
      const pos = await db.select().from(purchaseOrders).where(eq(purchaseOrders.orgId, orgId));
      const won = quotes.filter((q) => q.status === "won");
      if (prs.length !== 1) return { ok: false, detail: `expected 1 purchase request, got ${prs.length}` };
      return {
        ok: (prs[0]!.status === "approved" || prs[0]!.status === "converted") && won.length === 1 && pos.length === 1,
        detail: `pr=${prs[0]!.status}, ${quotes.length} rfq(s) ${won.length} won, ${pos.length} PO(s)`,
      };
    },
  },
  {
    key: "documents-analytics",
    modules: ['documents', 'crm', 'accounting', 'analytics'],
    orgName: "Groq Media Analytics",
    goal:
      "Combined reporting + memory task. Ingest a document titled 'Q3 Media Strategy' whose text contains verbatim: 'Ad budget is capped at forty thousand dollars next quarter.' — parse it into searchable memory. Create customer Northstar Media and ONE invoice to them for 40_000_00 minor. Pull the last 12 months of revenue analytics, render a 'Q3 Media Report' with a revenue section and a short narrative, then search memory for the budget policy and quote it in your final answer.",
    hints:
      "documents createDocument → parseDocument; accounting createCustomer+invoice; analytics revenueByMonth(monthsBack:12) → renderReport; documents.searchMemory with a query whose words appear in the document text.",
    maxSteps: 18,
    expectedCaps: ["documents.createDocument", "documents.parseDocument", "crm.createCustomer", "accounting.createInvoice", "analytics.renderReport", "documents.searchMemory"],
    verify: async (db, orgId) => {
      const docs = await db.select().from(documents).where(eq(documents.orgId, orgId));
      const mem = await db.select().from(memories).where(and(eq(memories.orgId, orgId), eq(memories.kind, "doc_chunk")));
      if (docs.length !== 1) return { ok: false, detail: `expected 1 document, got ${docs.length}` };
      return { ok: docs[0]!.status === "parsed" && mem.length >= 1, detail: `doc=${docs[0]!.status}, ${mem.length} memory chunk(s)` };
    },
  },
];

/** The ledger chains GLOBALLY (every append links to the most recent event across all orgs). */
async function chainIntegrity(db: Db): Promise<{ ok: boolean; detail: string }> {
  const rows = await db
    .select({
      seq: ledgerEvents.seq,
      kind: ledgerEvents.kind,
      capabilityId: ledgerEvents.capabilityId,
      prevHash: ledgerEvents.prevHash,
      hash: ledgerEvents.hash,
    })
    .from(ledgerEvents)
    .orderBy(asc(ledgerEvents.seq));
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prevHash !== prev) return { ok: false, detail: `chain broken at ${r.kind} (seq ${r.seq})` };
    prev = r.hash;
  }
  return { ok: true, detail: `${rows.length} events linked` };
}

/**
 * Mistral trial keys are ~4 req/min. Pace every request and back off on 429
 * so a multi-step agent turn never trips the limit mid-flight.
 */
const RATE_LIMIT_PACING_MS = 16_000;
function paced(adapter: ModelAdapter): ModelAdapter {
  let nextSlot = 0;
  const transient = (status: number) => status === 429 || (status >= 500 && status <= 599);
  return {
    async run(messages, tools, opts) {
      const wait = Math.max(0, nextSlot - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      for (let attempt = 1; ; attempt += 1) {
        try {
          const out = await adapter.run(messages, tools, opts);
          nextSlot = Date.now() + RATE_LIMIT_PACING_MS;
          return out;
        } catch (err) {
          const status = (err as { status?: number }).status ?? 0;
          if (!transient(status) || attempt > 5) throw err;
          // 429s double as proof the trial key is ~4 req/min; 5xx are the
          // Mistral upstream sometimes timing out (504). Back off, don't die.
          const backoff = 16_000 * attempt + Math.round(Math.random() * 4_000);
          nextSlot = Date.now() + backoff;
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    },
  } satisfies ModelAdapter;
}

async function main() {
  const db = getDb().db;
  console.log(`agent suite | model=${MODEL} | provider=${PROVIDER}\n`);

  const outcome: { key: string; ok: boolean; steps: number; ms: number; note: string }[] = [];
  let run = 0;

  const onlyTask: number[] = (process.env.SUITE_ONLY_TASK ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);

  for (const t of TASKS) {
    run += 1;
    if (onlyTask.length > 0 && !onlyTask.includes(run)) continue;
    const started = Date.now();
    const [owner] = await db
      .insert(users)
      .values({ email: `bench-${run}-${Date.now()}@groq.test`, name: `Bench ${run}` })
      .returning();
    if (!owner) throw new Error("user insert failed");
    const userId = owner.id;

    const { orgId } = await runOnboarding(db, {
      userId,
      userEmail: `${userId}@groq.test`,
      orgName: t.orgName,
      businessDescription: `${t.orgName} runs ChasteBusinessOS with an AI agent on Groq ${MODEL}.`,
    });
    await db.update(policies).set({ moneyThresholdMinor: MONEY_THRESHOLD_MINOR }).where(eq(policies.orgId, orgId));

    const actor = { type: "agent" as const, id: userId, orgId, permissions: new Set(["*"]) };
    const ctx = { actor, now: new Date(), services: {} as Record<string, unknown>, sessionId: `groq-bench-${run}` };
    const registry = buildScopedRegistry(db, t.modules);
    const executor = buildExecutor(db, registry);

    const chain: string[] = [];
    const adapter = new OpenAiCompatAdapter({ client: resolveClient(), model: MODEL });
    const model = PROVIDER === "mistral" ? paced(adapter) : adapter;

    let outcome_: { steps: number; finalMessage: string };
    let runError: string | null = null;
    try {
      outcome_ = await runAgentLoop(model, registry, executor, ctx, {
      sessionId: `groq-bench-${run}`,
      maxSteps: t.maxSteps,
      systemPrompt: [
        `You are the autonomous operations agent for ${t.orgName}.`,
        "You act through governed capabilities exposed as tools (dots became underscores: crm.createCustomer → crm_createCustomer).",
        ...(t.modules.includes("skills")
          ? ["For multi-step processes, first call skills_find with your task, then skills_load the matching playbook, then execute its capability steps in order."]
          : []),
        "Amounts are integer MINOR units ($1 = 100). Quantities are thousandths (1000 = 1 unit). Never invent ids, numbers, or currency; take values from tool results and echo them exactly.",
        "When a capability needs an exact expected total, reuse the figure the creating capability returned.",
        "Verify your work with a read-only tool (list/report/status) before finishing.",
        "End with a concise final message stating what you did with the real ids and totals and any variances.",
        "CRITICAL: execute the objective now using the tools that are actually listed above. Do not call file_ticket, skills_find, or any tool that is not listed.",
      ].join("\n"),
      userGoal: [t.hints.split("\n").map((h) => `Guidance — ${h}`).join("\n"), "Objective: " + t.goal].filter(Boolean).join("\n\n"),
      noCapabilityNote: null,
      onEvent: (e) => {
        if (e.role === "tool_call") {
          chain.push((e.content as { name: string }).name);
          console.log(`    > ${(e.content as { name: string }).name}`);
        } else if (e.role === "tool_result") {
          const c = e.content as { name: string; ok: boolean; error?: unknown; result?: unknown };
          if (!c.ok) console.log(`    ! ${c.name} FAILED: ${JSON.stringify(c.error ?? c.result)}`);
        }
      },
    });
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      outcome_ = { steps: 0, finalMessage: "" };
    }

    if (runError) {
      const ms = Date.now() - started;
      outcome.push({ key: t.key, ok: false, steps: 0, ms, note: `run-error: ${runError}` });
      console.log(`FAIL [${run}/${TASKS.length}] ${t.key.padEnd(22)} steps=0 ms=${ms} run-error: ${runError}`);
      continue;
    }

    const expectedSet = t.expectedCaps.map(sanitize);
    const missing = expectedSet.filter((c) => !chain.includes(c));
    const side = await t.verify(db, orgId);
    const integrity = await chainIntegrity(db);
    const ok = missing.length === 0 && side.ok && integrity.ok;
    const ms = Date.now() - started;
    const note = [
      missing.length ? `missing=${missing.join(",")}` : "",
      side.ok ? "" : `side=${side.detail}`,
      integrity.ok ? "" : integrity.detail,
      outcome_.finalMessage.length ? "" : "no final message",
    ]
      .filter(Boolean)
      .join(" | ");
    outcome.push({ key: t.key, ok, steps: outcome_.steps, ms, note });
    console.log(
      `${ok ? "PASS" : "FAIL"} [${run}/${TASKS.length}] ${t.key.padEnd(22)} steps=${outcome_.steps} ms=${ms} ${note || side.detail}`,
    );
  }

  const passed = outcome.filter((o) => o.ok).length;
  console.log("\n" + "=".repeat(72));
  console.log(`agent suite: ${passed}/${outcome.length} passed`);
  for (const o of outcome) console.log(`  ${o.ok ? "PASS" : "FAIL"} ${o.key.padEnd(22)} steps=${o.steps} ms=${o.ms}${o.note ? "  " + o.note : ""}`);
  if (passed !== outcome.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});