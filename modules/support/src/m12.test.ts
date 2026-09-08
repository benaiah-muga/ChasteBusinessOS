import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, customers, organizations, supportConversations, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerSupportCapabilities, type ModuleDeps } from "./index";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let customerId: string;
let conversationId: string;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerSupportCapabilities(registry, deps);
  return registry;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "M12 Tickets Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
  await db.db.insert(organizations).values({ id: orgId, name: "M12 Tickets Probe", slug: `t12-${orgId.slice(0, 8)}` });
  const [cust] = await db.db.insert(customers).values({ orgId, name: "Ticket Buyer" }).returning({ id: customers.id });
  customerId = cust!.id;
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
  const conv = await run("support.startConversation", { customerId, subject: "Order arrived broken — refund?" });
  conversationId = conv.conversationId ?? conv.id;
});

afterAll(async () => {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "M12 Tickets Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
});

describe("ticket depth (M12.3)", () => {
  it("category drafts rules-first from the subject", async () => {
    const s = await run("support.suggestCategory", { text: "Order arrived broken — refund?" });
    expect(s.draft).toBe(true);
    expect(s.category).toBe("billing");
  });

  it("ticket fields persist: number, priority, category, assignee, SLA", async () => {
    await run("support.updateTicket", {
      conversationId,
      priority: "high",
      category: "billing",
      slaDueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const [row] = await db.db.select().from(supportConversations).where(eq(supportConversations.id, conversationId));
    expect(row!.ticketNumber).toBe(1);
    expect(row!.priority).toBe("high");
    expect(row!.category).toBe("billing");
    expect(row!.slaDueAt).toBeInstanceOf(Date);
  });

  it("canned responses upsert and KB articles persist", async () => {
    const c = await run("support.createCannedResponse", { shortcut: "/refund-policy", title: "Refund policy", body: "We refund damaged goods in full within 14 days." });
    expect(c.cannedResponseId).toBeDefined();
    const k = await run("support.createKbArticle", { title: "How refunds work", body: "Step by step refund guide.", category: "billing" });
    expect(k.articleId).toBeDefined();
  });
});
