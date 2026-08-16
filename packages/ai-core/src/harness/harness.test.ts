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
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { requestPlanApproval } from "../planning/index.js";
import type { AgentPlan } from "../planning/index.js";
import { InMemorySessionLog } from "../trajectory/index.js";
import { createToolRegistry, defineBusinessTool } from "../tools/index.js";
import { topoSort } from "./plan-steps.js";
import { createHarness } from "./harness.js";
import type { HarnessOptions } from "./types.js";

const now = () => new Date("2026-08-16T10:00:00Z");

beforeEach(() => {
  PO_LOGS.length = 0;
  EMAIL_LOGS.length = 0;
});

// --- Bus fixtures ---------------------------------------------------------

const PO_LOGS: string[] = [];
const EMAIL_LOGS: string[] = [];

function registerCommands() {
  const registry = createCommandRegistry();
  registry.register(
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
  registry.register(
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
  return registry;
}

function registerQueries(): QueryRegistry {
  const registry = createQueryRegistry();
  registry.register(
    defineQuery({
      name: "sales.margin_report",
      permissions: ["sales.reports.view"],
      input: z.object({ period: z.string() }),
      output: z.object({ margin: z.number() }),
      handler: async (input) => ({ margin: input.period === "2026-Q3" ? 0.31 : 0.2 }),
    }),
  );
  return registry;
}

const purchaseOrderTool = defineBusinessTool({
  name: "procurement_create_purchase_order",
  description: "Create a purchase order.",
  command: "procurement.createPurchaseOrder",
  exposeWhen: ["procurement.purchase_order.create"],
  input: z.object({ supplierId: z.string(), totalAmount: z.number(), branchId: z.string() }),
  output: z.object({ purchaseOrderId: z.string(), status: z.string() }),
  renderResult: (r) => ({ summary: `PO ${r.purchaseOrderId} is ${r.status}.`, structured: r }),
});

const emailSendTool = defineBusinessTool({
  name: "messaging_send_email",
  description: "Send an email outside the platform.",
  command: "messaging.email.send",
  exposeWhen: ["messaging.email.send"],
  input: z.object({ to: z.string(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
  renderResult: (r) => ({ summary: `Email sent (${r.messageId}).`, structured: r }),
});

const marginReportTool = defineBusinessTool({
  name: "sales_margin_report",
  description: "Return the sales margin for a period.",
  kind: "query",
  command: "sales.margin_report",
  exposeWhen: ["sales.reports.view"],
  input: z.object({ period: z.string() }),
  output: z.object({ margin: z.number() }),
  renderResult: (r) => ({ summary: `Margin is ${r.margin}.`, structured: r }),
});

function actor(permissions: string[]): Actor {
  return { kind: "user", userId: "u1", organizationId: "o1", permissions: new Set(permissions) };
}

function helpers(): CommandHelpers {
  return { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
}

function registry() {
  const reg = createToolRegistry();
  reg.register(purchaseOrderTool);
  reg.register(emailSendTool);
  reg.register(marginReportTool);
  return reg;
}

/** Inbox whose `wait` returns a canned resolution (test-side decision surface). */
class FakeInbox implements InboxStore {
  waitValue = "approved";
  planCount = 0;

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
    this.planCount += 1;
    return {
      id: `plan-${this.planCount}`,
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
    return this.waitValue;
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
    return {
      id: `approval-${this.planCount + 1}`,
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
    throw new Error("unused");
  }
  async addNotification(): Promise<InboxItem> {
    throw new Error("unused");
  }
  async get(): Promise<InboxItem | undefined> {
    throw new Error("unused");
  }
  async list(): Promise<InboxItem[]> {
    throw new Error("unused");
  }
  async pending(): Promise<InboxItem[]> {
    throw new Error("unused");
  }
  async resolve(): Promise<boolean> {
    throw new Error("unused");
  }
  async resolveSession(): Promise<number> {
    throw new Error("unused");
  }
  async standingRuleFor(): Promise<null> {
    return null;
  }
  async inspectStandingRules(): Promise<never> {
    throw new Error("unused");
  }
  async reset(): Promise<void> {
    throw new Error("unused");
  }
  async reconcile(): Promise<never> {
    throw new Error("unused");
  }
}

function harness(opts: Partial<HarnessOptions> = {}): ReturnType<typeof createHarness> {
  return createHarness({
    registry: registry(),
    commands: registerCommands(),
    queries: registerQueries(),
    helpers: helpers(),
    grants: new InMemoryApprovalGrantStore({ now }),
    inbox: new FakeInbox(),
    approverUserId: "human-1",
    trajectory: new InMemorySessionLog(),
    now,
    ...opts,
  });
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan-1",
    objective: "Run the monthly close",
    assumptions: [],
    steps: [{ id: "s1", title: "Fetch margin", command: "sales.margin_report", args: { period: "2026-Q3" }, riskClass: "read" }],
    requiredApprovals: [],
    risks: [],
    evidenceNeeded: [],
    stopConditions: [],
    ...overrides,
  };
}

describe("topoSort", () => {
  it("orders steps so dependencies run first", () => {
    const a = { id: "a", title: "A", command: "x", dependsOn: [] };
    const b = { id: "b", title: "B", command: "x", dependsOn: ["a"] };
    const c = { id: "c", title: "C", command: "x", dependsOn: ["b"] };
    const order = topoSort([c, a, b]);
    expect(order.ok).toBe(true);
    if (order.ok) expect(order.order.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects cycles and missing dependencies", () => {
    expect(topoSort([{ id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] }]).ok).toBe(false);
    expect(topoSort([{ id: "a", title: "A", dependsOn: ["ghost"] }]).ok).toBe(false);
  });
});

describe("toolSurface", () => {
  it("exposes only tools the actor may use and renders schemas", () => {
    const h = harness();
    const surface = h.toolSurface(actor(["sales.reports.view"]));
    expect(surface.names).toEqual(["sales_margin_report"]);
    expect(surface.text).toContain("sales_margin_report");
    expect(surface.text).toContain("input");
  });

  it("reports no tools for an actor with no permissions", () => {
    const h = harness();
    const surface = h.toolSurface(actor([]));
    expect(surface.names).toEqual([]);
    expect(surface.text).toBe("(no tools exposed)");
  });
});

describe("harness.call", () => {
  it("runs a read tool through the bus and logs trajectory events", async () => {
    const h = harness();
    const outcome = await h.call({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["sales.reports.view"]),
      tool: "sales_margin_report",
      args: { period: "2026-Q3" },
      correlationId: "corr-1",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.structured).toEqual({ margin: 0.31 });
  });

  it("fails closed on an approval-required tool with no decision surface", async () => {
    const h = harness({ inbox: undefined, approverUserId: undefined });
    const outcome = await h.call({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["messaging.email.send"]),
      tool: "messaging_send_email",
      args: { to: "x@example.com", subject: "hi" },
      correlationId: "corr-1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("approval_required");
    expect(EMAIL_LOGS).toHaveLength(0);
  });

  it("returns an error outcome for an unknown tool", async () => {
    const h = harness();
    const outcome = await h.call({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor([]),
      tool: "nope",
      args: {},
      correlationId: "corr-1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("error");
  });
});

describe("harness.runPlan", () => {
  it("auto-runs a low-risk plan without minting grants", async () => {
    const h = harness();
    const result = await h.runPlan({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["sales.reports.view"]),
      plan: plan(),
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grantIds).toEqual([]);
      expect(result.stopped).toBe(false);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].outcome?.ok).toBe(true);
    }
  });

  it("mints plan grants and runs an external step under the covering grant", async () => {
    const h = harness();
    const result = await h.runPlan({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["messaging.email.send"]),
      plan: plan({
        steps: [{ id: "e1", title: "Notify supplier", command: "messaging.email.send", args: { to: "s@supplier.com", subject: "PO shipped" } }],
        requiredApprovals: [{ commandType: "messaging.email.send", riskClass: "external", reason: "notify supplier outside the platform" }],
      }),
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grantIds).toHaveLength(1);
      expect(result.steps[0].outcome?.ok).toBe(true);
    }
    expect(EMAIL_LOGS).toHaveLength(1);
    const log = JSON.parse(EMAIL_LOGS[0]);
    expect(log.approvalGrantId).toBe(result.ok && result.grantIds.length ? result.grantIds[0] : null);
  });

  it("runs steps in dependency order and skips dependents of failed steps", async () => {
    const h = harness();
    const result = await h.runPlan({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["messaging.email.send", "sales.reports.view"]),
      plan: plan({
        steps: [
          { id: "s1", title: "Fetch margin", command: "sales.margin_report", args: { period: "2026-Q3" }, riskClass: "read" },
          { id: "s2", title: "Email", command: "messaging.email.send", args: { to: "x@example.com", subject: "hi" }, dependsOn: ["s1"], riskClass: "external" },
          { id: "s3", title: "PO", command: "procurement.createPurchaseOrder", dependsOn: ["s2"] },
        ],
      }),
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // s2 is external with no covering grant or resolver item → approval_required.
      expect(result.steps[0].outcome?.ok).toBe(true);
      expect(result.steps[1].outcome?.ok).toBe(false);
      if (result.steps[1].outcome && !result.steps[1].outcome.ok) {
        expect(result.steps[1].outcome.kind).toBe("approval_required");
      }
      expect(result.steps[2].skipped).toBe("dep_failed");
      expect(PO_LOGS).toHaveLength(0);
    }
  });

  it("honors stop conditions", async () => {
    const h = harness();
    const result = await h.runPlan({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["sales.reports.view"]),
      plan: plan({
        steps: [
          { id: "s1", title: "Fetch margin", command: "sales.margin_report", args: { period: "2026-Q3" }, riskClass: "read" },
          { id: "s2", title: "Fetch margin again", command: "sales.margin_report", args: { period: "2026-Q2" }, riskClass: "read" },
        ],
        stopConditions: ["Margin is 0.31"],
      }),
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopped).toBe(true);
      expect(result.stopReason).toBe("Margin is 0.31");
      expect(result.steps[0].outcome?.ok).toBe(true);
      expect(result.steps[1].skipped).toBe("stopped");
    }
  });

  it("fails closed on boundary validation and on a missing approver", async () => {
    const h = harness();
    const invalid = await h.runPlan({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor([]),
      plan: plan({ objective: "" }),
      correlationId: "corr-1",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toContain("validation");

    const noApprover = await harness({ approverUserId: undefined }).runPlan({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["messaging.email.send"]),
      plan: plan({
        steps: [{ id: "e1", title: "Notify", command: "messaging.email.send", riskClass: "external" }],
        requiredApprovals: [{ commandType: "messaging.email.send", riskClass: "external", reason: "external" }],
      }),
      correlationId: "corr-1",
    });
    expect(noApprover.ok).toBe(false);
    if (!noApprover.ok) expect(noApprover.reason).toContain("approver");
  });

  it("attaches evidence for successful steps' expected evidence", async () => {
    const trajectory = new InMemorySessionLog();
    const h = harness({ trajectory });
    const result = await h.runPlan({
      sessionId: "s1",
      organizationId: "o1",
      actor: actor(["sales.reports.view"]),
      plan: plan({
        steps: [
          {
            id: "s1",
            title: "Fetch margin",
            command: "sales.margin_report",
            args: { period: "2026-Q3" },
            riskClass: "read",
            expectedEvidence: ["ev-margin"],
          },
        ],
      }),
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.steps[0].evidenceAttached).toEqual(["ev-margin"]);
    const types = (await trajectory.list("s1")).map((e) => e.type);
    expect(types).toContain("evidence/attached");
    expect(types).toContain("plan/proposed");
  });
});