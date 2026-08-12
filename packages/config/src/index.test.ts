import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./index.js";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    ...overrides,
  };
}

describe("loadConfig — auth posture (F1)", () => {
  it("defaults allowAnonymousAdmin to ON in development", () => {
    expect(loadConfig(env()).auth.allowAnonymousAdmin).toBe(true);
  });

  it("defaults allowAnonymousAdmin to OFF in production", () => {
    const cfg = loadConfig(
      env({ NODE_ENV: "production", CHASTE_SESSION_SECRET: "a-secret-that-is-long-enough!!" }),
    );
    expect(cfg.auth.allowAnonymousAdmin).toBe(false);
  });

  it("lets an explicit dev override turn the fallback off", () => {
    const cfg = loadConfig(env({ CHASTE_ALLOW_ANON_ADMIN: "false" }));
    expect(cfg.auth.allowAnonymousAdmin).toBe(false);
  });

  it("fail-closes: production refuses allowAnonymousAdmin=true", () => {
    expect(() =>
      loadConfig(
        env({
          NODE_ENV: "production",
          CHASTE_SESSION_SECRET: "a-secret-that-is-long-enough!!",
          CHASTE_ALLOW_ANON_ADMIN: "true",
        }),
      ),
    ).toThrow(ConfigError);
  });

  it("accepts a long bootstrap admin token", () => {
    const cfg = loadConfig(
      env({ CHASTE_ADMIN_TOKEN: "a-very-long-operator-provided-token-123456" }),
    );
    expect(cfg.auth.bootstrapAdminToken).toBe("a-very-long-operator-provided-token-123456");
  });

  it("exposes the token TTL configured via env", () => {
    const cfg = loadConfig(env({ CHASTE_SESSION_TOKEN_TTL: "86400" }));
    expect(cfg.session.tokenTtlSeconds).toBe(86400);
  });
});
