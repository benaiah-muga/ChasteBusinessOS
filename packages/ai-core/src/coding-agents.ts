/**
 * Coding-agent auto-detection.
 *
 * Chaste runs in-process with the operator's tools. If a supported coding
 * agent (Claude Code, Codex, OpenCode, Gemini CLI, Cline, Antigravity, Pi,
 * Grok, …) is already installed and authenticated on the host, we can reuse
 * its model + endpoint + credential as an `AiProvider` instead of forcing a
 * separate CHASTE_AI_PROVIDER/API-key setup.
 *
 * Design rules:
 * - Detection is a *probe*, never a guarantee: every result carries a
 *   `detail` reason and the secret value is never exposed (`hasApiKey` only).
 * - A coding agent never gains elevated platform privileges; it is just a
 *   completion backend behind the same command/query bus as any provider.
 * - The operator opts in via `provider: "auto"`; stock installs stay "none".
 * - Reads are synchronous and probes run at most once per process (the API
 *   and worker boot once, so a blocking PATH/config read is acceptable).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** How completions from this agent's model are reached. */
export type CodingAgentKind = "openai_compatible" | "anthropic" | "gemini";

export interface DetectedCodingAgent {
  id: string;
  displayName: string;
  /** Resolved binary path (env override, then PATH lookup). */
  binary: string | null;
  installed: boolean;
  version: string | null;
  /** Null when installed but the credential can't be reused as an API key. */
  providerKind: CodingAgentKind | null;
  model: string | null;
  baseUrl: string | null;
  /** True when a usable key was resolved. The value itself is never kept. */
  hasApiKey: boolean;
  /** Human-readable status / limitation (safe to log). */
  detail: string;
}

export interface CodingAgentRegistryEntry {
  id: string;
  displayName: string;
  binary: string[];
  /** Returns true/desc when a URL+model+key combo can be constructed. */
  resolve: (ctx: AgentProbeContext) => AgentResolution;
}

export interface AgentProbeContext {
  home: string;
  env: NodeJS.ProcessEnv;
  fileExists: (p: string) => boolean;
  readFile: (p: string) => string | null;
  bins: Map<string, string | null>;
}

export interface AgentResolution {
  providerKind: CodingAgentKind | null;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  detail: string;
}

/**
 * Known agents, in preference order when `prefer` is not set.
 * Only agents whose auth is API-key-reusable produce a provider; OAuth-only
 * agents (Cursor, Copilot, Devin, …) are still reported as installed so the
 * self-dev handoff knows they exist.
 */
export const CODING_AGENT_REGISTRY: CodingAgentRegistryEntry[] = [
  claudeCodeEntry(),
  codexEntry(),
  opencodeEntry(),
  geminiEntry(),
  grokEntry(),
  clineEntry(),
  cursorEntry(),
  copilotEntry(),
  qwenEntry(),
  aiderEntry(),
  piEntry(),
  antigravityEntry(),
  gooseEntry(),
  rooCodeEntry(),
  kilocodeEntry(),
  kimiEntry(),
  ampEntry(),
  droidEntry(),
  minimaxEntry(),
  mistralEntry(),
  codyEntry(),
  windsurfEntry(),
  hermesEntry(),
  auggieEntry(),
  openclawEntry(),
  devinEntry(),
  continueEntry(),
];

/**
 * Simple agents that hold their own API key in the environment — no config
 * file parsing required (MiniMax, Mistral, Kimi, Grok, Qwen, …).
 */
function apiKeyCodingAgent(def: {
  id: string;
  displayName: string;
  binary: string[];
  keyEnv: string[];
  baseUrl: string;
  modelEnv: string[];
  defaultModel: string;
  kind: CodingAgentKind;
}): CodingAgentRegistryEntry {
  return {
    id: def.id,
    displayName: def.displayName,
    binary: def.binary,
    resolve(ctx) {
      const env = ctx.env;
      const apiKey = def.keyEnv.map((k) => env[k]).find(Boolean) ?? null;
      const model = def.modelEnv.map((k) => env[k]).find(Boolean) ?? def.defaultModel;
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl: def.baseUrl,
          apiKey: null,
          detail: `installed; set ${def.keyEnv.join(" or ")} to reuse`,
        };
      }
      return {
        providerKind: def.kind,
        model,
        baseUrl: def.baseUrl,
        apiKey,
        detail: `reusing ${def.displayName} via ${def.kind}`,
      };
    },
  };
}

/** Reuses whichever of the common provider keys the agent already consumes. */
function reuseKeysCodingAgent(def: {
  id: string;
  displayName: string;
  binary: string[];
  modelEnv: string[];
  defaultModels?: { anthropic: string; openai: string };
}): CodingAgentRegistryEntry {
  return {
    id: def.id,
    displayName: def.displayName,
    binary: def.binary,
    resolve(ctx) {
      const env = ctx.env;
      const anthropicKey = env.ANTHROPIC_API_KEY ?? null;
      const openaiKey = env.OPENAI_API_KEY ?? null;
      const openrouterKey = env.OPENROUTER_API_KEY ?? null;
      const apiKey = anthropicKey ?? openaiKey ?? openrouterKey;
      const defaults =
        def.defaultModels ?? { anthropic: "claude-sonnet-4-5-20250929", openai: "gpt-5.1" };
      const kind: CodingAgentKind | null = anthropicKey
        ? "anthropic"
        : openaiKey || openrouterKey
          ? "openai_compatible"
          : null;
      const baseUrl = anthropicKey
        ? (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
        : openaiKey
          ? "https://api.openai.com/v1"
          : openrouterKey
            ? "https://openrouter.ai/api/v1"
            : null;
      const model =
        def.modelEnv.map((k) => env[k]).find(Boolean) ??
        (anthropicKey ? defaults.anthropic : openaiKey ? defaults.openai : null);
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl,
          apiKey: null,
          detail: `installed; set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY to reuse`,
        };
      }
      return {
        providerKind: kind,
        model,
        baseUrl,
        apiKey,
        detail: `reusing the API key ${def.displayName} is configured with`,
      };
    },
  };
}

/** Installed-on-PATH accounting for OAuth/subscription agents (no API key). */
function installedOnlyCodingAgent(def: {
  id: string;
  displayName: string;
  binary: string[];
  detail: string;
}): CodingAgentRegistryEntry {
  return {
    id: def.id,
    displayName: def.displayName,
    binary: def.binary,
    resolve() {
      return {
        providerKind: null,
        model: null,
        baseUrl: null,
        apiKey: null,
        detail: def.detail,
      };
    },
  };
}

function claudeCodeEntry(): CodingAgentRegistryEntry {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    binary: ["claude"],
    resolve(ctx) {
      const env = ctx.env;
      const settingsPath = path.join(ctx.home, ".claude", "settings.json");
      const settings = ctx.fileExists(settingsPath) ? parseJsonObject(ctx.readFile(settingsPath)) : {};
      // settings.json may carry {"env": {...}, "model": "..."} overrides.
      const model =
        (typeof settings.model === "string" && settings.model) ||
        env.CHASTE_CODING_AGENT_CLAUDE_MODEL ||
        "claude-sonnet-4-5-20250929";
      const baseUrl = env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
      // Token path is the Buzz-style gateway override; standard API key next.
      const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? env.CHASTE_CODING_AGENT_ANTHROPIC_KEY ?? null;
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl,
          apiKey: null,
          detail: "installed; set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL for a gateway) to reuse",
        };
      }
      return {
        providerKind: "anthropic" as const,
        model,
        baseUrl,
        apiKey,
        detail: "reusing Claude Code model via Anthropic Messages API",
      };
    },
  };
}

function codexEntry(): CodingAgentRegistryEntry {
  return {
    id: "codex",
    displayName: "Codex CLI",
    binary: ["codex"],
    resolve(ctx) {
      const env = ctx.env;
      const baseDir = path.join(ctx.home, ".codex");
      const auth = ctx.fileExists(path.join(baseDir, "auth.json"))
        ? parseJsonObject(ctx.readFile(path.join(baseDir, "auth.json")))
        : {};
      const apiKey =
        (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) ||
        env.OPENAI_API_KEY ||
        env.CHASTE_CODING_AGENT_CODE_KEY ||
        null;
      const { modelProvider, model, wireApi, providers } = parseCodexConfig(
        ctx.fileExists(path.join(baseDir, "config.toml"))
          ? ctx.readFile(path.join(baseDir, "config.toml"))
          : null,
      );
      const chosenModel = env.CHASTE_CODING_AGENT_CODE_MODEL ?? model ?? "gpt-5.3-codex";
      const name = modelProvider ?? "openai";
      const custom = providers[name] ?? {};
      const baseUrl = env.CODEX_API_BASE_URL ?? custom.baseUrl ?? "https://api.openai.com/v1";
      const wire = env.CODEX_WIRE_API ?? custom.wireApi ?? wireApi ?? "chat";
      if (!apiKey) {
        return {
          providerKind: null,
          model: chosenModel,
          baseUrl,
          apiKey: null,
          detail: "installed; ~/.codex/auth.json or OPENAI_API_KEY missing",
        };
      }
      if (wire !== "chat" && wire !== "responses") {
        return {
          providerKind: null,
          model: chosenModel,
          baseUrl,
          apiKey: null,
          detail: `installed; unsupported wire_api "${wire}" — set CODEX_WIRE_API=chat`,
        };
      }
      return {
        providerKind: "openai_compatible" as const,
        model: chosenModel,
        baseUrl,
        apiKey,
        detail: wire === "responses" ? "Codex wired to Responses API; chat completions used for this layer" : "reusing Codex model via OpenAI-compatible API",
      };
    },
  };
}

function opencodeEntry(): CodingAgentRegistryEntry {
  return {
    id: "opencode",
    displayName: "OpenCode",
    binary: ["opencode"],
    resolve(ctx) {
      const env = ctx.env;
      const configDir = env.OPENCODE_CONFIG_DIR ?? path.join(ctx.home, ".config", "opencode");
      const configPath = [path.join(configDir, "opencode.json"), path.join(configDir, "opencode.jsonc")].find(
        (p) => ctx.fileExists(p),
      );
      const authPath = env.OPENCODE_AUTH_PATH ?? path.join(ctx.home, ".local", "share", "opencode", "auth.json");
      const config = configPath ? parseOpenCodeConfig(ctx.readFile(configPath)) : null;
      const auth = ctx.fileExists(authPath) ? parseJsonObject(ctx.readFile(authPath)) : {};

      const model =
        env.CHASTE_CODING_AGENT_OPENCODE_MODEL ??
        config?.buildModel ??
        config?.model ??
        env.OPENCODE_MODEL ??
        null;
      if (!config || !model) {
        return {
          providerKind: null,
          model: null,
          baseUrl: null,
          apiKey: null,
          detail: configPath ? "installed; no model in opencode config" : "installed; opencode config not found",
        };
      }
      // Model ids look like "provider/model" — resolve provider metadata.
      const [providerName, providerModel] = splitModel(model);
      const prov = providerName ? config.providers[providerName] : undefined;
      const authKeyValue = providerName
        ? ((auth[providerName] as { key?: unknown } | undefined)?.key)
        : undefined;
      const authKey = typeof authKeyValue === "string" ? authKeyValue : null;
      const apiKey = authKey ?? env.CHASTE_CODING_AGENT_OPENCODE_KEY ?? null;
      const kind: CodingAgentKind | null = providerKindFor(prov?.npm);
      const baseUrl = prov?.baseURL ?? (providerName ? defaultBaseFor(providerName) : null);
      const modelId = providerModel ?? model;
      if (!providerName || !prov) {
        return {
          providerKind: null,
          model: modelId,
          baseUrl,
          apiKey: null,
          detail: `installed; provider metadata for "${providerName ?? "unknown"}" not found in opencode config`,
        };
      }
      if (!apiKey) {
        return {
          providerKind: kind,
          model: modelId,
          baseUrl,
          apiKey: null,
          detail: `installed; opencode auth for provider "${providerName}" missing`,
        };
      }
      if (!kind) {
        return {
          providerKind: null,
          model: modelId,
          baseUrl,
          apiKey: null,
          detail: `installed; provider "${providerName}" is not API-key-reusable via this layer`,
        };
      }
      return {
        providerKind: kind,
        model: modelId,
        baseUrl,
        apiKey,
        detail: `reusing OpenCode's "${providerName}" model`,
      };
    },
  };
}

function geminiEntry(): CodingAgentRegistryEntry {
  return {
    id: "gemini",
    displayName: "Gemini CLI",
    binary: ["gemini"],
    resolve(ctx) {
      const env = ctx.env;
      const apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? env.CHASTE_CODING_AGENT_GEMINI_KEY ?? null;
      const model = env.CHASTE_CODING_AGENT_GEMINI_MODEL ?? env.GEMINI_MODEL ?? "gemini-2.5-pro";
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiKey: null,
          detail: "installed; set GEMINI_API_KEY to reuse (Gemini CLI OAuth login is not an API key)",
        };
      }
      return {
        providerKind: "gemini" as const,
        model,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey,
        detail: "reusing Gemini model via OpenAI-compatible endpoint",
      };
    },
  };
}

function grokEntry(): CodingAgentRegistryEntry {
  return {
    id: "grok",
    displayName: "Grok Build",
    binary: ["grok"],
    resolve(ctx) {
      const env = ctx.env;
      const apiKey = env.XAI_API_KEY ?? env.CHASTE_CODING_AGENT_GROK_KEY ?? null;
      const model = env.CHASTE_CODING_AGENT_GROK_MODEL ?? env.GROK_MODEL ?? "grok-4-fast";
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl: "https://api.x.ai/v1",
          apiKey: null,
          detail: "installed; set XAI_API_KEY to reuse",
        };
      }
      return {
        providerKind: "openai_compatible" as const,
        model,
        baseUrl: "https://api.x.ai/v1",
        apiKey,
        detail: "reusing Grok model via xAI OpenAI-compatible API",
      };
    },
  };
}

function qwenEntry(): CodingAgentRegistryEntry {
  return {
    id: "qwen",
    displayName: "Qwen Code",
    binary: ["qwen"],
    resolve(ctx) {
      const env = ctx.env;
      const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_CODING_PLAN_API_KEY ?? null;
      const model = env.CHASTE_CODING_AGENT_QWEN_MODEL ?? env.QWEN_MODEL ?? "qwen3-coder-plus";
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: null,
          detail: "installed; set DASHSCOPE_API_KEY to reuse",
        };
      }
      return {
        providerKind: "openai_compatible" as const,
        model,
        // DashScope OpenAI-compatible endpoint (dashscope "qwen" group).
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey,
        detail: "reusing Qwen Code model via DashScope compatible endpoint",
      };
    },
  };
}

function aiderEntry(): CodingAgentRegistryEntry {
  return {
    id: "aider",
    displayName: "Aider",
    binary: ["aider"],
    resolve(ctx) {
      const env = ctx.env;
      // Aider reuses the same provider keys as Claude Code / Codex.
      const apiKey = env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY ?? null;
      const model = env.CHASTE_CODING_AGENT_AIDER_MODEL ?? env.AIDER_MODEL ?? "claude-sonnet-4-5-20250929";
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl: null,
          apiKey: null,
          detail: "installed; set ANTHROPIC_API_KEY or OPENAI_API_KEY to reuse",
        };
      }
      const anthropic = Boolean(env.ANTHROPIC_API_KEY);
      return {
        providerKind: anthropic ? ("anthropic" as const) : ("openai_compatible" as const),
        model,
        baseUrl: anthropic ? (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com") : "https://api.openai.com/v1",
        apiKey,
        detail: "reusing the key Aider is configured with",
      };
    },
  };
}

function cursorEntry(): CodingAgentRegistryEntry {
  return {
    id: "cursor",
    displayName: "Cursor (CLI)",
    binary: ["cursor-agent"],
    resolve() {
      return {
        providerKind: null,
        model: null,
        baseUrl: null,
        apiKey: null,
        detail: "installed; Cursor uses OAuth — not reusable as an API key here",
      };
    },
  };
}

function kimiEntry(): CodingAgentRegistryEntry {
  return {
    id: "kimi",
    displayName: "Kimi CLI",
    binary: ["kimi"],
    resolve(ctx) {
      const env = ctx.env;
      const apiKey = env.MOONSHOT_API_KEY ?? null;
      const model = env.CHASTE_CODING_AGENT_KIMI_MODEL ?? env.KIMI_MODEL ?? "kimi-k2.5-0711-preview";
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl: "https://api.moonshot.cn/v1",
          apiKey: null,
          detail: "installed; set MOONSHOT_API_KEY to reuse",
        };
      }
      return {
        providerKind: "openai_compatible" as const,
        model,
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey,
        detail: "reusing Kimi model via Moonshot OpenAI-compatible API",
      };
    },
  };
}

/** Parse ~/.codex/config.toml enough for model + provider + wire_api. */
export function parseCodexConfig(
  toml: string | null,
): {
  modelProvider: string | null;
  model: string | null;
  wireApi: string | null;
  providers: Record<string, { baseUrl?: string; wireApi?: string }>;
} {
  const out = {
    modelProvider: null as string | null,
    model: null as string | null,
    wireApi: null as string | null,
    providers: {} as Record<string, { baseUrl?: string; wireApi?: string }>,
  };
  if (!toml) return out;
  let currentTable: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const table = line.match(/^\[model_providers\.([^\]]+)\]$/);
    if (table) {
      const name = table[1]!;
      out.providers[name] = {};
      currentTable = name;
      continue;
    }
    if (line.startsWith("[")) {
      currentTable = null;
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const valueRaw = m[2]!;
    const value = unquoteToml(valueRaw);
    if (currentTable) {
      const entry = out.providers[currentTable];
      if (entry) {
        if (key === "base_url") entry.baseUrl = value;
        if (key === "wire_api") entry.wireApi = value;
      }
    } else {
      if (key === "model_provider") out.modelProvider = value;
      if (key === "model") out.model = value;
      if (key === "wire_api") out.wireApi = value;
    }
  }
  return out;
}

/** Parse OpenCode JSONC config down to the fields we need. */
export function parseOpenCodeConfig(
  jsonc: string | null,
): { buildModel: string | null; model: string | null; providers: Record<string, { npm?: string; baseURL?: string }> } {
  const out = {
    buildModel: null as string | null,
    model: null as string | null,
    providers: {} as Record<string, { npm?: string; baseURL?: string }>,
  };
  if (!jsonc) return out;
  const obj = parseJsonObject(stripJsonc(jsonc));
  const agent = asRecord(obj.agent);
  const build = asRecord(agent.build);
  if (typeof build.model === "string") out.buildModel = build.model;
  if (typeof obj.model === "string") out.model = obj.model;
  const providers = asRecord(obj.provider);
  for (const [name, p] of Object.entries(providers)) {
    const rec = asRecord(p);
    if (typeof rec.npm === "string") out.providers[name] = { ...out.providers[name], npm: rec.npm };
    const options = asRecord(rec.options);
    if (typeof options.baseURL === "string") {
      out.providers[name] = { ...out.providers[name], baseURL: options.baseURL };
    } else if (typeof rec.baseURL === "string") {
      out.providers[name] = { ...out.providers[name], baseURL: rec.baseURL };
    }
    if (!out.providers[name]) out.providers[name] = {};
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function providerKindFor(npm?: string): CodingAgentKind | null {
  if (!npm) return null;
  const l = npm.toLowerCase();
  if (l.includes("anthropic")) return "anthropic";
  if (l.includes("google") || l.includes("generative")) return "gemini";
  if (l.includes("openai-compatible") || l.includes("openrouter") || l.includes("openai") || l.includes("groq") || l.includes("xai") || l.includes("dashscope") || l.includes("custom")) return "openai_compatible";
  return null;
}

function defaultBaseFor(providerName: string): string | null {
  const l = providerName.toLowerCase();
  if (l === "openai") return "https://api.openai.com/v1";
  if (l === "anthropic") return "https://api.anthropic.com";
  if (l.includes("gemini") || l === "google") return "https://generativelanguage.googleapis.com/v1beta/openai";
  if (l === "grok" || l === "xai") return "https://api.x.ai/v1";
  return null;
}

export function splitModel(model: string): [string | null, string | null] {
  const idx = model.indexOf("/");
  if (idx === -1) return [null, model];
  return [model.slice(0, idx), model.slice(idx + 1)];
}

// ---- probing helpers -------------------------------------------------------

function parseJsonObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function unquoteToml(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function findBinary(bin: string, env: NodeJS.ProcessEnv): string | null {
  const override = env[`CHASTE_CODING_AGENT_${bin.replace(/[- ]/g, "_").toUpperCase()}_BIN`];
  if (override && existsSync(override)) return override;
  try {
    const out = execFileSync("sh", ["-c", `command -v -- ${JSON.stringify(bin)} 2>/dev/null || true`], {
      timeout: 2000,
      encoding: "utf8",
    });
    const found = out.split(/\r?\n/)[0]?.trim();
    return found && existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

function readVersion(binPath: string): string | null {
  try {
    const out = spawnSync(binPath, ["--version"], { timeout: 1500, encoding: "utf8" });
    if (out.error) return null;
    const text = (out.stdout ?? "").trim() || (out.stderr ?? "").trim();
    return text ? text.slice(0, 80).replace(/\r?\n/g, " ") : null;
  } catch {
    return null;
  }
}

/**
 * Probe every known agent. Synchronous by design (see file header) so
 * `createAiProvider` can stay synchronous; called once per process.
 */
export function detectCodingAgents(
  overrides: Partial<AgentProbeContext> & {
    findBinary?: (bin: string) => string | null;
    readVersion?: (binPath: string) => string | null;
  } = {},
): DetectedCodingAgent[] {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? os.homedir();
  const fileExists = overrides.fileExists ?? existsSync;
  const readFile = overrides.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  const findB = overrides.findBinary ?? ((bin: string) => findBinary(bin, env));
  const readV = overrides.readVersion ?? readVersion;
  const bins = overrides.bins ?? new Map<string, string | null>();

  const result: DetectedCodingAgent[] = [];
  for (const entry of CODING_AGENT_REGISTRY) {
    let binary = bins.get(entry.id);
    if (binary === undefined) {
      binary = entry.binary.map((b) => findB(b)).find((b): b is string => Boolean(b)) ?? null;
      bins.set(entry.id, binary);
    }
    if (!binary) {
      result.push({
        id: entry.id,
        displayName: entry.displayName,
        binary: null,
        installed: false,
        version: null,
        providerKind: null,
        model: null,
        baseUrl: null,
        hasApiKey: false,
        detail: "not installed",
      });
      continue;
    }
    const res = entry.resolve({ home, env, fileExists, readFile, bins });
    result.push({
      id: entry.id,
      displayName: entry.displayName,
      binary,
      installed: true,
      version: readV(binary),
      providerKind: res.providerKind,
      model: res.model,
      baseUrl: res.baseUrl,
      hasApiKey: Boolean(res.apiKey),
      detail: res.detail,
    });
  }
  return result;
}

/** First usable agent, honoring an optional `prefer` override by id. */
export function selectUsableCodingAgent(
  agents: DetectedCodingAgent[],
  prefer?: string | null,
): DetectedCodingAgent | null {
  if (prefer) {
    const wanted = agents.find((a) => a.id === prefer);
    if (wanted && isUsable(wanted)) return wanted;
  }
  return agents.find((a) => isUsable(a)) ?? null;
}

export function isUsable(a: DetectedCodingAgent): boolean {
  return a.installed && Boolean(a.providerKind) && Boolean(a.model) && a.hasApiKey && Boolean(a.baseUrl);
}

/** Redacted view safe for logs / settings UI (never exposes secrets). */
export function toPublicAgentInfo(a: DetectedCodingAgent) {
  return {
    id: a.id,
    displayName: a.displayName,
    installed: a.installed,
    version: a.version,
    usable: isUsable(a),
    providerKind: a.providerKind,
    model: a.model,
    baseUrl: a.baseUrl,
    detail: a.detail,
  };
}

let memoized: DetectedCodingAgent[] | null = null;

/** Process-memoized detection. Providers are constructed once at boot. */
export function detectedCodingAgents(): DetectedCodingAgent[] {
  if (!memoized) memoized = detectCodingAgents();
  return memoized;
}

export function resetDetectionCache() {
  memoized = null;
}

/** Memoized detector for a specific probe context (used by config/auto). */
export function createCodingAgentDetector(
  overrides: Parameters<typeof detectCodingAgents>[0] = {},
): () => DetectedCodingAgent[] {
  let cache: DetectedCodingAgent[] | null = null;
  return () => {
    if (!cache) cache = detectCodingAgents(overrides);
    return cache;
  };
}

// ---- additional top-20 agent entries ---------------------------------------

function clineEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "cline",
    displayName: "Cline",
    binary: ["cline"],
    modelEnv: ["CLINE_MODEL", "CHASTE_CODING_AGENT_CLINE_MODEL"],
  });
}

function copilotEntry(): CodingAgentRegistryEntry {
  return installedOnlyCodingAgent({
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    binary: ["copilot"],
    detail: "installed; Copilot uses OAuth — not reusable as a Chaste API provider",
  });
}

function piEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "pi",
    displayName: "Pi",
    binary: ["pi"],
    modelEnv: ["PI_MODEL", "CHASTE_CODING_AGENT_PI_MODEL"],
  });
}

function antigravityEntry(): CodingAgentRegistryEntry {
  return {
    id: "antigravity",
    displayName: "Google Antigravity",
    binary: ["antigravity"],
    resolve(ctx) {
      const env = ctx.env;
      const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? null;
      const model = env.ANTIGRAVITY_MODEL ?? env.CHASTE_CODING_AGENT_ANTIGRAVITY_MODEL ?? null;
      const baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
      if (!apiKey) {
        return {
          providerKind: null,
          model,
          baseUrl,
          apiKey: null,
          detail: "installed; Antigravity OAuth login isn't an API key — set GOOGLE_API_KEY (+ ANTIGRAVITY_MODEL) to reuse",
        };
      }
      if (!model) {
        return {
          providerKind: null,
          model: null,
          baseUrl,
          apiKey: null,
          detail: "installed; set ANTIGRAVITY_MODEL to reuse the Google key",
        };
      }
      return {
        providerKind: "gemini",
        model,
        baseUrl,
        apiKey,
        detail: "reusing Antigravity's Google model via OpenAI-compatible endpoint",
      };
    },
  };
}

function gooseEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "goose",
    displayName: "Goose",
    binary: ["goose"],
    modelEnv: ["GOOSE_MODEL", "CHASTE_CODING_AGENT_GOOSE_MODEL"],
  });
}

function rooCodeEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "roo",
    displayName: "Roo Code",
    binary: ["roo"],
    modelEnv: ["ROO_MODEL", "CHASTE_CODING_AGENT_ROO_MODEL"],
  });
}

function kilocodeEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "kilocode",
    displayName: "Kilo Code",
    binary: ["kilo"],
    modelEnv: ["KILO_MODEL", "CHASTE_CODING_AGENT_KILO_MODEL"],
  });
}

function ampEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "amp",
    displayName: "Amp",
    binary: ["amp"],
    modelEnv: ["AMP_MODEL", "CHASTE_CODING_AGENT_AMP_MODEL"],
  });
}

function droidEntry(): CodingAgentRegistryEntry {
  return installedOnlyCodingAgent({
    id: "droid",
    displayName: "Factory Droid",
    binary: ["droid"],
    detail: "installed; Droid authenticates to Factory's infra — not reusable as an API key",
  });
}

function minimaxEntry(): CodingAgentRegistryEntry {
  return apiKeyCodingAgent({
    id: "minimax",
    displayName: "MiniMax (M2)",
    binary: ["minimax", "mmx"],
    keyEnv: ["MINIMAX_API_KEY", "CHASTE_CODING_AGENT_MINIMAX_KEY"],
    baseUrl: "https://api.minimax.io/v1",
    modelEnv: ["MINIMAX_MODEL", "CHASTE_CODING_AGENT_MINIMAX_MODEL"],
    defaultModel: "minimax-m2",
    kind: "openai_compatible",
  });
}

function mistralEntry(): CodingAgentRegistryEntry {
  return apiKeyCodingAgent({
    id: "mistral",
    displayName: "Mistral (Coding)",
    binary: ["mistral"],
    keyEnv: ["MISTRAL_API_KEY", "CHASTE_CODING_AGENT_MISTRAL_KEY"],
    baseUrl: "https://api.mistral.ai/v1",
    modelEnv: ["MISTRAL_MODEL", "CHASTE_CODING_AGENT_MISTRAL_MODEL"],
    defaultModel: "codestral-latest",
    kind: "openai_compatible",
  });
}

function codyEntry(): CodingAgentRegistryEntry {
  return installedOnlyCodingAgent({
    id: "cody",
    displayName: "Sourcegraph Cody",
    binary: ["cody"],
    detail: "installed; Cody uses an enterprise/OAuth endpoint — not reusable as an API key",
  });
}

function windsurfEntry(): CodingAgentRegistryEntry {
  return installedOnlyCodingAgent({
    id: "windsurf",
    displayName: "Windsurf",
    binary: ["windsurf"],
    detail: "installed; Windsurf uses OAuth — not reusable as a Chaste API provider",
  });
}

function hermesEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "hermes",
    displayName: "Nous Hermes",
    binary: ["hermes", "acp"],
    modelEnv: ["HERMES_MODEL", "CHASTE_CODING_AGENT_HERMES_MODEL"],
  });
}

function auggieEntry(): CodingAgentRegistryEntry {
  return installedOnlyCodingAgent({
    id: "auggie",
    displayName: "Augment Code (Auggie)",
    binary: ["auggie"],
    detail: "installed; Auggie requires an Augment subscription — not reusable as an API key",
  });
}

function openclawEntry(): CodingAgentRegistryEntry {
  return installedOnlyCodingAgent({
    id: "openclaw",
    displayName: "OpenClaw",
    binary: ["openclaw"],
    detail: "installed; OpenClaw uses OAuth — not reusable as a Chaste API provider",
  });
}

function devinEntry(): CodingAgentRegistryEntry {
  return installedOnlyCodingAgent({
    id: "devin",
    displayName: "Devin",
    binary: ["devin"],
    detail: "installed; Devin is a managed cloud agent — API key reuse unsupported",
  });
}

function continueEntry(): CodingAgentRegistryEntry {
  return reuseKeysCodingAgent({
    id: "continue",
    displayName: "Continue",
    binary: ["continue"],
    modelEnv: ["CONTINUE_MODEL", "CHASTE_CODING_AGENT_CONTINUE_MODEL"],
  });
}