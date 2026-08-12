import { describe, expect, it } from "vitest";
import { loadConfig, publicConfigView } from "./index.js";

describe("loadConfig", () => {
  it("loads minimal valid config", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://u@localhost/db",
      NODE_ENV: "test",
    });
    expect(cfg.databaseUrl).toContain("postgres");
    expect(cfg.defaultAutonomy).toBe("confirm");
    expect(cfg.region).toBe("local");
  });

  it("fails without DATABASE_URL", () => {
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(/DATABASE_URL|databaseUrl/i);
  });

  it("accepts provider auto and a preferred coding agent", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://u@localhost/db",
      NODE_ENV: "test",
      CHASTE_AI_PROVIDER: "auto",
      CHASTE_AI_PREFER_CODING_AGENT: "claude-code",
    });
    expect(cfg.ai.provider).toBe("auto");
    expect(cfg.ai.codingAgentPrefer).toBe("claude-code");
    expect(publicConfigView(cfg).aiConfigured).toBe(true);
    expect(publicConfigView(cfg).preferredCodingAgent).toBe("claude-code");
  });
});
