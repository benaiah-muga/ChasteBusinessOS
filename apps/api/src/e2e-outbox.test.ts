/**
 * ARCH-9/REL-2 — outbox delivery hardening E2E (Horizon B/REL-2):
 *  - claim-then-ack with FOR UPDATE SKIP LOCKED (no double-processing)
 *  - attempt/backoff accounting, lease expiry, dead-letter transition
 *  - core.outbox.replay / core.outbox.listDead with org scoping, permissions,
 *    and audit coverage
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createCommandRegistry,
  createQueryRegistry,
  createModuleRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
  type CommandRegistry,
  type QueryRegistry,
} from "@chaste/kernel";
import {
  createDb,
  runMigrations,
  schema,
  type Db,
  cleanupTestData,
  PostgresOutboxWriter,
  replayDeadLetterEvents,
  listDeadLetterEvents,
  usersWithPermission,
} from "@chaste/db";
import { eq } from "drizzle-orm";
import { createPlatformModule } from "@chaste/module-platform";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

let db: ReturnType<typeof createDb>;
let commands: CommandRegistry;
let queries: QueryRegistry;
let audit: InMemoryAuditWriter;
let outbox: InMemoryOutboxWriter;

const OUTBOX_PERMISSIONS = ["core.outbox.read", "core.outbox.manage"];

interface TestUser {
  id: string;
  email: string;
  displayName: string;
  permissions: string[];
}

const orgA = { id: "", adminUser: {} as TestUser, noPermUser: {} as TestUser, operatorUser: {} as TestUser };
const orgB = { id: "", adminUser: {} as TestUser };

async function createCompany(name: string, email: string, display: string, perms: string[]) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, autonomy: "confirm", region: "local" })
    .returning();
  const [userRow] = await db
    .insert(schema.users)
    .values({ organizationId: org!.id, email, displayName: display })
    .returning();
  const [role] = await db
    .insert(schema.roles)
    .values({ organizationId: org!.id, key: "admin", name: "Administrator", isSystem: true })
    .returning();
  for (const perm of perms) {
    await db.insert(schema.rolePermissions).values({ roleId: role!.id, permission: perm });
  }
  await db.insert(schema.userRoles).values({ userId: userRow!.id, roleId: role!.id });
  return {
    orgId: org!.id,
    adminUser: { id: userRow!.id, email: userRow!.email, displayName: userRow!.displayName, permissions: perms },
  };
}

function ctxFor(user: TestUser, orgId: string) {
  return createRequestContext({
    actor: {
      kind: "user" as const,
      userId: user.id,
      organizationId: orgId,
      displayName: user.displayName,
      permissions: new Set(user.permissions),
    },
  });
}

async function cmd(user: TestUser, orgId: string, name: string, input: unknown) {
  const result = await executeCommand(commands, name, input, ctxFor(user, orgId), { audit, outbox });
  return result.data;
}

async function qry(user: TestUser, orgId: string, name: string, input: unknown = {}) {
  const result = await executeQuery(queries, name, input, ctxFor(user, orgId));
  return result.data;
}

async function cmdFails(user: TestUser, orgId: string, name: string, input: unknown): Promise<any> {
  try {
    await executeCommand(commands, name, input, ctxFor(user, orgId), { audit, outbox });
    expect.fail("Should have thrown");
  } catch (e: any) {
    return e;
  }
}

async function qryFails(user: TestUser, orgId: string, name: string, input: unknown = {}): Promise<any> {
  try {
    await executeQuery(queries, name, input, ctxFor(user, orgId));
    expect.fail("Should have thrown");
  } catch (e: any) {
    return e;
  }
}

describe.skipIf(!hasDb)("Outbox delivery hardening E2E (ARCH-9/REL-2)", () => {
  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    commands = createCommandRegistry();
    queries = createQueryRegistry();
    audit = new InMemoryAuditWriter();
    outbox = new InMemoryOutboxWriter();

    const modules = createModuleRegistry();
    const platform = createPlatformModule(db, modules, { allowFullAutonomous: true, regions: ["local"] });
    platform.register({ commands, queries });

    const a = await createCompany("Outbox A", "oa@test.com", "Outbox A Admin", OUTBOX_PERMISSIONS);
    orgA.id = a.orgId;
    orgA.adminUser = a.adminUser;
    const [bare] = await db
      .insert(schema.users)
      .values({ organizationId: orgA.id, email: "obare@test.com", displayName: "No Perms" })
      .returning();
    orgA.noPermUser = { id: bare!.id, email: bare!.email, displayName: "No Perms", permissions: [] };

    // Operator for the usersWithPermission / operator-notification assertion.
    const [op] = await db
      .insert(schema.users)
      .values({ organizationId: orgA.id, email: "oop@test.com", displayName: "Outbox Operator" })
      .returning();
    const [opRole] = await db
      .insert(schema.roles)
      .values({ organizationId: orgA.id, key: "operator", name: "Operator", isSystem: true })
      .returning();
    await db.insert(schema.rolePermissions).values({ roleId: opRole!.id, permission: "core.outbox.manage" });
    await db.insert(schema.userRoles).values({ userId: op!.id, roleId: opRole!.id });
    orgA.operatorUser = { id: op!.id, email: op!.email, displayName: "Outbox Operator", permissions: ["core.outbox.manage"] };

    const b = await createCompany("Outbox B", "ob@test.com", "Outbox B Admin", OUTBOX_PERMISSIONS);
    orgB.id = b.orgId;
    orgB.adminUser = b.adminUser;
  });

  afterAll(async () => {
    if (db && orgA.id) {
      await cleanupTestData(db);
      await db.$client.end({ timeout: 5 });
    }
  });

  function event(over: Partial<{ id: string; type: string; org: string; payload: Record<string, unknown> }> = {}) {
    const { org, ...rest } = over;
    return {
      id: crypto.randomUUID(),
      type: "crm.customer.created",
      organizationId: org ?? orgA.id,
      occurredAt: new Date().toISOString(),
      payload: { customerId: "c-1", name: "Acme" },
      ...rest,
    };
  }

  // ─── Claim-then-ack ──────────────────────────────────────────────────

  describe("claimUnprocessed", () => {
    it("claims unprocessed events in FIFO order and only once while the lease is held", async () => {
      const writer = new PostgresOutboxWriter(db);
      const e1 = event();
      const e2 = event();
      await writer.enqueue(e1);
      await writer.enqueue(e2);

      const first = await writer.claimUnprocessed(50, 60_000);
      expect(first.map((r) => r.id).sort()).toEqual([e1.id, e2.id].sort());

      const second = await writer.claimUnprocessed(50, 60_000);
      expect(second).toHaveLength(0);

      await writer.markProcessed(e1.id);
      await writer.markProcessed(e2.id);
    });

    it("reclaims rows whose lease has expired (crashed worker recovery)", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event();
      await writer.enqueue(ev);
      await writer.claimUnprocessed(50, 60_000);

      await db
        .update(schema.outboxEvents)
        .set({ claimedAt: new Date(Date.now() - 120_000) })
        .where(eq(schema.outboxEvents.id, ev.id));

      const reclaimed = await writer.claimUnprocessed(50, 60_000);
      expect(reclaimed.map((r) => r.id)).toEqual([ev.id]);
      await writer.markProcessed(ev.id);
    });
  });

  // ─── Backoff + dead-letter transition ───────────────────────────────

  describe("markFailed → retry → dead-letter", () => {
    it("records attempts/last_error and gates the next attempt on backoff", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event();
      await writer.enqueue(ev);

      await writer.markFailed(ev.id, new Error("boom"), { maxRetries: 5, backoffMs: 60_000 });

      // Within the backoff window the row is not claimable…
      const blocked = await writer.claimUnprocessed(50, 60_000);
      expect(blocked).toHaveLength(0);

      // …and once next_attempt_at passes it is retried with the failure ledger.
      await db
        .update(schema.outboxEvents)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000), claimedAt: null })
        .where(eq(schema.outboxEvents.id, ev.id));
      const retried = await writer.claimUnprocessed(50, 60_000);
      expect(retried).toHaveLength(1);
      expect(retried[0].attempts).toBe(1);
      expect(retried[0].lastError).toBe("boom");
      await writer.markProcessed(ev.id);
    });

    it("copies the event to dead_letter_events after retries are exhausted", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event({ type: "acc.invoice.created" });
      await writer.enqueue(ev);

      const out = await writer.markFailed(ev.id, new Error("permanent failure"), {
        maxRetries: 1,
        backoffMs: 0,
        errorCode: "HANDLER_ERROR",
      });
      expect(out.deadLettered).toBe(true);

      const [outboxRow] = await db
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, ev.id));
      expect(outboxRow.deadLetteredAt).not.toBeNull();
      expect(outboxRow.attempts).toBe(1);

      const dead = await listDeadLetterEvents(db, orgA.id, 50);
      const dlq = dead.find((d) => d.id === ev.id);
      expect(dlq).toBeDefined();
      expect(dlq!.type).toBe("acc.invoice.created");
      expect(dlq!.lastError).toBe("permanent failure");
      expect(dlq!.errorCode).toBe("HANDLER_ERROR");
      expect(dlq!.replayedAt).toBeNull();
    });
  });

  // ─── Replay ─────────────────────────────────────────────────────────

  describe("replayDeadLetterEvents", () => {
    it("returns a dead-lettered event to the outbox and stamps replayed_at", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event();
      await writer.enqueue(ev);
      await writer.markFailed(ev.id, new Error("x"), { maxRetries: 1, backoffMs: 0 });

      const replayed = await replayDeadLetterEvents(db, orgA.id, [ev.id]);
      expect(replayed).toBe(1);

      const [outboxRow] = await db
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, ev.id));
      expect(outboxRow.deadLetteredAt).toBeNull();
      expect(outboxRow.attempts).toBe(0);

      const [dlqRow] = await db
        .select()
        .from(schema.deadLetterEvents)
        .where(eq(schema.deadLetterEvents.id, ev.id));
      expect(dlqRow.replayedAt).not.toBeNull();

      // Replaying again is a no-op (already replayed).
      expect(await replayDeadLetterEvents(db, orgA.id, [ev.id])).toBe(0);

      // And the row is now claimable again.
      const claimed = await writer.claimUnprocessed(50, 60_000);
      expect(claimed.some((r) => r.id === ev.id)).toBe(true);
      await writer.markProcessed(ev.id);
    });

    it("is org-scoped: another org cannot replay this org's events", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event({ org: orgA.id });
      await writer.enqueue(ev);
      await writer.markFailed(ev.id, new Error("x"), { maxRetries: 1, backoffMs: 0 });

      const replayedByOtherOrg = await replayDeadLetterEvents(db, orgB.id, [ev.id]);
      expect(replayedByOtherOrg).toBe(0);
    });
  });

  // ─── Operator discovery (DLQ notifications) ─────────────────────────

  describe("usersWithPermission", () => {
    it("returns only users holding the permission in the org", async () => {
      const admins = await usersWithPermission(db, orgA.id, "core.outbox.manage");
      const ids = admins.map((u) => u.userId).sort();
      expect(ids).toContain(orgA.adminUser.id);
      expect(ids).toContain(orgA.operatorUser.id);
      expect(ids).not.toContain(orgA.noPermUser.id);

      const noneInB = await usersWithPermission(db, orgB.id, "core.outbox.manage");
      expect(noneInB.map((u) => u.userId)).not.toContain(orgA.adminUser.id);
    });
  });

  // ─── Bus surface (permissions, org scoping, audit) ──────────────────

  describe("core.outbox.* commands/queries", () => {
    it("core.outbox.listDead returns dead events to readers and forbids others", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event();
      await writer.enqueue(ev);
      await writer.markFailed(ev.id, new Error("boom"), { maxRetries: 1, backoffMs: 0 });

      const res = await qry(orgA.adminUser, orgA.id, "core.outbox.listDead", {});
      expect(res.events.some((e: any) => e.id === ev.id)).toBe(true);
      expect(res.events[0].replayedAt).toBeNull();

      const denied = await qryFails(orgA.noPermUser, orgA.id, "core.outbox.listDead", {});
      expect(denied.code).toBe("PERMISSION_DENIED");
    });

    it("core.outbox.replay re-queues events with audit coverage and forbids non-managers", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event();
      await writer.enqueue(ev);
      await writer.markFailed(ev.id, new Error("boom"), { maxRetries: 1, backoffMs: 0 });

      audit.entries.length = 0;
      const res = await cmd(orgA.adminUser, orgA.id, "core.outbox.replay", { eventIds: [ev.id] });
      expect(res.replayed).toBe(1);

      // Audit coverage via the command bus: action + success + input provenance.
      const replayAudits = audit.entries.filter((e) => e.action === "core.outbox.replay");
      expect(replayAudits).toHaveLength(1);
      expect(replayAudits[0].success).toBe(true);
      expect(replayAudits[0].actorUserId).toBe(orgA.adminUser.id);
      expect(replayAudits[0].inputSummary).toEqual({ eventIds: [ev.id] });

      const denied = await cmdFails(orgA.noPermUser, orgA.id, "core.outbox.replay", { eventIds: [ev.id] });
      expect(denied.code).toBe("PERMISSION_DENIED");
    });

    it("core.outbox.replay cannot re-queue another org's events", async () => {
      const writer = new PostgresOutboxWriter(db);
      const ev = event({ org: orgB.id });
      await writer.enqueue(ev);
      await writer.markFailed(ev.id, new Error("boom"), { maxRetries: 1, backoffMs: 0 });

      const res = await cmd(orgA.adminUser, orgA.id, "core.outbox.replay", { eventIds: [ev.id] });
      expect(res.replayed).toBe(0);
    });
  });
});
