import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, customers, deals, documents, invoices, organizations, payments, quotes, tasks, type Database } from "@chaste/db";
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

  it("imports reviewed rows, skips phone matches, and reversibly deactivates the imported batch", async () => {
    await run("crm.createCustomer", { name: "Phone Match Company", phone: "+256 772 123 456" });
    const imported = await run("crm.importCustomers", { rows: [
      { rowNumber: 2, name: "Possible duplicate", phone: "0772-123-456", allowDuplicate: false },
      { rowNumber: 3, name: "Fresh customer", email: "fresh@example.com", allowDuplicate: false },
    ] });
    expect(imported).toMatchObject({ imported: 1, skippedDuplicateRows: [2] });
    const [fresh] = await db.db.select({ id: customers.id, deactivatedAt: customers.deactivatedAt }).from(customers).where(eq(customers.email, "fresh@example.com"));
    expect(fresh?.deactivatedAt).toBeNull();
    const undone = await run("crm.undoCustomerImport", { customerIds: imported.createdIds });
    expect(undone.deactivated).toBe(1);
    const [deactivated] = await db.db.select({ deactivatedAt: customers.deactivatedAt }).from(customers).where(eq(customers.id, fresh!.id));
    expect(deactivated?.deactivatedAt).not.toBeNull();
    const restored = await run("crm.restoreImportedCustomers", { customerIds: undone.customerIds });
    expect(restored.restored).toBe(1);
  });

  it("convertLead creates the customer and qualifies the deal", async () => {
    const deal = await run("crm.createDeal", { title: "Website lead - Falcon", valueMinor: 500_000, source: "website" });
    const converted = await run("crm.convertLead", { dealId: deal.dealId, createCustomer: true, customerName: "Falcon Industries" });
    expect(converted.stage).toBe("qualified");
    const [row] = await db.db.select({ customerId: deals.customerId, stage: deals.stage }).from(deals).where(eq(deals.id, deal.dealId));
    expect(row!.stage).toBe("qualified");
    const [cust] = await db.db.select({ name: customers.name }).from(customers).where(eq(customers.id, row!.customerId!));
    expect(cust!.name).toBe("Falcon Industries");
  });

  it("moveDealStage preserves the lost reason", async () => {
    const deal = await run("crm.createDeal", { title: "Doomed deal" });
    await expect(run("crm.moveDealStage", { dealId: deal.dealId, stage: "lost" })).rejects.toThrow(/reason/i);
    await run("crm.moveDealStage", { dealId: deal.dealId, stage: "lost", lostReason: "price" });
    const [row] = await db.db.select({ lostReason: deals.lostReason, stage: deals.stage }).from(deals).where(eq(deals.id, deal.dealId));
    expect(row!.stage).toBe("lost");
    expect(row!.lostReason).toBe("price");
  });

  it("reschedules a follow-up and restores its previous due date through the inverse", async () => {
    const originalDue = new Date("2026-09-27T09:00:00.000Z").toISOString();
    const nextDue = new Date("2026-09-29T09:00:00.000Z").toISOString();
    const task = await run("crm.createTask", { title: "Call the customer", dueAt: originalDue });
    const update = await run("crm.updateTaskDetails", { taskId: task.taskId, dueAt: nextDue });
    const [changed] = await db.db.select({ dueAt: tasks.dueAt }).from(tasks).where(eq(tasks.id, task.taskId));
    expect(changed!.dueAt!.toISOString()).toBe(nextDue);
    await run("crm.restoreTaskDetails", { taskId: task.taskId, ...update.previous });
    const [restored] = await db.db.select({ dueAt: tasks.dueAt }).from(tasks).where(eq(tasks.id, task.taskId));
    expect(restored!.dueAt!.toISOString()).toBe(originalDue);
  });

  it("renames a customer and reverses the name from its profile snapshot", async () => {
    const customer = await run("crm.createCustomer", { name: "Original display name" });
    const updated = await run("crm.updateCustomerProfiles", {
      customerIds: [customer.customerId],
      name: "Corrected display name",
    });
    expect(updated.previous[0]).toMatchObject({ customerId: customer.customerId, name: "Original display name" });

    const [changed] = await db.db.select({ name: customers.name }).from(customers).where(eq(customers.id, customer.customerId));
    expect(changed!.name).toBe("Corrected display name");

    const restored = await run("crm.restoreCustomerProfiles", { profiles: updated.previous });
    expect(restored.previous[0]).toMatchObject({ customerId: customer.customerId, name: "Corrected display name" });
    const [original] = await db.db.select({ name: customers.name }).from(customers).where(eq(customers.id, customer.customerId));
    expect(original!.name).toBe("Original display name");

    await run("crm.reapplyCustomerProfiles", { profiles: restored.previous });
    const [reapplied] = await db.db.select({ name: customers.name }).from(customers).where(eq(customers.id, customer.customerId));
    expect(reapplied!.name).toBe("Corrected display name");
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

  it("merges duplicate profiles without rewriting linked history, then restores them on undo", async () => {
    const survivor = await run("crm.createCustomer", { name: "Northwind Works", email: "northwind@example.com" });
    const duplicate = await run("crm.createCustomer", { name: "Northwind Work", phone: "+256 772 222 111" });
    await db.db.update(customers).set({ tags: ["priority"], notes: "Primary notes" }).where(eq(customers.id, survivor.customerId));
    await db.db.update(customers).set({ tags: ["wholesale"], notes: "Original duplicate notes", doNotContact: true }).where(eq(customers.id, duplicate.customerId));

    const [invoice] = await db.db.insert(invoices).values({
      orgId, customerId: duplicate.customerId, number: 20001, status: "sent", subtotalMinor: 50_000, taxMinor: 0, totalMinor: 50_000, issuedAt: new Date("2026-02-10"),
    }).returning({ id: invoices.id });
    const [quote] = await db.db.insert(quotes).values({
      orgId, customerId: duplicate.customerId, number: 20001, status: "sent", subtotalMinor: 40_000, taxMinor: 0, totalMinor: 40_000, createdByActorType: "human", createdByActorId: null,
    }).returning({ id: quotes.id });
    const [document] = await db.db.insert(documents).values({
      orgId, title: "Northwind agreement", sourceType: "text", rawText: "Agreement notes", status: "parsed", createdByActorType: "human", refType: "customer", refId: duplicate.customerId,
    }).returning({ id: documents.id });
    const deal = await run("crm.createDeal", { title: "Northwind renewal", customerId: duplicate.customerId, valueMinor: 75_000 });
    const task = await run("crm.createTask", { title: "Check Northwind renewal", refType: "customer", refId: duplicate.customerId });

    const merged = await run("crm.mergeCustomers", { survivorCustomerId: survivor.customerId, duplicateCustomerId: duplicate.customerId });
    expect(merged.previous).toHaveLength(2);
    const [profile] = await db.db.select({ tags: customers.tags, doNotContact: customers.doNotContact, email: customers.email, phone: customers.phone }).from(customers).where(eq(customers.id, survivor.customerId));
    expect(profile).toMatchObject({ tags: ["priority", "wholesale"], doNotContact: true, email: "northwind@example.com", phone: "+256 772 222 111" });
    const [linkedInvoice] = await db.db.select({ customerId: invoices.customerId }).from(invoices).where(eq(invoices.id, invoice!.id));
    const [linkedQuote] = await db.db.select({ customerId: quotes.customerId }).from(quotes).where(eq(quotes.id, quote!.id));
    const [linkedDeal] = await db.db.select({ customerId: deals.customerId }).from(deals).where(eq(deals.id, deal.dealId));
    const [linkedTask] = await db.db.select({ refId: tasks.refId }).from(tasks).where(eq(tasks.id, task.taskId));
    const [linkedDocument] = await db.db.select({ refId: documents.refId }).from(documents).where(eq(documents.id, document!.id));
    expect([linkedInvoice!.customerId, linkedQuote!.customerId, linkedDeal!.customerId, linkedTask!.refId, linkedDocument!.refId]).toEqual(Array(5).fill(duplicate.customerId));

    const timeline = await run("crm.customerTimeline", { customerId: survivor.customerId });
    expect(timeline.entries.map((entry: { refId: string }) => entry.refId)).toEqual(expect.arrayContaining([invoice!.id, quote!.id, deal.dealId, task.taskId, document!.id]));
    const directory = await run("crm.listCustomers", {});
    expect(directory.customers.some((customer: { id: string }) => customer.id === duplicate.customerId)).toBe(false);

    await run("crm.restoreCustomerMerge", merged);
    const [restoredSurvivor] = await db.db.select({ tags: customers.tags, notes: customers.notes, doNotContact: customers.doNotContact }).from(customers).where(eq(customers.id, survivor.customerId));
    const [restoredDuplicate] = await db.db.select({ tags: customers.tags, notes: customers.notes, deactivatedAt: customers.deactivatedAt, mergedIntoCustomerId: customers.mergedIntoCustomerId }).from(customers).where(eq(customers.id, duplicate.customerId));
    expect(restoredSurvivor).toMatchObject({ tags: ["priority"], notes: "Primary notes", doNotContact: false });
    expect(restoredDuplicate).toMatchObject({ tags: ["wholesale"], notes: "Original duplicate notes", deactivatedAt: null, mergedIntoCustomerId: null });
  });
});
