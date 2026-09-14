import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CapabilityRegistry, defineCapability, type EffectReceipt, type NewLedgerEntry } from "./index";
import { KernelExecutor } from "./executor";

/**
 * B02 executor contract: honest outcomes at the trust boundary. A committed
 * write whose audit fails or whose output violates its schema reports
 * outcome "unknown" (never a plainly retryable failure); retries of one
 * intent key serve the stored receipt; key reuse with a different payload is
 * a conflict. Proves F01 and F02 stay fixed.
 */

function makeExecutor(options: {
  ledger?: (entry: NewLedgerEntry) => Promise<number>;
  receipts?: Map<string, EffectReceipt>;
}) {
  let committed = 0;
  const cap = defineCapability<{ n: number }, { n: number }>({
    id: "probe.write",
    title: "Probe write",
    intent: "Probe capability demonstrating executor outcome and receipt semantics",
    module: "probe",
    risk: "write",
    permission: "probe.write",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    execute: async (_ctx, input) => {
      committed += 1;
      if (input.n === 999) return { n: "schema violation" } as unknown as { n: number };
      return { n: input.n };
    },
  });
  void committed;
  const registry = new CapabilityRegistry();
  registry.register(cap);

  const store = new Map(options.receipts ?? []);
  const executor = new KernelExecutor({
    registry,
    ledger: { lastHash: async () => null, append: options.ledger ?? (async () => 0) },
    receipts: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, receipt) => void store.set(key, receipt),
    },
  });
  return { executor, store, committedCount: () => committed };
}

const ctx = (intentId?: string) => ({
  actor: { type: "human" as const, id: "u1", orgId: "o1", permissions: new Set(["probe.write"]) },
  intentId,
  now: new Date(),
  services: {},
});

describe("executor outcome and receipt semantics", () => {
  it("reports outcome unknown when the audit append fails after a committed write", async () => {
    const { executor, committedCount } = makeExecutor({
      ledger: async (entry) => {
        if (entry.kind === "capability.executed") throw new Error("audit down");
        return 0;
      },
    });
    const result = await executor.execute("probe.write", ctx(), { n: 1 });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("audit failed");
    expect(committedCount()).toBe(1);
  });

  it("reports outcome unknown when a write returns schema-violating output", async () => {
    const { executor, committedCount } = makeExecutor({});
    const result = await executor.execute("probe.write", ctx(), { n: 999 });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("invalid output");
    expect(committedCount()).toBe(1);
  });

  it("records an unknown receipt so a retry reconciles instead of re-executing", async () => {
    const { executor, store, committedCount } = makeExecutor({
      ledger: async (entry) => {
        if (entry.kind === "capability.executed") throw new Error("audit down");
        return 0;
      },
    });
    const first = await executor.execute("probe.write", ctx("intent-1"), { n: 1 });
    expect(first.outcome).toBe("unknown");
    const receipt = store.get("o1:intent-1")!;
    expect(receipt.outcome).toBe("unknown");

    const retry = await executor.execute("probe.write", ctx("intent-1"), { n: 1 });
    expect(retry.replayed).toBe(true);
    expect(retry.outcome).toBe("unknown");
    expect(committedCount()).toBe(1);
  });

  it("serves the prior receipt for a repeated successful intent", async () => {
    const { executor, committedCount } = makeExecutor({});
    const first = await executor.execute("probe.write", ctx("intent-2"), { n: 5 });
    const second = await executor.execute("probe.write", ctx("intent-2"), { n: 5 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.data).toEqual({ n: 5 });
    expect(committedCount()).toBe(1);
  });

  it("rejects a reused intent key carrying a different payload", async () => {
    const { executor, committedCount } = makeExecutor({});
    await executor.execute("probe.write", ctx("intent-3"), { n: 5 });
    const conflict = await executor.execute("probe.write", ctx("intent-3"), { n: 6 });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain("conflict");
    expect(committedCount()).toBe(1);
  });

  it("executes without receipt semantics when no intent id is supplied", async () => {
    const { executor, committedCount } = makeExecutor({});
    await executor.execute("probe.write", ctx(undefined), { n: 5 });
    const again = await executor.execute("probe.write", ctx(undefined), { n: 5 });
    expect(again.replayed).toBeUndefined();
    expect(committedCount()).toBe(2);
  });
});
