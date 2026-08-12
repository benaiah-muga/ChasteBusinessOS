/**
 * Buzz bridge inbound webhook E2E: HMAC verification and posting into an
 * internal thread as the thread creator through the normal command bus.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";
import { schema } from "@chaste/db";

const hasDb = Boolean(process.env.DATABASE_URL);
const SECRET = "buzz-test-secret";

describe.skipIf(!hasDb)("buzz bridge webhook", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;
  let orgId: string;
  let adminId: string;
  let threadId: string;

  function sign(payload: unknown): string {
    return createHmac("sha256", SECRET).update(JSON.stringify(payload)).digest("hex");
  }

  beforeAll(async () => {
    process.env.CHASTE_BUZZ_WEBHOOK_SECRET = SECRET;
    const built = await buildServer();
    server = built.server;
    app = built.app;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;

    const session = (await fetch(`${base}/api/v1/session`).then((r) => r.json())) as {
      userId: string;
      organizationId: string;
    };
    orgId = session.organizationId;
    adminId = session.userId;

    const [member] = await app.db
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email: `buzz-${Date.now()}@test.local`,
        displayName: "Buzz Member",
      })
      .returning();

    const created = (await fetch(`${base}/api/v1/commands/messaging.thread.create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { kind: "group", name: "Buzz Bridge Test", memberIds: [member!.id] },
      }),
    }).then((r) => r.json())) as { data: { id: string } };
    threadId = created.data.id;
  }, 60_000);

  afterAll(async () => {
    await server.close();
    delete process.env.CHASTE_BUZZ_WEBHOOK_SECRET;
  });

  it("rejects unsigned webhooks", async () => {
    const res = await fetch(`${base}/api/v1/buzz/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, body: "hello", ts: Math.floor(Date.now() / 1000) }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a webhook signed with the wrong secret", async () => {
    const res = await fetch(`${base}/api/v1/buzz/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chaste-signature": createHmac("sha256", "wrong-secret")
          .update(JSON.stringify({ threadId, body: "hello", ts: Math.floor(Date.now() / 1000) }))
          .digest("hex"),
      },
      body: JSON.stringify({ threadId, body: "hello", ts: Math.floor(Date.now() / 1000) }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a replayed webhook with a stale timestamp (F18)", async () => {
    const payload = {
      threadId,
      body: "stale",
      ts: Math.floor(Date.now() / 1000) - 3600,
    };
    const res = await fetch(`${base}/api/v1/buzz/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chaste-signature": sign(payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("BUZZ_STALE_TIMESTAMP");
  });

  it("posts a valid signed message into the thread as its creator", async () => {
    const payload = { threadId, body: "Hello from Buzz", ts: Math.floor(Date.now() / 1000) };
    const res = await fetch(`${base}/api/v1/buzz/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chaste-signature": sign(payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { threadId: string; body: string };
    expect(result.threadId).toBe(threadId);

    const rows = await app.db
      .select()
      .from(schema.msgMessages)
      .where(eq(schema.msgMessages.threadId, threadId));
    const buzzMsg = rows.find((m) => m.body.includes("Hello from Buzz"));
    expect(buzzMsg).toBeTruthy();
    expect(buzzMsg!.senderId).toBe(adminId);
    expect(buzzMsg!.body).toBe("[via Buzz] Hello from Buzz");
  });

  it("returns 404 for an unknown thread", async () => {
    const payload = {
      threadId: "00000000-0000-0000-0000-000000000000",
      body: "lost",
      ts: Math.floor(Date.now() / 1000),
    };
    const res = await fetch(`${base}/api/v1/buzz/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chaste-signature": sign(payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(404);
  });
});
