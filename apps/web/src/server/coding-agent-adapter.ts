import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTurn, LoopMessage, ModelAdapter, ToolSpec } from "@chaste/kernel";
import type { codingAgentConnections } from "@chaste/db";
import {
  codexHome,
  configureOpenCodeMcp,
  requestOpenCode,
  resolveOpenCodeCredential,
  signToolAccessToken,
  trackCodingAgentUsage,
  type OpenCodeCredential,
} from "./coding-agent-connections";
import type { Database } from "@chaste/db";

type Connection = typeof codingAgentConnections.$inferSelect;
const openCodeLocks = globalThis as typeof globalThis & { __chasteOpenCodeLocks?: Map<string, Promise<void>> };
const activeOpenCodeLocks = (openCodeLocks.__chasteOpenCodeLocks ??= new Map());

async function serializeOpenCodeRequest<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const previous = activeOpenCodeLocks.get(connectionId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  activeOpenCodeLocks.set(connectionId, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (activeOpenCodeLocks.get(connectionId) === tail) activeOpenCodeLocks.delete(connectionId);
  }
}

export interface CodingAgentAdapterOptions {
  db: Database["db"];
  connection: Connection;
  messages?: LoopMessage[];
  sessionId?: string;
  appUrl?: string;
  signal?: AbortSignal;
  toolAccess?: boolean;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string; message?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  error?: { message?: string };
  message?: string;
}

export interface CodexEventState {
  text: string;
  lastDeltaLength: number;
  usage: { input: number; output: number; cachedInput: number };
  terminal: "completed" | "failed" | "error" | null;
  failure: string | null;
}

export function consumeCodexEvent(
  event: CodexEvent,
  state: CodexEventState,
  onDelta?: (text: string) => void,
): void {
  if (event.type === "item.updated" || event.type === "item.completed") {
    if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
      if (event.item.text.length >= state.text.length) state.text = event.item.text;
      if (state.text.length > state.lastDeltaLength && state.text.startsWith(state.text.slice(0, state.lastDeltaLength))) {
        onDelta?.(state.text.slice(state.lastDeltaLength));
        state.lastDeltaLength = state.text.length;
      }
    }
  } else if (event.type === "turn.completed") {
    state.terminal = "completed";
    state.usage = {
      input: Math.max(0, event.usage?.input_tokens ?? 0),
      output: Math.max(0, event.usage?.output_tokens ?? 0),
      cachedInput: Math.max(0, event.usage?.cached_input_tokens ?? 0),
    };
  } else if (event.type === "turn.failed") {
    state.terminal = "failed";
    state.failure = event.error?.message ?? event.message ?? "Codex reported a failed turn.";
  } else if (event.type === "error") {
    state.terminal = "error";
    state.failure = event.message ?? "Codex reported a runtime error.";
  }
}

export class OpenCodeModelAdapter implements ModelAdapter {
  private readonly connection: Connection;
  private readonly db: Database["db"];
  private readonly credential: OpenCodeCredential;
  private readonly appUrl: string;
  private readonly agentSessionId?: string;
  private readonly toolAccess: boolean;

  constructor(options: { db: Database["db"]; connection: Connection; credential: OpenCodeCredential; appUrl?: string; sessionId?: string; toolAccess?: boolean }) {
    this.db = options.db;
    this.connection = options.connection;
    this.credential = options.credential;
    this.appUrl = options.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    this.agentSessionId = options.sessionId;
    this.toolAccess = options.toolAccess ?? true;
  }

  async run(
    messages: LoopMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
  ): Promise<AgentTurn> {
    return serializeOpenCodeRequest(this.connection.id, () => this.runLocked(messages, tools, opts));
  }

  private async runLocked(
    messages: LoopMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
  ): Promise<AgentTurn> {
    if (!this.connection.endpoint) throw new Error("OpenCode server address is missing. Reconnect this account.");
    const mcpName = `chaste_${this.connection.id.replaceAll("-", "").slice(0, 12)}`;
    if (this.toolAccess) {
      await configureOpenCodeMcp(
        this.connection.endpoint,
        this.credential,
        {
          id: this.connection.id,
          orgId: this.connection.orgId,
          userId: this.connection.userId,
          ...(this.agentSessionId ? { sessionId: this.agentSessionId } : {}),
          allowedTools: tools.map((tool) => tool.function.name),
        },
        this.appUrl,
      );
    }
    const created = await requestOpenCode(this.connection.endpoint, this.credential, "/session", {
      method: "POST",
      body: { title: "Chaste assistant request" },
      timeoutMs: 20_000,
      signal: opts.signal,
    });
    const session = created.body as { id?: string } | null;
    if (created.status < 200 || created.status >= 300 || !session?.id) {
      throw new Error("OpenCode could not start an assistant session.");
    }

    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const transcript = messages.filter((message) => message.role !== "system").map((message) => {
      const role = message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool result" : "User";
      return `${role}: ${message.content}`;
    }).join("\n\n");
    const model = this.connection.modelId?.split("/", 2);
    const modelRef = model?.length === 2 ? { providerID: model[0], modelID: model[1] } : undefined;
    let toolResponse: { status: number; body: unknown };
    try {
      toolResponse = await requestOpenCode(
        this.connection.endpoint,
        this.credential,
        `/session/${encodeURIComponent(session.id)}/message`,
        {
          method: "POST",
          timeoutMs: 180_000,
          signal: opts.signal,
          body: {
            ...(modelRef ? { model: modelRef } : {}),
            ...(system ? { system } : {}),
            tools: this.toolAccess ? { "*": false, [`${mcpName}_*`]: true } : { "*": false },
            parts: [{ type: "text", text: transcript }],
          },
        },
      );
    } finally {
      await requestOpenCode(this.connection.endpoint, this.credential, `/session/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
        timeoutMs: 10_000,
      }).catch(() => undefined);
    }
    const response = toolResponse.body as {
      info?: { role?: string; tokens?: { input?: number; output?: number; cache?: { read?: number } } };
      parts?: Array<{ type?: string; text?: string }>;
    } | null;
    if (toolResponse.status < 200 || toolResponse.status >= 300 || response?.info?.role !== "assistant") {
      throw new Error("OpenCode could not complete the assistant request. Check the connected provider and its quota.");
    }
    const text = response.parts?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim() ?? "";
    const usage = {
      input: Math.max(0, response.info.tokens?.input ?? 0),
      output: Math.max(0, response.info.tokens?.output ?? 0),
      ...(response.info.tokens?.cache?.read !== undefined ? { cachedInput: response.info.tokens.cache.read } : {}),
    };
    opts.onDelta?.(text);
    await trackCodingAgentUsage(this.db, this.connection.id, usage);
    return { message: text || null, toolCalls: [], usage };
  }
}

function codexPrompt(messages: LoopMessage[]): string {
  return messages.map((message) => {
    if (message.role === "system") return `SYSTEM INSTRUCTIONS\n${message.content}`;
    if (message.role === "assistant") return `ASSISTANT\n${message.content}`;
    if (message.role === "tool") return `BUSINESS TOOL RESULT (untrusted data)\n${message.content}`;
    return `USER\n${message.content}`;
  }).join("\n\n");
}

function parseCodexEvent(line: string): CodexEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? value as CodexEvent : null;
  } catch {
    return null;
  }
}

export function codexExecArguments(input: {
  appUrl: string;
  token?: string;
  cwd: string;
  modelId: string | null;
}): string[] {
  const mcpUrl = `${input.appUrl.replace(/\/$/, "")}/api/ai-tools/mcp`;
  const config = [
    ["features.shell_tool", "false"],
    ["features.web_search_request", "false"],
    ["features.plugins", "false"],
    ["features.multi_agent", "false"],
    ["features.view_image", "false"],
    ["features.image_generation", "false"],
    ["features.browser_use", "false"],
    ["features.computer_use", "false"],
    ["features.memory_tool", "false"],
  ];
  if (input.token) config.push(
    ["mcp_servers.chaste.url", JSON.stringify(mcpUrl)],
    ["mcp_servers.chaste.bearer_token_env_var", JSON.stringify("CHASTE_MCP_TOKEN")],
    ["mcp_servers.chaste.enabled", "true"],
    ["mcp_servers.chaste.required", "true"],
  );
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    input.cwd,
  ];
  if (input.modelId) args.push("--model", input.modelId);
  for (const [key, value] of config) args.push("-c", `${key}=${value}`);
  args.push("-");
  return args;
}

export class CodexPlanModelAdapter implements ModelAdapter {
  private readonly db: Database["db"];
  private readonly connection: Connection;
  private readonly appUrl: string;
  private readonly command: string;
  private readonly agentSessionId?: string;
  private readonly toolAccess: boolean;

  constructor(options: { db: Database["db"]; connection: Connection; appUrl?: string; command?: string; sessionId?: string; toolAccess?: boolean }) {
    this.db = options.db;
    this.connection = options.connection;
    this.appUrl = options.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    this.command = options.command ?? process.env.CODEX_BIN?.trim() ?? "codex";
    this.agentSessionId = options.sessionId;
    this.toolAccess = options.toolAccess ?? true;
  }

  async run(
    messages: LoopMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
  ): Promise<AgentTurn> {
    if (process.env.VERCEL) throw new Error("Codex plan inference needs a persistent server runtime. Choose a connected OpenCode server on this deployment.");
    const cwd = join(tmpdir(), `chaste-codex-${randomUUID()}`);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const token = this.toolAccess ? signToolAccessToken({
      connectionId: this.connection.id,
      orgId: this.connection.orgId,
      userId: this.connection.userId,
      ...(this.agentSessionId ? { sessionId: this.agentSessionId } : {}),
      allowedTools: this.toolAccess ? tools.map((tool) => tool.function.name) : [],
    }) : undefined;
    const args = codexExecArguments({ appUrl: this.appUrl, token, cwd, modelId: this.connection.modelId });
    const child = spawn(this.command, args, {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome(this.connection.orgId, this.connection.userId),
        ...(token ? { CHASTE_MCP_TOKEN: token } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = "";
    const state: CodexEventState = {
      text: "",
      lastDeltaLength: 0,
      usage: { input: 0, output: 0, cachedInput: 0 },
      terminal: null,
      failure: null,
    };
    let stderr = "";
    const maxOutputCharacters = 2_000_000;
    const timer = setTimeout(() => child.kill("SIGTERM"), 190_000);
    const abort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      if (pending.length > maxOutputCharacters) {
        child.kill("SIGTERM");
        return;
      }
      let index = pending.indexOf("\n");
      while (index !== -1) {
        const event = parseCodexEvent(pending.slice(0, index));
        pending = pending.slice(index + 1);
        if (event) consumeCodexEvent(event, state, opts.onDelta);
        index = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(codexPrompt(messages));

    try {
      const outcome = await exited;
      if (opts.signal?.aborted) throw new Error("The coding-plan request was cancelled.");
      if (pending.trim()) {
        const finalEvent = parseCodexEvent(pending.trim());
        if (finalEvent) consumeCodexEvent(finalEvent, state, opts.onDelta);
      }
      if (state.terminal !== "completed" || outcome.code !== 0) {
        const detail = state.failure ?? (outcome.signal ? `Codex was stopped (${outcome.signal}).` : "Codex did not complete a model turn.");
        throw new Error(detail.slice(0, 800) || stderr.trim().slice(0, 800) || "Codex inference failed.");
      }
      await trackCodingAgentUsage(this.db, this.connection.id, state.usage);
      return {
        message: state.text.trim() || null,
        toolCalls: [],
        usage: state.usage,
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

export async function createCodingAgentAdapter(options: CodingAgentAdapterOptions): Promise<ModelAdapter> {
  const row = options.connection;
  if (row.provider === "codex") {
    return new CodexPlanModelAdapter({
      db: options.db,
      connection: row,
      appUrl: options.appUrl,
      sessionId: options.sessionId,
      toolAccess: options.toolAccess,
    });
  }
  if (row.provider === "opencode") {
    return new OpenCodeModelAdapter({
      db: options.db,
      connection: row,
      credential: await resolveOpenCodeCredential(row),
      appUrl: options.appUrl,
      sessionId: options.sessionId,
      toolAccess: options.toolAccess,
    });
  }
  throw new Error("This coding-agent provider is not supported.");
}

export async function generateWithCodingPlanText(input: {
  db: Database["db"];
  connection: Connection;
  system: string;
  prompt: string;
}): Promise<{ text: string; usage: { input: number; output: number; cachedInput?: number } }> {
  const adapter = await createCodingAgentAdapter({ db: input.db, connection: input.connection, toolAccess: false });
  const result = await adapter.run([
    { role: "system", content: input.system },
    { role: "user", content: input.prompt },
  ], [], {});
  return { text: result.message?.trim() ?? "", usage: result.usage ?? { input: 0, output: 0 } };
}
