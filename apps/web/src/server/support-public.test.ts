import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, customers, organizations, supportConversations, supportSettings, type Database } from "@chaste/db";
import { purgeTenantFinancials } from "@chaste/db";
import { GET, POST } from "@/app/api/support/public/route";

/**
 * I1 (N04) widget containment: a visitor-supplied email never binds a
 * customer. The public token identifies the org, not the visitor; the
 * per-conversation secret issued once at start is what makes a thread the
 * visitor's — knowing a former customer's email plus the public token must
 * reveal nothing about them.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
const orgId = crypto.randomUUID();
const victimEmail = "victim@widget.test";
const embedToken = `embed-${crypto.randomUUID()}`;

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://test/api/support/public", { method: "POST", body: JSON.stringify(body) }));
}

function poll(conversationId: string, secret: string): Promise<Response> {
  return GET(
    new Request(
      `http://test/api/support/public?token=${embedToken}&conversationId=${conversationId}&secret=${secret}`,
    ),
  );
}

beforeAll(async () => {
  db = createDb(url);
  await db.db.insert(organizations).values({ id: orgId, name: "Widget Org", slug: `widget-${orgId.slice(0, 8)}` });
  await db.db.insert(customers).values({ orgId, name: "Victim Customer", email: victimEmail });
  await db.db.insert(supportSettings).values({ orgId, embedToken, autoReplyEnabled: true });
});

afterAll(async () => {
  await purgeTenantFinancials(db.db, orgId);
  await db.db.delete(supportConversations).where(eq(supportConversations.orgId, orgId));
  await db.db.delete(supportSettings).where(eq(supportSettings.orgId, orgId));
  await db.db.delete(customers).where(eq(customers.orgId, orgId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("public widget identity containment (N04)", () => {
  it("starts an unbound thread: no customer row is matched, created, or attached", async () => {
    const res = await post({
      action: "start",
      token: embedToken,
      email: victimEmail,
      name: "Someone Entirely Different",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { conversationId: string; secret: string };
    expect(data.secret).toBeTruthy();

    const [conv] = await db.db
      .select()
      .from(supportConversations)
      .where(eq(supportConversations.id, data.conversationId));
    expect(conv!.customerId).toBeNull();
    expect(conv!.visitorEmail).toBe(victimEmail);
    expect(conv!.visitorSecretHash).toBeTruthy();
    // The victim's customer row is untouched — no new customer was created
    // for the visitor either.
    const victimRows = await db.db
      .select()
      .from(customers)
      .where(and(eq(customers.orgId, orgId), eq(customers.email, victimEmail)));
    expect(victimRows).toHaveLength(1);
    expect(victimRows[0]!.name).toBe("Victim Customer");
  });

  it("the secret gates reading: token plus conversation id alone reveal nothing", async () => {
    const start = (await (
      await post({ action: "start", token: embedToken, email: "holder@widget.test" })
    ).json()) as { conversationId: string; secret: string };

    const noSecret = await GET(
      new Request(
        `http://test/api/support/public?token=${embedToken}&conversationId=${start.conversationId}`,
      ),
    );
    expect(noSecret.status).toBe(404);

    const wrongSecret = await poll(start.conversationId, "0".repeat(48));
    expect(wrongSecret.status).toBe(404);

    const ok = await poll(start.conversationId, start.secret);
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { messages: unknown[] };
    expect(data.messages.length).toBeGreaterThan(0);
  });

  it("the secret gates writing and escalating", async () => {
    const start = (await (
      await post({ action: "start", token: embedToken, email: "writer@widget.test" })
    ).json()) as { conversationId: string; secret: string };

    const refused = await post({
      action: "message",
      token: embedToken,
      conversationId: start.conversationId,
      secret: "0".repeat(48),
      body: "injected?",
    });
    expect(refused.status).toBe(404);

    const ok = await post({
      action: "message",
      token: embedToken,
      conversationId: start.conversationId,
      secret: start.secret,
      body: "hello from the real visitor",
    });
    expect(ok.status).toBe(200);

    const human = await post({
      action: "human",
      token: embedToken,
      conversationId: start.conversationId,
      secret: start.secret,
    });
    expect(human.status).toBe(200);
    const [conv] = await db.db
      .select()
      .from(supportConversations)
      .where(eq(supportConversations.id, start.conversationId));
    expect(conv!.status).toBe("escalated");
  });
});
