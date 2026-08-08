/**
 * Postgres-backed `WakeStore` over the `ai_wakes` table.
 *
 * ARCH-4 — the durable counterpart to `InMemoryWakeStore`. Schedules a session
 * to be re-invoked on a timer/completion/event trigger and persists across
 * processes, so a wake scheduled through the API is honored by the worker's
 * follow-up tick.
 */
import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
const { aiWakes } = schema;
import type { WakeKind, WakeRecord, WakeState, WakeStore } from "@chaste/ai-core";

export interface PostgresWakeStoreOptions {
  /** Optional clock — tests inject deterministic time. */
  now?: () => Date;
}

export class PostgresWakeStore implements WakeStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    opts: PostgresWakeStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async addTimer(
    sessionId: string,
    fireAt: Date,
    opts: { taskId?: string; proactiveText?: string; note?: string } = {},
  ): Promise<WakeRecord> {
    return this.put({ kind: "timer", sessionId, fireAt: fireAt.toISOString(), ...opts });
  }

  async addCompletion(
    sessionId: string,
    jobId: string,
    opts: { taskId?: string; proactiveText?: string; note?: string } = {},
  ): Promise<WakeRecord> {
    return this.put({ kind: "completion", sessionId, jobId, ...opts });
  }

  async addEvent(
    sessionId: string,
    eventKey: string,
    opts: { taskId?: string; proactiveText?: string; note?: string } = {},
  ): Promise<WakeRecord> {
    return this.put({ kind: "event", sessionId, eventKey, ...opts });
  }

  /** Timer wakes whose fire time has passed + completion/event wakes that have been signaled. */
  async due(now: Date = this.now()): Promise<WakeRecord[]> {
    const timer = and(
      eq(aiWakes.state, "pending"),
      eq(aiWakes.kind, "timer"),
      sql`${aiWakes.fireAt} IS NOT NULL`,
      sql`${aiWakes.fireAt} <= ${now.toISOString()}`,
    )!;
    const signaled = and(
      eq(aiWakes.state, "due"),
      ne(aiWakes.kind, "timer"),
    )!;
    const rows = await this.db
      .select()
      .from(aiWakes)
      .where(or(timer, signaled));
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.map((r) => this.toRecord(r));
  }

  /** Mark every completion wake for `jobId` as due (the job exited). Returns the marked rows. */
  async completeJob(jobId: string): Promise<WakeRecord[]> {
    return this.markDue(and(eq(aiWakes.kind, "completion"), eq(aiWakes.jobId, jobId))!);
  }

  /** Mark every event wake for `eventKey` as due (a connector/webhook fired). */
  async fireEvent(eventKey: string): Promise<WakeRecord[]> {
    return this.markDue(and(eq(aiWakes.kind, "event"), eq(aiWakes.eventKey, eventKey))!);
  }

  async markFired(wakeId: string): Promise<void> {
    await this.db
      .update(aiWakes)
      .set({ state: "fired" })
      .where(eq(aiWakes.id, wakeId));
  }

  async pending(sessionId?: string): Promise<WakeRecord[]> {
    const rows = sessionId
      ? await this.db
          .select()
          .from(aiWakes)
          .where(and(eq(aiWakes.sessionId, sessionId), ne(aiWakes.state, "fired")))
      : await this.db.select().from(aiWakes).where(ne(aiWakes.state, "fired"));
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.map((r) => this.toRecord(r));
  }

  /** Test/debug hook — clears the store. Not used by the orchestrator. */
  async reset(): Promise<void> {
    await this.db.delete(aiWakes);
  }

  /** Test/debug hook — returns every wake record. */
  async inspect(): Promise<WakeRecord[]> {
    const rows = await this.db.select().from(aiWakes);
    return rows.map((r) => this.toRecord(r));
  }

  // ---- internals -------------------------------------------------------

  private async markDue(where: SQL): Promise<WakeRecord[]> {
    const pendingRows = await this.db
      .select()
      .from(aiWakes)
      .where(and(where, eq(aiWakes.state, "pending")));
    if (pendingRows.length === 0) return [];
    await this.db
      .update(aiWakes)
      .set({ state: "due" })
      .where(inArray(aiWakes.id, pendingRows.map((r) => r.id)));
    return pendingRows.map((r) => this.toRecord(r));
  }

  private async put(input: {
    kind: WakeKind;
    sessionId: string;
    taskId?: string;
    proactiveText?: string;
    fireAt?: string;
    jobId?: string;
    eventKey?: string;
    note?: string;
  }): Promise<WakeRecord> {
    const id = crypto.randomUUID();
    const createdAt = this.now();
    await this.db.insert(aiWakes).values({
      id,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      proactiveText: input.proactiveText ?? null,
      kind: input.kind,
      state: "pending",
      fireAt: input.fireAt ? new Date(input.fireAt) : null,
      jobId: input.jobId ?? null,
      eventKey: input.eventKey ?? null,
      note: input.note ?? null,
      createdAt,
    });
    return {
      id,
      sessionId: input.sessionId,
      taskId: input.taskId,
      proactiveText: input.proactiveText,
      kind: input.kind,
      state: "pending",
      fireAt: input.fireAt,
      jobId: input.jobId,
      eventKey: input.eventKey,
      note: input.note,
      createdAt: createdAt.toISOString(),
    };
  }

  private toRecord(r: {
    id: string;
    sessionId: string;
    taskId: string | null;
    proactiveText: string | null;
    kind: string;
    state: string;
    fireAt: Date | null;
    jobId: string | null;
    eventKey: string | null;
    note: string | null;
    createdAt: Date;
  }): WakeRecord {
    return {
      id: r.id,
      sessionId: r.sessionId,
      taskId: r.taskId ?? undefined,
      proactiveText: r.proactiveText ?? undefined,
      kind: r.kind as WakeKind,
      state: r.state as WakeState,
      fireAt: r.fireAt?.toISOString(),
      jobId: r.jobId ?? undefined,
      eventKey: r.eventKey ?? undefined,
      note: r.note ?? undefined,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
