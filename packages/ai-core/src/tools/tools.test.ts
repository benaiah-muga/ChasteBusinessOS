import {
  createCommandRegistry,
  createQueryRegistry,
  defineCommand,
  defineQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import type { Actor, CommandHelpers, QueryRegistry } from "@chaste/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeTool, describeToolSet } from "./describe.js";
import { defaultToolPolicy, executeBusinessTool } from "./execute.js";
import { createToolRegistry, defineBusinessTool } from "./registry.js";
import { zodToSchemaText } from "./schema.js";
import type { BusinessToolDefinition, ToolContext } from "./types.js";
import { InMemorySessionLog } from "../trajectory/index.js";

const now = () => new Date("2026-08-16T10:00:00Z");

beforeEach(() => {
  PO_LOGS.length = 0;
});

// --- Bus fixtures ---------------------------------------------------------

const PO_LOGS: string[] = [];
function registerCommands() {
  const registry = createCommandRegistry();
  registry.register(
    defineCommand({
      name: "procurement.createPurchaseOrder",
      permissions: ["procurement.purchase_order.create"],
      tags: ["procurement"],
      input: z.object({
        supplierId: z.string(),
        totalAmount: z.number(),
        branchId: z.string(),
      }),
      output: z.object({ purchaseOrderId: z.string(), status: z.string() }),
      handler: async (input, ctx) => {
        PO_LOGS.push(JSON.stringify({ input, approvalGrantId: ctx.approvalGrantId ?? null }));
        return { purchaseOrderId: "po-1", status: "pending" };
      },
    }),
  );
  registry.register(
    defineCommand({
      name: "messaging.email.send",
      permissions: ["messaging.email.send"],
      tags: ["messaging"],
      riskClass: "external",
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ messageId: z.string() }),
      handler: async () => ({ messageId: "msg-1" }),
    }),
  );
  return registry;
}

function registerQueries(): QueryRegistry {
  const registry = createQueryRegistry();
  registry.register(
    defineQuery({
      name: "sales.margin_report",
      permissions: ["sales.reports.view"],
      tags: ["sales"],
      input: z.object({ period: z.string() }),
      output: z.object({ margin: z.number() }),
      handler: async (input) => ({ margin: input.period === "2026-Q3" ? 0.31 : 0.2 }),
    }),
  );
  return registry;
}

const purchaseOrderTool = defineBusinessTool({
  name: "procurement_create_purchase_order",
  description: "Create a purchase order after supplier, branch, amount, and approval policy checks.",
  command: "procurement.createPurchaseOrder",
  exposeWhen: ["procurement.purchase_order.create"],
  input: z.object({
    supplierId: z.string(),
    totalAmount: z.number(),
    branchId: z.string(),
  }),
  output: z.object({ purchaseOrderId: z.string(), status: z.string() }),
  renderResult: (result) => ({
    summary: `Purchase order ${result.purchaseOrderId} is ${result.status}.`,
    structured: result,
  }),
});

const emailSendTool = defineBusinessTool({
  name: "messaging_send_email",
  description: "Send an email to a recipient outside the platform.",
  command: "messaging.email.send",
  exposeWhen: ["messaging.email.send"],
  input: z.object({ to: z.string(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
  renderResult: (r) => ({ summary: `Email sent to ${r.messageId}.`, structured: r }),
});

const marginReportTool = defineBusinessTool({
  name: "sales_margin_report",
  description: "Return the sales margin for a period.",
  kind: "query",
  command: "sales.margin_report",
  exposeWhen: ["sales.reports.view"],
  input: z.object({ period: z.string() }),
  output: z.object({ margin: z.number() }),
  renderResult: (r) => ({ summary: `Margin for period is ${r.margin}.`, structured: r }),
});

function actor(permissions: string[]): Actor {
  return { kind: "user", userId: "u1", organizationId: "o1", permissions: new Set(permissions) };
}

function helpers(): CommandHelpers {
  return { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    organizationId: "o1",
    actor: actor(["procurement.purchase_order.create", "sales.reports.view"]),
    correlationId: "corr-1",
    commands: registerCommands(),
    queries: registerQueries(),
    helpers: helpers(),
    trajectory: new InMemorySessionLog(),
    now,
    ...overrides,
  };
}

async function eventTypes(ctx: ToolContext): Promise<string[]> {
  const events = await ctx.trajectory!.list("s1");
  return events.map((e) => e.type);
}

// --- Pipeline -------------------------------------------------------------

describe("executeBusinessTool pipeline", () => {
  it("dispatches through the bus and returns the rendered result", async () => {
    const ctx = makeCtx();
    const out = await executeBusinessTool(purchaseOrderTool, {
      supplierId: "sup-1",
      totalAmount: 1250,
      branchId: "br-1",
    }, ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.summary).toBe("Purchase order po-1 is pending.");
    expect(out.result.structured).toEqual({ purchaseOrderId: "po-1", status: "pending" });
    expect(out.policyDecisions[0]?.kind).toBe("allow");
    expect(PO_LOGS.pop()).toContain('"approvalGrantId":null');
  });

  it("logs call arguments before dispatch and the result after", async () => {
    const ctx = makeCtx();
    const out = await executeBusinessTool(purchaseOrderTool, {
      supplierId: "sup-1",
      totalAmount: 1250,
      branchId: "br-1",
    }, ctx);

    const events = await ctx.trajectory!.list("s1");
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "tool/call",
      "policy/decision",
      "command/dispatched",
      "command/result",
      "tool/result",
    ]);

    const call = events.find((e) => e.type === "tool/call")!;
    expect(call.payload).toMatchObject({
      tool: "procurement_create_purchase_order",
      args: { supplierId: "sup-1", totalAmount: 1250, branchId: "br-1" },
      riskClass: "write_local",
    });

    const result = events.find((e) => e.type === "tool/result")!;
    expect(result.payload).toMatchObject({
      ok: true,
      summary: "Purchase order po-1 is pending.",
    });

    expect(out.ok).toBe(true);
  });

  it("never dispatches on invalid arguments and returns a typed validation outcome", async () => {
    const ctx = makeCtx();
    const out = await executeBusinessTool(purchaseOrderTool, {
      supplierId: "sup-1",
      totalAmount: "not-a-number",
      branchId: "br-1",
    }, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("validation");
    expect(out.issues[0]?.path).toBe("totalAmount");
    expect(await eventTypes(ctx)).not.toContain("command/dispatched");
    expect(PO_LOGS.length).toBe(0);
  });

  it("returns a typed denial and dispatches nothing when exposeWhen is unmet", async () => {
    const ctx = makeCtx({ actor: actor(["sales.reports.view"]) });
    const out = await executeBusinessTool(purchaseOrderTool, {
      supplierId: "sup-1",
      totalAmount: 1250,
      branchId: "br-1",
    }, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("denied");
    expect(out.reason).toContain("procurement.purchase_order.create");
    expect(await eventTypes(ctx)).not.toContain("command/dispatched");
  });

  it("renders external-risk calls as approval requests, not failures, without a resolver", async () => {
    const ctx = makeCtx({ actor: actor(["messaging.email.send"]) });
    const out = await executeBusinessTool(emailSendTool, {
      to: "vendor@example.com",
      subject: "PO confirmation",
    }, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("approval_required");
    expect(out.approvalRequest.riskClass).toBe("external");
    expect(out.approvalRequest.commandType).toBe("messaging.email.send");
    expect(await eventTypes(ctx)).toContain("approval/requested");
    expect(await eventTypes(ctx)).not.toContain("command/dispatched");
  });

  it("proceeds with a durable approval grant when a resolver grants it", async () => {
    const ctx = makeCtx({
      actor: actor(["messaging.email.send"]),
      approvals: {
        request: async () => ({ granted: true, grantId: "grant-1", policyBasis: "ops-approved" }),
      },
    });
    const out = await executeBusinessTool(emailSendTool, {
      to: "vendor@example.com",
      subject: "PO confirmation",
    }, ctx);

    expect(out.ok).toBe(true);
    if (out.ok) return;
    expect(out.approvalGrantId).toBe("grant-1");
    const events = await ctx.trajectory!.list("s1");
    expect(events.map((e) => e.type)).toContain("approval/granted");
    expect(events.map((e) => e.type)).toContain("command/dispatched");
  });

  it("keeps an approval-required call pending when the resolver denies it", async () => {
    const ctx = makeCtx({
      actor: actor(["messaging.email.send"]),
      approvals: { request: async () => ({ granted: false }) },
    });
    const out = await executeBusinessTool(emailSendTool, {
      to: "vendor@example.com",
      subject: "PO confirmation",
    }, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("approval_required");
    expect(await eventTypes(ctx)).not.toContain("command/dispatched");
  });

  it("supports query tools through the query bus", async () => {
    const ctx = makeCtx();
    const out = await executeBusinessTool(marginReportTool, { period: "2026-Q3" }, ctx);

    expect(out.ok).toBe(true);
    if (out.ok) return;
    expect(out.result.structured).toEqual({ margin: 0.31 });
    const events = await ctx.trajectory!.list("s1");
    expect(events.map((e) => e.type)).toContain("query/dispatched");
    expect(events.map((e) => e.type)).toContain("query/result");
  });

  it("returns a typed error outcome when the bus handler throws", async () => {
    const registry = createCommandRegistry();
    registry.register(
      defineCommand({
        name: "boom.crash",
        permissions: ["boom.crash"],
        input: z.object({}),
        output: z.object({}),
        handler: async () => {
          throw new Error("kaboom");
        },
      }),
    );
    const tool = defineBusinessTool({
      name: "boom_crash",
      description: "crashes",
      command: "boom.crash",
      exposeWhen: ["boom.crash"],
      input: z.object({}),
      output: z.object({}),
    });
    const ctx = makeCtx({ actor: actor(["boom.crash"]), commands: registry });
    const out = await executeBusinessTool(tool, {}, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("error");
    expect(out.message).toBe("kaboom");
    const events = await ctx.trajectory!.list("s1");
    expect(events.map((e) => e.type)).toContain("command/result");
  });
});

// --- Risk classification --------------------------------------------------

describe("risk classification", () => {
  it("derives risk from the underlying command metadata (external)", async () => {
    const ctx = makeCtx({
      actor: actor(["messaging.email.send"]),
      approvals: { request: async () => ({ granted: true, grantId: "g" }) },
    });
    const out = await executeBusinessTool(emailSendTool, {
      to: "vendor@example.com",
      subject: "hi",
    }, ctx);

    expect(out.ok).toBe(true);
    if (out.ok) return;
    const events = await ctx.trajectory!.list("s1");
    const call = events.find((e) => e.type === "tool/call")!;
    expect(call.payload).toMatchObject({ riskClass: "external" });
    // external risk needed approval even though the actor had permission
    expect(out.approvalGrantId).toBe("g");
  });

  it("a declared risk override wins over command metadata", async () => {
    const overrideTool: BusinessToolDefinition<z.ZodType, z.ZodType> = {
      ...emailSendTool,
      risk: "read",
    };
    const ctx = makeCtx({ actor: actor(["messaging.email.send"]) });
    const out = await executeBusinessTool(overrideTool, {
      to: "vendor@example.com",
      subject: "hi",
    }, ctx);

    expect(out.ok).toBe(true);
    if (out.ok) return;
    const events = await ctx.trajectory!.list("s1");
    const call = events.find((e) => e.type === "tool/call")!;
    expect(call.payload).toMatchObject({ riskClass: "read" });
    expect(events.map((e) => e.type)).not.toContain("approval/requested");
  });
});

// --- Default policy -------------------------------------------------------

describe("defaultToolPolicy", () => {
  it("allows reads and in-tenant writes under the actor's own authority", () => {
    expect(defaultToolPolicy({ riskClass: "read", isQuery: true }).kind).toBe("allow");
    expect(defaultToolPolicy({ riskClass: "write_local", isQuery: false }).kind).toBe("allow");
  });

  it("requires approval for exec/external side effects", () => {
    expect(defaultToolPolicy({ riskClass: "exec", isQuery: false }).kind).toBe("approval_required");
    expect(defaultToolPolicy({ riskClass: "external", isQuery: false }).kind).toBe("approval_required");
  });
});

// --- Registry visibility --------------------------------------------------

describe("ToolRegistry", () => {
  it("registers and looks up tools", () => {
    const registry = createToolRegistry();
    registry.register(purchaseOrderTool);
    expect(registry.has("procurement_create_purchase_order")).toBe(true);
    expect(registry.get("procurement_create_purchase_order")).toBe(purchaseOrderTool);
  });

  it("rejects duplicate registration", () => {
    const registry = createToolRegistry();
    registry.register(purchaseOrderTool);
    expect(() => registry.register(purchaseOrderTool)).toThrow(/already registered/);
  });

  it("hides tools from model context unless the actor can use them", () => {
    const registry = createToolRegistry();
    registry.register(purchaseOrderTool);
    registry.register(emailSendTool);
    registry.register(marginReportTool);

    const poClerk = actor(["procurement.purchase_order.create"]);
    expect(registry.listForActor(poClerk).map((t) => t.name)).toEqual([
      "procurement_create_purchase_order",
    ]);

    const superuser = actor(["*"]);
    expect(registry.listForActor(superuser)).toHaveLength(3);
  });
});

// --- Tool surface ---------------------------------------------------------

describe("describeTool / describeToolSet", () => {
  it("renders the full tool-surface metadata", () => {
    const text = describeTool(purchaseOrderTool);
    expect(text).toContain("## procurement_create_purchase_order");
    expect(text).toContain("Create a purchase order");
    expect(text).toContain("risk: write_local");
    expect(text).toContain("approval: review");
    expect(text).toContain("access: write");
    expect(text).toContain("idempotent: no");
    expect(text).toContain('"supplierId":"string"');
    expect(text).toContain('"totalAmount":"number"');
    expect(text).toContain('"purchaseOrderId":"string"');
  });

  it("renders a capability-directory one-liner when catalog is requested", () => {
    const registry = createToolRegistry();
    registry.register(purchaseOrderTool);
    registry.register(marginReportTool);
    const text = describeToolSet(registry.list(), { catalog: true });
    expect(text).toContain("procurement_create_purchase_order: Create a purchase order");
    expect(text).toContain("sales_margin_report: Return the sales margin for a period.");
  });

  it("renders an empty marker when no tools are exposed", () => {
    expect(describeToolSet([], { catalog: true })).toBe("(no tools exposed)");
  });
});

// --- Schema text ----------------------------------------------------------

describe("zodToSchemaText", () => {
  it("renders a nested schema deterministically", () => {
    const schema = z.object({
      id: z.string(),
      qty: z.number().int().optional(),
      tags: z.array(z.string()),
      state: z.enum(["open", "closed"]),
    });
    expect(zodToSchemaText(schema)).toBe(
      JSON.stringify({
        id: "string",
        qty: "integer?",
        tags: ["string"],
        state: "enum(open|closed)",
      }),
    );
  });

  it("marks optional fields and unwraps defaults", () => {
    const schema = z.object({
      name: z.string().optional(),
      count: z.number().default(0),
    });
    expect(zodToSchemaText(schema)).toBe(JSON.stringify({ name: "string?", count: "number" }));
  });
});