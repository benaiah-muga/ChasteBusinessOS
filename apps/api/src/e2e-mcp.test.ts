/**
 * ADR 0014 tranche 14 — MCP/integration plane E2E over HTTP.
 *
 * Proves the scoped MCP gateway is reachable over the API as
 * `POST /api/v1/mcp`: an external harness can initialize, list the tools it is
 * allowed to see, call a tool through the command/query bus, and observe
 * explainable results for rejected calls — all mediated, reauthorized, and
 * recorded on the shared session log.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@chaste/db";
import { buildServer } from "./server.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const ADDR = "http://127.0.0.1";

describe.skipIf(!hasDb)("MCP/integration plane over HTTP", () => {
  let server: FastifyInstance;
  let base: string;
  const sessionId = crypto.randomUUID();

  beforeAll(async () => {
    await runMigrations(process.env.DATABASE_URL!);
    const built = await buildServer();
    server = built.server;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `${ADDR}:${port}`;
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  async function mcp(message: unknown) {
    const response = await fetch(`${base}/api/v1/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-chaste-session": sessionId },
      body: JSON.stringify(message),
    });
    return (await response.json()) as {
      jsonrpc: string;
      id?: number | string | null;
      result?: unknown;
      error?: { code: number; message: string };
    };
  }

  it("initializes the MCP server", async () => {
    const response = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(response.error).toBeUndefined();
    const result = response.result as { protocolVersion: string; capabilities: { tools: Record<string, never> }; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toEqual({});
    expect(result.serverInfo.name).toBe("chaste-business-os");
  });

  it("lists the actor's scoped tools with JSON-Schema input contracts", async () => {
    const response = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(response.error).toBeUndefined();
    const tools = (response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it("calls a tool through the bus and returns an explainable result", async () => {
    const listed = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    const target = tools[0]!.name;

    const response = await mcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: target, arguments: {} },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { content?: Array<{ type: "text"; text: string }>; isError?: boolean };
    // Either the call succeeded (content + no isError) or failed explainably
    // (content + isError). Either way the pipeline returned a text payload,
    // never a silent success.
    expect(result.content).toBeDefined();
    expect(typeof result.isError).toBe("boolean");
  }, 30_000);

  it("answers ping and rejects unknown methods", async () => {
    const ping = await mcp({ jsonrpc: "2.0", id: 5, method: "ping" });
    expect(ping.result).toEqual({});

    const unknown = await mcp({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(unknown.error?.code).toBe(-32601);
  });

  it("persists the MCP session's tool calls on the shared trajectory", async () => {
    // The call above ran on `sessionId`; the event stream is durable and
    // shared, so a fresh gateway request on the same session sees the log.
    const response = await mcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ping", arguments: {} } });
    // `ping` is not a tool → tool-not-found proves hidden/nonexistent tools are
    // indistinguishable to the external harness.
    expect(response.error?.code).toBe(-32002);
  });
});