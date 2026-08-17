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
import { z } from "zod";
import { createToolRegistry, defineBusinessTool } from "../../tools/index.js";
import type { SessionLog } from "../../trajectory/index.js";
import { createHarness } from "../../harness/index.js";
import type { Harness, HarnessOptions } from "../../harness/index.js";

/**
 * Shared fixture for golden evaluation scenarios: a real kernel command/query
 * bus, a real tool registry, durable in-memory grants, a decision surface that
 * approves plans, and a real harness whose trajectory is the scenario's own
 * session log — so a scenario run IS a real, replayable agent session.
 */

export interface HarnessFixture {
  harness: Harness;
  actor: (permissions: string[]) => Actor;
  poLogs: string[];
  emailLogs: string[];
  build: (opts?: Partial<HarnessOptions>) => Harness;
}

/** Inbox whose blocking `wait` resolves to the configured value (host-side
 * decision surface). */
class ScriptedInbox implements InboxStore {
  constructor(public resolution: "approved" | "rejected" = "approved") {}
  private counter = 0;

  async addPlan(input: {
    sessionId: string;
    organizationId: string;
    userId: string;
    title: string;
    body?: string;
    inbox?: string;
    visibility?: string;
    toolCallId?: string;
    data?: Record<string, unknown>;
  }): Promise<InboxItem> {
    this.counter += 1;
    return {
      id: `plan-${this.counter}`,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      kind: "plan",
      title: input.title,
      body: input.body,
      state: "pending",
      inbox: input.inbox ?? "default",
      visibility: "inbox",
      data: input.data,
      createdAt: new Date().toISOString(),
    };
  }

  async wait(): Promise<string> {
    return this.resolution;
  }

  async addApproval(input: {
    sessionId: string;
    organizationId: string;
    userId: string;
    title: string;
    body?: string;
    inbox?: string;
    visibility?: string;
    toolCallId?: string;
    data?: Record<string, unknown>;
  }): Promise<InboxItem> {
    this.counter += 1;
    return {
      id: `approval-${this.counter}`,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      kind: "approval",
      title: input.title,
      body: input.body,
      state: "pending",
      inbox: input.inbox ?? "default",
      visibility: "inbox",
      toolCallId: input.toolCallId,
      data: input.data,
      createdAt: new Date().toISOString(),
    };
  }

  async addQuestion(): Promise<InboxItem> {
    throw new Error("unused in scenarios");
  }
  async addNotification(): Promise<InboxItem> {
    throw new Error("unused in scenarios");
  }
  async get(): Promise<InboxItem | undefined> {
    throw new Error("unused in scenarios");
  }
  async list(): Promise<InboxItem[]> {
    throw new Error("unused in scenarios");
  }
  async pending(): Promise<InboxItem[]> {
    throw new Error("unused in scenarios");
  }
  async resolve(): Promise<boolean> {
    throw new Error("unused in scenarios");
  }
  async resolveSession(): Promise<number> {
    throw new Error("unused in scenarios");
  }
  async standingRuleFor(): Promise<null> {
    return null;
  }
  async inspectStandingRules(): Promise<never> {
    throw new Error("unused in scenarios");
  }
  async reset(): Promise<void> {
    throw new Error("unused in scenarios");
  }
  async reconcile(): Promise<never> {
    throw new Error("unused in scenarios");
  }
}

export function createHarnessFixture(opts: {
  log: SessionLog;
  organizationId: string;
  now: () => Date;
}): HarnessFixture {
  const poLogs: string[] = [];
  const emailLogs: string[] = [];

  const commands = createCommandRegistry();
  commands.register(
    defineCommand({
      name: "procurement.createPurchaseOrder",
      permissions: ["procurement.purchase_order.create"],
      input: z.object({ supplierId: z.string(), totalAmount: z.number(), branchId: z.string() }),
      output: z.object({ purchaseOrderId: z.string(), status: z.string() }),
      handler: async (input, ctx) => {
        poLogs.push(JSON.stringify({ input, approvalGrantId: ctx.approvalGrantId ?? null }));
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
        emailLogs.push(JSON.stringify({ input, approvalGrantId: ctx.approvalGrantId ?? null }));
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

  const inbox = new ScriptedInbox();
  const grants = new InMemoryApprovalGrantStore({ now: opts.now });
  const helpers: CommandHelpers = { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };

  const build = (overrides: Partial<HarnessOptions> = {}): Harness =>
    createHarness({
      registry,
      commands,
      queries,
      helpers,
      grants,
      inbox,
      approverUserId: "human-1",
      trajectory: opts.log,
      now: opts.now,
      ...overrides,
    });

  return {
    harness: build(),
    actor: (permissions: string[]) => ({
      kind: "user",
      userId: "u1",
      organizationId: opts.organizationId,
      permissions: new Set(permissions),
    }),
    poLogs,
    emailLogs,
    build,
  };
}