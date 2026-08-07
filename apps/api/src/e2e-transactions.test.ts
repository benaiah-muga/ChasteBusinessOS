/**
 * ARCH-2 — transactional-outbox chaos tests (real PostgreSQL).
 *
 * Proves the command bus wraps business writes + outbox event + success audit in
 * a single DB transaction:
 *   - a handler whose business writes succeed but then throws leaves NO row and
 *     NO event behind (full rollback), but DOES record a failure audit row;
 *   - a normal command commits business row + outbox event + audit atomically.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createCommandRegistry,
  createModuleRegistry,
  createQueryRegistry,
  createRequestContext,
  executeCommand,
  defineCommand,
  type Actor,
  type CommandHelpers,
} from "@chaste/kernel";
import {
  createDb,
  createCommandHelpers,
  PostgresAuditWriter,
  PostgresOutboxWriter,
  schema,
  type Db,
} from "@chaste/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

let db: Db;
let orgId: string;
let actorId: string;
let actor: Actor;

async function customerCount() {
  const rows = await db
    .select({ id: schema.crmCustomers.id })
    .from(schema.crmCustomers)
    .where(eq(schema.crmCustomers.organizationId, orgId));
  return rows.length;
}

async function eventCount(type: string) {
  const rows = await db
    .select({ id: schema.outboxEvents.id })
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.organizationId, orgId))
    .where(eq(schema.outboxEvents.type, type));
  return rows.length;
}

async function auditCount(action: string) {
  const rows = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actorUserId, actorId))
    .where(eq(schema.auditLog.action, action));
  return rows.length;
}

function makeHub(): CommandHelpers {
  return createCommandHelpers({
    audit: new PostgresAuditWriter(db),
    outbox: new PostgresOutboxWriter(db),
    db,
  });
}

function buildRegistry() {
  const commands = createCommandRegistry();
  const queries = createQueryRegistry();
  void createModuleRegistry(commands, queries);

  commands.register(
    defineCommand({
      name: "arch2.boom",
      permissions: ["arch2.boom"],
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.literal(true) }),
      handler: async (input, ctx, h) => {
        const tx = (h.db ?? db) as Db;
        await tx.insert(schema.crmCustomers).values({
          organizationId: orgId,
          name: input.name,
        });
        await tx.insert(schema.outboxEvents).values({
          id: crypto.randomUUID(),
          type: "arch2.phantom",
          organizationId: orgId,
          payload: { name: input.name },
        });
        throw new Error("kaboom after write");
      },
    }),
  );

  commands.register(
    defineCommand({
      name: "arch2.ok",
      permissions: ["arch2.ok"],
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
      handler: async (input, ctx, h) => {
        const tx = (h.db ?? db) as Db;
        const [row] = await tx
          .insert(schema.crmCustomers)
          .values({ organizationId: orgId, name: input.name })
          .returning();
        await tx.insert(schema.outboxEvents).values({
          id: crypto.randomUUID(),
          type: "arch2.created",
          organizationId: orgId,
          payload: { name: input.name },
        });
        return { id: row!.id };
      },
    }),
  );

  return commands;
}

describe.skipIf(!hasDb)("ARCH-2 transactional outbox", () => {
  beforeAll(async () => {
    db = createDb(DB_URL);
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "ARCH2 Test Co", autonomy: "confirm", region: "local" })
      .returning();
    orgId = org!.id;
    const [u] = await db
      .insert(schema.users)
      .values({ organizationId: orgId, email: "arch2@test.local", displayName: "ARCH2 Tester" })
      .returning();
    actorId = u!.id;
    actor = {
      kind: "user",
      userId: actorId,
      organizationId: orgId,
      permissions: new Set(["arch2.boom", "arch2.ok"]),
    };
  });

  afterAll(async () => {
    if (db) {
      await db.delete(schema.crmCustomers).where(eq(schema.crmCustomers.organizationId, orgId));
      await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.organizationId, orgId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.actorUserId, actorId));
      await db.delete(schema.users).where(eq(schema.users.id, actorId));
      await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      await db.$client.end({ timeout: 5 });
    }
  });

  it("rolls back business writes AND outbox when the handler throws", async () => {
    const commands = buildRegistry();
    const before = await customerCount();

    await expect(
      executeCommand(commands, "arch2.boom", { name: "Ghost Co" }, createRequestContext({ actor }), makeHub()),
    ).rejects.toThrow("kaboom after write");

    // Business row gone, phantom event gone.
    expect(await customerCount()).toBe(before);
    expect(await eventCount("arch2.phantom")).toBe(0);
    // Failure audit IS recorded (outside the rolled-back tx).
    expect(await auditCount("arch2.boom")).toBe(1);
  });

  it("commits business writes + outbox + success audit atomically on success", async () => {
    const commands = buildRegistry();
    const before = await customerCount();

    const res = await executeCommand(
      commands,
      "arch2.ok",
      { name: "Atomic Co" },
      createRequestContext({ actor }),
      makeHub(),
    );
    expect(res.ok).toBe(true);

    expect(await customerCount()).toBe(before + 1);
    expect(await eventCount("arch2.created")).toBe(1);
    // Success audit written via the tx-scoped writer.
    expect(await auditCount("arch2.ok")).toBe(1);
  });
});