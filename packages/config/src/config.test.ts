import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

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
});
