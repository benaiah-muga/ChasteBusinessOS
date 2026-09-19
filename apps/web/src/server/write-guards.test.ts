import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  creatorProposals,
  notificationReads,
  notifications,
  organizations,
  supportSettings,
  users,
  type Database,
} from "@chaste/db";

/**
 * Slice-A write-boundary proofs:
 *  - N29: broadcast reads are per-user receipts; one person's read never
 *    clears a notification for anyone else; repeats are idempotent; a user
 *    cannot mark another user's personal notification.
 *  - N34: proposal review decisions are compare-and-set - exactly one
 *    decision wins, the loser gets a conflict.
 *  - N08: reading channel settings never creates the settings row and never
 *    exposes the embed token to non-admins; only admins mutate.
 */

const state = vi.hoisted(() => ({
  current: null as {
    userId: string;
    email: string;
    name: string | null;
    orgId: string | null;
    permissions: Set<string>;
  } | null,
}));

vi.mock("@/server/session", () => ({
  getResolvedUser: async () => state.current,
}));

const { GET: notificationsGET, POST: notificationsPOST } = await import("@/app/api/notifications/route");
const { POST: proposalsPOST } = await import("@/app/api/proposals/route");
const { GET: channelsGET, POST: channelsPOST } = await import("@/app/api/support/channels/route");

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
const orgId = crypto.randomUUID();
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();

function asUser(userId: string, permissions: string[]) {
  state.current = { userId, email: `${userId}@probe.test`, name: null, orgId, permissions: new Set(permissions) };
}

async function post(route: (req: Request) => Promise<Response>, payload: unknown): Promise<Response> {
  return route(new Request("http://probe.test/api", { method: "POST", body: JSON.stringify(payload) }));
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(users).values([
    { id: userA, email: `${userA}@probe.test` },
    { id: userB, email: `${userB}@probe.test` },
  ]);
  await db.insert(organizations).values({ id: orgId, name: "Write Guard Org", slug: `write-guard-${orgId.slice(0, 8)}` });
});

afterAll(async () => {
  await db.delete(notificationReads).where(eq(notificationReads.orgId, orgId));
  await db.delete(notifications).where(eq(notifications.orgId, orgId));
  await db.delete(creatorProposals).where(eq(creatorProposals.orgId, orgId));
  await db.delete(supportSettings).where(eq(supportSettings.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userA));
  await db.delete(users).where(eq(users.id, userB));
  await pg.client.end();
});

describe("per-user notification receipts (N29)", () => {
  it("one person's read of a broadcast leaves it unread for everyone else", async () => {
    const [broadcast] = await db
      .insert(notifications)
      .values({ orgId, kind: "system", title: "Org-wide notice" })
      .returning();

    asUser(userA, []);
    const mark = await post(notificationsPOST, { id: broadcast!.id });
    expect(mark.status).toBe(200);

    const aFeed = (await (await notificationsGET(new Request("http://probe.test/api"))).json()) as { unreadCount: number };
    expect(aFeed.unreadCount).toBe(0);

    asUser(userB, []);
    const bFeed = (await (await notificationsGET(new Request("http://probe.test/api"))).json()) as { unreadCount: number };
    expect(bFeed.unreadCount).toBe(1);

    const [row] = await db.select().from(notifications).where(eq(notifications.id, broadcast!.id));
    expect(row!.readAt).toBeNull();
  });

  it("repeated mark-read is idempotent", async () => {
    const [n] = await db.insert(notifications).values({ orgId, kind: "system", title: "idem" }).returning();
    asUser(userA, []);
    expect((await post(notificationsPOST, { id: n!.id })).status).toBe(200);
    expect((await post(notificationsPOST, { id: n!.id })).status).toBe(200);
    const reads = await db.select().from(notificationReads).where(eq(notificationReads.notificationId, n!.id));
    expect(reads).toHaveLength(1);
  });

  it("a user cannot mark someone else's personal notification", async () => {
    const [personal] = await db
      .insert(notifications)
      .values({ orgId, userId: userA, kind: "system", title: "only for A" })
      .returning();
    asUser(userB, []);
    const res = await post(notificationsPOST, { id: personal!.id });
    expect(res.status).toBe(404);
  });
});

describe("proposal review compare-and-set (N34)", () => {
  it("exactly one decision wins; the competing decision conflicts", async () => {
    const [proposal] = await db
      .insert(creatorProposals)
      .values({
        orgId,
        title: "probe proposal",
        summary: "summary",
        diffText: "diff",
        status: "in_review",
        proposedByActorType: "human",
      })
      .returning();

    asUser(userA, ["platform.creator"]);
    const first = await post(proposalsPOST, { proposalId: proposal!.id, decision: "approved", comment: "fine" });
    expect(first.status).toBe(200);

    asUser(userB, ["platform.creator"]);
    const second = await post(proposalsPOST, { proposalId: proposal!.id, decision: "rejected" });
    expect(second.status).toBe(409);

    const [row] = await db.select().from(creatorProposals).where(eq(creatorProposals.id, proposal!.id));
    expect(row!.status).toBe("approved");
    expect(row!.reviewedByUserId).toBe(userA);
  });
});

describe("support channel settings without read side effects (N08)", () => {
  it("GET never creates the settings row and hides the token from non-admins", async () => {
    asUser(userA, ["support.read"]);
    const res = (await (await channelsGET()).json()) as { embedToken: string | null; canManage: boolean };
    expect(res.embedToken).toBeNull();
    expect(res.canManage).toBe(false);
    const rows = await db.select().from(supportSettings).where(eq(supportSettings.orgId, orgId));
    expect(rows).toHaveLength(0);
  });

  it("only admins can change settings or provision the token", async () => {
    asUser(userA, ["support.read"]);
    expect((await post(channelsPOST, { greeting: "hi" })).status).toBe(403);

    asUser(userA, ["iam.admin"]);
    const created = (await (await post(channelsPOST, { greeting: "hello", autoReplyEnabled: true })).json()) as {
      embedToken: string;
    };
    expect(created.embedToken).toBeTruthy();

    const before = created.embedToken;
    const rotated = (await (await post(channelsPOST, { regenerateToken: true })).json()) as { embedToken: string };
    expect(rotated.embedToken).not.toBe(before);
  });
});
