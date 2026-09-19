import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  bootstrapIntents,
  createDb,
  memberships,
  memories,
  organizations,
  policies,
  purgeTenantFinancials,
  roles,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { runOnboarding } from "./onboarding";

/**
 * B01/T08: the bootstrap is the one declared exception to the governed
 * command path - tenant creation cannot require an existing tenant - so its
 * honesty must be mechanical: a retry after a lost response replays the
 * receipt committed with the organization (even once the session already
 * resolves the org), a conflicting reuse of an intent id is refused, slug
 * uniqueness settles inside the transaction, and the embedding call never
 * holds the bootstrap transaction hostage.
 */

vi.mock("@chaste/ai", () => ({
  embed: vi.fn(async () => [new Array(1024).fill(0.5)]),
}));

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();
const orgIds: string[] = [];

const baseParams = (userId: string) => ({
  userId,
  userEmail: `${userId}@bootstrap.test`,
  orgName: "Bootstrap Works",
  businessDescription: "We repair vintage bicycles and sell refurbished frames and parts.",
});

async function waitForEmbeddingUpgrade(orgId: string): Promise<number[] | null> {
  for (let i = 0; i < 40; i++) {
    const [row] = await db.db.select({ embedding: memories.embedding }).from(memories).where(eq(memories.orgId, orgId));
    const vec = row?.embedding as unknown;
    if (Array.isArray(vec) && (vec as number[])[0] === 0.5) return vec as number[];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function track<T extends { orgId: string }>(result: T): T {
  orgIds.push(result.orgId);
  return result;
}

beforeAll(async () => {
  db = createDb(url);
  await db.db.insert(users).values([
    { id: userA, email: `${userA}@bootstrap.test`, name: "Founder A" },
    { id: userB, email: `${userB}@bootstrap.test`, name: "Founder B" },
  ]);
});

afterAll(async () => {
  for (const orgId of orgIds) {
    await purgeTenantFinancials(db.db, orgId);
    await db.db.delete(accounts).where(eq(accounts.orgId, orgId));
    await db.db.delete(memories).where(eq(memories.orgId, orgId));
    await db.db.delete(policies).where(eq(policies.orgId, orgId));
    await db.db.delete(userRoles).where(eq(userRoles.orgId, orgId));
    await db.db.delete(roles).where(eq(roles.orgId, orgId));
    await db.db.delete(organizations).where(eq(organizations.id, orgId));
  }
  await db.db.delete(bootstrapIntents).where(eq(bootstrapIntents.userId, userA));
  await db.db.delete(bootstrapIntents).where(eq(bootstrapIntents.userId, userB));
  await db.db.delete(memberships).where(eq(memberships.userId, userA));
  await db.db.delete(memberships).where(eq(memberships.userId, userB));
  await db.db.delete(users).where(eq(users.id, userA));
  await db.db.delete(users).where(eq(users.id, userB));
  await db.client.end();
});

describe("intent-keyed bootstrap (B01/T08)", () => {
  it("commits the receipt with the org; a retry after response loss replays it, even though the session now resolves the org", async () => {
    const first = track(await runOnboarding(db.db, { ...baseParams(userA), intentId: "intent-alpha-1" }));
    expect(first.replayed).toBeUndefined();

    // The user now has a membership; the retry must still find the receipt.
    const second = await runOnboarding(db.db, { ...baseParams(userA), intentId: "intent-alpha-1" });
    expect(second).toEqual({ orgId: first.orgId, replayed: true });

    // Exactly one workspace, one membership, one receipt.
    const ms = await db.db.select().from(memberships).where(eq(memberships.userId, userA));
    expect(ms).toHaveLength(1);
    const receipts = await db.db.select().from(bootstrapIntents).where(eq(bootstrapIntents.userId, userA));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.orgId).toBe(first.orgId);
  });

  it("refuses a conflicting reuse of the same intent id with a different payload", async () => {
    await expect(
      runOnboarding(db.db, { ...baseParams(userA), orgName: "A Different Business", intentId: "intent-alpha-1" }),
    ).rejects.toThrow(/intent conflict/);
  });

  it("without an intent id the second attempt is refused as already onboarded", async () => {
    await expect(runOnboarding(db.db, baseParams(userA))).rejects.toThrow(/already belongs/);
  });

  it("settles slug uniqueness inside the transaction against concurrent tenants", async () => {
    // The first test claimed the plain slug "bootstrap-works"; the unique
    // constraint, not a pre-flight check, decides here, and the service
    // walks the suffix under a savepoint inside the transaction.
    const result = track(await runOnboarding(db.db, { ...baseParams(userB), intentId: "intent-beta-1" }));
    const [org] = await db.db.select().from(organizations).where(eq(organizations.id, result.orgId));
    expect(org!.slug).toBe("bootstrap-works-2");
  });

  it("upgrades the zero-vector business profile with a real embedding after commit", async () => {
    const vec = await waitForEmbeddingUpgrade(orgIds[0]!);
    expect(vec).not.toBeNull();
    expect(vec).toHaveLength(1024);
  });

  it("two concurrent bootstraps on one intent create one org; the loser replays instead of erroring", async () => {
    const userC = crypto.randomUUID();
    await db.db.insert(users).values({ id: userC, email: `${userC}@bootstrap.test`, name: "Founder C" });
    try {
      const params = { ...baseParams(userC), intentId: "intent-race-1" };
      const outcomes = await Promise.allSettled([runOnboarding(db.db, params), runOnboarding(db.db, params)]);
      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      // Exactly one bootstrap wins; the loser converges to the winner's
      // receipt instead of surfacing a raw unique violation or a second org.
      expect(rejected).toHaveLength(0);
      expect(fulfilled).toHaveLength(2);
      const orgIds = fulfilled.map((o) => (o as PromiseFulfilledResult<{ orgId: string }>).value.orgId);
      expect(orgIds[0]).toBe(orgIds[1]);
      const replayed = fulfilled.map((o) => (o as PromiseFulfilledResult<{ orgId: string; replayed?: boolean }>).value.replayed ?? false);
      expect(replayed.filter(Boolean)).toHaveLength(1);
      track({ orgId: orgIds[0]! });
      const ms = await db.db.select().from(memberships).where(eq(memberships.userId, userC));
      expect(ms).toHaveLength(1);
    } finally {
      await db.db.delete(bootstrapIntents).where(eq(bootstrapIntents.userId, userC));
      await db.db.delete(memberships).where(eq(memberships.userId, userC));
      await db.db.delete(users).where(eq(users.id, userC));
    }
  });
});
