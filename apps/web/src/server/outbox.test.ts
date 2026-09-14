import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, createDb, customers, notifications, organizations, outboxMessages, type Database } from "@chaste/db";
import { logger } from "@chaste/kernel";
import { DbApprovalFlow } from "./kernel";
import { enqueueOutboxMessage, processOneOutbox, reconcileOutboxMessage } from "./outbox";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
const orgId = crypto.randomUUID();

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({
    id: orgId,
    name: "Outbox Test Org",
    slug: `outbox-test-${orgId.slice(0, 8)}`,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.delete(outboxMessages).where(eq(outboxMessages.orgId, orgId));
  await db.delete(customers).where(eq(customers.orgId, orgId));
  await db.delete(notifications).where(eq(notifications.orgId, orgId));
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("durable external outbox", () => {
  it("deduplicates a webhook intent and records the provider acknowledgement", async () => {
    const id = await enqueueOutboxMessage(db, {
      orgId,
      kind: "webhook",
      dedupeKey: "test:webhook:one",
      payload: { url: "https://notify.example.test/hook", body: { event: "test" } },
    });
    expect(await enqueueOutboxMessage(db, {
      orgId,
      kind: "webhook",
      dedupeKey: "test:webhook:one",
      payload: { url: "https://notify.example.test/hook", body: { event: "test" } },
    })).toBe(id);

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await processOneOutbox(db, logger, { workerId: "outbox-test", now: new Date(Date.now() + 1_000) })).toBe(true);
    const [row] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id));
    expect(row!.status).toBe("sent");
    expect(row!.providerReceipt).toMatchObject({ status: 202 });
    expect(await processOneOutbox(db, logger, { workerId: "outbox-test" })).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not resend an uncertain provider call and exposes explicit reconciliation", async () => {
    const id = await enqueueOutboxMessage(db, {
      orgId,
      kind: "webhook",
      dedupeKey: "test:webhook:unknown",
      payload: { url: "https://notify.example.test/hook", body: { event: "timeout" } },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    vi.stubGlobal("fetch", fetchMock);
    await processOneOutbox(db, logger, { workerId: "outbox-test" });
    const [unknown] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id));
    expect(unknown!.status).toBe("unknown");
    expect(await processOneOutbox(db, logger, { workerId: "outbox-test" })).toBe(false);
    expect(await reconcileOutboxMessage({ db, orgId, outboxId: id, status: "sent", providerReceipt: { checked: true } })).toBe(true);
    const [resolved] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id));
    expect(resolved!.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("writes approval webhook and email intents through the durable approval sink", async () => {
    vi.stubEnv("NOTIFICATION_WEBHOOK_URL", "https://notify.example.test/hook");
    vi.stubEnv("SMTP_HOST", "smtp.example.test");
    vi.stubEnv("SMTP_TO", "ops@example.test");
    const flow = new DbApprovalFlow(db);
    await flow.submit(
      {
        capabilityId: "accounting.recordPayment",
        riskClass: "money",
        payload: { invoiceNumber: 42, amountMinor: 5000 },
        rationale: "A human must approve this payment before it is posted.",
      },
      {
        actor: { type: "agent", id: crypto.randomUUID(), orgId, permissions: new Set(["accounting.recordPayment"]) },
        now: new Date(),
        services: {},
      },
    );
    const rows = await db
      .select({ kind: outboxMessages.kind })
      .from(outboxMessages)
      .where(and(eq(outboxMessages.orgId, orgId), eq(outboxMessages.status, "pending")));
    expect(rows.map((row) => row.kind).sort()).toEqual(["email", "webhook"]);
  });

  it("rechecks a marketing recipient before dispatch and does not call SMTP after unsubscribe", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ orgId, name: "Unsubscribed Customer", email: "unsubscribe@example.test" })
      .returning({ id: customers.id });
    const id = await enqueueOutboxMessage(db, {
      orgId,
      kind: "email",
      dedupeKey: "marketing:test:unsubscribe",
      payload: {
        to: "unsubscribe@example.test",
        subject: "A campaign",
        text: "This should not be delivered.",
        customerId: customer!.id,
      },
    });
    await db.update(customers).set({ marketingOptOut: true }).where(eq(customers.id, customer!.id));
    vi.stubEnv("SMTP_HOST", "smtp.example.test");
    await processOneOutbox(db, logger, { workerId: "outbox-test" });
    const [row] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id));
    expect(row!.status).toBe("failed");
    expect(row!.lastError).toMatch(/no longer eligible/);
  });
});
