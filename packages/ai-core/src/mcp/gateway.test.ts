import {
  createCommandRegistry,
  createQueryRegistry,
  defineCommand,
  defineQuery,
  InMemoryApprovalGrantStore,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import type { Actor, CommandHelpers, InboxItem, InboxStore, QueryRegistry } from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemorySessionLog } from "../trajectory/index.js";
import { createToolRegistry, defineBusinessTool } from "../tools/index.js";
import { createMcpGateway } from "./gateway.js";
import type { McpGatewaySession } from "./gateway.js";
import { handleMcpLine } from "./stdio.js";
import { McpErrorCode } from "./protocol.js";

const now = () => new Date("2026-08-16T10:00:00Z");

const EMAIL_LOGS: string[] = [];
const PO_LOGS: string[] = [];

function gateway(opts: { approvals?: boolean } = {}) {
  const approvals = opts.approvals ?? true;
  const commands = createCommandRegistry();
  commands.register(
    defineCommand({
      name: "procurement.createPurchaseOrder",
      permissions: ["procurement.purchase_order.create"],
      input: z.object({ supplierId: z.string(), totalAmount: z.number(), branchId: z.string() }),
      output: z.object({ purchaseOrderId: z.string(), status: z.string() }),
      handler: async (input, ctx) => {
        PO_LOGS.push(JSON.stringify({ input, approvalGrantId: ctx.approvalGrantId ?? null }));
        return { purchaseOrderId: "po-1", status: "pending" };
      },
    }),
  );
  commands.register(
    defineCommand({
      name: "messaging.email.send",
      permissions: ["messaging.email.send"],
      riskClass: "external",
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ messageId: z.string() }),
      handler: async (input, ctx) => {
        EMAIL_LOGS.push(JSON.stringify({ input, approvalGrantId: ctx.approvalGrantId ?? null }));
        return { messageId: "msg-1" };
      },
    }),
  );

  const queries: QueryRegistry = createQueryRegistry();
  queries.register(
    defineQuery({
      name: "sales.margin_report",
      permissions: ["sales.reports.view"],
      input: z.object({ period: z.string() }),
      output: z.object({ margin: z.number() }),
      handler: async (input) => ({ margin: input.period === "2026-Q3" ? 0.31 : 0.2 }),
    }),
  );

  const registry = createToolRegistry();
  registry.register(
    defineBusinessTool({
      name: "procurement_create_purchase_order",
      description: "Create a purchase order.",
      command: "procurement.createPurchaseOrder",
      exposeWhen: ["procurement.purchase_order.create"],
      input: z.object({ supplierId: z.string(), totalAmount: z.number(), branchId: z.string() }),
      output: z.object({ purchaseOrderId: z.string(), status: z.string() }),
      renderResult: (r) => ({ summary: `PO ${r.purchaseOrderId} is ${r.status}.`, structured: r }),
    }),
  );
  registry.register(
    defineBusinessTool({
      name: "messaging_send_email",
      description: "Send an email outside the platform.",
      command: "messaging.email.send",
      exposeWhen: ["messaging.email.send"],
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ messageId: z.string() }),
      renderResult: (r) => ({ summary: `Email sent (${r.messageId}).`, structured: r }),
    }),
  );
  registry.register(
    defineBusinessTool({
      name: "sales_margin_report",
      description: "Return the sales margin for a period.",
      kind: "query",
      command: "sales.margin_report",
      exposeWhen: ["sales.reports.view"],
      input: z.object({ period: z.string() }),
      output: z.object({ margin: z.number() }),
      renderResult: (r) => ({ summary: `Margin is ${r.margin}.`, structured: r }),
    }),
  );

  const grants = new InMemoryApprovalGrantStore({ now });
  const helpers: CommandHelpers = { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
  const inbox = new (class implements InboxStore {
    async wait(): Promise<string> {
      return "allow";
    }
    async addApproval(input: { title: string; body?: string }): Promise<InboxItem> {
      return {
        id: "approval-1",
        sessionId: "s1",
        organizationId: "o1",
        userId: "u1",
        kind: "approval",
        title: input.title,
        body: input.body,
        state: "pending",
        inbox: "default",
        visibility: "inbox",
        createdAt: now().toISOString(),
      };
    }
    async addPlan(): Promise<InboxItem> {
      throw new Error("unused");
    }
    async addQuestion(): Promise<InboxItem> {
      throw new Error("unused");
    }
    async addNotification(): Promise<InboxItem> {
      throw new Error("unused");
    }
    async get(): Promise<InboxItem | undefined> {
      return undefined;
    }
    async list(): Promise<InboxItem[]> {
      return [];
    }
    async pending(): Promise<InboxItem[]> {
      return [];
    }
    async resolve(): Promise<boolean> {
      return false;
    }
    async resolveSession(): Promise<number> {
      return 0;
    }
    async standingRuleFor(): Promise<null> {
      return null;
    }
    async inspectStandingRules(): Promise<never> {
      throw new Error("unused");
    }
    async reset(): Promise<void> {}
    async reconcile(): Promise<never> {
      throw new Error("unused");
    }
  })();

  const mcp = createMcpGateway({
    registry,
    commands,
    queries,
    helpers,
    ...(approvals
      ? {
          grants,
          inbox,
          approverUserId: "human-1",
        }
      : {}),
    trajectory: new InMemorySessionLog(),
    now,
    serverInfo: { name: "chaste-test", version: "0.1.0" },
  });
  return { mcp, grants, registry };
}

function actor(permissions: string[]): Actor {
  return { kind: "user", userId: "u1", organizationId: "o1", permissions: new Set(permissions) };
}

function session(g: ReturnType<typeof gateway>["mcp"], perms: string[]): McpGatewaySession {
  return g.createSession({ sessionId: "s1", organizationId: "o1", actor: actor(perms) });
}

function send(sess: McpGatewaySession, line: unknown): Promise<string | null> {
  return handleMcpLine(sess, JSON.stringify(line));
}

describe("createMcpGateway", () => {
  it("answers initialize with server info and tool capability", async () => {
    const { mcp } = gateway();
    const sess = session(mcp, []);
    const response = await send(sess, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const parsed = JSON.parse(response!) as { result: { protocolVersion: string; capabilities: { tools: Record<string, never> }; serverInfo: { name: string } } };
    expect(parsed.result.protocolVersion).toBe("2025-06-18");
    expect(parsed.result.capabilities.tools).toEqual({});
    expect(parsed.result.serverInfo.name).toBe("chaste-test");
  });

  it("scopes tools/list to the bound actor's permissions", async () => {
    const { mcp } = gateway();
    const limited = await send(session(mcp, ["sales.reports.view"]), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const full = await send(session(mcp, ["sales.reports.view", "messaging.email.send"]), { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const limitedTools = JSON.parse(limited!).result.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    const fullTools = JSON.parse(full!).result.tools as Array<{ name: string }>;
    expect(limitedTools.map((t) => t.name)).not.toContain("messaging_send_email");
    expect(fullTools.map((t) => t.name)).toContain("messaging_send_email");
    // inputSchema is a JSON Schema object with required fields.
    expect(limitedTools[0]!.inputSchema.type).toBe("object");
    expect(limitedTools[0]!.inputSchema.properties).toBeTruthy();
  });

  it("calls a scoped read tool and returns a text result", async () => {
    const { mcp } = gateway();
    const sess = session(mcp, ["sales.reports.view"]);
    const response = await send(sess, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "sales_margin_report", arguments: { period: "2026-Q3" } },
    });
    const parsed = JSON.parse(response!) as { result: { content: Array<{ text: string }> } };
    expect(parsed.result.content[0]!.text).toContain("0.31");
    expect(parsed.result.content[0]!.text).toContain("margin");
  });

  it("refuses a tool the actor cannot see as tool-not-found", async () => {
    const { mcp } = gateway();
    const sess = session(mcp, ["sales.reports.view"]);
    const response = await send(sess, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "messaging_send_email", arguments: { to: "x@example.com", subject: "hi" } },
    });
    const parsed = JSON.parse(response!) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(McpErrorCode.ToolNotFound);
  });

  it("returns an explainable approval-required result and dispatches nothing", async () => {
    EMAIL_LOGS.length = 0;
    // No decision surface: a risky call is surfaced as an approval request,
    // never executed and never silently failed.
    const { mcp } = gateway({ approvals: false });
    const sess = session(mcp, ["messaging.email.send"]);
    const response = await send(sess, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "messaging_send_email", arguments: { to: "x@example.com", subject: "hi" } },
    });
    const parsed = JSON.parse(response!) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.content[0]!.text).toContain("approval_required");
    expect(EMAIL_LOGS).toHaveLength(0);
  });

  it("executes an external call under a durable grant", async () => {
    EMAIL_LOGS.length = 0;
    const { mcp, grants } = gateway();
    await grants.create({
      organizationId: "o1",
      grantedBy: "human-1",
      grantedToUserId: "u1",
      scope: { commandType: "messaging.email.send" },
      expiresAt: new Date(now().getTime() + 3_600_000).toISOString(),
      conditions: [],
      policyBasis: "test-grant",
    });
    const sess = session(mcp, ["messaging.email.send"]);
    const response = await send(sess, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "messaging_send_email", arguments: { to: "x@example.com", subject: "hi" } },
    });
    const parsed = JSON.parse(response!) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(parsed.result.isError).toBeUndefined();
    expect(parsed.result.content[0]!.text).toContain("msg-1");
    expect(EMAIL_LOGS).toHaveLength(1);
    expect(JSON.parse(EMAIL_LOGS[0]!).approvalGrantId).toBeTruthy();
  });

  it("returns a validation error result for bad arguments", async () => {
    const { mcp } = gateway();
    const sess = session(mcp, ["sales.reports.view"]);
    const response = await send(sess, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "sales_margin_report", arguments: {} },
    });
    const parsed = JSON.parse(response!) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.content[0]!.text).toContain("validation");
  });

  it("records the call on the session trajectory", async () => {
    const { mcp } = gateway();
    const log = new InMemorySessionLog();
    const g = createMcpGateway({
      ...gatewayFixturesFor(log),
      trajectory: log,
      serverInfo: { name: "t", version: "0" },
    });
    const sess = g.createSession({ sessionId: "s1", organizationId: "o1", actor: actor(["sales.reports.view"]) });
    await send(sess, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "sales_margin_report", arguments: { period: "2026-Q3" } },
    });
    const events = await log.list("s1");
    expect(events.some((e) => e.type === "tool/call")).toBe(true);
    expect(events.some((e) => e.type === "query/dispatched")).toBe(true);
    expect(events.some((e) => e.type === "tool/result")).toBe(true);
  });
});

describe("MCP protocol over the line handler", () => {
  it("ignores notifications (no response)", async () => {
    const { mcp } = gateway();
    const response = await send(session(mcp, []), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response).toBeNull();
  });

  it("returns a parse error for invalid JSON", async () => {
    const { mcp } = gateway();
    const response = await session(mcp, []).handleMessage("{not json");
    const parsed = JSON.parse(response!) as { error: { code: number } };
    expect(parsed.error.code).toBe(McpErrorCode.ParseError);
  });

  it("returns method-not-found for unknown methods", async () => {
    const { mcp } = gateway();
    const response = await send(session(mcp, []), { jsonrpc: "2.0", id: 10, method: "resources/list" });
    const parsed = JSON.parse(response!) as { error: { code: number } };
    expect(parsed.error.code).toBe(McpErrorCode.MethodNotFound);
  });

  it("returns invalid-params for a malformed tools/call", async () => {
    const { mcp } = gateway();
    const response = await send(session(mcp, []), { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: 42 } });
    const parsed = JSON.parse(response!) as { error: { code: number } };
    expect(parsed.error.code).toBe(McpErrorCode.InvalidParams);
  });

  it("answers ping", async () => {
    const { mcp } = gateway();
    const response = await send(session(mcp, []), { jsonrpc: "2.0", id: 12, method: "ping" });
    expect(JSON.parse(response!)).toEqual({ jsonrpc: "2.0", id: 12, result: {} });
  });
});

// Shared fixtures for the trajectory test — the same bus/tools as `gateway()`.
function gatewayFixturesFor(log: InMemorySessionLog) {
  const commands = createCommandRegistry();
  commands.register(
    defineCommand({
      name: "sales.margin_report",
      permissions: ["sales.reports.view"],
      input: z.object({ period: z.string() }),
      output: z.object({ margin: z.number() }),
      handler: async (input) => ({ margin: input.period === "2026-Q3" ? 0.31 : 0.2 }),
    }),
  );
  const queries = createQueryRegistry();
  const registry = createToolRegistry();
  registry.register(
    defineBusinessTool({
      name: "sales_margin_report",
      description: "Return the sales margin for a period.",
      kind: "query",
      command: "sales.margin_report",
      exposeWhen: ["sales.reports.view"],
      input: z.object({ period: z.string() }),
      output: z.object({ margin: z.number() }),
      renderResult: (r) => ({ summary: `Margin is ${r.margin}.`, structured: r }),
    }),
  );
  return {
    registry,
    commands,
    queries,
    helpers: { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() } satisfies CommandHelpers,
    now,
  };
}