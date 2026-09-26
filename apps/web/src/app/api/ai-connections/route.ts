import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { chooseDefaultCodingAgent, connectOpenCode, disconnectCodingAgent, listUserCodingAgentConnections, pollCodexDeviceLogin, probeCodex, startCodexDeviceLogin } from "@/server/coding-agent-connections";
import { getResolvedUser } from "@/server/session";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("connect_opencode"),
    endpoint: z.string().min(1).max(500),
    username: z.string().trim().max(100).default("opencode"),
    password: z.string().min(1).max(1000),
    modelId: z.string().trim().max(200).optional(),
    makeDefault: z.boolean().optional(),
  }),
  z.object({ action: z.literal("start_codex_login") }),
  z.object({ action: z.literal("poll_codex_login"), makeDefault: z.boolean().optional() }),
  z.object({ action: z.literal("set_default"), connectionId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("disconnect"), provider: z.enum(["codex", "opencode"]) }),
]);

function privateJson(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return privateJson({ error: "unauthorized" }, { status: 401 });
  const [connections, codex] = await Promise.all([
    listUserCodingAgentConnections(getDb().db, resolved.orgId, resolved.userId),
    Promise.resolve(probeCodex()),
  ]);
  return privateJson({ connections, codexRuntime: { available: codex.available, version: codex.version } });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return privateJson({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return privateJson({ error: "invalid coding-agent connection request" }, { status: 400 });
  const db = getDb().db;
  const owner = { orgId: resolved.orgId, userId: resolved.userId };

  try {
    switch (parsed.data.action) {
      case "connect_opencode": {
        const connection = await connectOpenCode(db, { ...owner, ...parsed.data });
        return privateJson({ ok: true, connection });
      }
      case "start_codex_login": {
        const login = await startCodexDeviceLogin(owner);
        return privateJson({ ok: true, login });
      }
      case "poll_codex_login": {
        const login = await pollCodexDeviceLogin(db, { ...owner, makeDefault: parsed.data.makeDefault });
        return privateJson({ ok: true, login });
      }
      case "set_default": {
        await chooseDefaultCodingAgent(db, resolved.orgId, resolved.userId, parsed.data.connectionId);
        return privateJson({ ok: true, connections: await listUserCodingAgentConnections(db, resolved.orgId, resolved.userId) });
      }
      case "disconnect": {
        await disconnectCodingAgent(db, resolved.orgId, resolved.userId, parsed.data.provider);
        return privateJson({ ok: true, connections: await listUserCodingAgentConnections(db, resolved.orgId, resolved.userId) });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update this connection.";
    return privateJson({ error: message.slice(0, 500) }, { status: 422 });
  }
}
