import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentSessions, codingAgentConnections, getDb, memberships } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry, resolveForOrg } from "@/server/kernel";
import { checkRateLimit } from "@/server/rate-limit";
import { verifyToolAccessToken } from "@/server/coding-agent-connections";
import { appendSessionEvent } from "@/server/session-events";

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

function rpcError(id: string | number | undefined, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function toolName(capabilityId: string): string {
  return capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function jsonText(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length <= 24_000 ? text : `${text.slice(0, 23_800)}… output shortened`;
  } catch {
    return "The capability completed, but its result could not be formatted.";
  }
}

export async function POST(req: Request) {
  const authorization = req.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const claims = verifyToolAccessToken(token);
  if (!claims) return rpcError(undefined, -32001, "Coding-agent access token is invalid or expired.", 401);

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return rpcError(undefined, -32700, "Invalid JSON-RPC request.", 400);
  const request = parsed.data;
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
    return new NextResponse(null, { status: 202 });
  }
  if (request.method === "ping") return NextResponse.json({ jsonrpc: "2.0", id: request.id ?? null, result: {} });
  if (request.method === "initialize") {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "chaste-businessos", version: "1.0.0" },
        instructions: "These tools are governed ChasteBusinessOS capabilities. Their organization data is scoped to the connected user; permission, policy, approval, ledger, and reversibility controls remain active.",
      },
    }, { headers: { "MCP-Protocol-Version": "2025-11-25" } });
  }

  const db = getDb().db;
  const [connection] = await db.select({ id: codingAgentConnections.id }).from(codingAgentConnections).where(and(
    eq(codingAgentConnections.id, claims.connectionId),
    eq(codingAgentConnections.orgId, claims.orgId),
    eq(codingAgentConnections.userId, claims.userId),
    eq(codingAgentConnections.status, "connected"),
  )).limit(1);
  if (!connection) return rpcError(request.id, -32001, "This coding-agent connection has been revoked.", 401);
  const [membership] = await db.select({ orgId: memberships.orgId }).from(memberships).where(and(
    eq(memberships.orgId, claims.orgId),
    eq(memberships.userId, claims.userId),
  )).limit(1);
  if (!membership) return rpcError(request.id, -32001, "The connected user no longer belongs to this workspace.", 401);
  if (claims.sessionId) {
    const [session] = await db.select({ id: agentSessions.id }).from(agentSessions).where(and(
      eq(agentSessions.id, claims.sessionId),
      eq(agentSessions.orgId, claims.orgId),
      eq(agentSessions.userId, claims.userId),
    )).limit(1);
    if (!session) return rpcError(request.id, -32001, "The assistant session is no longer available.", 401);
  }

  const resolved = await resolveForOrg(claims.userId, claims.orgId, db);
  const ctx = actorFromResolved(resolved, { asAgent: true, ...(claims.sessionId ? { sessionId: claims.sessionId } : {}) });
  if (!ctx) return rpcError(request.id, -32001, "The connected user is not available.", 401);
  const registry = buildRegistry(db).scopedToModules(
    resolved.enabledModules ? new Set(resolved.enabledModules) : null,
  );
  const capabilities = registry.forActor(ctx.actor).filter((capability) => claims.allowedTools.includes(toolName(capability.id)));
  const names = new Map<string, string>();
  for (const capability of capabilities) {
    const name = toolName(capability.id);
    if (names.has(name) && names.get(name) !== capability.id) {
      return rpcError(request.id, -32603, "Business tool names are ambiguous. Contact your workspace administrator.");
    }
    names.set(name, capability.id);
  }

  if (request.method === "tools/list") {
    const tools = capabilities.map((capability) => ({
      name: toolName(capability.id),
      title: capability.title,
      description: `[${capability.risk}] ${capability.title}. ${capability.intent}`,
      inputSchema: z.toJSONSchema(capability.input, { target: "draft-7" }),
    }));
    return NextResponse.json({ jsonrpc: "2.0", id: request.id ?? null, result: { tools } });
  }

  if (request.method !== "tools/call") return rpcError(request.id, -32601, "This Chaste tool bridge does not support that method.");
  const limit = checkRateLimit(`coding-tools:${claims.userId}:${claims.connectionId}`, { max: 180, windowMs: 60_000 });
  if (!limit.allowed) return rpcError(request.id, -32029, "Too many business-tool requests. Try again shortly.", 429);
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (typeof name !== "string") return rpcError(request.id, -32602, "A tool name is required.");
  const capabilityId = names.get(name);
  if (!capabilityId) {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: { isError: true, content: [{ type: "text", text: "That business action is not available to this user." }] },
    });
  }
  if (claims.sessionId) {
    await appendSessionEvent(db, claims.sessionId, "tool_call", { name: capabilityId, args });
  }
  const result = await buildExecutor(db, registry).execute(capabilityId, ctx, args);
  const output = result.ok
    ? result.data
    : { ok: false, error: result.error, pendingApproval: Boolean(result.pendingApproval) };
  if (claims.sessionId) {
    await appendSessionEvent(db, claims.sessionId, "tool_result", {
      name: capabilityId,
      ok: result.ok,
      pendingApproval: Boolean(result.pendingApproval),
      error: result.error,
    });
  }
  return NextResponse.json({
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: { isError: !result.ok && !result.pendingApproval, content: [{ type: "text", text: jsonText(output) }] },
  });
}
