import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_CONTEXT_WINDOW, shouldCompact } from "./compaction";
import { defineCapability, type ActionContext } from "./capability";
import { KernelExecutor } from "./executor";
import { InMemoryLedger } from "./ledger";
import { runAgentLoop, type AskQuestion, type LoopMessage, type ModelAdapter, type ToolCall } from "./loop";
import { CapabilityRegistry } from "./registry";

function makeCtx(): ActionContext {
  return {
    actor: { type: "agent", id: "u1", orgId: "org1", permissions: new Set(["crm.write"]) },
    now: new Date("2026-08-29T00:00:00Z"),
    services: {},
  };
}

const createCustomer = defineCapability({
  id: "crm.createCustomer",
  title: "Create customer",
  intent: "Create a new customer record with a name for future invoicing",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ id: z.string() }),
  execute: async (_ctx, input) => ({ id: `cus_${input.name.toLowerCase()}` }),
});

function buildHarness() {
  const registry = new CapabilityRegistry();
  registry.register(createCustomer);
  const executor = new KernelExecutor({ registry, ledger: new InMemoryLedger() });
  return { registry, executor };
}

/** Scripted adapter: yields pre-baked turns in order and records every call. */
function scriptedModel(turns: Array<{ message: string | null; toolCalls: ToolCall[] }>): {
  adapter: ModelAdapter;
  calls: () => LoopMessage[][];
} {
  const calls: LoopMessage[][] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    async run(messages) {
      calls.push(messages.map((m) => ({ ...m })));
      return { ...(turns[Math.min(i++, turns.length - 1)] ?? { message: "done", toolCalls: [] }), usage: { input: 10, output: 5 } };
    },
  };
  return { adapter, calls: () => calls };
}

describe("loop: step events", () => {
  it("emits a step event per iteration with position and max", async () => {
    const h = buildHarness();
    const { adapter } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "crm_createCustomer", args: { name: "Acme" } }] },
      { message: "Created.", toolCalls: [] },
    ]);
    const events: Array<{ seq: number; role: string; content: unknown }> = [];
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      maxSteps: 5,
      onEvent: (e) => events.push(e),
    });
    const steps = events.filter((e) => e.role === "step");
    expect(steps.map((s) => s.content)).toEqual([
      { step: 1, maxSteps: 5 },
      { step: 2, maxSteps: 5 },
    ]);
  });
});

describe("loop: mid-run steering", () => {
  it("injects queued user messages before the next model call", async () => {
    const h = buildHarness();
    const { adapter, calls } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "crm_createCustomer", args: { name: "Acme" } }] },
      { message: "Done, with your steering.", toolCalls: [] },
    ]);
    let drained = 0;
    const result = await runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      maxSteps: 3,
      getSteering: () => {
        drained += 1;
        return drained === 1 ? [{ text: "focus on invoices" }] : [];
      },
    });
    expect(drained).toBe(2);
    const second = calls()[1]!;
    expect(second.some((m) => m.role === "user" && m.content === "[steering] focus on invoices")).toBe(true);
    expect(result.finalMessage).toContain("steering");
  });

  it("skips blank steering entries", async () => {
    const h = buildHarness();
    const { adapter, calls } = scriptedModel([{ message: "done", toolCalls: [] }]);
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      getSteering: () => [{ text: "   " }],
    });
    expect(calls()[0]!.filter((m) => m.role === "user")).toHaveLength(1);
  });
});

describe("loop: abort signal", () => {
  it("refuses to start when already aborted", async () => {
    const h = buildHarness();
    const { adapter, calls } = scriptedModel([{ message: "done", toolCalls: [] }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
        sessionId: "s1",
        systemPrompt: "test",
        userGoal: "go",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).toHaveLength(0);
  });

  it("stops between steps when aborted mid-run", async () => {
    const h = buildHarness();
    const controller = new AbortController();
    const adapter: ModelAdapter = {
      async run() {
        controller.abort();
        return { message: null, toolCalls: [{ id: "t1", name: "crm_createCustomer", args: { name: "Acme" } }], usage: { input: 1, output: 1 } };
      },
    };
    await expect(
      runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
        sessionId: "s1",
        systemPrompt: "test",
        userGoal: "go",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("forwards the signal into the model adapter call", async () => {
    const h = buildHarness();
    let seen: AbortSignal | undefined;
    const adapter: ModelAdapter = {
      async run(_messages, _tools, opts) {
        seen = opts.signal;
        return { message: "done", toolCalls: [] };
      },
    };
    const controller = new AbortController();
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });
});

describe("loop: ask_user clarification", () => {
  it("delivers the question, emits an ask event, and ends the run", async () => {
    const h = buildHarness();
    const { adapter, calls } = scriptedModel([
      {
        message: null,
        toolCalls: [
          { id: "q1", name: "ask_user", args: { question: "Cash or accrual?", options: ["Cash", "Accrual"], allowOther: true } },
        ],
      },
    ]);
    const delivered: AskQuestion[] = [];
    const events: Array<{ seq: number; role: string; content: unknown }> = [];
    const result = await runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "set up my books",
      ask: { deliver: async (q) => void delivered.push(q) },
      onEvent: (e) => events.push(e),
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ id: "q1", question: "Cash or accrual?", options: ["Cash", "Accrual"] });
    expect(events.some((e) => e.role === "ask")).toBe(true);
    // Turn ended: the model was called exactly once even though maxSteps allows more.
    expect(calls()).toHaveLength(1);
    expect(result.steps).toBe(1);
    expect(events.filter((e) => e.role === "step")).toHaveLength(1);
  });

  it("clamps oversized question text and option counts", async () => {
    const h = buildHarness();
    const { adapter } = scriptedModel([
      {
        message: null,
        toolCalls: [
          { id: "q1", name: "ask_user", args: { question: "x".repeat(5000), options: Array.from({ length: 9 }, (_, i) => `opt ${i}: ${"y".repeat(150)}`) } },
        ],
      },
    ]);
    const delivered: AskQuestion[] = [];
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      ask: { deliver: async (q) => void delivered.push(q) },
    });
    expect(delivered[0]!.question.length).toBeLessThanOrEqual(2000);
    expect(delivered[0]!.options).toHaveLength(5);
    for (const o of delivered[0]!.options ?? []) expect(o.length).toBeLessThanOrEqual(100);
  });

  it("offers ask_user only when an ask channel is present", async () => {
    const h = buildHarness();
    const { adapter } = scriptedModel([{ message: "done", toolCalls: [] }]);
    const events: Array<{ seq: number; role: string; content: unknown }> = [];
    const toolsSeen: string[] = [];
    const wrapping: ModelAdapter = {
      async run(messages, tools, opts) {
        toolsSeen.push(...tools.map((t) => t.function.name));
        return adapter.run(messages, tools, opts);
      },
    };
    await runAgentLoop(wrapping, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      onEvent: (e) => events.push(e),
    });
    expect(toolsSeen).not.toContain("ask_user");
    expect(toolsSeen).toContain("crm_createCustomer");
  });
});

describe("loop: window-aware compaction", () => {
  it("compacts against the model context window, not a fixed budget", async () => {
    expect(shouldCompact([{ role: "user", content: "x".repeat(500_000) }], { contextWindow: DEFAULT_CONTEXT_WINDOW })).toBe(true);
    expect(shouldCompact([{ role: "user", content: "x".repeat(400_000) }], { contextWindow: 32_000 })).toBe(true);
    expect(shouldCompact([{ role: "user", content: "x".repeat(40_000) }], { contextWindow: 200_000 })).toBe(false);

    const h = buildHarness();
    const big = "z".repeat(60_000);
    let calls = 0;
    const adapter: ModelAdapter = {
      async run() {
        calls += 1;
        if (calls === 1) {
          return { message: big, toolCalls: [{ id: "t1", name: "crm_createCustomer", args: { name: "Acme" } }] };
        }
        return { message: "done", toolCalls: [] };
      },
    };
    const events: Array<{ seq: number; role: string; content: unknown }> = [];
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      contextWindow: 8192,
      reserveTokens: 1024,
      onEvent: (e) => events.push(e),
    });
    // With an 8k window the 60k reply guarantees a compaction on step 2.
    expect(calls).toBe(2);
    expect(events.some((e) => e.role === "compaction")).toBe(true);
  });
});
