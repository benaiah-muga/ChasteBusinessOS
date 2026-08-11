/**
 * ARCH-9/REL-2 — drain logic unit tests (no Postgres/Redis).
 * The adapter-level claim/DLQ behavior is covered by the e2e suite.
 */
import { describe, expect, it, vi } from "vitest";
import { drainOnce, type OutboxDrainSource, type OutboxEventRow } from "./drain.js";

function row(over: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: "e-1",
    type: "crm.customer.created",
    organizationId: "org-1",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    payload: { customerId: "c-1" },
    correlationId: null,
    causationId: null,
    ...over,
  };
}

/** Stateful fake: a row is claimable until it is dead-lettered. */
function failingSource(maxRetries: number) {
  let attempts = 0;
  const state = {
    claimed: 0,
    processed: 0,
    markFailedCalls: 0,
    notified: [] as OutboxEventRow[],
    markFailedOpts: [] as { maxRetries: number; backoffMs: number; errorCode?: string }[],
  };
  const notify = async (r: OutboxEventRow) => {
    state.notified.push(r);
  };
  const source: OutboxDrainSource = {
    async claimUnprocessed(_limit, _leaseMs) {
      if (attempts >= maxRetries) return [];
      state.claimed += 1;
      return [row()];
    },
    async markProcessed() {
      state.processed += 1;
    },
    async markFailed(id, error, markOpts) {
      state.markFailedCalls += 1;
      state.markFailedOpts.push(markOpts);
      attempts += 1;
      return { deadLettered: attempts >= maxRetries, attempts };
    },
  };
  return { source, state, notify };
}

const never = async () => {
  throw new Error("handler boom");
};

describe("drainOnce", () => {
  it("acks successfully-processed events and does not notify", async () => {
    const state = { processed: 0, notified: [] as OutboxEventRow[] };
    const source: OutboxDrainSource = {
      async claimUnprocessed() {
        return [row()];
      },
      async markProcessed() {
        state.processed += 1;
      },
      async markFailed() {
        return { deadLettered: false, attempts: 1 };
      },
    };
    const notify = vi.fn(async (r: OutboxEventRow) => {
      state.notified.push(r);
    });

    const result = await drainOnce(source, { process: async () => {} }, notify, {
      batch: 10,
      maxRetries: 3,
      backoffMs: 1_000,
    });

    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0, deadLettered: 0 });
    expect(state.processed).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("passes the configured batch and lease to the source", async () => {
    const calls: { limit: number; leaseMs: number }[] = [];
    const source: OutboxDrainSource = {
      async claimUnprocessed(limit, leaseMs) {
        calls.push({ limit, leaseMs });
        return [];
      },
      async markProcessed() {},
      async markFailed() {
        return { deadLettered: false, attempts: 1 };
      },
    };

    await drainOnce(source, { process: async () => {} }, async () => {}, {
      batch: 7,
      leaseMs: 123_000,
      maxRetries: 3,
      backoffMs: 1_000,
    });

    expect(calls).toEqual([{ limit: 7, leaseMs: 123_000 }]);
  });

  it("records a failure with backoff and only dead-letters after maxRetries", async () => {
    const { source, state, notify } = failingSource(3);

    const first = await drainOnce(source, { process: never }, notify, {
      batch: 10,
      maxRetries: 3,
      backoffMs: 1_000,
      errorCode: "HANDLER_ERROR",
    });
    expect(first).toEqual({ claimed: 1, processed: 0, failed: 1, deadLettered: 0 });
    expect(state.markFailedOpts[0]).toEqual({ maxRetries: 3, backoffMs: 1_000, errorCode: "HANDLER_ERROR" });

    const second = await drainOnce(source, { process: never }, notify, {
      batch: 10,
      maxRetries: 3,
      backoffMs: 1_000,
    });
    expect(second.failed).toBe(1);
    expect(second.deadLettered).toBe(0);

    const third = await drainOnce(source, { process: never }, notify, {
      batch: 10,
      maxRetries: 3,
      backoffMs: 1_000,
    });
    expect(third.deadLettered).toBe(1);
    expect(state.notified).toHaveLength(1);
    expect(state.notified[0]!.id).toBe("e-1");

    // After dead-lettering the row is no longer claimable.
    const fourth = await drainOnce(source, { process: never }, notify, {
      batch: 10,
      maxRetries: 3,
      backoffMs: 1_000,
    });
    expect(fourth.claimed).toBe(0);
    expect(state.markFailedCalls).toBe(3);
    expect(state.processed).toBe(0);
  });

  it("dead-letter notification failures do not abort the drain", async () => {
    const { source } = failingSource(1);
    const result = await drainOnce(
      source,
      { process: never },
      async () => {
        throw new Error("notify store down");
      },
      { batch: 10, maxRetries: 1, backoffMs: 0 },
    );
    expect(result.deadLettered).toBe(1);
  });

  it("uses default options when omitted", async () => {
    const calls: { limit: number; leaseMs: number }[] = [];
    const source: OutboxDrainSource = {
      async claimUnprocessed(limit, leaseMs) {
        calls.push({ limit, leaseMs });
        return [];
      },
      async markProcessed() {},
      async markFailed() {
        return { deadLettered: false, attempts: 1 };
      },
    };
    await drainOnce(source, { process: async () => {} }, async () => {});
    expect(calls).toEqual([{ limit: 50, leaseMs: 60_000 }]);
  });
});
