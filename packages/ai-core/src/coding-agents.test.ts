import { describe, expect, it } from "vitest";
import type { AgentProbeContext } from "./coding-agents.js";
import {
  CODING_AGENT_REGISTRY,
  detectCodingAgents,
  isUsable,
  parseCodexConfig,
  parseOpenCodeConfig,
  providerKindFor,
  selectUsableCodingAgent,
  splitModel,
  toPublicAgentInfo,
} from "./coding-agents.js";
import { AnthropicMessagesProvider, NoneProvider, OpenAiCompatibleProvider } from "./providers.js";
import { createAiProvider, providerFromCodingAgent } from "./providers.js";

function makeContext(
  opts: {
    files?: Record<string, string>;
    env?: Record<string, string>;
    bins?: Record<string, string>;
  } = {},
): AgentProbeContext {
  const files = opts.files ?? {};
  return {
    home: "/home/fake",
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    fileExists: (p) => p in files,
    readFile: (p) => files[p] ?? null,
    bins: new Map<string, string | null>(Object.entries(opts.bins ?? {})),
  };
}

/** Detect only against the injected binary map — no real PATH probing. */
function detectAgainst(ctx: AgentProbeContext, overrides: { readVersion?: (p: string) => string | null } = {}) {
  return detectCodingAgents({
    ...ctx,
    findBinary: (bin) => ctx.bins.get(bin) ?? null,
    readVersion: overrides.readVersion ?? (() => null),
  });
}

describe("coding agent registry", () => {
  it("registers at least 20 agents with unique ids", () => {
    expect(CODING_AGENT_REGISTRY.length).toBeGreaterThanOrEqual(20);
    const ids = CODING_AGENT_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CODING_AGENT_REGISTRY) {
      expect(e.binary.length).toBeGreaterThan(0);
      expect(e.displayName.length).toBeGreaterThan(0);
    }
  });

  it("includes the headline agents", () => {
    const ids = CODING_AGENT_REGISTRY.map((e) => e.id);
    for (const id of ["claude-code", "codex", "opencode", "gemini", "grok", "cline", "antigravity", "pi"]) {
      expect(ids).toContain(id);
    }
  });
});

describe("parseCodexConfig", () => {
  it("parses model, model_provider, wire_api and custom provider base_url", () => {
    const parsed = parseCodexConfig(`model_provider = "buzz"
model = "gpt-5.3-codex"
disable_response_storage = true

[model_providers.buzz]
name = "BUZZ AI"
base_url = "https://buzzai.cc/v1"
wire_api = "responses"
`);
    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelProvider).toBe("buzz");
    expect(parsed.wireApi).toBeNull();
    expect(parsed.providers.buzz?.baseUrl).toBe("https://buzzai.cc/v1");
    expect(parsed.providers.buzz?.wireApi).toBe("responses");
  });

  it("returns empties for garbage", () => {
    const parsed = parseCodexConfig("not toml at all ===");
    expect(parsed.model).toBeNull();
    expect(parsed.modelProvider).toBeNull();
  });
});

describe("parseOpenCodeConfig", () => {
  it("parses build model and provider metadata from JSONC", () => {
    const parsed = parseOpenCodeConfig(`{
  // model used by the build agent
  "agent": { "build": { "model": "anthropic/claude-sonnet-4-20250514" } },
  "provider": {
    "custom": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://127.0.0.1:8080/v1" } }
  }
}`);
    expect(parsed.buildModel).toBe("anthropic/claude-sonnet-4-20250514");
    expect(parsed.providers.custom?.npm).toBe("@ai-sdk/openai-compatible");
    expect(parsed.providers.custom?.baseURL).toBe("http://127.0.0.1:8080/v1");
  });

  it("handles missing/empty config", () => {
    const parsed = parseOpenCodeConfig(null);
    expect(parsed.buildModel).toBeNull();
    expect(Object.keys(parsed.providers)).toHaveLength(0);
  });
});

describe("providerKindFor / splitModel", () => {
  it("maps npm packages to kinds", () => {
    expect(providerKindFor("@ai-sdk/anthropic")).toBe("anthropic");
    expect(providerKindFor("@google/generative-ai")).toBe("gemini");
    expect(providerKindFor("@ai-sdk/openai-compatible")).toBe("openai_compatible");
    expect(providerKindFor("some-unknown-package")).toBeNull();
    expect(providerKindFor(undefined)).toBeNull();
  });

  it("splits provider/model ids", () => {
    expect(splitModel("anthropic/claude-sonnet-4")).toEqual(["anthropic", "claude-sonnet-4"]);
    expect(splitModel("bare-model")).toEqual([null, "bare-model"]);
  });
});

describe("detectCodingAgents", () => {
  it("reports not-installed when no binary is found", () => {
    const agents = detectCodingAgents({
      findBinary: () => null,
      readVersion: () => null,
      ...makeContext(),
    });
    expect(agents).toHaveLength(CODING_AGENT_REGISTRY.length);
    for (const a of agents) {
      expect(a.installed).toBe(false);
      expect(a.detail).toBe("not installed");
      expect(a.hasApiKey).toBe(false);
      expect(a.binary).toBeNull();
    }
  });

  it("reuses Codex config + auth into a usable openai_compatible provider", () => {
    const ctx = makeContext({
      files: {
        "/home/fake/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-test-123" }),
        "/home/fake/.codex/config.toml": `model_provider = "openai"\nmodel = "gpt-5.3-codex"\n`,
      },
      bins: { codex: "/usr/bin/codex" },
    });
    const agents = detectAgainst(ctx, { readVersion: () => "1.0.0-test" });
    const codex = agents.find((a) => a.id === "codex");
    expect(codex).toMatchObject({
      installed: true,
      version: "1.0.0-test",
      providerKind: "openai_compatible",
      model: "gpt-5.3-codex",
      hasApiKey: true,
    });
    expect(isUsable(codex!)).toBe(true);
  });

  it("reuses Claude Code model when ANTHROPIC_API_KEY is present", () => {
    const ctx = makeContext({ env: { ANTHROPIC_API_KEY: "sk-ant-test" }, bins: { claude: "/usr/bin/claude" } });
    const agents = detectAgainst(ctx);
    const claude = agents.find((a) => a.id === "claude-code");
    expect(claude).toMatchObject({
      installed: true,
      providerKind: "anthropic",
      hasApiKey: true,
    });
    expect(claude!.model).toBeTruthy();
  });

  it("flags OAuth-only agents as installed but not reusable", () => {
    const ctx = makeContext({ bins: { copilot: "/usr/bin/copilot" } });
    const agents = detectAgainst(ctx);
    const copilot = agents.find((a) => a.id === "copilot");
    expect(copilot?.installed).toBe(true);
    expect(copilot?.providerKind).toBeNull();
    expect(copilot?.hasApiKey).toBe(false);
    expect(copilot?.detail).toMatch(/OAuth/);
  });

  it("public info never leaks the key", () => {
    const ctx = makeContext({
      files: { "/home/fake/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-super-secret" }) },
      bins: { codex: "/usr/bin/codex" },
    });
    const agents = detectAgainst(ctx);
    const codex = agents.find((a) => a.id === "codex")!;
    const json = JSON.stringify(toPublicAgentInfo(codex));
    expect(json).not.toContain("sk-super-secret");
    expect(JSON.stringify(codex)).not.toContain("sk-super-secret");
  });
});

describe("selectUsableCodingAgent", () => {
  const usable = (id: string): ReturnType<typeof detectCodingAgents>[number] => ({
    id,
    displayName: id,
    binary: "/usr/bin/" + id,
    installed: true,
    version: null,
    providerKind: "openai_compatible",
    model: "m",
    baseUrl: "http://x/v1",
    hasApiKey: true,
    detail: "",
  });
  const notUsable = (id: string) => ({
    ...usable(id),
    installed: false,
    hasApiKey: false,
    providerKind: null,
  });

  it("honors a usable prefer override", () => {
    const agents = [usable("codex"), usable("opencode")];
    expect(selectUsableCodingAgent(agents, "opencode")?.id).toBe("opencode");
  });

  it("falls back to registry order when prefer is unusable or unset", () => {
    expect(selectUsableCodingAgent([usable("codex"), usable("gemini")])?.id).toBe("codex");
    expect(selectUsableCodingAgent([notUsable("codex"), usable("gemini")], "codex")?.id).toBe("gemini");
  });

  it("returns null when nothing is usable", () => {
    expect(selectUsableCodingAgent([notUsable("codex"), notUsable("claude-code")])).toBeNull();
  });
});

describe("providerFromCodingAgent", () => {
  it("returns NoneProvider for null/unusable agents", () => {
    expect(providerFromCodingAgent(null)).toBeInstanceOf(NoneProvider);
  });

  it("builds the right provider class per agent kind", () => {
    const ctx = makeContext({
      files: { "/home/fake/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-test" }) },
      bins: { codex: "/usr/bin/codex" },
    });
    const agents = detectAgainst(ctx);
    const codex = agents.find((a) => a.id === "codex")!;
    const p = providerFromCodingAgent(codex, ctx);
    expect(p).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(p.id).toBe("codex");
  });
});

describe("createAiProvider(auto)", () => {
  it("returns NoneProvider when no coding agent is usable", () => {
    const ctx = makeContext({ findBinary: () => null });
    const provider = createAiProvider(
      { ...emptyAiCfg, provider: "auto" },
      { detectCodingAgents: () => detectCodingAgents({ ...ctx, findBinary: () => null }), agentContext: ctx },
    );
    expect(provider).toBeInstanceOf(NoneProvider);
  });

  it("selects the preferred agent and reuses its model", () => {
    const ctx = makeContext({
      env: { ANTHROPIC_API_KEY: "sk-ant" },
      files: {
        "/home/fake/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-openai" }),
        "/home/fake/.claude/settings.json": "{}",
      },
      bins: { claude: "/usr/bin/claude", codex: "/usr/bin/codex" },
    });
    const agents = detectAgainst(ctx);
    const provider = createAiProvider(
      { ...emptyAiCfg, provider: "auto", codingAgentPrefer: "claude-code" },
      { detectCodingAgents: () => agents, agentContext: ctx },
    );
    expect(provider.id).toBe("claude-code");
    expect(provider).toBeInstanceOf(AnthropicMessagesProvider);
  });
});

const emptyAiCfg = {
  model: "",
  defaultInboxVisibility: "inline",
  codingAgentPrefer: null,
} as const;