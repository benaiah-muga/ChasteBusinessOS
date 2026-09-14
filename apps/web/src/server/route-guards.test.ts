import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentSessions,
  conversations,
  conversationMembers,
  createDb,
  customers,
  employees,
  messages,
  organizations,
  users,
  type Database,
} from "@chaste/db";

/**
 * N01/N06 route-boundary matrix: session membership alone must not reveal
 * another module's records; session lists follow the detail visibility rule;
 * conversation lists agree with the detail boundary's membership requirement.
 * Route handlers are called directly with a mocked session resolution.
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

const { GET: hrGET } = await import("@/app/api/hr/route");
const { GET: customersGET } = await import("@/app/api/customers/route");
const { GET: sessionsGET } = await import("@/app/api/sessions/route");
const { GET: conversationsGET } = await import("@/app/api/conversations/route");
const { GET: setupGET } = await import("@/app/api/setup/route");

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
const orgId = crypto.randomUUID();
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();
const otherSessionId = crypto.randomUUID();
const privateConversationId = crypto.randomUUID();

function asUser(userId: string, permissions: string[]) {
  state.current = { userId, email: `${userId}@probe.test`, name: null, orgId, permissions: new Set(permissions) };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(users).values([
    { id: userA, email: `${userA}@probe.test` },
    { id: userB, email: `${userB}@probe.test` },
  ]);
  await db.insert(organizations).values({ id: orgId, name: "Guard Probe Org", slug: `guard-probe-${orgId.slice(0, 8)}` });
  await db.insert(employees).values({
    orgId,
    name: "Probe Employee",
    monthlySalaryMinor: 555_000,
    taxRateBps: 1_000,
  });
  await db.insert(customers).values({ orgId, name: "Probe Customer", email: "probe@customer.test" });
  await db.insert(agentSessions).values([
    { id: crypto.randomUUID(), orgId, userId: userA, title: "A's session", mode: "chat", status: "active" },
    { id: otherSessionId, orgId, userId: userB, title: "B's private session", mode: "chat", status: "active" },
  ]);
  await db.insert(conversations).values({
    id: privateConversationId,
    orgId,
    kind: "dm",
    title: "B only",
  });
  await db.insert(conversationMembers).values({ conversationId: privateConversationId, userId: userB });
  await db.insert(messages).values({ orgId, conversationId: privateConversationId, senderUserId: userB, body: "private preview text" });
});

afterAll(async () => {
  await db.delete(messages).where(eq(messages.conversationId, privateConversationId));
  await db.delete(conversationMembers).where(eq(conversationMembers.userId, userB));
  await db.delete(conversations).where(eq(conversations.orgId, orgId));
  await db.delete(agentSessions).where(eq(agentSessions.orgId, orgId));
  await db.delete(employees).where(eq(employees.orgId, orgId));
  await db.delete(customers).where(eq(customers.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userA));
  await db.delete(users).where(eq(users.id, userB));
  await pg.client.end();
});

describe("route read-authorization matrix (N01)", () => {
  it("hr salaries require hr.read; a restricted member gets 403 with no salary data", async () => {
    asUser(userA, ["hr.read"]);
    const ok = await hrGET();
    expect(ok.status).toBe(200);
    const data = await body(ok);
    expect(JSON.stringify(data)).toContain("555000");

    asUser(userA, ["crm.read"]);
    const denied = await hrGET();
    expect(denied.status).toBe(403);
    const deniedBody = await body(denied);
    expect(JSON.stringify(deniedBody)).not.toContain("555000");
    expect(deniedBody.error).toContain("hr.read");
  });

  it("customer directory requires crm.read", async () => {
    asUser(userA, ["crm.read"]);
    expect((await customersGET()).status).toBe(200);
    asUser(userA, []);
    expect((await customersGET()).status).toBe(403);
  });

  it("setup checklist requires iam.admin", async () => {
    asUser(userA, ["iam.admin"]);
    expect((await setupGET()).status).toBe(200);
    asUser(userA, ["hr.read"]);
    expect((await setupGET()).status).toBe(403);
  });

  it("session lists follow the detail visibility rule: own sessions, or everything for admins", async () => {
    asUser(userB, ["iam.read"]);
    const own = await body(await sessionsGET());
    expect((own.sessions as { title: string }[]).map((s) => s.title)).toEqual(["B's private session"]);

    asUser(userA, ["iam.admin"]);
    const admin = await body(await sessionsGET());
    expect((admin.sessions as { title: string }[])).toHaveLength(2);
  });

  it("conversation lists agree with the detail boundary's membership requirement (N06)", async () => {
    asUser(userB, ["messaging.read"]);
    const member = await body(await conversationsGET());
    const memberList = member.conversations as { id: string; lastMessage: { body: string } | null }[];
    expect(memberList.map((c) => c.id)).toContain(privateConversationId);
    expect(memberList.find((c) => c.id === privateConversationId)?.lastMessage?.body).toBe("private preview text");

    asUser(userA, ["messaging.read"]);
    const nonmember = await body(await conversationsGET());
    expect((nonmember.conversations as { id: string }[]).map((c) => c.id)).not.toContain(privateConversationId);
  });

  it("a wildcard-permission owner passes every guard", async () => {
    asUser(userA, ["*"]);
    expect((await hrGET()).status).toBe(200);
    expect((await customersGET()).status).toBe(200);
    expect((await setupGET()).status).toBe(200);
    expect((await sessionsGET()).status).toBe(200);
    expect((await conversationsGET()).status).toBe(200);
  });
});
