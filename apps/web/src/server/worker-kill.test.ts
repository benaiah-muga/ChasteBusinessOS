import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  actionReceipts,
  createDb,
  jobs,
  organizations,
  outboxMessages,
  purgeTenantFinancials,
  type Database,
} from "@chaste/db";
import { logger, type ActionContext, type CapabilityResult, type KernelExecutor } from "@chaste/kernel";
import { enqueueCapabilityJob, processOneJob } from "./jobs";
import { enqueueOutboxMessage, processOneOutbox, reconcileOutboxMessage } from "./outbox";
import type * as kernelModule from "@/server/kernel";

/**
 * B03 worker-kill fixture: a worker dies mid-flight while holding the lease,
 * and the surviving system must converge honestly. Three kill windows, each
 * with a different contract:
 *
 * 1. killed after the effect + receipt but before acknowledgement - the
 *    replacement worker replays the receipt: exactly one effect, one audit
 *    row, the late worker's acknowledgement is fenced.
 * 2. killed mid-execution, before the effect - the replacement runs fresh;
 *    when the dead worker's execution un-freezes it produces a SECOND effect
 *    whose acknowledgement is still fenced. The queue's honest promise is
 *    at-least-once plus fencing: mid-flight crashes need capability-level
 *    idempotency, which is why external effects carry idempotency keys.
 * 3. external delivery (outbox webhook): the provider received the call but
 *    the acknowledgement died in transit - the row converges to "unknown",
 *    nothing re-fires automatically, and reconciliation settles it from the
 *    provider receipt exactly once.
 */

const kill = vi.hoisted(() => ({
  parkInside: false,
  parkAfter: false,
  runs: 0,
  effects: [] as string[],
  db: null as { execute: (q: unknown) => Promise<unknown> } | null,
  gates: {} as Record<string, Promise<void>>,
  releases: {} as Record<string, () => void>,
  open(name: string) {
    this.gates[name] = new Promise<void>((resolve) => {
      this.releases[name] = resolve;
    });
  },
  close(name: string) {
    this.releases[name]?.();
  },
}));

vi.mock("@/server/kernel", async (importActual) => {
  const actual = await importActual<typeof kernelModule>();
  const { z } = await import("zod");
  const { defineCapability } = await import("@chaste/kernel");
  const cap = defineCapability({
    id: "messaging.killzoneProbe",
    module: "messaging",
    title: "Worker kill probe",
    intent: "fixture capability proving kill-window exactly-once and fencing semantics",
    permission: "messaging.write",
    risk: "write",
    input: z.object({ tag: z.string() }),
    output: z.object({ ran: z.boolean() }),
    async execute(_ctx, input) {
      kill.runs += 1;
      if (kill.parkInside) {
        kill.parkInside = false;
        await kill.gates.inside!;
      }
      kill.effects.push(input.tag);
      return { ran: true };
    },
  });
  return {
    ...actual,
    buildRegistry: (db: Parameters<typeof actual.buildRegistry>[0]) => {
      const registry = actual.buildRegistry(db);
      if (!registry.get("messaging.killzoneProbe")) registry.register(cap);
      return registry;
    },
    buildExecutor: (db: Parameters<typeof actual.buildExecutor>[0], registry: Parameters<typeof actual.buildExecutor>[1]) => {
      const executor: KernelExecutor = actual.buildExecutor(db, registry);
      const inner = executor.execute.bind(executor) as <O>(
        id: string,
        ctx: ActionContext,
        input: unknown,
        opts?: { approvedApprovalId?: string },
      ) => Promise<CapabilityResult<O>>;
      executor.execute = async <O>(id: string, ctx: ActionContext, input: unknown, opts?: { approvedApprovalId?: string }): Promise<CapabilityResult<O>> => {
        const result = await inner<O>(id, ctx, input, opts);
        if (id === "messaging.killzoneProbe" && kill.parkAfter) {
          kill.parkAfter = false;
          await kill.gates.after!;
        }
        return result;
      };
      return executor;
    },
  };
});

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let pg: Database;
let db: Database["db"];
const orgId = crypto.randomUUID();

async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function auditRowCount(): Promise<number> {
  const result = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ledger_events WHERE capability_id = 'messaging.killzoneProbe'`,
  )) as unknown as { rows?: { n: number }[] } | { n: number }[];
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return Number(rows[0]?.n ?? 0);
}

/** Audit rows accumulate across cases in the shared org; assert on deltas. */
async function expectAuditDelta(before: number, delta: number): Promise<void> {
  expect(await auditRowCount() - before).toBe(delta);
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({
    id: orgId,
    name: "Worker Kill Probe",
    slug: `kill-probe-${orgId.slice(0, 8)}`,
  });
});

afterAll(async () => {
  await purgeTenantFinancials(db, orgId);
  await db.delete(jobs).where(eq(jobs.orgId, orgId));
  await db.delete(outboxMessages).where(eq(outboxMessages.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete(jobs).where(eq(jobs.orgId, orgId));
  await db.delete(outboxMessages).where(eq(outboxMessages.orgId, orgId));
  kill.parkAfter = false;
  kill.parkInside = false;
  kill.runs = 0;
  kill.effects = [];
});

describe("worker-kill convergence (B03)", () => {
  it("killed after the effect and receipt, before the acknowledgement: the replacement replays the receipt - one effect, one audit row, late ack fenced", async () => {
    const jobId = await enqueueCapabilityJob(db, { orgId, type: "messaging.killzoneProbe", payload: { tag: "after-receipt" } });
    const auditBefore = await auditRowCount();
    kill.parkAfter = true;
    kill.open("after");

    const dead = processOneJob(db, logger, { workerId: "worker-A", now: new Date(), leaseMs: 400 });
    await until(async () => kill.runs === 1, "worker A to reach the kill window");
    // The kill window is "after the receipt": runs === 1 only proves the
    // effect started - the audit + receipt writes still need their database
    // round-trips. Waiting for the receipt row itself is the honest sync
    // point; without it a loaded database lets worker B read before worker
    // A's receipt lands, and B re-executes instead of replaying (flake).
    await until(async () => {
      const rows = await db
        .select({ id: actionReceipts.id })
        .from(actionReceipts)
        .where(and(eq(actionReceipts.orgId, orgId), eq(actionReceipts.intentKey, `${orgId}:${jobId}`)));
      return rows.length > 0;
    }, "worker A's receipt to become durable");

    // Worker B arrives after the (simulated) death: the lease is long past
    // expiry on B's clock, and A's heartbeat cannot out-run it.
    await processOneJob(db, logger, { workerId: "worker-B", now: new Date(Date.now() + 120_000), leaseMs: 400 });

    const [done] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(done!.status).toBe("done");
    expect(done!.attempts).toBe(2);
    expect(kill.effects).toEqual(["after-receipt"]);
    await expectAuditDelta(auditBefore, 1);

    // The "dead" worker un-freezes and tries to finish: its acknowledgement
    // is fenced, the completed state survives untouched.
    kill.close("after");
    await dead;
    const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(after!.status).toBe("done");
    await expectAuditDelta(auditBefore, 1);
  });

  it("killed mid-execution, before the effect: the replacement runs fresh and the revived corpse's effect is still fenced at acknowledgement - at-least-once, honestly", async () => {
    const jobId = await enqueueCapabilityJob(db, { orgId, type: "messaging.killzoneProbe", payload: { tag: "mid-flight" } });
    const auditBefore = await auditRowCount();
    kill.parkInside = true;
    kill.open("inside");

    const dead = processOneJob(db, logger, { workerId: "worker-A", now: new Date(), leaseMs: 400 });
    await until(async () => kill.runs === 1, "worker A to park mid-execution");

    await processOneJob(db, logger, { workerId: "worker-B", now: new Date(Date.now() + 120_000), leaseMs: 400 });
    const [done] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(done!.status).toBe("done");
    expect(kill.effects).toEqual(["mid-flight"]);

    // The corpse resumes and commits its effect - the at-least-once reality
    // of a mid-flight kill - but its acknowledgement can never win.
    kill.close("inside");
    await dead;
    const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(after!.status).toBe("done");
    expect(kill.effects).toEqual(["mid-flight", "mid-flight"]);
    await expectAuditDelta(auditBefore, 2);
  });

  it("external delivery died after the provider received it: converges to unknown, auto-retry never re-fires, reconciliation settles it once", async () => {
    let deliveries = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        deliveries += 1;
        await kill.gates.provider!;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    kill.open("provider");

    const outboxId = await enqueueOutboxMessage(db, {
      orgId,
      kind: "webhook",
      dedupeKey: "provider-once",
      payload: { url: "http://provider.test/hook", body: { event: "kill" } },
    });

    const dead = processOneOutbox(db, logger, { workerId: "worker-A", now: new Date(), leaseMs: 400 });
    await until(async () => deliveries === 1, "the provider to receive the webhook");

    // The worker dies with the response in flight. The next worker pass
    // marks the delivery unknown and claims nothing: no blind re-fire.
    await processOneOutbox(db, logger, { workerId: "worker-B", now: new Date(Date.now() + 120_000), leaseMs: 400 });
    const [unknown] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, outboxId));
    expect(unknown!.status).toBe("unknown");
    expect(deliveries).toBe(1);

    // The corpse un-freezes; its acknowledgement is fenced by the unknown
    // transition.
    kill.close("provider");
    await dead;
    const [stillUnknown] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, outboxId));
    expect(stillUnknown!.status).toBe("unknown");

    // Reconciliation settles it from the provider's receipt, exactly once;
    // a duplicate enqueue of the same intent collapses onto the settled row.
    expect(
      await reconcileOutboxMessage({ db, orgId, outboxId, status: "sent", providerReceipt: { checked: "provider" } }),
    ).toBe(true);
    expect(await reconcileOutboxMessage({ db, orgId, outboxId, status: "failed", note: "late operator guess" })).toBe(false);
    const reEnqueued = await enqueueOutboxMessage(db, {
      orgId,
      kind: "webhook",
      dedupeKey: "provider-once",
      payload: { url: "http://provider.test/hook", body: { event: "kill" } },
    });
    expect(reEnqueued).toBe(outboxId);

    const [settled] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, outboxId));
    expect(settled!.status).toBe("sent");
    expect(deliveries).toBe(1);
  });
});
