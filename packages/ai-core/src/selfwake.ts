/**
 * Self-wake — ported from OpenWorker `coworker/selfwake.py`.
 *
 * Lets an agent suspend itself and be re-invoked on a trigger, converting the
 * always-on proactive loop into a suspend/resume pattern with ~zero idle cost.
 * This is the implementation backing the platform's FollowUp → harness re-entry
 * loop (VISION §5B + ARCHITECTURE §"Scheduling") that previously had no
 * runtime mechanism specified.
 *
 * Three triggers:
 * - `timer`     (`sleepFor` / `sleepUntil`): fire when wall-clock passes.
 * - `completion` (`wakeOnJob`): fire when a referenced background job exits.
 * - `event`     (`wakeOnEvent`): fire when a named connector/webhook fires.
 *
 * The store is pure logic; the worker tick consumes `due()` and resolves
 * scheduled AI turns back into the orchestrator. Durable Postgres-backed
 * persistence is layered via `ai_wakes` (see packages/db schema additions).
 */

export type WakeKind = "timer" | "completion" | "event";

export type WakeState = "pending" | "due" | "fired";

export interface WakeRecord {
  id: string;
  sessionId: string;
  /** Optional owning task — known to the scheduler for re-entry. */
  taskId?: string;
  /** Synthetic proactive message delivered when this wake fires. */
  proactiveText?: string;
  /** When the wake fires, the orchestrator re-enters the harness with this call. */
  kind: WakeKind;
  state: WakeState;
  /** ISO-8601 — when this wake is next eligible to fire (timer kind only). */
  fireAt?: string;
  /** Background job id — for completion kind. */
  jobId?: string;
  /** Named event key — for event kind. */
  eventKey?: string;
  note?: string;
  createdAt: string;
}

export interface WakeStoreOptions {
  now?: () => Date;
}

export class WakeStore {
  private readonly wakes = new Map<string, WakeRecord>();
  private readonly now: () => Date;

  constructor(opts: WakeStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  addTimer(
    sessionId: string,
    fireAt: Date,
    opts: { taskId?: string; proactiveText?: string; note?: string } = {},
  ): WakeRecord {
    return this.put({
      kind: "timer",
      sessionId,
      fireAt: fireAt.toISOString(),
      ...opts,
    });
  }

  addCompletion(
    sessionId: string,
    jobId: string,
    opts: { taskId?: string; proactiveText?: string; note?: string } = {},
  ): WakeRecord {
    return this.put({
      kind: "completion",
      sessionId,
      jobId,
      ...opts,
    });
  }

  addEvent(
    sessionId: string,
    eventKey: string,
    opts: { taskId?: string; proactiveText?: string; note?: string } = {},
  ): WakeRecord {
    return this.put({
      kind: "event",
      sessionId,
      eventKey,
      ...opts,
    });
  }

  /** Timer wakes whose fire time has passed + completion/event wakes that have been signaled. */
  due(now: Date = this.now()): WakeRecord[] {
    const out: WakeRecord[] = [];
    for (const w of this.wakes.values()) {
      if (w.state === "fired") continue;
      if (
        w.kind === "timer" &&
        w.state === "pending" &&
        w.fireAt &&
        new Date(w.fireAt).getTime() <= now.getTime()
      ) {
        out.push(w);
      } else if (w.kind !== "timer" && w.state === "due") {
        out.push(w);
      }
    }
    // stable order by createdAt
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  /** Mark every completion wake for `jobId` as due (the job exited). Returns the marked rows. */
  completeJob(jobId: string): WakeRecord[] {
    return this.markDue((w) => w.kind === "completion" && w.jobId === jobId);
  }

  /** Mark every event wake for `eventKey` as due (a connector/webhook fired). */
  fireEvent(eventKey: string): WakeRecord[] {
    return this.markDue((w) => w.kind === "event" && w.eventKey === eventKey);
  }

  markFired(wakeId: string): void {
    const w = this.wakes.get(wakeId);
    if (w) {
      w.state = "fired";
      this.wakes.set(wakeId, w);
    }
  }

  pending(sessionId?: string): WakeRecord[] {
    return [...this.wakes.values()].filter(
      (w) => w.state !== "fired" && (sessionId == null || w.sessionId === sessionId),
    );
  }

  // ---- test/debug helpers --------------------------------------------------

  reset(): void {
    this.wakes.clear();
  }

  inspect(): WakeRecord[] {
    return [...this.wakes.values()];
  }

  // ---- internals ---------------------------------------------------------

  private markDue(pred: (w: WakeRecord) => boolean): WakeRecord[] {
    const fired: WakeRecord[] = [];
    for (const w of this.wakes.values()) {
      if (w.state === "pending" && pred(w)) {
        w.state = "due";
        this.wakes.set(w.id, w);
        fired.push(w);
      }
    }
    return fired;
  }

  private put(input: Omit<WakeRecord, "id" | "state" | "createdAt">): WakeRecord {
    const id = crypto.randomUUID();
    const rec: WakeRecord = {
      ...input,
      id,
      state: "pending",
      createdAt: this.now().toISOString(),
    };
    this.wakes.set(id, rec);
    return rec;
  }
}

// ---------------------------------------------------------------------------
// Tools surfaced to the agent — the orchestrator wires these as AI-callable
// `agent.*` tools. Each returns the durable wake record so the agent (and the
// audit log) can reason about it.
// ---------------------------------------------------------------------------

export interface SelfWakeTools {
  sleepFor: (
    seconds: number,
    note?: string,
  ) => { ok: true; wakeId: string; fireAt: string };
  sleepUntil: (
    isoTimestamp: string,
    note?: string,
  ) => { ok: true; wakeId: string; fireAt: string };
  wakeOnJob: (
    jobId: string,
    note?: string,
  ) => { ok: true; wakeId: string; jobId: string };
  wakeOnEvent: (
    eventKey: string,
    note?: string,
  ) => { ok: true; wakeId: string; eventKey: string };
}

/**
 * Build the four agent-callable self-wake tools bound to a session. The
 * orchestrator's tool registry forwards these directly; every tool's side effect
 * is the creation of a durable wake record, never a silent side effect on real
 * state. The tools never modify the agent's runtime directly.
 */
export function selfWakeTools(
  store: WakeStore,
  sessionId: string,
  opts: { taskId?: string; proactiveText?: string } = {},
): SelfWakeTools {
  function sleepFor(seconds: number, note?: string) {
    const when = new Date(Date.now() + Math.max(0, Math.trunc(seconds) * 1000));
    const w = store.addTimer(sessionId, when, { ...opts, note });
    return { ok: true as const, wakeId: w.id, fireAt: w.fireAt! };
  }
  function sleepUntil(isoTimestamp: string, note?: string) {
    const when = new Date(isoTimestamp);
    if (Number.isNaN(when.getTime())) throw new Error(`invalid iso timestamp: ${isoTimestamp}`);
    const w = store.addTimer(sessionId, when, { ...opts, note });
    return { ok: true as const, wakeId: w.id, fireAt: w.fireAt! };
  }
  function wakeOnJob(jobId: string, note?: string) {
    const w = store.addCompletion(sessionId, jobId, { ...opts, note });
    return { ok: true as const, wakeId: w.id, jobId };
  }
  function wakeOnEvent(eventKey: string, note?: string) {
    const w = store.addEvent(sessionId, eventKey, { ...opts, note });
    return { ok: true as const, wakeId: w.id, eventKey };
  }
  return { sleepFor, sleepUntil, wakeOnJob, wakeOnEvent };
}
