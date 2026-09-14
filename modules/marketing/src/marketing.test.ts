import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, customers, organizations, outboxMessages, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerMarketingCapabilities, type ModuleDeps } from "./index";

/**
 * Marketing delivery (N26): deterministic segments, opt-out honored at send
 * time, recipient intent queued to the outbox, and analytics count only
 * provider-confirmed delivery.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerMarketingCapabilities(registry, deps);
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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Marketing Lite Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
  await db.db.insert(organizations).values({ id: orgId, name: "Marketing Lite Probe", slug: `mk-${orgId.slice(0, 8)}` });
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
  // Big spender (in segment), opted-out spender (excluded), no-address spender (skipped).
  await db.db.insert(customers).values([
    { orgId, name: "Big Spender", email: "big@example.test", marketingOptOut: false },
    { orgId, name: "Quiet Spender", email: "quiet@example.test", marketingOptOut: true },
    { orgId, name: "No Address", marketingOptOut: false },
  ]);
  await db.db.execute(sql`update customers set marketing_opt_out = true where name = 'Quiet Spender'`);
  // Lifetime spend: give all three qualifying customers 600 each via invoices.
  for (const name of ["Big Spender", "Quiet Spender", "No Address"]) {
    const [c] = await db.db.select({ id: customers.id }).from(customers).where(eq(customers.name, name));
    await db.db.execute(sql`insert into invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at) values (${orgId}, ${c!.id}, ${name === 'Big Spender' ? 901 : name === 'Quiet Spender' ? 902 : 903}, 'paid', 60000, 0, 60000, now())`);
  }
});

afterAll(async () => {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Marketing Lite Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
});

describe("marketing-lite (M13.3)", () => {
  it("segments resolve deterministic recipients; send honors opt-out and queues once", async () => {
    const segment = await run("marketing.createSegment", { name: "Spenders 500+", minSpendMinor: 50_000 });
    const campaign = await run("marketing.createCampaign", {
      segmentId: segment.segmentId,
      name: "Spring thank-you",
      subject: "A thank-you from us",
      body: "30 days: 21 entitlement, 3 taken, 18 remaining.",
    });
    const send = await run("marketing.sendCampaign", { campaignId: campaign.campaignId });
    expect(send).toMatchObject({ recipients: 1, skippedOptOut: 1, skippedNoAddress: 1, alreadySent: 0 });
    const queued = await db.db
      .select({ kind: outboxMessages.kind })
      .from(outboxMessages)
      .where(eq(outboxMessages.orgId, orgId));
    expect(queued).toEqual([{ kind: "email" }]);
    const analytics = await run("marketing.campaignAnalytics", { campaignId: campaign.campaignId });
    expect(analytics.sentCount).toBe(0);
    await expect(run("marketing.sendCampaign", { campaignId: campaign.campaignId })).rejects.toThrow(/already sent/);
  });
});
