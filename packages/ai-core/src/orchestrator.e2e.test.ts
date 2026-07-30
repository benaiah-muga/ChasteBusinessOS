/**
 * AI orchestration E2E tests.
 *
 * Tests the full AI chat turn pipeline:
 * - Deterministic rule parsing (planFromText)
 * - 3-tier fallback: rule → LLM → help text
 * - Confirmation / cancel flows
 * - Autonomy gating (recommend → confirm → guarded_auto → full_autonomous)
 * - Permission enforcement (AI cannot bypass RBAC)
 * - Proactive follow-up suggestions
 * - LLM clarify / plan / command responses
 * - Memory store write/search
 * - Explanation audit trail
 */
import {
  createCommandRegistry,
  createQueryRegistry,
  createRequestContext,
  defineCommand,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
  type CommandRegistry,
  type QueryRegistry,
  type AutonomyLevel,
} from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  handleChatTurn,
  planFromText,
  planManyFromText,
  resolvePlanStepInput,
  wireSequentialPlanInputs,
  type ChatSessionState,
  type OrchestratorDeps,
} from "./orchestrator.js";
import { generateSuggestions } from "./suggestions.js";
import { InMemoryMemoryStore } from "./memory.js";
import type { AiProvider, CompletionResult } from "./providers.js";
import { NoneProvider } from "./providers.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function emptyQueries(): QueryRegistry {
  const reg = createQueryRegistry();
  return reg;
}

function makeCtx(overrides?: { permissions?: Set<string>; autonomy?: AutonomyLevel }) {
  return createRequestContext({
    actor: {
      kind: "user" as const,
      userId: "u1",
      organizationId: "o1",
      permissions: overrides?.permissions ?? new Set([
        "crm.customer.create",
        "crm.customer.read",
        "hr.payroll.run",
        "hr.employee.create",
        "hr.employee.read",
        "acc.invoice.create",
        "acc.invoice.read",
        "acc.journal.post",
        "acc.account.read",
        "pur.vendor.create",
        "pur.po.read",
        "inv.product.create",
        "inv.stock.move",
        "inv.stock.read",
        "inv.warehouse.manage",
        "mfg.bom.manage",
        "mfg.wo.manage",
        "mfg.wo.read",
        "core.modules.read",
        "core.rbac.read",
      ]),
    },
    autonomy: overrides?.autonomy ?? "confirm",
  });
}

function registerTestCommands(commands: CommandRegistry) {
  commands.register(
    defineCommand({
      name: "crm.customer.create",
      permissions: ["crm.customer.create"],
      tags: ["crm"],
      input: z.object({
        name: z.string().min(1),
        city: z.string().optional(),
      }),
      output: z.object({ id: z.string(), name: z.string(), city: z.string().optional() }),
      handler: async (input) => ({ id: "cust-1", name: input.name, city: input.city }),
    }),
  );
  commands.register(
    defineCommand({
      name: "hr.payroll.prepare",
      permissions: ["hr.payroll.run"],
      tags: ["hr"],
      input: z.object({ periodLabel: z.string().min(1) }),
      output: z.object({ id: z.string(), periodLabel: z.string(), status: z.string() }),
      handler: async (input) => ({ id: "pr-1", periodLabel: input.periodLabel, status: "prepared" }),
    }),
  );
  commands.register(
    defineCommand({
      name: "acc.invoice.create",
      permissions: ["acc.invoice.create"],
      tags: ["accounting"],
      input: z.object({
        number: z.string().min(1),
        total: z.number().default(0),
        currency: z.string().default("USD"),
        customerId: z.string().optional(),
      }),
      output: z.object({
        id: z.string(),
        number: z.string(),
        total: z.number(),
        customerId: z.string().optional(),
      }),
      handler: async (input) => ({
        id: "inv-1",
        number: input.number,
        total: input.total,
        customerId: input.customerId,
      }),
    }),
  );
  commands.register(
    defineCommand({
      name: "pur.vendor.create",
      permissions: ["pur.vendor.create"],
      tags: ["purchasing"],
      input: z.object({ name: z.string().min(1) }),
      output: z.object({ id: z.string(), name: z.string() }),
      handler: async (input) => ({ id: "vend-1", name: input.name }),
    }),
  );
  commands.register(
    defineCommand({
      name: "inv.product.create",
      permissions: ["inv.product.create"],
      tags: ["inventory"],
      input: z.object({
        sku: z.string().min(1),
        name: z.string().min(1),
      }),
      output: z.object({ id: z.string(), sku: z.string(), name: z.string() }),
      handler: async (input) => ({ id: "prod-1", sku: input.sku, name: input.name }),
    }),
  );
  commands.register(
    defineCommand({
      name: "hr.employee.create",
      permissions: ["hr.employee.create"],
      tags: ["hr"],
      input: z.object({
        employeeNumber: z.string().min(1),
        fullName: z.string().min(1),
      }),
      output: z.object({ id: z.string(), employeeNumber: z.string(), fullName: z.string() }),
      handler: async (input) => ({ id: "emp-1", employeeNumber: input.employeeNumber, fullName: input.fullName }),
    }),
  );
}

function makeDeps(overrides?: {
  autonomy?: AutonomyLevel;
  provider?: AiProvider;
  allowFullAutonomous?: boolean;
  commands?: CommandRegistry;
}) {
  const commands = overrides?.commands ?? createCommandRegistry();
  if (!overrides?.commands) registerTestCommands(commands);
  return {
    commands,
    queries: emptyQueries(),
    helpers: { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() },
    autonomy: overrides?.autonomy ?? "confirm",
    provider: overrides?.provider,
    allowFullAutonomous: overrides?.allowFullAutonomous,
  } satisfies OrchestratorDeps;
}

function freshSession(): ChatSessionState {
  return { id: "s1", messages: [] };
}

// ---------------------------------------------------------------------------
// Mock AI provider
// ---------------------------------------------------------------------------

class MockProvider implements AiProvider {
  readonly id = "mock";
  private readonly responses: string[];
  private callIndex = 0;

  constructor(...responses: string[]) {
    this.responses = responses;
  }

  async complete(): Promise<CompletionResult> {
    const text = this.responses[this.callIndex] ?? "";
    this.callIndex++;
    return { text, provider: "mock", model: "mock-v1" };
  }
}

// ===================================================================
// planFromText
// ===================================================================

describe("planFromText", () => {
  it("parses customer creation intent", () => {
    const plan = planFromText("Create customer Acme Ltd in Nairobi");
    expect(plan).toMatchObject({
      command: "crm.customer.create",
      input: { name: "Acme Ltd", city: "Nairobi" },
    });
  });

  it("parses customer creation without city", () => {
    const plan = planFromText("Create customer Widget Co");
    expect(plan).toMatchObject({
      command: "crm.customer.create",
      input: { name: "Widget Co", city: undefined },
    });
  });

  it("parses payroll intent", () => {
    const plan = planFromText("Prepare payroll for March 2026");
    expect(plan).toMatchObject({
      command: "hr.payroll.prepare",
      input: { periodLabel: "March 2026" },
    });
  });

  it("parses invoice intent with amount", () => {
    const plan = planFromText("Create invoice INV-1001 for 250.00 USD");
    expect(plan).toMatchObject({
      command: "acc.invoice.create",
      input: { number: "INV-1001", total: 250, currency: "USD" },
    });
  });

  it("parses invoice intent without amount", () => {
    const plan = planFromText("Create invoice INV-1002");
    expect(plan).toMatchObject({
      command: "acc.invoice.create",
      input: { number: "INV-1002", total: 0, currency: "USD" },
    });
  });

  it("parses vendor creation intent", () => {
    const plan = planFromText("Create vendor Contoso Supplies");
    expect(plan).toMatchObject({
      command: "pur.vendor.create",
      input: { name: "Contoso Supplies" },
    });
  });

  it("parses product creation intent", () => {
    const plan = planFromText("Create product SKU-1 Widget Gadget");
    expect(plan).toMatchObject({
      command: "inv.product.create",
      input: { sku: "SKU-1", name: "Widget Gadget" },
    });
  });

  it("parses employee creation intent", () => {
    const plan = planFromText("Create employee E-100 Jane Doe");
    expect(plan).toMatchObject({
      command: "hr.employee.create",
      input: { employeeNumber: "E-100", fullName: "Jane Doe" },
    });
  });

  it("returns null for unrecognized text", () => {
    expect(planFromText("Hello, how are you?")).toBeNull();
  });

  it("is case-insensitive", () => {
    const plan = planFromText("CREATE CUSTOMER Test Corp IN Lagos");
    expect(plan).toMatchObject({
      command: "crm.customer.create",
      input: { name: "Test Corp", city: "Lagos" },
    });
  });
});

describe("planManyFromText", () => {
  it("parses compound create customer and invoice", () => {
    const plans = planManyFromText(
      "Create customer Acme Ltd in Nairobi and create invoice INV-200 for 100.00 USD",
    );
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      command: "crm.customer.create",
      input: { name: "Acme Ltd", city: "Nairobi" },
    });
    expect(plans[1]).toMatchObject({
      command: "acc.invoice.create",
      input: { number: "INV-200", total: 100, currency: "USD" },
    });
    // Cross-step wiring for customerId
    expect(plans[1]!.input.customerId).toBe("${step1.id}");
  });

  it("returns single plan for simple requests", () => {
    expect(planManyFromText("Create customer Solo Co")).toHaveLength(1);
  });
});

describe("resolvePlanStepInput", () => {
  it("resolves step templates and auto-wires customerId", () => {
    const resolved = resolvePlanStepInput(
      "acc.invoice.create",
      { number: "INV-1", total: 50, customerId: "${step1.id}" },
      [{ command: "crm.customer.create", data: { id: "cust-99", name: "Acme" } }],
      1,
    );
    expect(resolved).toMatchObject({ number: "INV-1", total: 50, customerId: "cust-99" });
  });

  it("auto-wires customerId when template missing", () => {
    const resolved = resolvePlanStepInput(
      "acc.invoice.create",
      { number: "INV-2", total: 10 },
      [{ command: "crm.customer.create", data: { id: "cust-auto" } }],
      1,
    );
    expect(resolved.customerId).toBe("cust-auto");
  });
});

describe("wireSequentialPlanInputs", () => {
  it("injects customerId template after customer create", () => {
    const wired = wireSequentialPlanInputs([
      { command: "crm.customer.create", input: { name: "A" }, summary: "c" },
      { command: "acc.invoice.create", input: { number: "I", total: 1 }, summary: "i" },
    ]);
    expect(wired[1]!.input.customerId).toBe("${step1.id}");
  });
});

// ===================================================================
// handleChatTurn — empty / no-input
// ===================================================================

describe("handleChatTurn — empty input", () => {
  it("returns help prompt for empty message", async () => {
    const deps = makeDeps();
    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "",
      ctx: makeCtx(),
    });

    expect(result.session.pending).toBeUndefined();
    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("Send a message or confirm");
  });

  it("returns help prompt for unrecognized text with no LLM", async () => {
    const deps = makeDeps();
    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "do something random",
      ctx: makeCtx(),
    });

    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("I can prepare validated business actions");
  });
});

// ===================================================================
// handleChatTurn — rule-based confirm flow
// ===================================================================

describe("handleChatTurn — confirm flow (autonomy=confirm)", () => {
  it("creates customer through plan → confirm → execute", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    // Step 1: user sends message → should create pending action
    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd in Nairobi",
      ctx,
    });

    expect(plan.session.pending).toBeDefined();
    expect(plan.session.pending!.command).toBe("crm.customer.create");
    expect(plan.session.pending!.input).toMatchObject({ name: "Acme Ltd", city: "Nairobi" });

    // Step 2: user confirms → should execute
    const confirmed = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: plan.session.pending!.id,
      ctx,
    });

    expect(confirmed.session.pending).toBeUndefined();
    expect(confirmed.explanation).toBeDefined();
    expect(confirmed.explanation!.plannedCommand).toBe("crm.customer.create");

    // Verify audit trail
    expect(deps.helpers.audit.entries.some((e) => e.success && e.action === "crm.customer.create")).toBe(true);
  });

  it("creates vendor through plan → confirm → execute", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create vendor Contoso Supplies",
      ctx,
    });

    expect(plan.session.pending!.command).toBe("pur.vendor.create");

    const confirmed = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: plan.session.pending!.id,
      ctx,
    });

    expect(confirmed.session.pending).toBeUndefined();
    expect(deps.helpers.audit.entries.some((e) => e.success && e.action === "pur.vendor.create")).toBe(true);
  });

  it("creates employee through plan → confirm → execute", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create employee E-100 Jane Doe",
      ctx,
    });

    expect(plan.session.pending!.command).toBe("hr.employee.create");

    const confirmed = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: plan.session.pending!.id,
      ctx,
    });

    expect(confirmed.session.pending).toBeUndefined();
    expect(deps.helpers.audit.entries.some((e) => e.success && e.action === "hr.employee.create")).toBe(true);
  });

  it("posts explanation parts in confirmed response", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    const confirmed = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: plan.session.pending!.id,
      ctx,
    });

    // The confirmation message (with explanation + table) is followed by suggestions message
    const confirmMsg = confirmed.session.messages.find(
      (m) => m.parts.some((p) => p.type === "explanation"),
    );
    expect(confirmMsg).toBeDefined();
  });

  it("includes table part with result data", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    const confirmed = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: plan.session.pending!.id,
      ctx,
    });

    const confirmMsg = confirmed.session.messages.find(
      (m) => m.parts.some((p) => p.type === "table"),
    );
    const tablePart = confirmMsg?.parts.find((p) => p.type === "table") as { type: "table"; rows: unknown[] } | undefined;
    expect(tablePart).toBeDefined();
    expect(tablePart!.rows.length).toBeGreaterThan(0);
  });
});

// ===================================================================
// handleChatTurn — cancel flow
// ===================================================================

describe("handleChatTurn — cancel flow", () => {
  it("cancels a pending action", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(plan.session.pending).toBeDefined();

    const cancelled = await handleChatTurn(deps, {
      session: plan.session,
      cancelId: plan.session.pending!.id,
      ctx,
    });

    expect(cancelled.session.pending).toBeUndefined();
    const lastMsg = cancelled.session.messages[cancelled.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("Cancelled");
  });

  it("does not execute on confirm after cancel", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    const pendingId = plan.session.pending!.id;

    // Cancel — returns a new session with pending cleared
    const cancelled = await handleChatTurn(deps, {
      session: plan.session,
      cancelId: pendingId,
      ctx,
    });

    // Try to confirm with same ID on the CANCELLED session — should not match
    const confirmed = await handleChatTurn(deps, {
      session: cancelled.session,
      confirmId: pendingId,
      ctx,
    });

    // No command should have been executed
    expect(confirmed.session.pending).toBeUndefined();
    // The only message should be "Send a message or confirm"
    const lastMsg = confirmed.session.messages[confirmed.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("Send a message");
  });
});

// ===================================================================
// handleChatTurn — autonomy levels
// ===================================================================

describe("handleChatTurn — autonomy levels", () => {
  it("recommend autonomy creates pending (no execution)", async () => {
    const deps = makeDeps({ autonomy: "recommend" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(plan.session.pending).toBeDefined();
    const lastMsg = plan.session.messages[plan.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("Recommendation only");
  });

  it("confirm autonomy creates pending with confirm action", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(plan.session.pending).toBeDefined();
    const lastMsg = plan.session.messages[plan.session.messages.length - 1]!;
    const confirmPart = lastMsg.parts.find((p) => p.type === "confirm_action");
    expect(confirmPart).toBeDefined();
  });

  it("guarded_auto autonomy auto-executes", async () => {
    const deps = makeDeps({ autonomy: "guarded_auto" });
    const ctx = makeCtx();

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(result.session.pending).toBeUndefined();
    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("Executed automatically");
    expect(deps.helpers.audit.entries.some((e) => e.success && e.action === "crm.customer.create")).toBe(true);
  });

  it("full_autonomous auto-executes with warning", async () => {
    const deps = makeDeps({ autonomy: "full_autonomous", allowFullAutonomous: true });
    const ctx = makeCtx();

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(result.session.pending).toBeUndefined();
    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const textParts = lastMsg.parts.filter((p) => p.type === "text") as { type: "text"; text: string }[];
    const autoText = textParts.find((p) => p.text.includes("Executed automatically"));
    expect(autoText).toBeDefined();
  });

  it("full_autonomous blocked when allowFullAutonomous=false", async () => {
    const deps = makeDeps({ autonomy: "full_autonomous", allowFullAutonomous: false });
    const ctx = makeCtx();

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(result.session.pending).toBeUndefined();
    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const errorPart = lastMsg.parts.find((p) => p.type === "error") as { type: "error"; code: string } | undefined;
    expect(errorPart?.code).toBe("AUTONOMY_DISABLED");
  });
});

// ===================================================================
// handleChatTurn — permission enforcement
// ===================================================================

describe("handleChatTurn — permission enforcement", () => {
  it("blocks AI-executed command when actor lacks permission", async () => {
    const deps = makeDeps({ autonomy: "guarded_auto" });
    const ctx = makeCtx({ permissions: new Set(["crm.customer.read"]) });

    await expect(
      handleChatTurn(deps, {
        session: freshSession(),
        userText: "Create customer Acme Ltd",
        ctx,
      }),
    ).rejects.toThrow();
  });

  it("allows AI-executed command when actor has permission", async () => {
    const deps = makeDeps({ autonomy: "guarded_auto" });
    const ctx = makeCtx({ permissions: new Set(["crm.customer.create"]) });

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(result.session.pending).toBeUndefined();
    expect(deps.helpers.audit.entries.some((e) => e.success && e.action === "crm.customer.create")).toBe(true);
  });
});

// ===================================================================
// handleChatTurn — module missing
// ===================================================================

describe("handleChatTurn — module missing", () => {
  it("returns MODULE_MISSING for planFromText match with unregistered command", async () => {
    const commands = createCommandRegistry();
    // Only register crm, not hr
    commands.register(
      defineCommand({
        name: "crm.customer.create",
        permissions: ["crm.customer.create"],
        tags: ["crm"],
        input: z.object({ name: z.string() }),
        output: z.object({ id: z.string(), name: z.string() }),
        handler: async (input) => ({ id: "c1", name: input.name }),
      }),
    );

    const deps = makeDeps({ commands });

    // "Prepare payroll for March 2026" matches planFromText → hr.payroll.prepare
    // but hr.payroll.prepare is NOT in the registry
    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Prepare payroll for March 2026",
      ctx: makeCtx(),
    });

    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const errorPart = lastMsg.parts.find((p) => p.type === "error") as { type: "error"; code: string } | undefined;
    expect(errorPart?.code).toBe("MODULE_MISSING");
  });
});

// ===================================================================
// handleChatTurn — LLM integration
// ===================================================================

describe("handleChatTurn — LLM integration", () => {
  it("LLM clarify response emits clarification questions", async () => {
    const deps = makeDeps();
    const provider = new MockProvider(
      JSON.stringify({ clarify: ["What is the customer's email?", "Which city are they based in?"] }),
    );

    const result = await handleChatTurn(
      { ...deps, provider },
      {
        session: freshSession(),
        userText: "Add a new customer",
        ctx: makeCtx(),
      },
    );

    expect(result.session.pending).toBeUndefined();
    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const clarifyPart = lastMsg.parts.find((p) => p.type === "clarify") as { type: "clarify"; questions: string[] } | undefined;
    expect(clarifyPart).toBeDefined();
    expect(clarifyPart!.questions).toHaveLength(2);
    expect(clarifyPart!.questions).toContain("What is the customer's email?");
  });

  it("LLM command response creates pending action", async () => {
    const deps = makeDeps();
    const provider = new MockProvider(
      JSON.stringify({ command: "crm.customer.create", input: { name: "LLM Corp" } }),
    );

    const result = await handleChatTurn(
      { ...deps, provider },
      {
        session: freshSession(),
        userText: "Add LLM Corp as a customer",
        ctx: makeCtx(),
      },
    );

    expect(result.session.pending).toBeDefined();
    expect(result.session.pending!.command).toBe("crm.customer.create");
    expect(result.session.pending!.input).toMatchObject({ name: "LLM Corp" });
  });

  it("rule-based multi-step request creates pending multi plan", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer MultiCo in Kisumu and create invoice INV-M1 for 200.00 USD",
      ctx: makeCtx(),
    });
    expect(result.session.pending?.plan).toHaveLength(2);
    expect(result.session.pending!.plan![0]!.command).toBe("crm.customer.create");
    expect(result.session.pending!.plan![1]!.command).toBe("acc.invoice.create");
  });

  it("LLM plan response emits multi-step plan with confirm-all", async () => {
    const deps = makeDeps();
    const provider = new MockProvider(
      JSON.stringify({
        plan: [
          { command: "crm.customer.create", input: { name: "PlanCo" }, description: "Create customer" },
          { command: "acc.invoice.create", input: { number: "INV-PLAN-1", total: 500 }, description: "Create invoice" },
        ],
      }),
    );

    const result = await handleChatTurn(
      { ...deps, provider },
      {
        session: freshSession(),
        userText: "Set up PlanCo with an invoice",
        ctx: makeCtx(),
      },
    );

    // Under autonomy=confirm, multi-step plans wait for a single confirm-all
    expect(result.session.pending).toBeDefined();
    expect(result.session.pending!.plan).toHaveLength(2);
    expect(result.session.pending!.plan![1]!.input).toMatchObject({
      customerId: "${step1.id}",
    });
    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const planPart = lastMsg.parts.find((p) => p.type === "plan") as { type: "plan"; steps: unknown[] } | undefined;
    expect(planPart).toBeDefined();
    expect(planPart!.steps).toHaveLength(2);
    const confirmPart = lastMsg.parts.find((p) => p.type === "confirm_action") as
      | { type: "confirm_action"; confirmLabel: string }
      | undefined;
    expect(confirmPart?.confirmLabel).toBe("Confirm all");
  });

  it("confirm-all executes multi-step plan with cross-step wiring", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const planned = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer WireCo and create invoice INV-WIRE for 75.00 USD",
      ctx: makeCtx(),
    });

    expect(planned.session.pending?.plan).toHaveLength(2);
    const confirmed = await handleChatTurn(deps, {
      session: planned.session,
      confirmId: planned.session.pending!.id,
      ctx: makeCtx(),
    });

    expect(confirmed.session.pending).toBeUndefined();
    const done = confirmed.session.messages[confirmed.session.messages.length - 1]!;
    // last message may be suggestions; find the Done message
    const doneMsg = [...confirmed.session.messages].reverse().find((m) =>
      m.parts.some((p) => p.type === "text" && "text" in p && String(p.text).includes("Executed 2 steps")),
    );
    expect(doneMsg).toBeDefined();
    const table = doneMsg!.parts.find((p) => p.type === "table") as
      | { type: "table"; rows: { command: string; result: string }[] }
      | undefined;
    expect(table?.rows).toHaveLength(2);
    expect(table!.rows[1]!.result).toContain("cust-1");
    void done;
  });

  it("LLM error falls through to help text", async () => {
    const deps = makeDeps();
    const provider = new MockProvider("not valid json at all {{{");

    const result = await handleChatTurn(
      { ...deps, provider },
      {
        session: freshSession(),
        userText: "Something weird",
        ctx: makeCtx(),
      },
    );

    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("I can prepare validated business actions");
  });

  it("skips LLM when provider.id is 'none'", async () => {
    const deps = makeDeps({ provider: new NoneProvider() });

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Something that rules don't match",
      ctx: makeCtx(),
    });

    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("I can prepare validated business actions");
  });

  it("skips LLM when no provider is set", async () => {
    const deps = makeDeps({ provider: undefined });

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Something that rules don't match",
      ctx: makeCtx(),
    });

    const lastMsg = result.session.messages[result.session.messages.length - 1]!;
    const textPart = lastMsg.parts.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toContain("I can prepare validated business actions");
  });

  it("rules take priority over LLM (rule match wins)", async () => {
    const deps = makeDeps();
    const provider = new MockProvider(
      JSON.stringify({ command: "pur.vendor.create", input: { name: "LLM Vendor" } }),
    );

    const result = await handleChatTurn(
      { ...deps, provider },
      {
        session: freshSession(),
        userText: "Create customer Acme Ltd in Nairobi",
        ctx: makeCtx(),
      },
    );

    // Rule parser matches crm.customer.create, not pur.vendor.create from LLM
    expect(result.session.pending!.command).toBe("crm.customer.create");
  });
});

// ===================================================================
// handleChatTurn — conversation history
// ===================================================================

describe("handleChatTurn — conversation history", () => {
  it("preserves previous messages in session", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    // First turn
    const first = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(first.session.messages.length).toBeGreaterThanOrEqual(2); // user + assistant

    // Second turn carries history
    const second = await handleChatTurn(deps, {
      session: first.session,
      userText: "Create vendor Contoso",
      ctx,
    });

    // Should have messages from both turns
    expect(second.session.messages.length).toBeGreaterThanOrEqual(4);
  });

  it("confirm clears pending and preserves history", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    const confirmed = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: plan.session.pending!.id,
      ctx,
    });

    expect(confirmed.session.pending).toBeUndefined();
    expect(confirmed.session.messages.length).toBeGreaterThanOrEqual(3);
  });
});

// ===================================================================
// generateSuggestions
// ===================================================================

describe("generateSuggestions", () => {
  it("returns rule-based suggestions for known commands", async () => {
    const result = await generateSuggestions("crm.customer.create", { id: "c1", name: "Acme" });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions).toContain("Create an invoice for this customer");
  });

  it("returns rule-based suggestions for hr.employee.create", async () => {
    const result = await generateSuggestions("hr.employee.create", { id: "e1" });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions).toContain("Set up a payroll entry for this employee");
  });

  it("returns rule-based suggestions for acc.invoice.create", async () => {
    const result = await generateSuggestions("acc.invoice.create", { id: "i1" });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions).toContain("Send this invoice via email");
  });

  it("returns empty for unknown commands without LLM", async () => {
    const result = await generateSuggestions("unknown.command", {});
    expect(result.suggestions).toHaveLength(0);
  });

  it("falls back to LLM for unknown commands", async () => {
    const provider = new MockProvider('["Check stock levels", "Reorder inventory"]');
    const result = await generateSuggestions("custom.command", {}, provider);
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions).toContain("Check stock levels");
  });

  it("returns empty when LLM returns invalid JSON", async () => {
    const provider = new MockProvider("not json at all");
    const result = await generateSuggestions("custom.command", {}, provider);
    expect(result.suggestions).toHaveLength(0);
  });

  it("returns empty when LLM errors", async () => {
    const brokenProvider: AiProvider = {
      id: "broken",
      complete: async () => { throw new Error("LLM is down"); },
    };
    const result = await generateSuggestions("custom.command", {}, brokenProvider);
    expect(result.suggestions).toHaveLength(0);
  });

  it("ignores LLM when provider.id is 'none'", async () => {
    const provider = new NoneProvider();
    const result = await generateSuggestions("custom.command", {}, provider);
    expect(result.suggestions).toHaveLength(0);
  });
});

// ===================================================================
// InMemoryMemoryStore
// ===================================================================

describe("InMemoryMemoryStore", () => {
  it("writes and retrieves a memory record", async () => {
    const store = new InMemoryMemoryStore();
    const record = await store.write({
      organizationId: "o1",
      kind: "short_term_chat",
      content: "User prefers dark mode",
    });

    expect(record.id).toBeTruthy();
    expect(record.organizationId).toBe("o1");
    expect(record.kind).toBe("short_term_chat");
    expect(record.content).toBe("User prefers dark mode");
    expect(record.createdAt).toBeTruthy();
  });

  it("searches memories by content", async () => {
    const store = new InMemoryMemoryStore();
    await store.write({ organizationId: "o1", kind: "short_term_chat", content: "User prefers dark mode" });
    await store.write({ organizationId: "o1", kind: "long_term_org", content: "Company HQ is in Nairobi" });
    await store.write({ organizationId: "o2", kind: "short_term_chat", content: "User prefers light mode" });

    const results = await store.search("o1", "dark");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("User prefers dark mode");
  });

  it("searches are scoped to organization", async () => {
    const store = new InMemoryMemoryStore();
    await store.write({ organizationId: "o1", kind: "short_term_chat", content: "Secret plan A" });
    await store.write({ organizationId: "o2", kind: "short_term_chat", content: "Secret plan B" });

    const o1Results = await store.search("o1", "Secret");
    expect(o1Results).toHaveLength(1);
    expect(o1Results[0]!.organizationId).toBe("o1");

    const o2Results = await store.search("o2", "Secret");
    expect(o2Results).toHaveLength(1);
    expect(o2Results[0]!.organizationId).toBe("o2");
  });

  it("respects limit parameter", async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 20; i++) {
      await store.write({ organizationId: "o1", kind: "short_term_chat", content: `Item ${i}` });
    }

    const results = await store.search("o1", "Item", 5);
    expect(results).toHaveLength(5);
  });

  it("supports custom id", async () => {
    const store = new InMemoryMemoryStore();
    const record = await store.write({
      id: "custom-id",
      organizationId: "o1",
      kind: "permanent_business_pointer",
      content: "Main warehouse code is WH-001",
    });

    expect(record.id).toBe("custom-id");
  });

  it("stores metadata", async () => {
    const store = new InMemoryMemoryStore();
    const record = await store.write({
      organizationId: "o1",
      kind: "workflow_session",
      content: "Processing step 2 of 3",
      metadata: { workflowId: "wf-1", step: 2 },
    });

    expect(record.metadata).toMatchObject({ workflowId: "wf-1", step: 2 });
  });

  it("returns empty for non-matching org", async () => {
    const store = new InMemoryMemoryStore();
    await store.write({ organizationId: "o1", kind: "short_term_chat", content: "Important fact" });

    const results = await store.search("o999", "Important");
    expect(results).toHaveLength(0);
  });

  it("search is case-insensitive", async () => {
    const store = new InMemoryMemoryStore();
    await store.write({ organizationId: "o1", kind: "short_term_chat", content: "User prefers Dark Mode" });

    const results = await store.search("o1", "dark mode");
    expect(results).toHaveLength(1);
  });
});

// ===================================================================
// NoneProvider
// ===================================================================

describe("NoneProvider", () => {
  it("returns empty text with model 'rules'", async () => {
    const provider = new NoneProvider();
    const result = await provider.complete({ system: "test" });
    expect(result.text).toBe("");
    expect(result.model).toBe("rules");
    expect(result.provider).toBe("none");
  });
});

// ===================================================================
// handleChatTurn — multi-turn with pending
// ===================================================================

describe("handleChatTurn — multi-turn edge cases", () => {
  it("new message replaces old pending action", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    // First: create pending for customer
    const first = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    const firstPendingId = first.session.pending!.id;

    // Second: new message before confirming — should replace pending
    const second = await handleChatTurn(deps, {
      session: first.session,
      userText: "Create vendor Contoso",
      ctx,
    });

    // New pending should exist, old one should be gone
    expect(second.session.pending).toBeDefined();
    expect(second.session.pending!.command).toBe("pur.vendor.create");
  });

  it("confirm with wrong ID does not execute", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    // Confirm with wrong ID
    const result = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: "wrong-id",
      ctx,
    });

    // Pending should still exist (not cleared)
    expect(result.session.pending).toBeDefined();
    expect(deps.helpers.audit.entries.some((e) => e.action === "crm.customer.create")).toBe(false);
  });

  it("cancel with wrong ID does not clear pending", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    const result = await handleChatTurn(deps, {
      session: plan.session,
      cancelId: "wrong-id",
      ctx,
    });

    expect(result.session.pending).toBeDefined();
  });
});

// ===================================================================
// handleChatTurn — explanation audit trail
// ===================================================================

describe("handleChatTurn — explanation audit trail", () => {
  it("includes explanation on confirmed action", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const plan = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    const confirmed = await handleChatTurn(deps, {
      session: plan.session,
      confirmId: plan.session.pending!.id,
      ctx,
    });

    expect(confirmed.explanation).toBeDefined();
    expect(confirmed.explanation!.runId).toBeTruthy();
    expect(confirmed.explanation!.summary).toContain("crm.customer.create");
    expect(confirmed.explanation!.reasons.length).toBeGreaterThan(0);
    expect(confirmed.explanation!.rulesApplied).toContain("ai_manual_parity");
    expect(confirmed.explanation!.autonomy).toBe("confirm");
  });

  it("includes explanation on auto-executed action", async () => {
    const deps = makeDeps({ autonomy: "guarded_auto" });
    const ctx = makeCtx();

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(result.explanation).toBeDefined();
    expect(result.explanation!.autonomy).toBe("guarded_auto");
    expect(result.explanation!.plannedCommand).toBe("crm.customer.create");
  });

  it("includes explanation on pending (confirm) action", async () => {
    const deps = makeDeps({ autonomy: "confirm" });
    const ctx = makeCtx();

    const result = await handleChatTurn(deps, {
      session: freshSession(),
      userText: "Create customer Acme Ltd",
      ctx,
    });

    expect(result.explanation).toBeDefined();
    expect(result.explanation!.plannedInput).toMatchObject({ name: "Acme Ltd" });
  });
});
