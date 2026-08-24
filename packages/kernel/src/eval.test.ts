import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability, type ActionContext } from "./capability";
import { KernelExecutor } from "./executor";
import { InMemoryLedger } from "./ledger";
import { runAgentLoop, type AgentTurn, type LoopMessage, type ModelAdapter, type ToolSpec } from "./loop";
import { CapabilityRegistry } from "./registry";

/**
 * Governance evaluation harness, v1.
 *
 * Golden agent trajectories replayed against a scripted model adapter,
 * asserting the *harness* behavior that must hold regardless of which model
 * sits behind ModelAdapter:
 *   - every proposed tool call funnels through the governed executor
 *   - policy gates surface as structured tool results, never bypasses
 *   - hallucinated capabilities produce an honest error for the model
 *   - missing capability => ticket, never improvisation
 *
 * This is the seed of a CI eval suite: grow the scenario list as prompts,
 * models, or policies change; any regression in harness behavior fails here
 * before it fails in front of a customer's books.
 */

function makeCtx(permissions: string[]): ActionContext {
  return {
    actor: { type: "agent", id: "u1", orgId: "org1", permissions: new Set(permissions) },
    now: new Date("2026-08-21T00:00:00Z"),
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

const postMoney = defineCapability({
  id: "accounting.postJournalEntry",
  title: "Post journal entry",
  intent: "Post an immutable journal entry into the general ledger",
  module: "accounting",
  risk: "money",
  permission: "accounting.post",
  moneyThresholdMinor: 50_000,
  moneyAmount: (input) => input.amountMinor,
  input: z.object({ amountMinor: z.number().int() }),
  output: z.object({ posted: z.boolean() }),
  execute: async () => ({ posted: true }),
});

/** Scripted adapter: returns pre-baked turns in order; records what it saw. */
function scriptedModel(turns: Array<Pick<AgentTurn, "message" | "toolCalls">>): {
  adapter: ModelAdapter;
  seenToolSpecs: () => ToolSpec[];
  seenMessages: () => LoopMessage[];
} {
  const seenToolSpecs: ToolSpec[] = [];
  const seenMessages: LoopMessage[] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    async run(messages, tools) {
      if (messages.length > 0) seenMessages.push(messages[messages.length - 1]!);
      if (seenToolSpecs.length === 0) seenToolSpecs.push(...tools);
      const turn = turns[Math.min(i++, turns.length - 1)] ?? { message: "done", toolCalls: [] };
      return { ...turn, usage: { input: 10, output: 5 } };
    },
  };
  return { adapter, seenToolSpecs: () => seenToolSpecs, seenMessages: () => seenMessages };
}

function buildHarness(tickets?: { filed: { title: string; description: string }[] }) {
  const registry = new CapabilityRegistry();
  registry.register(createCustomer);
  registry.register(postMoney);
  const ledger = new InMemoryLedger();
  const executor = new KernelExecutor({
    registry,
    ledger,
    approvals: tickets
      ? {
          submit: async () => false,
          verify: async () => false,
        }
      : undefined,
  });
  const ticketSink = tickets
    ? {
        file: async (_orgId: string, title: string, description: string) =>
          void tickets.filed.push({ title, description }),
      }
    : undefined;
  return { registry, ledger, executor, ticketSink };
}

describe("governance eval: golden trajectories", () => {
  it("tool calls route through governed execution and audit", async () => {
    const h = buildHarness();
    const { adapter, seenToolSpecs } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "crm_createCustomer", args: { name: "Acme" } }] },
      { message: "Created Acme.", toolCalls: [] },
    ]);
    const result = await runAgentLoop(adapter, h.registry, h.executor, makeCtx(["crm.write"]), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "create a customer named Acme",
      maxSteps: 3,
    });

    expect(result.finalMessage).toBe("Created Acme.");
    // The ledger proves execution went through the funnel, not around it.
    expect(h.ledger.entries.map((e) => e.kind)).toEqual(["capability.executed"]);
    // The model only ever saw sanitized names + risk labels.
    expect(seenToolSpecs().map((t) => t.function.name)).toContain("crm_createCustomer");
    expect(seenToolSpecs()[0]?.function.description.startsWith("[write]")).toBe(true);
  });

  it("hallucinated capability names get an honest error, not a crash", async () => {
    const h = buildHarness();
    const { adapter, seenMessages } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "time_travel_bookFlight", args: {} }] },
      { message: "I cannot time travel.", toolCalls: [] },
    ]);
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(["*"]), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "book a flight to 1970",
      maxSteps: 3,
    });
    const toolResult = seenMessages().find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("unknown capability");
  });

  it("gated money actions come back as pendingApproval for the model to relay", async () => {
    const h = buildHarness();
    const { adapter, seenMessages } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "accounting_postJournalEntry", args: { amountMinor: 900_000 } }] },
      { message: "That payment needs human approval.", toolCalls: [] },
    ]);
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(["accounting.post"]), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "post a big entry",
      maxSteps: 3,
    });
    const toolResult = JSON.parse(seenMessages().find((m) => m.role === "tool")?.content ?? "{}");
    expect(toolResult.pendingApproval).toBe(true);
    // Nothing executed; the gate is audited instead.
    expect(h.ledger.entries.map((e) => e.kind)).toEqual(["approval.requested"]);
  });

  it("missing capability goals end in a filed ticket when a sink is wired", async () => {
    const tickets: { title: string; description: string }[] = [];
    const h = buildHarness({ filed: tickets });
    const { adapter } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "file_ticket", args: { title: "Payroll via crypto", description: "No capability pays salaries in dogecoin." } }] },
      { message: "Filed a ticket; cannot pay in dogecoin.", toolCalls: [] },
    ]);
    const result = await runAgentLoop(
      adapter,
      h.registry,
      h.executor,
      makeCtx(["*"]),
      { sessionId: "s1", systemPrompt: "test", userGoal: "pay everyone in dogecoin", maxSteps: 3 },
      h.ticketSink,
    );

    expect(result.finalMessage).toContain("ticket");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.description).toContain("dogecoin");
  });

  it("the loop respects maxSteps even when the model keeps calling tools", async () => {
    const h = buildHarness();
    const endless = scriptedModel([
      { message: null, toolCalls: [{ id: "t", name: "crm_createCustomer", args: { name: "A" } }] },
    ]);
    const result = await runAgentLoop(endless.adapter, h.registry, h.executor, makeCtx(["*"]), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "loop forever",
      maxSteps: 4,
    });
    expect(result.steps).toBeLessThanOrEqual(4);
    // Every iteration was governed; nothing ran outside audit.
    expect(h.ledger.entries.every((e) => e.kind === "capability.executed")).toBe(true);
  });

  it("emits trajectory events so hosts can stream and replay decisions", async () => {
    const h = buildHarness();
    const roles: string[] = [];
    const { adapter } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "crm_createCustomer", args: { name: "Acme" } }] },
      { message: "done", toolCalls: [] },
    ]);
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(["crm.write"]), {
      sessionId: "s1",
      systemPrompt: "test",
      userGoal: "go",
      maxSteps: 3,
      onEvent: (e) => roles.push(e.role),
    });
    expect(roles).toContain("tool_call");
    expect(roles).toContain("tool_result");
  });

  it("frames retrieved content as data: every loop carries the untrusted-content rule", async () => {
    const h = buildHarness();
    let systemMessage = "";
    const adapter: ModelAdapter = {
      async run(messages) {
        systemMessage = messages.find((m) => m.role === "system")?.content ?? "";
        return { message: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    await runAgentLoop(adapter, h.registry, h.executor, makeCtx(["crm.write"]), {
      sessionId: "s1",
      systemPrompt: "org prompt",
      userGoal: "go",
      maxSteps: 1,
    });
    // Prompt-injection defense: documents, memories, and transcripts are
    // attacker-influenceable, so the harness itself must mark them untrusted.
    expect(systemMessage).toContain("untrusted data");
    expect(systemMessage).toContain("org prompt");
  });

  it("bounds model-controlled ticket text before it reaches storage or email", async () => {
    const tickets: { title: string; description: string }[] = [];
    const h = buildHarness({ filed: tickets });
    const longTitle = "T".repeat(5_000);
    const longBody = "D".repeat(50_000);
    const { adapter } = scriptedModel([
      { message: null, toolCalls: [{ id: "t1", name: "file_ticket", args: { title: longTitle, description: longBody } }] },
      { message: "filed", toolCalls: [] },
    ]);
    await runAgentLoop(
      adapter,
      h.registry,
      h.executor,
      makeCtx(["*"]),
      { sessionId: "s1", systemPrompt: "test", userGoal: "file a huge ticket", maxSteps: 2 },
      h.ticketSink,
    );
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.title.length).toBeLessThanOrEqual(200);
    expect(tickets[0]!.description.length).toBeLessThanOrEqual(4000);
  });
});
