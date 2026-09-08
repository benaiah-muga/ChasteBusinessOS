import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, customers, deals, invoices, organizations, payments, quotes, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerCrmCapabilities, createCrmSignalProducer, type ModuleDeps } from "./index";

/**
 * CRM depth proof (M9.3/9.4): duplicate detection warns without refusing,
 * lead conversion creates/attaches the customer and qualifies the deal,
 * lost reasons survive, overdue tasks signal with a governed completion
 * action, and the customer timeline merges every source in order.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerCrmCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "CRM Depth Probe"));
  for (const o of orgs) {
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "CRM Depth Probe", slug: `cr-${orgId.slice(0, 8)}` });
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("crm depth (M9.3)", () => {
  it("createCustomer warns on deterministic duplicates without refusing", async () => {
    const a = await run("crm.createCustomer", { name: "Acme LLC", email: "billing@acme.com" });
    expect(a.duplicateWarning).toBeNull();
    const b = await run("crm.createCustomer", { name: "acme", email: "other@elsewhere.com" });
    expect(b.duplicateWarning).toContain("Acme LLC");
    expect(b.duplicateWarning).toContain("matched by name");
    const c = await run("crm.createCustomer", { name: "Totally Different Co", email: "billing@acme.com" });
    expect(c.duplicateWarning).toContain("matched by email");
  });

  it("convertLead creates the customer and qualifies the deal", async () => {
    const deal = await run("crm.createDeal", { title: "Website lead — Falcon", valueMinor: 500_000, source: "website" });
    const converted = await run("crm.convertLead", { dealId: deal.dealId, createCustomer: true, customerName: "Falcon Industries" });
    expect(converted.stage).toBe("qualified");
    const [row] = await db.db.select({ customerId: deals.customerId, stage: deals.stage }).from(deals).where(eq(deals.id, deal.dealId));
    expect(row!.stage).toBe("qualified");
    const [cust] = await db.db.select({ name: customers.name }).from(customers).where(eq(customers.id, row!.customerId!));
    expect(cust!.name).toBe("Falcon Industries");
  });

  it("moveDealStage preserves the lost reason", async () => {
    const deal = await run("crm.createDeal", { title: "Doomed deal" });
    await run("crm.moveDealStage", { dealId: deal.dealId, stage: "lost", lostReason: "price" });
    const [row] = await db.db.select({ lostReason: deals.lostReason, stage: deals.stage }).from(deals).where(eq(deals.id, deal.dealId));
    expect(row!.stage).toBe("lost");
    expect(row!.lostReason).toBe("price");
  });

  it("overdue tasks signal red with a governed completion action", async () => {
    const task = await run("crm.createTask", {
      title: "Call back Falcon",
      dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      refType: "customer",
      refId: crypto.randomUUID(),
    });
    const signals = await createCrmSignalProducer(deps.db)(orgId, new Date());
    const hit = signals.find((s) => s.id === `crm.taskOverdue:${task.taskId}`);
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("red");
    expect(hit!.suggestedAction?.capabilityId).toBe("crm.completeTask");

    await run("crm.completeTask", { taskId: task.taskId });
    const after = await createCrmSignalProducer(deps.db)(orgId, new Date());
    expect(after.find((s) => s.id === `crm.taskOverdue:${task.taskId}`)).toBeUndefined();
    await expect(run("crm.completeTask", { taskId: task.taskId })).rejects.toThrow(/already completed/);
  });
});

describe("customer timeline (M9.4)", () => {
  it("merges invoice, payment, quote, deal, and task rows reverse-chronologically", async () => {
    const cust = await run("crm.createCustomer", { name: "Timeline Buyer" });
    const customerId = cust.customerId;

    const [inv] = await db.db
      .insert(invoices)
      .values({ orgId, customerId, number: 1, status: "sent", subtotalMinor: 100_000, taxMinor: 0, totalMinor: 100_000, issuedAt: new Date("2026-01-10") })
      .returning({ id: invoices.id });
    await db.db.insert(payments).values({ orgId, invoiceId: inv!.id, amountMinor: 40_000, method: "card", receivedAt: new Date("2026-01-15") });
    await db.db.insert(quotes).values({ orgId, customerId, number: 1, status: "declined", subtotalMinor: 90_000, taxMinor: 0, totalMinor: 90_000, decidedAt: new Date("2026-01-05"), createdByActorType: "human", createdByActorId: null });
    const deal = await run("crm.createDeal", { title: "Timeline deal", customerId, valueMinor: 250_000 });
    const task = await run("crm.createTask", { title: "Send catalog", refType: "customer", refId: customerId });

    const timeline = await run("crm.customerTimeline", { customerId });
    const kinds = timeline.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("invoice");
    expect(kinds).toContain("payment");
    expect(kinds).toContain("quote");
    expect(kinds).toContain("deal");
    expect(kinds).toContain("task");
    const dates = timeline.entries.map((e: { date: string }) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(timeline.entries[0].refId).toBe(task.taskId);
    expect(timeline.entries.at(-1)!.summary).toContain("Quote #1");
    expect(deal.dealId).toBeDefined();
  });
});
