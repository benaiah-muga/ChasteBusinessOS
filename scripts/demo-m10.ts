/**
 * M10 verification — accounting & purchasing depth.
 * Every assertion is a product guarantee.
 *
 * Run: pnpm demo:m10 [cashflow|creditnote|statements|reminders|supplier|forecast|duplicate|all]
 */
import { and, eq } from "drizzle-orm";
import {
  approvals,
  conversationMembers,
  conversations,
  customers,
  getDb,
  users,
  vendorBills,
} from "@chaste/db";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

let passed = 0;
function ok(label: string, condition?: boolean) {
  if (condition === false) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
  passed += 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- demo reads heterogeneous capability outputs; each assertion narrows its shape
function data(run: any) {
  if (run.error) throw new Error(`capability failed: ${run.error}`);
  if (run.pendingApproval) throw new Error(`unexpectedly gated: ${run.capabilityId ?? "?"}`);
  return run.data;
}

async function seedOrg(db: ReturnType<typeof getDb>["db"], orgName: string) {
  const [owner] = await db
    .insert(users)
    .values({ email: `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.test`, name: "Owner" })
    .returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.test`,
    orgName,
    businessDescription: "Trading company that trusts its money statements and remembers its suppliers.",
  });
  return {
    orgId,
    owner,
    ownerCtx: {
      actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
    agentCtx: {
      actor: { type: "agent" as const, id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
  };
}

async function approve(
  db: ReturnType<typeof getDb>["db"],
  orgId: string,
  executor: ReturnType<typeof buildExecutor>,
  ownerCtx: Parameters<ReturnType<typeof buildExecutor>["execute"]>[1],
  capabilityId: string,
) {
  const gate = (
    await db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))).at(-1);
  if (!gate) throw new Error("gated but no approval row exists");
  return executor.execute(capabilityId, ownerCtx, gate.payload, { approvedApprovalId: gate.id });
}

async function cashflowScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const ex = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M10 Money Co");

  const cust = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Forecast Buyer" }));
  await ex.execute("inventory.createItem", ownerCtx, { sku: "CASH-1", name: "Cash cow", salePriceMinor: 1_000_00 });
  data(await ex.execute("accounting.createInvoice", ownerCtx, {
    customerId: cust.customerId,
    lines: [{ description: "Cash cow", quantity: 1_000, unitPriceMinor: 1_000_00 }],
  }));
  data(await ex.execute("accounting.recordPayment", ownerCtx, { invoiceNumber: 1, amountMinor: 400_00 }));

  const vendor = data(await ex.execute("purchasing.createVendor", ownerCtx, { name: "Paper Supplier" }));
  data(await ex.execute("purchasing.createBill", ownerCtx, {
    vendorId: vendor.vendorId,
    lines: [{ description: "Office paper", quantity: 1_000, unitPriceMinor: 600_00 }],
  }));
  data(await ex.execute("purchasing.payBill", ownerCtx, { billNumber: 1, amountMinor: 200_00 }));

  const cf = data(await ex.execute("accounting.cashFlow", ownerCtx, { cashAccountCodes: ["1000"] }));
  ok(`statement ties to the cash balance (${cf.closingMinor} minor)`, cf.ties === true);
  ok(`operating net +${cf.operating.netMinor} = receipt 40000 − payment 20000`, cf.operating.netMinor === 200_00);
  ok("closing chains from opening", cf.closingMinor === cf.openingMinor + cf.netMinor);
  console.log("CASHFLOW TIES");
  return orgId;
}

async function creditnoteScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const ex = buildExecutor(db, registry);
  const { orgId, ownerCtx, agentCtx } = await seedOrg(db, "M10 Credit Co");

  const cust = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Concession Buyer" }));
  const inv = data(await ex.execute("accounting.createInvoice", ownerCtx, {
    customerId: cust.customerId,
    lines: [{ description: "Scratched table", quantity: 1_000, unitPriceMinor: 300_00 }],
  }));

  const agentRun = await ex.execute("accounting.creditNote", agentCtx, {
    invoiceId: inv.invoiceId,
    amountMinor: 100_00,
    reason: "scratch on delivery — agreed with customer",
  });
  ok("credit note waits for a human whatever the size", Boolean(agentRun.pendingApproval));
  const approved = data(await approve(db, orgId, ex, ownerCtx, "accounting.creditNote"));
  ok(`approved credit posted; invoice balance now ${approved.invoiceBalanceMinor}`, approved.invoiceBalanceMinor === 200_00);
  console.log("CREDIT NOTE GATED");
  return orgId;
}

async function statementsScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const ex = buildExecutor(db, registry);
  const { orgId, ownerCtx, agentCtx } = await seedOrg(db, "M10 Statements Co");

  const cust = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Statement Buyer Co" }));
  const inv = data(await ex.execute("accounting.createInvoice", ownerCtx, {
    customerId: cust.customerId,
    lines: [{ description: "Goods", quantity: 1_000, unitPriceMinor: 500_00 }],
  }));
  data(await ex.execute("accounting.recordPayment", ownerCtx, { invoiceNumber: inv.invoiceNumber, amountMinor: 100_00 }));
  await ex.execute("accounting.creditNote", agentCtx, {
    invoiceId: inv.invoiceId,
    amountMinor: 50_00,
    reason: "partial goodwill",
  });
  data(await approve(db, orgId, ex, ownerCtx, "accounting.creditNote"));

  const stmt = data(await ex.execute("accounting.customerStatement", ownerCtx, { customerId: cust.customerId }));
  const kinds = stmt.rows.map((r: { kind: string }) => r.kind);
  ok(`customer statement rows: ${kinds.join(" → ")}`, kinds.join(",") === "invoice,payment,credit_note");
  ok(`closing balance ${stmt.closingBalanceMinor} = 50000 − 10000 − 5000`, stmt.closingBalanceMinor === 350_00);

  const vendor = data(await ex.execute("purchasing.createVendor", ownerCtx, { name: "Statement Vendor" }));
  await ex.execute("purchasing.createBill", ownerCtx, {
    vendorId: vendor.vendorId,
    lines: [{ description: "Services", quantity: 1_000, unitPriceMinor: 300_00 }],
  });
  await ex.execute("purchasing.billCreditNote", agentCtx, {
    billId: (
      await db.select({ id: vendorBills.id }).from(vendorBills).where(eq(vendorBills.orgId, orgId))
    ).at(-1)!.id,
    amountMinor: 25_00,
    reason: "vendor concession",
  });
  data(await approve(db, orgId, ex, ownerCtx, "purchasing.billCreditNote"));
  const sup = data(await ex.execute("purchasing.supplierStatement", ownerCtx, { vendorId: vendor.vendorId }));
  ok(`supplier statement nets to ${sup.closingBalanceMinor}`, sup.closingBalanceMinor === 275_00);
  console.log("STATEMENTS RENDERED");
  return orgId;
}

async function remindersScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const ex = buildExecutor(db, registry);
  const { orgId, owner, ownerCtx } = await seedOrg(db, "M10 Reminders Co");

  const warm = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Warm Collections Co" }));
  const quiet = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Do Not Nudge Ltd" }));
  await db.update(customers).set({ reminderOptOut: true }).where(eq(customers.id, quiet.customerId));

  const past = new Date(Date.now() - 12 * 86_400_000).toISOString();
  await ex.execute("inventory.createItem", ownerCtx, { sku: "NUDGE-1", name: "Nudge goods", salePriceMinor: 250_00 });
  data(await ex.execute("accounting.createInvoice", ownerCtx, {
    customerId: warm.customerId,
    dueAt: past,
    lines: [{ description: "Nudge goods", quantity: 1_000, unitPriceMinor: 250_00 }],
  }));
  data(await ex.execute("accounting.createInvoice", ownerCtx, {
    customerId: quiet.customerId,
    dueAt: past,
    lines: [{ description: "Nudge goods", quantity: 1_000, unitPriceMinor: 300_00 }],
  }));

  const reminders = data(await ex.execute("accounting.buildReminders", ownerCtx, {}));
  const ids = reminders.reminders.map((r: { customerId: string }) => r.customerId);
  ok("opted-out customer is excluded at drafting time", !ids.includes(quiet.customerId));
  const draft = reminders.reminders.find((r: { customerId: string }) => r.customerId === warm.customerId);
  ok(`draft says: ${draft.message.slice(0, 80)}…`, draft.message.includes("past due"));

  const [channel] = await db
    .insert(conversations)
    .values({ orgId, kind: "channel", title: "collections" })
    .returning({ id: conversations.id });
  await db.insert(conversationMembers).values({ conversationId: channel!.id, userId: owner.id }).onConflictDoNothing();
  const sent = data(await ex.execute("messaging.sendMessage", ownerCtx, {
    conversationId: channel!.id,
    body: `[reminder] ${draft.message}`,
  }));
  ok(`reminder delivered through the messaging seam (${sent.messageId.slice(0, 8)}…)`);
  console.log("REMINDER DRAFTED");
  return orgId;
}

async function supplierScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const ex = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M10 Supplier Co");

  await ex.execute("inventory.createItem", ownerCtx, { sku: "PART-9", name: "Part nine", salePriceMinor: 8_00 });
  const vendor = data(await ex.execute("purchasing.createVendor", ownerCtx, { name: "Dependable Casting", paymentTermDays: 14 }));

  const po1 = data(await ex.execute("purchasing.createPurchaseOrder", ownerCtx, {
    vendorId: vendor.vendorId,
    promisedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    lines: [{ description: "Part nine crate", quantity: 40_000, unitPriceMinor: 2_000, sku: "PART-9" }],
  }));
  data(await ex.execute("purchasing.receiveGoods", ownerCtx, { poNumber: po1.poNumber, lines: [{ lineNumber: 1, quantity: 40_000 }] }));
  await ex.execute("purchasing.createBill", ownerCtx, {
    vendorId: vendor.vendorId,
    poNumber: po1.poNumber,
    lines: [{ description: "Part nine crate", quantity: 40_000, unitPriceMinor: 2_000, poLineNumber: 1 }],
  });
  const [billRow] = await db.select({ dueAt: vendorBills.dueAt }).from(vendorBills).where(eq(vendorBills.orgId, orgId)).limit(1);
  const termDays = Math.round((billRow!.dueAt!.getTime() - Date.now()) / 86_400_000);
  ok(`bill due in ~${termDays} days from the vendor's net-14 terms`, termDays >= 13 && termDays <= 15);

  const perf = data(await ex.execute("purchasing.supplierPerformance", ownerCtx, {}));
  const mine = perf.vendors.find((v: { vendorId: string }) => v.vendorId === vendor.vendorId);
  ok(`fill rate ${mine.fillRate}% and on-time ${mine.onTimeRate}% against the promised date`, mine.fillRate === 100 && mine.onTimeRate === 100);

  const po2 = data(await ex.execute("purchasing.createPurchaseOrder", ownerCtx, {
    vendorId: vendor.vendorId,
    lines: [{ description: "Backorder probe", quantity: 50_000, unitPriceMinor: 2_000, sku: "PART-9" }],
  }));
  data(await ex.execute("purchasing.receiveGoods", ownerCtx, { poNumber: po2.poNumber, lines: [{ lineNumber: 1, quantity: 20_000 }] }));
  const closed = data(await ex.execute("purchasing.closePurchaseOrder", ownerCtx, { poNumber: po2.poNumber }));
  ok(`closed short: backordered with ${closed.shortThousandths} thousandths on record`, closed.backordered === true);

  const returned = data(await ex.execute("purchasing.returnGoods", ownerCtx, {
    poNumber: po1.poNumber,
    lines: [{ lineNumber: 1, quantity: 5_000, reason: "three units arrived cracked" }],
  }));
  ok(`return booked through the ledger (${returned.lines} line)`);

  const history = data(await ex.execute("purchasing.priceHistory", ownerCtx, { sku: "PART-9" }));
  ok(`price history holds ${history.rows.length} receipts at 2000 minor`, history.rows.every((r: { unitPriceMinor: number }) => r.unitPriceMinor === 2_000));
  console.log("SUPPLIER MEMORY OK");
  return orgId;
}

async function forecastScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const ex = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M10 Forecast Co");

  const cust = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Maybe Pays Co" }));
  const vendor = data(await ex.execute("purchasing.createVendor", ownerCtx, { name: "Maybe Charges Co" }));
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000).toISOString();
  data(await ex.execute("accounting.createInvoice", ownerCtx, {
    customerId: cust.customerId,
    dueAt: inThreeDays,
    lines: [{ description: "Expected income", quantity: 1_000, unitPriceMinor: 900_00 }],
  }));
  data(await ex.execute("purchasing.createBill", ownerCtx, {
    vendorId: vendor.vendorId,
    dueAt: inThreeDays,
    lines: [{ description: "Expected cost", quantity: 1_000, unitPriceMinor: 400_00 }],
  }));

  const fc = data(await ex.execute("accounting.cashForecast", ownerCtx, { cashAccountCodes: ["1000"] }));
  ok(`13 weekly closes rendered (start ${fc.startMinor} → final ${fc.finalMinor})`, fc.weeks.length === 13);
  const totalIn = fc.weeks.reduce((s, w) => s + w.inflowMinor, 0);
  const totalOut = fc.weeks.reduce((s, w) => s + w.outflowMinor, 0);
  ok(`forecast nets +50000 (${totalIn} AR due − ${totalOut} AP due, whichever week they land in)`, totalIn === 900_00 && totalOut === 400_00);
  ok(`trough recorded at ${fc.lowestCloseMinor}`, fc.lowestCloseMinor <= fc.finalMinor);
  console.log("FORECAST RENDERED");
  return orgId;
}

async function duplicateScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const ex = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M10 Double Pay Co");

  const cust = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Double Clicker Co" }));
  const inv = data(await ex.execute("accounting.createInvoice", ownerCtx, {
    customerId: cust.customerId,
    lines: [{ description: "Goods paid twice by accident", quantity: 1_000, unitPriceMinor: 800_00 }],
  }));
  data(await ex.execute("accounting.recordPayment", ownerCtx, { invoiceNumber: inv.invoiceNumber, amountMinor: 400_00 }));
  data(await ex.execute("accounting.recordPayment", ownerCtx, { invoiceNumber: inv.invoiceNumber, amountMinor: 400_00 }));

  const signals = data(await ex.execute("signals.list", ownerCtx, {}));
  const dupe = (signals.signals ?? []).find((s: { id: string }) => s.id.startsWith("accounting.duplicatePayment:"));
  if (!dupe) throw new Error("duplicate payment must raise an orange signal");
  ok(`duplicate flagged orange: ${dupe.subject}`);
  console.log("DUPLICATE FLAGGED");
  return orgId;
}

async function main() {
  const scenario = process.argv[2] ?? "all";
  if (scenario === "cashflow" || scenario === "all") await cashflowScenario();
  if (scenario === "creditnote" || scenario === "all") await creditnoteScenario();
  if (scenario === "statements" || scenario === "all") await statementsScenario();
  if (scenario === "reminders" || scenario === "all") await remindersScenario();
  if (scenario === "supplier" || scenario === "all") await supplierScenario();
  if (scenario === "forecast" || scenario === "all") await forecastScenario();
  if (scenario === "duplicate" || scenario === "all") await duplicateScenario();
  console.log(`\n${passed} guarantees held.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
