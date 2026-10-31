import { z } from "zod";

const AgentConnectionSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(["opencode", "codex"]),
  endpoint: z.string().nullable(),
  modelId: z.string().nullable(),
  status: z.string().min(1),
  isDefault: z.boolean(),
  runCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
  connectedAt: z.string(),
}).strict();

const ListSchema = z.object({
  connections: z.array(AgentConnectionSchema),
  codexRuntime: z.object({ available: z.boolean(), version: z.string().nullable() }).strict().optional(),
}).strict();

export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
export type AgentConnections = z.infer<typeof ListSchema>;

export class AgentConnectionsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AgentConnectionsError";
  }
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
    signal: AbortSignal.timeout(25_000),
    ...init,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.string().optional(), message: z.string().optional() }).passthrough().safeParse(body);
    const message = parsed.success ? parsed.data.error ?? parsed.data.message : undefined;
    throw new AgentConnectionsError(response.status, message ?? "The coding agent service did not accept that request.");
  }
  return body;
}

export async function fetchAgentConnections(signal?: AbortSignal): Promise<AgentConnections> {
  const response = await fetch("/api/ai-connections", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AgentConnectionsError(response.status, response.status === 403 ? "You do not have permission to manage coding agent connections." : "Could not load coding agent connections.");
  const parsed = ListSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AgentConnectionsError(response.status, "The coding agent service returned an unexpected response.");
  return parsed.data;
}

export async function connectOpenCode(input: { endpoint: string; username?: string; password: string; modelId?: string; makeDefault?: boolean }): Promise<AgentConnection> {
  const body = await call("/api/ai-connections", {
    method: "POST",
    body: JSON.stringify({ action: "connect_opencode", ...input }),
  });
  const parsed = z.object({ ok: z.literal(true), connection: AgentConnectionSchema }).safeParse(body);
  if (!parsed.success) throw new AgentConnectionsError(200, "OpenCode connected, but the connection details could not be read.");
  return parsed.data.connection;
}

export async function setDefaultAgentConnection(connectionId: string | null): Promise<void> {
  await call("/api/ai-connections", { method: "POST", body: JSON.stringify({ action: "set_default", connectionId }) });
}

export async function disconnectAgent(provider: "opencode" | "codex"): Promise<void> {
  await call("/api/ai-connections", { method: "POST", body: JSON.stringify({ action: "disconnect", provider }) });
}
