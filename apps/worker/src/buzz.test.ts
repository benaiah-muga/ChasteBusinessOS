/**
 * Buzz bridge outbound mirror tests: registration gating, HMAC signing, and
 * the no-loop guard for messages that arrived via Buzz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createHmac } from "node:crypto";
import { createDb, runMigrations, schema, cleanupTestData, type Db } from "@chaste/db";
import { OutboxProcessor } from "@chaste/kernel";
import { buzzEnabled, buzzSignature, registerBuzzMirror } from "./buzz.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;
const SECRET = "mirror-secret";

describe("buzz outbound mirror", () => {
  it("signs payloads with HMAC-SHA256", () => {
    expect(buzzSignature("secret", "hello")).toBe(
      createHmac("sha256", "secret").update("hello").digest("hex"),
    );
  });

  it("is a no-op without a secret", () => {
    const prev = process.env.CHASTE_BUZZ_WEBHOOK_SECRET;
    delete process.env.CHASTE_BUZZ_WEBHOOK_SECRET;
    expect(buzzEnabled()).toBe(false);
    if (prev === undefined) delete process.env.CHASTE_BUZZ_WEBHOOK_SECRET;
    else process.env.CHASTE_BUZZ_WEBHOOK_SECRET = prev;
  });
});

describe.skipIf(!hasDb)("buzz outbound mirror (db)", () => {
  let db: Db;
  let received: { headers: http.IncomingHttpHeaders; body: unknown }[];
  let mock: http.Server;
  let url: string;
  let orgId: string;
  let userId: string;
  let threadId: string;
  let msgId: string;

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    received = [];
    mock = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: JSON.parse(data) });
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const addr = mock.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/webhook`;

    const [org] = await db.insert(schema.organizations).values({ name: "Buzz Org", autonomy: "confirm", region: "local" }).returning();
    const [user] = await db.insert(schema.users).values({ organizationId: org!.id, email: "buzz@test.local", displayName: "Buzz Admin" }).returning();
    const [thread] = await db
      .insert(schema.msgThreads)
      .values({ organizationId: org!.id, type: "group", name: "Mirror Room", createdBy: user!.id })
      .returning();
    const [msg] = await db
      .insert(schema.msgMessages)
      .values({ organizationId: org!.id, threadId: thread!.id, senderId: user!.id, kind: "text", body: "Hello mirror" })
      .returning();

    orgId = org!.id;
    userId = user!.id;
    threadId = thread!.id;
    msgId = msg!.id;

    process.env.CHASTE_BUZZ_WEBHOOK_SECRET = SECRET;
    process.env.CHASTE_BUZZ_OUTBOUND_WEBHOOK_URL = url;
  }, 60_000);

  afterAll(async () => {
    await cleanupTestData(db);
    await new Promise<void>((r) => mock.close(() => r()));
    delete process.env.CHASTE_BUZZ_WEBHOOK_SECRET;
    delete process.env.CHASTE_BUZZ_OUTBOUND_WEBHOOK_URL;
  });

  it("registers a handler and mirrors the event with a valid signature", async () => {
    const processor = new OutboxProcessor();
    expect(registerBuzzMirror(processor, db)).toBe(true);
    expect(processor.registeredTypes()).toContain("messaging.message.sent");

    await processor.process({
      id: crypto.randomUUID(),
      type: "messaging.message.sent",
      organizationId: orgId,
      occurredAt: new Date().toISOString(),
      payload: { threadId, messageId: msgId, sentById: userId },
    });

    expect(received.length).toBe(1);
    const { headers, body } = received[0]!;
    const payload = body as { event: string; threadId: string; body: string; threadName: string };
    expect(payload.event).toBe("messaging.message.sent");
    expect(payload.threadId).toBe(threadId);
    expect(payload.threadName).toBe("Mirror Room");
    expect(payload.body).toBe("Hello mirror");
    const expectedSig = buzzSignature(SECRET, JSON.stringify(body));
    expect(headers["x-chaste-signature"]).toBe(expectedSig);
  });

  it("skips messages that already arrived via Buzz (no echo loop)", async () => {
    const [echoMsg] = await db
      .insert(schema.msgMessages)
      .values({ organizationId: orgId, threadId, senderId: userId, kind: "text", body: "[via Buzz] echoed back" })
      .returning();

    const processor = new OutboxProcessor();
    registerBuzzMirror(processor, db);
    await processor.process({
      id: crypto.randomUUID(),
      type: "messaging.message.sent",
      organizationId: orgId,
      occurredAt: new Date().toISOString(),
      payload: { threadId, messageId: echoMsg!.id, sentById: userId },
    });

    expect(received.length).toBe(1); // unchanged
  });
});
