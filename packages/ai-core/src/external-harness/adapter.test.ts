import {
  createCommandRegistry,
  createQueryRegistry,
  defineCommand,
  defineQuery,
  InMemoryApprovalGrantStore,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import type { Actor, CommandHelpers, QueryRegistry } from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemorySessionLog } from "../trajectory/index.js";
import { createToolRegistry, defineBusinessTool } from "../tools/index.js";
import { createMcpGateway } from "../mcp/index.js";
import { createHarnessAdapter } from "./adapter.js";
import { harnessRunFromTrajectory } from "./adapter.js";
import { EXTERNAL_HARNESS_DEFINITIONS } from "./definitions.js";
import type { HarnessAdapter, HarnessStartRequest } from "./types.js";

const now = () => new Date("2026-08-17T10:00:00Z");

const EMAIL_LOGS: string[] = [];

function fixture() {
  const log = new InMemorySessionLog();
  const commands = createCommandRegistry();
  commands.register(
    defineCommand({
      name: "procurement.createPurchaseOrder",
      permissions: ["procurement.purchase_order.create"],
      input: z.object({ supplierId: z.string(), totalAmount: z.number() }),
      output: z.object({ purchaseOrderId: z.string(), status: z.string() }),
      handler: async (input) => ({ purchaseOrderId: "po-1", status: "pending" }),
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
      input: z.object({ supplierId: z.string(), totalAmount: z.number() }),
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
  const mcp = createMcpGateway({
    registry,
    commands,
    queries,
    helpers: { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() } satisfies CommandHelpers,
    grants,
    trajectory: log,
    now,
    serverInfo: { name: "chaste-test", version: "0.1.0" },
  });
  return { log, mcp, grants, registry };
}

function actor(permissions: string[]): Actor {
  return { kind: "user", userId: "u1", organizationId: "o1", permissions: new Set(permissions) };
}

function adapter(fixture: ReturnType<typeof fixture>): HarnessAdapter {
  return createHarnessAdapter({
    definition: EXTERNAL_HARNESS_DEFINITIONS[0]!, // codex
    mcp: fixture.mcp,
    log: fixture.log,
    now,
  });
}

function startRequest(overrides: Partial<HarnessStartRequest> = {}): HarnessStartRequest {
  return {
    actor: actor(["procurement.purchase_order.create", "sales.reports.view"]),
    objective: "Draft a purchase order for the restock",
    tenantId: "o1",
    allowedTools: [{ tool: "sales_margin_report" }],
    forbiddenDataClasses: ["personal_data"],
    ...overrides,
  };
}

describe("external harness adapter (build item 16)", () => {
  it("records an externalHarness/session-start on the Chaste trajectory", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    expect(handle.runId).toBeTruthy();
    expect(handle.status).toBe("running");
    expect(handle.usageVisibility).toBe("unknown");

    const events = await f.log.list(handle.runId);
    const start = events.find((e) => e.type === "externalHarness/session-start");
    expect(start).toBeDefined();
    const payload = start!.payload as Record<string, unknown>;
    expect(payload.objective).toContain("restock");
    expect(payload.allowedTools).toEqual([{ tool: "sales_margin_report" }]);
    expect(payload.forbiddenDataClasses).toEqual(["personal_data"]);
    expect(payload.harnessKind).toBe("codex");
  });

  it("records provider/model usage when the harness exposes it", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    const next = await a.followup(handle, {
      role: "assistant",
      content: "I checked the margin.",
      provider: "anthropic",
      model: "claude-opus-4",
      usage: { promptTokens: 100, completionTokens: 40, costCents: 2 },
    });
    expect(next.usageVisibility).toBe("recorded");
    expect(next.modelUsage).toHaveLength(1);
    expect(next.modelUsage[0]!.model).toBe("claude-opus-4");

    const events = await f.log.list(handle.runId);
    const turn = events.find((e) => e.type === "externalHarness/turn");
    const payload = turn!.payload as Record<string, unknown>;
    expect(payload.usageVisibility).toBe("recorded");
  });

  it("marks the run usage-unknown when the harness hides provider/model", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    const next = await a.followup(handle, {
      role: "assistant",
      content: "I did some work.",
    });
    expect(next.usageVisibility).toBe("unknown");

    const events = await f.log.list(handle.runId);
    const turn = events.find((e) => e.type === "externalHarness/turn");
    const payload = turn!.payload as Record<string, unknown>;
    expect(payload.usageVisibility).toBe("unknown");
  });

  it("mediates an allowed scoped tool call through the bus and records it", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    const next = await a.followup(handle, {
      role: "assistant",
      content: "Let me check the margin.",
      toolCalls: [{ tool: "sales_margin_report", args: { period: "2026-Q3" }, toolCallId: "tc1" }],
    });
    expect(next.toolOutcomes).toHaveLength(1);
    expect(next.toolOutcomes[0]!.ok).toBe(true);
    expect(next.toolOutcomes[0]!.summary).toContain("0.31");

    const events = await f.log.list(handle.runId);
    expect(events.some((e) => e.type === "externalHarness/tool-call")).toBe(true);
    expect(events.some((e) => e.type === "externalHarness/tool-result")).toBe(true);
    expect(events.some((e) => e.type === "query/dispatched")).toBe(true);
  });

  it("refuses a tool that is not in allowedTools and dispatches nothing", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest()); // allowedTools = margin only
    const next = await a.followup(handle, {
      role: "assistant",
      content: "Let me send an email.",
      toolCalls: [{ tool: "messaging_send_email", args: { to: "x@example.com", subject: "hi" } }],
    });
    expect(next.toolOutcomes[0]!.ok).toBe(false);
    expect(next.toolOutcomes[0]!.error).toContain("not in allowedTools");

    const events = await f.log.list(handle.runId);
    expect(events.some((e) => e.type === "command/dispatched")).toBe(false);
    expect(events.some((e) => e.type === "externalHarness/tool-result")).toBe(true);
  });

  it("attaches artifacts as externalHarness/artifact events", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    const next = await a.followup(handle, {
      role: "assistant",
      content: "Here is the trace.",
      artifacts: [{ ref: "s3://trace/run-1.json", summary: "Codex trace", version: "v1" }],
    });
    expect(next.artifacts).toEqual([{ ref: "s3://trace/run-1.json", summary: "Codex trace", version: "v1" }]);

    const events = await f.log.list(handle.runId);
    expect(events.some((e) => e.type === "externalHarness/artifact")).toBe(true);
  });

  it("ends the run and records externalHarness/session-end on endSession/cancel", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    const done = await a.followup(handle, { role: "assistant", content: "Done.", endSession: true });
    expect(done.status).toBe("succeeded");

    const cancelled = await a.cancel(done, "user aborted");
    expect(cancelled.status).toBe("cancelled");

    const events = await f.log.list(handle.runId);
    const ends = events.filter((e) => e.type === "externalHarness/session-end");
    expect(ends).toHaveLength(2);
    expect((ends[1]!.payload as { status: string }).status).toBe("cancelled");
  });

  it("collects a run result whose traceRef is the Chaste trajectory id", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    const next = await a.followup(handle, {
      role: "assistant",
      content: "Done.",
      provider: "openai",
      model: "gpt-5",
      artifacts: [{ ref: "trace-1" }],
      endSession: true,
    });
    const result = await a.collect(next);
    expect(result.status).toBe("succeeded");
    expect(result.traceRef).toBe(handle.runId);
    expect(result.artifacts).toEqual([{ ref: "trace-1" }]);
    expect(result.usageVisibility).toBe("recorded");
    expect(result.modelUsage[0]!.model).toBe("gpt-5");
  });

  it("reconstructs a run handle from the trajectory (stateless resume)", async () => {
    const f = fixture();
    const a = adapter(f);
    const handle = await a.start(startRequest());
    const next = await a.followup(handle, {
      role: "assistant",
      content: "Checked.",
      provider: "anthropic",
      model: "claude-opus-4",
      toolCalls: [{ tool: "sales_margin_report", args: { period: "2026-Q3" } }],
      artifacts: [{ ref: "trace-1" }],
      endSession: true,
    });

    const events = await f.log.list(handle.runId);
    const rebuilt = harnessRunFromTrajectory(handle.runId, events);
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.status).toBe("succeeded");
    expect(rebuilt!.usageVisibility).toBe("recorded");
    expect(rebuilt!.toolOutcomes).toEqual(next.toolOutcomes);
    expect(rebuilt!.artifacts).toEqual([{ ref: "trace-1" }]);
    expect(rebuilt!.allowedTools).toEqual([{ tool: "sales_margin_report" }]);
  });

  it("returns undefined for a runId with no session-start event", async () => {
    expect(harnessRunFromTrajectory("missing", [])).toBeUndefined();
  });

  it("exposes capabilities from the definition", async () => {
    const f = fixture();
    const a = adapter(f);
    const caps = await a.capabilities();
    expect(caps.kind).toBe("codex");
    expect(caps.recordsProviderModel).toBe(true);
    expect(caps.integrationNotes.some((n) => n.includes("MCP"))).toBe(true);
  });
});

describe("external harness definitions", () => {
  it("registers the four supported harnesses", () => {
    const kinds = EXTERNAL_HARNESS_DEFINITIONS.map((d) => d.kind).sort();
    expect(kinds).toEqual(["claude-code", "codex", "deepseek-harness", "opencode"]);
  });

  it("records that opencode does not attach artifacts while the others do", () => {
    const byKind = new Map(EXTERNAL_HARNESS_DEFINITIONS.map((d) => [d.kind, d]));
    expect(byKind.get("opencode")!.supportsArtifacts).toBe(false);
    expect(byKind.get("codex")!.supportsArtifacts).toBe(true);
    expect(byKind.get("claude-code")!.supportsArtifacts).toBe(true);
    expect(byKind.get("deepseek-harness")!.supportsArtifacts).toBe(true);
  });
});
