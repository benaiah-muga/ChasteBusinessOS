import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import type { AppConfig } from "@chaste/config";
import type { ChatMessage } from "@chaste/ui-schema";
import {
  CODING_AGENT_REGISTRY,
  type AgentProbeContext,
  type DetectedCodingAgent,
  detectedCodingAgents,
  selectUsableCodingAgent,
} from "./coding-agents.js";

/**
 * LLM provider abstraction.
 * Credentials always come from config (env/secret manager) — never from client.
 */
export interface CompletionRequest {
  system: string;
  /** Single-turn shortcut — used when no conversation history exists. */
  user?: string;
  /** Multi-turn conversation history. When provided, takes precedence over `user`. */
  messages?: ChatMessage[];
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface AiProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Hard wall on single-turn completions (chat clarification, workflow builder).
 * Remote NIM models can stall; without this the workspace hangs indefinitely.
 */
const AI_TIMEOUT_MS = 30_000;

export class NoneProvider implements AiProvider {
  readonly id = "none";
  async complete(): Promise<CompletionResult> {
    return {
      text: "",
      provider: "none",
      model: "rules",
    };
  }
}

/** OpenAI or OpenAI-compatible HTTP API (including some local gateways). */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
    id = "openai_compatible",
  ) {
    this.id = id;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const apiMessages = buildApiMessages(req);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: req.temperature ?? 0,
          messages: apiMessages,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`AI provider timed out after ${AI_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AI provider error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      provider: this.id,
      model: this.model,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
    };
  }
}

/** Local Ollama HTTP API (no API key required). */
export class OllamaProvider implements AiProvider {
  readonly id = "ollama";
  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const apiMessages = buildApiMessages(req);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: apiMessages,
          options: { num_predict: 1024 },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Ollama timed out after ${AI_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return {
      text: json.message?.content ?? "",
      provider: this.id,
      model: this.model,
    };
  }
}

/** Anthropic Messages API (Claude Code's model, reused directly). */
export class AnthropicMessagesProvider implements AiProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    baseUrl: string,
    id = "anthropic",
  ) {
    this.id = id;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  private readonly baseUrl: string;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          temperature: req.temperature ?? 0,
          system: req.system,
          messages: buildApiMessages(req).filter((m) => m.role !== "system"),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Anthropic provider timed out after ${AI_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic provider error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
    return {
      text,
      provider: this.id,
      model: this.model,
      usage: json.usage
        ? {
            promptTokens: json.usage.input_tokens,
            completionTokens: json.usage.output_tokens,
            totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }
}

/**
 * Converts CompletionRequest into OpenAI-format messages array.
 * When `messages` (history) is provided, converts them and prepends system.
 * Falls back to single-turn system + user.
 */
function buildApiMessages(req: CompletionRequest): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [];

  // System prompt always first
  msgs.push({ role: "system", content: req.system });

  if (req.messages && req.messages.length > 0) {
    // Multi-turn: convert ChatMessage[] to OpenAI format
    for (const msg of req.messages) {
      const textParts = msg.parts
        .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (textParts) {
        msgs.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: textParts,
        });
      }
    }
  } else if (req.user) {
    // Single-turn shortcut
    msgs.push({ role: "user", content: req.user });
  }

  return msgs;
}

/** Dependency injection seam for tests; defaults to the real host probe. */
export interface ProviderDeps {
  detectCodingAgents?: () => DetectedCodingAgent[];
  /** Probe context forwarded to agent resolution (for tests/containers). */
  agentContext?: AgentProbeContext & Record<string, unknown>;
}

export function createAiProvider(cfg: AppConfig["ai"], deps: ProviderDeps = {}): AiProvider {
  switch (cfg.provider) {
    case "none":
      return new NoneProvider();
    case "auto":
      return providerFromCodingAgent(selectAutoCodingAgent(cfg, deps), deps.agentContext);
    case "ollama":
      return new OllamaProvider(cfg.model, cfg.baseUrl ?? "http://127.0.0.1:11434");
    case "openai":
      if (!cfg.apiKey) return new NoneProvider();
      return new OpenAiCompatibleProvider(
        cfg.apiKey,
        cfg.model,
        cfg.baseUrl ?? "https://api.openai.com/v1",
        "openai",
      );
    case "openai_compatible":
      if (!cfg.apiKey) return new NoneProvider();
      return new OpenAiCompatibleProvider(
        cfg.apiKey,
        cfg.model,
        cfg.baseUrl ?? "http://127.0.0.1:8080/v1",
        "openai_compatible",
      );
    case "nvidia_nim": {
      const key = cfg.nvidiaApiKey ?? cfg.apiKey;
      if (!key) return new NoneProvider();
      return new OpenAiCompatibleProvider(
        key,
        cfg.model,
        cfg.nvidiaBaseUrl ?? "https://integrate.api.nvidia.com/v1",
        "nvidia_nim",
      );
    }
    default:
      return new NoneProvider();
  }
}

/**
 * Auto mode: pick the best usable coding agent and build a provider from its
 * own model/endpoint/credential. `prefer` names a specific agent id; without
 * it the registry order is used. Falls back to NoneProvider when nothing on
 * the host is reusable (never crashes boot).
 */
export function selectAutoCodingAgent(
  cfg: AppConfig["ai"],
  deps: ProviderDeps = {},
): DetectedCodingAgent | null {
  const agents = (deps.detectCodingAgents ?? detectedCodingAgents)();
  return selectUsableCodingAgent(agents, cfg.codingAgentPrefer ?? null);
}

/** Build an AiProvider for a detected agent (NoneProvider when unusable). */
export function providerFromCodingAgent(
  agent: DetectedCodingAgent | null,
  agentContext?: AgentProbeContext,
): AiProvider {
  if (!agent || !agent.hasApiKey || !agent.model) return new NoneProvider();
  // The raw key lives inside each agent's resolution; re-run resolve to get it.
  const entry = CODING_AGENT_REGISTRY.find((e) => e.id === agent.id);
  if (!entry) return new NoneProvider();
  const ctx: AgentProbeContext = agentContext ?? {
    home: os.homedir(),
    env: process.env,
    fileExists: existsSync,
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    bins: new Map([[agent.id, agent.binary]]),
  };
  const res = entry.resolve(ctx);
  if (!res.apiKey || !res.model || !res.baseUrl || !res.providerKind) return new NoneProvider();
  switch (res.providerKind) {
    case "anthropic":
      return new AnthropicMessagesProvider(res.apiKey, res.model, res.baseUrl, agent.id);
    case "gemini":
    case "openai_compatible":
      return new OpenAiCompatibleProvider(res.apiKey, res.model, res.baseUrl, agent.id);
    default:
      return new NoneProvider();
  }
}
