/**
 * ADR 0014 tranche 15 — external harness adapters over HTTP (build item 16).
 *
 * Proves the four harness adapters (Codex, Claude Code, opencode, DeepSeek
 * Harness) are reachable over the API: their capabilities are listed, a run is
 * bound to the authenticated actor and recorded on the Chaste trajectory
 * (`externalHarness/*`), tool calls are mediated by the MCP gateway (never
 * bypassing the bus), runs resume by `runId` from the trajectory, and
 * provider/model usage is captured when the harness exposes it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@chaste/db";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const ADDR = "http://127.0.0.1";

describe.skipIf(!hasDb)("External harness adapters HTTP surface", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;

  beforeAll(async () => {
    await runMigrations(process.env.DATABASE_URL!);
    const built = await buildServer();
    server = built.server;
    app = built.app;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `${ADDR}:${port}`;
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  async function startRun(
    kind: string,
    body: Record<string, unknown>,
  ): Promise<{
    runId: string;
    status: string;
    usageVisibility: string;
    toolOutcomes: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>;
    summary: string;
  }> {
    const response = await fetch(`${base}/api/v1/harness-adapters/${kind}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Awaited<ReturnType<typeof startRun>>;
  }

  async function postTurn(
    kind: string,
    runId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: string; usageVisibility: string; summary: string }> {
    const response = await fetch(`${base}/api/v1/harness-adapters/${kind}/runs/${runId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Awaited<ReturnType<typeof postTurn>>;
  }

  it("lists the four supported harness adapters with capabilities", async () => {
    const response = (await fetch(`${base}/api/v1/harness-adapters`).then((r) => r.json())) as {
      items: Array<{ id: string; kind: string; capabilities: { connector: string; integrationNotes: string[] } }>;
    };
    const kinds = response.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["claude-code", "codex", "deepseek-harness", "opencode"]);
    expect(response.items[0]!.capabilities.connector).toBeTruthy();
    expect(response.items[0]!.capabilities.integrationNotes.length).toBeGreaterThan(0);
  });

  it("starts a run, records externalHarness/* events, and mediates a tool call through the bus", async () => {
    const run = await startRun("codex", {
      objective: "List the roles the org has",
      allowedTools: [{ tool: "core_rbac_overview" }],
      forbiddenDataClasses: ["personal_data"],
      turn: {
        role: "assistant",
        content: "Let me check the roles.",
        toolCalls: [{ tool: "core_rbac_overview", args: {}, toolCallId: "tc-1" }],
      },
    });
    expect(run.runId).toBeTruthy();
    expect(run.toolOutcomes).toHaveLength(1);
    expect(run.toolOutcomes[0]!.ok).toBe(true);
    expect(run.toolOutcomes[0]!.summary).toContain("roles");

    const events = await app.sessionLog.list(run.runId);
    const types = events.map((e) => e.type);
    expect(types).toContain("externalHarness/session-start");
    expect(types).toContain("externalHarness/turn");
    expect(types).toContain("externalHarness/tool-call");
    expect(types).toContain("externalHarness/tool-result");
    // The tool call went through the bus, so the query dispatch is on the log.
    expect(types).toContain("query/dispatched");
    const start = events.find((e) => e.type === "externalHarness/session-start");
    expect((start!.payload as { harnessKind: string }).harnessKind).toBe("codex");
  }, 30_000);

  it("records usage as unknown when the harness hides provider/model, and recorded when exposed", async () => {
    const hidden = await startRun("opencode", {
      objective: "A bare task without model attribution",
    });
    expect(hidden.usageVisibility).toBe("unknown");

    const exposed = await startRun("codex", {
      objective: "A task with model attribution",
      turn: {
        role: "assistant",
        content: "Finished.",
        provider: "openai",
        model: "gpt-5",
        usage: { promptTokens: 50, completionTokens: 20, costCents: 1 },
      },
    });
    expect(exposed.usageVisibility).toBe("recorded");
  });

  it("resumes a run by runId from the trajectory and collects its result", async () => {
    const run = await startRun("codex", {
      objective: "Draft a technical note",
    });
    const resumed = await postTurn("codex", run.runId, {
      role: "assistant",
      content: "Draft attached.",
      provider: "openai",
      model: "gpt-5",
      artifacts: [{ ref: "s3://codex/draft.md", summary: "Draft note" }],
      endSession: true,
    });
    expect(resumed.status).toBe("succeeded");
    expect(resumed.usageVisibility).toBe("recorded");

    const collected = (await fetch(
      `${base}/api/v1/harness-adapters/codex/runs/${run.runId}`,
    ).then((r) => r.json())) as {
      status: string;
      traceRef: string;
      artifacts: Array<{ ref: string }>;
      modelUsage: Array<{ model?: string }>;
      usageVisibility: string;
    };
    expect(collected.status).toBe("succeeded");
    expect(collected.traceRef).toBe(run.runId);
    expect(collected.artifacts.map((a) => a.ref)).toContain("s3://codex/draft.md");
    expect(collected.modelUsage[0]!.model).toBe("gpt-5");
    expect(collected.usageVisibility).toBe("recorded");
  }, 30_000);

  it("refuses tools outside allowedTools and dispatches nothing", async () => {
    const run = await startRun("codex", {
      objective: "Attempt a tool outside the grant",
      turn: {
        role: "assistant",
        content: "Trying the disallowed tool.",
        toolCalls: [{ tool: "core_rbac_overview", args: {}, toolCallId: "tc-x" }],
      },
    });
    expect(run.toolOutcomes[0]!.ok).toBe(false);
    expect(run.toolOutcomes[0]!.error).toContain("not in allowedTools");

    const events = await app.sessionLog.list(run.runId);
    expect(events.some((e) => e.type === "query/dispatched")).toBe(false);
    expect(events.some((e) => e.type === "externalHarness/tool-result")).toBe(true);
  }, 30_000);
});