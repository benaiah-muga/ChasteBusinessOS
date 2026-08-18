import {
  createCommandRegistry,
  createQueryRegistry,
  createRequestContext,
  defineCommand,
  defineQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleChatTurn } from "./orchestrator.js";
import { InMemorySkillStore } from "./skills.js";
import type { CompletionRequest, CompletionResult, AiProvider } from "./providers.js";

/**
 * Scripted native-tool-calling provider: returns a fixed queue of completions,
 * records every request (including offered tools + fed-back tool history).
 */
class ScriptedProvider implements AiProvider {
  readonly id = "scripted";
  readonly toolCalling = true;
  calls: CompletionRequest[] = [];
  constructor(private readonly steps: CompletionResult[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    return this.steps.shift() ?? { text: "", provider: "scripted", model: "m" };
  }
}

function makeCtx(permissions: string[], autonomy: "confirm" | "guarded_auto") {
  return createRequestContext({
    actor: {
      kind: "user",
      userId: "u1",
      organizationId: "o1",
      permissions: new Set(permissions),
    },
    autonomy,
    correlationId: "corr-1",
    causationId: "cause-1",
  });
}

const tool = (name: string, args: Record<string, unknown>) => ({ id: name, name, arguments: args });

function baseRegistries() {
  const commands = createCommandRegistry();
  const queries = createQueryRegistry();

  const counters = { customerListCalls: 0, journalPostCalls: 0, customerCreateCalls: 0 };

  queries.register(
    defineQuery({
      name: "crm.customer.list",
      description: "List customers",
      permissions: ["crm.customer.read"],
      input: z.object({ city: z.string().optional() }),
      output: z.array(z.object({ id: z.string(), name: z.string() })),
      handler: async () => {
        counters.customerListCalls += 1;
        return [
          { id: "c1", name: "Kampala Coffee Works" },
          { id: "c2", name: "Jinja Bakery Supplies" },
        ];
      },
    }),
  );

  commands.register(
    defineCommand({
      name: "acc.journal.post",
      description: "Post a journal entry",
      permissions: ["acc.journal.post"],
      tags: ["acc"],
      input: z.object({
        debitAccountId: z.string(),
        creditAccountId: z.string(),
        amount: z.number(),
        note: z.string().optional(),
      }),
      output: z.object({ id: z.string(), amount: z.number() }),
      handler: async (input) => {
        counters.journalPostCalls += 1;
        return { id: "j1", amount: input.amount };
      },
    }),
  );

  commands.register(
    defineCommand({
      name: "crm.customer.create",
      description: "Create a customer",
      permissions: ["crm.customer.create"],
      tags: ["crm"],
      input: z.object({ name: z.string(), city: z.string().optional() }),
      output: z.object({ id: z.string(), name: z.string() }),
      handler: async (input) => {
        counters.customerCreateCalls += 1;
        return { id: "c-new", name: input.name };
      },
    }),
  );

  return {
    commands,
    queries,
    audit: new InMemoryAuditWriter(),
    outbox: new InMemoryOutboxWriter(),
    counters,
  };
}

describe("handleChatTurn — business-tool agent loop (native function calling)", () => {
  it("chains a read tool call into a prose answer (read→observe→answer)", async () => {
    const r = baseRegistries();
    const provider = new ScriptedProvider([
      { text: "", provider: "scripted", model: "m", toolCalls: [tool("crm_customer_list", {})] },
      { text: "2 customers on file: Kampala Coffee Works and Jinja Bakery Supplies.", provider: "scripted", model: "m" },
    ]);
    const ctx = makeCtx(["crm.customer.read"], "confirm");

    const result = await handleChatTurn(
      { commands: r.commands, queries: r.queries, helpers: { audit: r.audit, outbox: r.outbox }, autonomy: "confirm", provider },
      {
        session: { id: "s1", messages: [] },
        userText: "Tell me which of our customers were created this quarter",
        ctx,
      },
    );

    expect(r.counters.customerListCalls).toBe(1);
    expect(provider.calls).toHaveLength(2);
    const text = result.session.messages
      .flatMap((m) => m.parts)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("Kampala Coffee Works");
    expect(result.session.pending).toBeUndefined();
  });

  it("parks a write tool call as a confirm card under autonomy=confirm (never dispatches)", async () => {
    const r = baseRegistries();
    const provider = new ScriptedProvider([
      {
        text: "",
        provider: "scripted",
        model: "m",
        toolCalls: [
          tool("acc_journal_post", { debitAccountId: "a1", creditAccountId: "a2", amount: 800000 }),
        ],
      },
      { text: "I posted the bill.", provider: "scripted", model: "m" },
    ]);
    const ctx = makeCtx(["acc.journal.post"], "confirm");

    const result = await handleChatTurn(
      { commands: r.commands, queries: r.queries, helpers: { audit: r.audit, outbox: r.outbox }, autonomy: "confirm", provider },
      {
        session: { id: "s1", messages: [] },
        userText: "Reconcile supplier balances with the accounts payable ledger",
        ctx,
      },
    );

    // The write was NOT executed by the loop; it surfaced as a confirm card.
    expect(r.counters.journalPostCalls).toBe(0);
    expect(result.session.pending?.command).toBe("acc.journal.post");
    expect(result.session.pending?.input).toMatchObject({ debitAccountId: "a1", amount: 800000 });
  });

  it("parks multiple write tool calls as a multi-step plan confirm card", async () => {
    const r = baseRegistries();
    const provider = new ScriptedProvider([
      {
        text: "",
        provider: "scripted",
        model: "m",
        toolCalls: [
          tool("crm_customer_create", { name: "Acme Ltd", city: "Nairobi" }),
          tool("acc_journal_post", { debitAccountId: "a1", creditAccountId: "a2", amount: 250000 }),
        ],
      },
      { text: "done", provider: "scripted", model: "m" },
    ]);
    const ctx = makeCtx(["crm.customer.create", "acc.journal.post"], "confirm");

    const result = await handleChatTurn(
      { commands: r.commands, queries: r.queries, helpers: { audit: r.audit, outbox: r.outbox }, autonomy: "confirm", provider },
      {
        session: { id: "s1", messages: [] },
        userText: "Sign up Acme Ltd and book the setup fee in the ledger",
        ctx,
      },
    );

    expect(r.counters.customerCreateCalls).toBe(0);
    expect(r.counters.journalPostCalls).toBe(0);
    expect(result.session.pending?.plan).toHaveLength(2);
    expect(result.session.pending?.plan?.[0]).toMatchObject({ command: "crm.customer.create" });
    expect(result.session.pending?.plan?.[1]).toMatchObject({ command: "acc.journal.post" });
  });

  it("auto-executes a write tool call under guarded_auto and does not re-propose it from terminal JSON", async () => {
    const r = baseRegistries();
    const provider = new ScriptedProvider([
      { text: "", provider: "scripted", model: "m", toolCalls: [tool("crm_customer_create", { name: "Acme Ltd" })] },
      { text: '{"command":"crm.customer.create","input":{"name":"Acme Ltd"}}', provider: "scripted", model: "m" },
    ]);
    const ctx = makeCtx(["crm.customer.create"], "guarded_auto");

    const result = await handleChatTurn(
      { commands: r.commands, queries: r.queries, helpers: { audit: r.audit, outbox: r.outbox }, autonomy: "guarded_auto", provider },
      {
        session: { id: "s1", messages: [] },
        userText: "Onboard the vendor Acme as a customer in our records",
        ctx,
      },
    );

    // Executed exactly once by the tool loop; the terminal JSON was dropped.
    expect(r.counters.customerCreateCalls).toBe(1);
    expect(result.session.pending).toBeUndefined();
  });

  it("denies a write tool call when full autonomous mode is disabled", async () => {
    const r = baseRegistries();
    const provider = new ScriptedProvider([
      { text: "", provider: "scripted", model: "m", toolCalls: [tool("crm_customer_create", { name: "Acme Ltd" })] },
      { text: "Blocked.", provider: "scripted", model: "m" },
    ]);
    const ctx = makeCtx(["crm.customer.create"], "full_autonomous");

    const result = await handleChatTurn(
      {
        commands: r.commands,
        queries: r.queries,
        helpers: { audit: r.audit, outbox: r.outbox },
        autonomy: "full_autonomous",
        allowFullAutonomous: false,
        provider,
      },
      {
        session: { id: "s1", messages: [] },
        userText: "Onboard the vendor Acme as a customer in our records",
        ctx,
      },
    );

    expect(r.counters.customerCreateCalls).toBe(0);
    const text = result.session.messages
      .flatMap((m) => m.parts)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("Blocked.");
  });

  it("breaks out of a repeated-tool stall and answers from the data already gathered", async () => {
    const r = baseRegistries();
    const provider = new ScriptedProvider([
      { text: "", provider: "scripted", model: "m", toolCalls: [tool("crm_customer_list", {})] },
      { text: "", provider: "scripted", model: "m", toolCalls: [tool("crm_customer_list", {})] },
    ]);
    const ctx = makeCtx(["crm.customer.read"], "confirm");

    const result = await handleChatTurn(
      { commands: r.commands, queries: r.queries, helpers: { audit: r.audit, outbox: r.outbox }, autonomy: "confirm", provider },
      {
        session: { id: "s1", messages: [] },
        userText: "Tell me about the customers we onboarded in Q1",
        ctx,
      },
    );

    // Duplicate tool call (same name + args) terminates the loop early and
    // renders a prose answer from the read result instead of a null response.
    expect(provider.calls.length).toBeLessThan(6);
    const text = result.session.messages
      .flatMap((m) => m.parts)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("Kampala Coffee Works");
  });

  it("synthesizes an answer when the iteration cap is hit after read tools", async () => {
    const r = baseRegistries();
    // Every completion re-calls a different read tool, so the loop exhausts
    // its budget without ever producing a terminal response.
    const steps: CompletionResult[] = [];
    for (let i = 0; i < 12; i++) {
      steps.push({ text: "", provider: "scripted", model: "m", toolCalls: [tool("crm_customer_list", { city: `c${i}` })] });
    }
    const provider = new ScriptedProvider(steps);
    const ctx = makeCtx(["crm.customer.read"], "confirm");

    const result = await handleChatTurn(
      { commands: r.commands, queries: r.queries, helpers: { audit: r.audit, outbox: r.outbox }, autonomy: "confirm", provider },
      {
        session: { id: "s1", messages: [] },
        userText: "Summarize our customer base",
        ctx,
      },
    );

    const text = result.session.messages
      .flatMap((m) => m.parts)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("Kampala Coffee Works");
    expect(text).toContain("step budget");
  });
});

describe("handleChatTurn — agent tools still work for text-only providers (fallback)", () => {
  it("keeps the JSON toolCall loop for providers without native tool calling", async () => {
    const r = baseRegistries();
    let invokedSkill = false;
    const provider: AiProvider = {
      id: "textonly",
      toolCalling: false,
      async complete() {
        if (!invokedSkill) {
          invokedSkill = true;
          return {
            text: '{"toolCall":{"name":"loadSkill","args":{"name":"stock-reviews"}}}',
            provider: "textonly",
            model: "m",
          };
        }
        return { text: '{"answer":"Loaded stock review guidance."}', provider: "textonly", model: "m" };
      },
    };
    const ctx = makeCtx(["crm.customer.read"], "confirm");
    const skills = new InMemorySkillStore();
    await skills.upsert({
      scope: "platform",
      organizationId: "o1",
      name: "stock-reviews",
      title: "Stock reviews",
      summary: "Review guidance",
      instructions: "Check reorder levels weekly.",
      enabled: true,
      files: [],
    });

    const result = await handleChatTurn(
      {
        commands: r.commands,
        queries: r.queries,
        helpers: { audit: r.audit, outbox: r.outbox },
        autonomy: "confirm",
        provider,
        skills,
      },
      {
        session: { id: "s1", messages: [] },
        userText: "Advise on our weekly stock review cadence",
        ctx,
      },
    );

    expect(invokedSkill).toBe(true);
    const text = result.session.messages
      .flatMap((m) => m.parts)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("Loaded stock review guidance.");
  });
});
