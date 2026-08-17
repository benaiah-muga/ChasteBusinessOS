import { describe, expect, it } from "vitest";
import { InMemorySessionLog } from "../trajectory/index.js";
import type { Scenario, ScenarioContext } from "./scenario.js";
import { createScenarioContext, runScenario, runScenarioSuite } from "./scenario.js";
import { GOLDEN_SCENARIOS } from "./scenarios/index.js";

const now = () => new Date("2026-08-16T10:00:00Z");

function makeContext(scenario: Scenario): ScenarioContext {
  const organizationId = `org-${scenario.id}`.replace(/[^a-zA-Z0-9]/g, "-");
  const sessionId = `session-${scenario.id}`.replace(/[^a-zA-Z0-9]/g, "-");
  return createScenarioContext({ log: new InMemorySessionLog(), sessionId, organizationId, now });
}

describe("runScenario", () => {
  it("attaches the replay invariant and a fork to every scenario verdict", async () => {
    const ctx = createScenarioContext({
      log: new InMemorySessionLog(),
      sessionId: "session-s",
      organizationId: "org-s",
      now,
    });
    await ctx.record("session/start", { channel: "api" });
    await ctx.record("model/request", {
      modelRoute: "planning",
      provider: "eval",
      model: "eval-harness",
      systemPromptSections: ["Policy: act within granted permissions."],
      messages: [{ role: "user", content: "hello" }],
      toolSchemas: [{ name: "tool" }],
      evidenceRefs: [],
      memoryReads: [],
    });

    const result = await runScenario(
      { id: "s", name: "n", description: "d", run: async () => {} },
      ctx,
    );
    expect(result.passed).toBe(true);
    expect(result.totalEvents).toBe(2);
    expect(result.replay.complete).toBe(true);
    expect(result.forkedSessionId).toBe("session-s--fork");
    expect(result.checks.some((c) => c.label.startsWith("replay:"))).toBe(true);
    expect(result.checks.some((c) => c.label.startsWith("fork:"))).toBe(true);
  });

  it("reports a failing check as a failed scenario without throwing", async () => {
    const failing: Scenario = {
      id: "fails",
      name: "Failing",
      description: "deliberately fails",
      run: (ctx) => {
        ctx.check("this check fails", false, "because the scenario says so");
        return Promise.resolve();
      },
    };
    const ctx = makeContext(failing);
    const result = await runScenario(failing, ctx);
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.label === "this check fails" && !c.passed)).toBe(true);
  });
});

describe("runScenarioSuite", () => {
  it("passes the golden harness-policy regression suite", async () => {
    const report = await runScenarioSuite(GOLDEN_SCENARIOS, makeContext);
    expect(report.passed).toBe(true);
    expect(report.passedCount).toBe(GOLDEN_SCENARIOS.length);
    expect(report.failedCount).toBe(0);
    for (const r of report.results) {
      expect(r.error).toBeUndefined();
      expect(r.replay.complete).toBe(true);
      expect(r.fork?.copied).toBe(r.totalEvents);
    }
  }, 15_000);

  it("reports a suite with a failing scenario as failed", async () => {
    const bad: Scenario = {
      id: "bad",
      name: "Bad",
      description: "deliberately incomplete trace",
      run: (ctx) => {
        ctx.check("ok check", true);
        return Promise.resolve();
      },
    };
    const report = await runScenarioSuite([GOLDEN_SCENARIOS[0]!, bad], makeContext);
    expect(report.passed).toBe(false);
    expect(report.failedCount).toBe(1);
    const badResult = report.results.find((r) => r.id === "bad")!;
    expect(badResult.checks.some((c) => c.label.startsWith("replay:") && !c.passed)).toBe(true);
  }, 15_000);
});