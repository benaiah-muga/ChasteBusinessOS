import { describe, expect, it } from "vitest";
import {
  BudgetLimitError,
  InMemoryUsageLedger,
  ModelRouteError,
  createModelRouter,
  estimateCostCents,
  type AiProvider,
} from "./model-router.js";
import type { CompletionRequest, CompletionResult } from "./providers.js";

const now = () => new Date("2026-08-17T10:00:00Z");

function fakeProvider(id: string, opts: { model?: string; tokens?: number } = {}): AiProvider {
  return {
    id,
    async complete(_req: CompletionRequest): Promise<CompletionResult> {
      return {
        text: `from ${id}`,
        provider: id,
        model: opts.model ?? `model-${id}`,
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      };
    },
  };
}

describe("estimateCostCents", () => {
  it("computes cost from per-1M-token prices", () => {
    expect(
      estimateCostCents(
        { promptCents: 300, completionCents: 1500 },
        { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      ),
    ).toBe(1800);
    expect(estimateCostCents(undefined, { promptTokens: 1000 })).toBe(0);
  });
});

describe("createModelRouter — routing", () => {
  it("routes a task class to its configured provider and records usage", async () => {
    const ledger = new InMemoryUsageLedger();
    const router = createModelRouter({
      providers: { main: fakeProvider("main"), cheap: fakeProvider("cheap") },
      config: {
        routes: { rules: "cheap", chat: "main" },
        defaultRoute: "main",
      },
      ledger,
      now,
    });

    expect(router.route("rules")).toBe("cheap");
    expect(router.route("report")).toBe("main");

    const result = await router.complete(
      "rules",
      { user: "classify" },
      { organizationId: "o1", sessionId: "s1" },
    );
    expect(result.text).toBe("from cheap");
    expect(result.taskClass).toBe("rules");
    expect(result.estimatedCostCents).toBe(0);

    const spent = await ledger.spendForOrganization("o1", new Date("2026-08-01T00:00:00Z"));
    expect(spent).toBe(0);
  });

  it("fails closed when a task class has no route and no default", async () => {
    const router = createModelRouter({
      providers: { cheap: fakeProvider("cheap") },
      config: { routes: { rules: "cheap" } },
      ledger: new InMemoryUsageLedger(),
    });
    expect(() => router.route("report")).toThrow(ModelRouteError);
    await expect(
      router.complete("chat", { user: "x" }, { organizationId: "o1", sessionId: "s1" }),
    ).rejects.toThrow(ModelRouteError);
  });

  it("fails closed when the routed provider id is not registered", async () => {
    const router = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { routes: { report: "unregistered" } },
      ledger: new InMemoryUsageLedger(),
    });
    expect(() => router.route("report")).toThrow(ModelRouteError);
  });
});

describe("createModelRouter — cost controls", () => {
  it("enforces an organization monthly cap shared across the ledger", async () => {
    const ledger = new InMemoryUsageLedger();
    await ledger.record({
      organizationId: "o1",
      sessionId: "s-other",
      taskClass: "chat",
      providerId: "main",
      model: "m",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostCents: 10_000,
      createdAt: now().toISOString(),
    });

    const router = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { defaultRoute: "main" },
      budget: { enabled: true, organizationMonthlyCents: 10_000 },
      ledger,
      now,
    });

    await expect(
      router.complete("chat", { user: "over budget" }, { organizationId: "o1", sessionId: "s1" }),
    ).rejects.toThrow(BudgetLimitError);
  });

  it("enforces a per-session cap", async () => {
    const ledger = new InMemoryUsageLedger();
    await ledger.record({
      organizationId: "o1",
      sessionId: "s1",
      taskClass: "chat",
      providerId: "main",
      model: "m",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostCents: 50,
      createdAt: now().toISOString(),
    });
    const router = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { defaultRoute: "main" },
      budget: { enabled: true, sessionCents: 50 },
      ledger,
      now,
    });
    await expect(
      router.complete("chat", { user: "x" }, { organizationId: "o1", sessionId: "s1" }),
    ).rejects.toThrow(BudgetLimitError);
  });

  it("records usage after dispatch so the next request is budget-checked", async () => {
    const ledger = new InMemoryUsageLedger();
    const router = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { defaultRoute: "main" },
      budget: { enabled: true, sessionCents: 1 },
      prices: { main: { promptCents: 100, completionCents: 100 } },
      ledger,
      now,
    });

    await router.complete("chat", { user: "first" }, { organizationId: "o1", sessionId: "s1" });
    // 1500 total tokens @ 100¢/M ≈ 0¢; still allowed until spent >= 1¢.
    await expect(
      router.complete("chat", { user: "second" }, { organizationId: "o1", sessionId: "s1" }),
    ).resolves.toBeDefined();
  });

  it("applies prices to attribute estimated cost per request", async () => {
    const ledger = new InMemoryUsageLedger();
    const router = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { defaultRoute: "main" },
      prices: { main: { promptCents: 300, completionCents: 1500 } },
      ledger,
      now,
    });
    const result = await router.complete(
      "report",
      { user: "analyze" },
      { organizationId: "o1", sessionId: "s1" },
    );
    // 1000 prompt + 500 completion @ the configured prices.
    expect(result.estimatedCostCents).toBe(1);
    expect(await ledger.spendForSession("s1")).toBe(1);
  });
});

describe("InMemoryUsageLedger", () => {
  it("records, sums per org since a date, and per session", async () => {
    const ledger = new InMemoryUsageLedger();
    const base = {
      providerId: "main",
      model: "m",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostCents: 10,
    };
    await ledger.record({
      ...base,
      organizationId: "o1",
      sessionId: "s1",
      taskClass: "chat" as const,
      createdAt: "2026-08-05T00:00:00Z",
    });
    await ledger.record({
      ...base,
      organizationId: "o1",
      sessionId: "s2",
      taskClass: "chat" as const,
      createdAt: "2026-08-15T00:00:00Z",
    });
    await ledger.record({
      ...base,
      organizationId: "o2",
      sessionId: "s3",
      taskClass: "chat" as const,
      createdAt: "2026-08-15T00:00:00Z",
    });

    expect(await ledger.spendForOrganization("o1", new Date("2026-08-01T00:00:00Z"))).toBe(20);
    expect(await ledger.spendForOrganization("o1", new Date("2026-08-10T00:00:00Z"))).toBe(10);
    expect(await ledger.spendForSession("s2")).toBe(10);
    expect(await ledger.spendForSession("nope")).toBe(0);
  });
});