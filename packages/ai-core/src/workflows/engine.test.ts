import {
  createCommandRegistry,
  createRequestContext,
  defineCommand,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  executeDynamicWorkflow,
  lookupPath,
  normalizeFieldNames,
  resolveInput,
  type WorkflowDefinition,
} from "./engine.js";
import { generateWorkflowFromNL, createWorkflowBuilderAgent } from "./builder.js";
import type { AiProvider, CompletionResult } from "../providers.js";

function makeCtx() {
  return createRequestContext({
    actor: {
      kind: "user",
      userId: "u1",
      organizationId: "o1",
      permissions: new Set(["crm.customer.create", "acc.invoice.create"]),
    },
    autonomy: "confirm",
  });
}

function registerCommands() {
  const registry = createCommandRegistry();
  registry.register(
    defineCommand({
      name: "crm.customer.create",
      permissions: ["crm.customer.create"],
      tags: ["crm"],
      input: z.object({
        name: z.string().min(1),
        email: z.string().email().optional(),
        city: z.string().optional(),
      }),
      output: z.object({ id: z.string(), name: z.string(), city: z.string().optional() }),
      handler: async (input) => ({ id: "cust-1", name: input.name, city: input.city }),
    }),
  );
  registry.register(
    defineCommand({
      name: "acc.invoice.create",
      permissions: ["acc.invoice.create"],
      tags: ["accounting"],
      input: z.object({
        number: z.string().min(1),
        total: z.number().nonnegative(),
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
  return registry;
}

function helpers() {
  return { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
}

describe("resolveInput / lookupPath", () => {
  it("resolves top-level variables", () => {
    const out = resolveInput(
      { name: "${customerName}", city: "${city}" },
      { customerName: "Acme", city: "Nairobi" },
    );
    expect(out).toEqual({ name: "Acme", city: "Nairobi" });
  });

  it("resolves nested step paths", () => {
    const out = resolveInput(
      { customerId: "${step1.id}", number: "INV-1" },
      { step1: { id: "cust-1", name: "Acme" } },
    );
    expect(out).toEqual({ customerId: "cust-1", number: "INV-1" });
  });

  it("supports partial string interpolation", () => {
    const out = resolveInput({ number: "INV-${suffix}" }, { suffix: "42" });
    expect(out).toEqual({ number: "INV-42" });
  });

  it("lookupPath walks dotted paths", () => {
    expect(lookupPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
    expect(lookupPath({ a: 1 }, "a.b")).toBeUndefined();
  });
});

describe("normalizeFieldNames", () => {
  it("maps common LLM aliases", () => {
    expect(
      normalizeFieldNames({
        location: "Mombasa",
        amount: 500,
        customer_id: "c1",
        name: "Acme",
      }),
    ).toEqual({
      city: "Mombasa",
      total: 500,
      customerId: "c1",
      name: "Acme",
    });
  });
});

describe("executeDynamicWorkflow", () => {
  it("runs a multi-step command workflow with variable wiring", async () => {
    const registry = registerCommands();
    const def: WorkflowDefinition = {
      id: "wf1",
      name: "Onboard",
      description: "customer + invoice",
      trigger: "manual",
      createdBy: "user",
      createdAt: new Date().toISOString(),
      steps: [
        {
          id: "step1",
          type: "command",
          command: "crm.customer.create",
          input: { name: "${customerName}", city: "${city}" },
          onError: "bail",
        },
        {
          id: "step2",
          type: "command",
          command: "acc.invoice.create",
          input: {
            number: "${invoiceNumber}",
            total: "${total}",
            customerId: "${step1.id}",
          },
          onError: "bail",
        },
      ],
    };

    const result = await executeDynamicWorkflow(
      def,
      { customerName: "Acme", city: "Nairobi", invoiceNumber: "INV-9", total: 100 },
      { registry, requestCtx: makeCtx(), helpers: helpers() },
    );

    expect(result.success).toBe(true);
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]?.status).toBe("completed");
    expect(result.stepResults[1]?.status).toBe("completed");
    expect(result.stepResults[1]?.output).toMatchObject({
      number: "INV-9",
      total: 100,
      customerId: "cust-1",
    });
  });

  it("pauses on approval and resumes when approved", async () => {
    const registry = registerCommands();
    const def: WorkflowDefinition = {
      id: "wf2",
      name: "With approval",
      description: "gate",
      trigger: "manual",
      createdBy: "ai",
      createdAt: new Date().toISOString(),
      steps: [
        {
          id: "step1",
          type: "command",
          command: "crm.customer.create",
          input: { name: "Acme" },
        },
        {
          id: "gate",
          type: "approval",
          description: "Approve invoice",
        },
        {
          id: "step3",
          type: "command",
          command: "acc.invoice.create",
          input: { number: "INV-1", total: 50, customerId: "${step1.id}" },
        },
      ],
    };

    const first = await executeDynamicWorkflow(
      def,
      {},
      { registry, requestCtx: makeCtx(), helpers: helpers() },
    );
    expect(first.success).toBe(false);
    expect(first.pendingApproval?.stepId).toBe("gate");
    expect(first.stepResults.map((s) => s.status)).toEqual(["completed", "pending_approval"]);

    const second = await executeDynamicWorkflow(
      def,
      {},
      { registry, requestCtx: makeCtx(), helpers: helpers() },
      { approvedStepIds: ["gate"] },
    );
    expect(second.success).toBe(true);
    expect(second.stepResults).toHaveLength(3);
    expect(second.stepResults[2]?.status).toBe("completed");
  });

  it("normalizes AI field aliases on execute", async () => {
    const registry = registerCommands();
    const def: WorkflowDefinition = {
      id: "wf3",
      name: "Aliases",
      description: "llm fields",
      trigger: "manual",
      createdBy: "ai",
      createdAt: new Date().toISOString(),
      steps: [
        {
          id: "step1",
          type: "command",
          command: "crm.customer.create",
          input: { name: "BuildTest", location: "Mombasa" },
        },
        {
          id: "step2",
          type: "command",
          command: "acc.invoice.create",
          input: {
            number: "INV-BUILD-1",
            amount: 500,
            customer_id: "${step1.id}",
          },
        },
      ],
    };

    const result = await executeDynamicWorkflow(
      def,
      {},
      { registry, requestCtx: makeCtx(), helpers: helpers() },
    );
    expect(result.success).toBe(true);
    expect(result.stepResults[0]?.output).toMatchObject({ name: "BuildTest", city: "Mombasa" });
    expect(result.stepResults[1]?.output).toMatchObject({
      number: "INV-BUILD-1",
      total: 500,
      customerId: "cust-1",
    });
  });

  it("does not pollute next-step inputs with prior output keys", async () => {
    const registry = registerCommands();
    // If context were flat-merged, prior `id` could leak into invoice validation oddly.
    // Invoice must only receive resolved step input fields.
    const def: WorkflowDefinition = {
      id: "wf4",
      name: "No pollution",
      description: "clean",
      trigger: "manual",
      createdBy: "user",
      createdAt: new Date().toISOString(),
      steps: [
        {
          id: "create_customer",
          type: "command",
          command: "crm.customer.create",
          input: { name: "X" },
        },
        {
          id: "create_invoice",
          type: "command",
          command: "acc.invoice.create",
          input: { number: "INV-X", total: 10 },
        },
      ],
    };
    const result = await executeDynamicWorkflow(
      def,
      {},
      { registry, requestCtx: makeCtx(), helpers: helpers() },
    );
    expect(result.success).toBe(true);
  });

  it("continues on onError: continue", async () => {
    const registry = registerCommands();
    const def: WorkflowDefinition = {
      id: "wf5",
      name: "Continue",
      description: "skip fail",
      trigger: "manual",
      createdBy: "user",
      createdAt: new Date().toISOString(),
      steps: [
        {
          id: "bad",
          type: "command",
          command: "crm.customer.create",
          input: { name: "" }, // fails validation
          onError: "continue",
        },
        {
          id: "good",
          type: "command",
          command: "crm.customer.create",
          input: { name: "OK" },
          onError: "bail",
        },
      ],
    };
    const result = await executeDynamicWorkflow(
      def,
      {},
      { registry, requestCtx: makeCtx(), helpers: helpers() },
    );
    expect(result.success).toBe(true);
    expect(result.stepResults[0]?.status).toBe("failed");
    expect(result.stepResults[1]?.status).toBe("completed");
  });
});

describe("generateWorkflowFromNL", () => {
  class MockProvider implements AiProvider {
    readonly id = "mock";
    constructor(private text: string) {}
    async complete(): Promise<CompletionResult> {
      return { text: this.text, provider: "mock", model: "m" };
    }
  }

  it("parses fenced JSON and normalizes field aliases", async () => {
    const registry = registerCommands();
    const agent = createWorkflowBuilderAgent({
      commandRegistry: registry,
      aiProvider: new MockProvider(`Here you go:
\`\`\`json
{
  "name": "Test",
  "description": "d",
  "trigger": "manual",
  "steps": [
    {
      "id": "step1",
      "type": "command",
      "command": "crm.customer.create",
      "input": { "name": "Acme", "location": "Nairobi" },
      "onError": "bail"
    }
  ]
}
\`\`\``),
    });

    const wf = await generateWorkflowFromNL(agent, "create customer Acme in Nairobi");
    expect(wf).not.toBeNull();
    expect(wf!.steps[0]!.input).toMatchObject({ name: "Acme", city: "Nairobi" });
    expect(wf!.createdBy).toBe("ai");
  });
});
