import { describe, expect, it } from "vitest";
import { allocateBudget } from "./budget.js";
import { buildContextBundle, explainContext } from "./builder.js";

const route = { routeId: "r1", provider: "local", model: "small", costClass: "cheap" as const };

const base = {
  sessionId: "s1",
  organizationId: "o1",
  turn: 1,
  modelRoute: route,
};

describe("allocateBudget", () => {
  it("carves response reserve and respects a cost cap", () => {
    const b = allocateBudget({ capacity: 10000, costCapTokens: 6000, taskKind: "ordinary" });
    // reserve 15% of 10000 = 1500 → hard budget = min(8500, 6000) = 6000
    expect(b.reserveTokens).toBe(1500);
    expect(b.hardBudget).toBe(6000);
  });

  it("scales reserve for document/report generation", () => {
    const b = allocateBudget({ capacity: 10000, taskKind: "document_report" });
    expect(b.reserveTokens).toBeGreaterThanOrEqual(3000);
    expect(b.hardBudget).toBeLessThanOrEqual(7000);
  });
});

describe("buildContextBundle", () => {
  it("admits sections in allocation order until the budget is spent", () => {
    const { bundle } = buildContextBundle({
      ...base,
      budget: { capacity: 2000, taskKind: "ordinary" },
      sections: [
        {
          key: "invariants",
          tier: 0,
          purpose: "instruction",
          source: "system",
          renderedText: "system invariants",
          required: true,
        },
        {
          key: "task_intent",
          tier: 2,
          purpose: "state",
          source: "module",
          renderedText: "user intent",
        },
        {
          key: "tool_schemas",
          tier: 3,
          purpose: "tool_schema",
          source: "module",
          renderedText: "tool schemas",
        },
        {
          key: "examples_longtail",
          tier: 5,
          purpose: "memory",
          source: "memory",
          renderedText: "examples",
        },
      ],
    });

    expect(bundle.sections[0]?.tier).toBe(0);
    expect(bundle.tokenBudget.usedTokens).toBeGreaterThan(0);
    expect(bundle.tokenBudget.overflow).toBe(false);
    expect(bundle.omitted).toHaveLength(0);
  });

  it("fails closed when a required section cannot fit (overflow)", () => {
    const { bundle } = buildContextBundle({
      ...base,
      budget: { capacity: 300, taskKind: "ordinary" },
      sections: [
        {
          key: "invariants",
          tier: 0,
          purpose: "instruction",
          source: "system",
          renderedText: "invariants",
          required: true,
          tokenEstimate: 100,
        },
        {
          key: "tool_schemas",
          tier: 3,
          purpose: "tool_schema",
          source: "module",
          renderedText: "schemas",
          required: true,
          tokenEstimate: 250,
        },
        {
          key: "examples_longtail",
          tier: 5,
          purpose: "memory",
          source: "memory",
          renderedText: "examples",
          tokenEstimate: 200,
        },
      ],
    });

    // hard budget ≈ 300 − 45 reserve = 255; invariants (100) fits, then the
    // required tool_schemas (250) overflows → fail closed rather than trimming
    // critical context. The long-tail example (200) also no longer fits (300
    // used would exceed 255), so it is omitted for budget as well.
    expect(bundle.tokenBudget.overflow).toBe(true);
    expect(bundle.sections.some((s) => s.purpose === "instruction")).toBe(true);
    expect(bundle.sections.some((s) => s.purpose === "tool_schema")).toBe(false);
    expect(bundle.omitted.some((o) => o.reason === "budget")).toBe(true);
    expect(bundle.omitted).toHaveLength(2);
  });

  it("never admits unauthorized sections; records a redaction", () => {
    const { bundle } = buildContextBundle({
      ...base,
      budget: { capacity: 5000, taskKind: "ordinary" },
      sections: [
        {
          key: "invariants",
          tier: 0,
          purpose: "instruction",
          source: "system",
          renderedText: "ok",
        },
        {
          key: "cited_evidence",
          tier: 3,
          purpose: "evidence",
          source: "document",
          renderedText: "secret doc",
          authorized: false,
        },
      ],
    });

    expect(bundle.sections).toHaveLength(1);
    expect(bundle.redactions.some((r) => r.reason === "unauthorized")).toBe(true);
    expect(bundle.omitted.some((o) => o.reason === "unauthorized")).toBe(true);
  });

  it("explains included and omitted sections (audit-friendly)", () => {
    const { bundle } = buildContextBundle({
      ...base,
      budget: { capacity: 300, taskKind: "ordinary" },
      sections: [
        {
          key: "invariants",
          tier: 0,
          purpose: "instruction",
          source: "system",
          renderedText: "invariants",
          required: true,
          tokenEstimate: 100,
        },
        {
          key: "examples_longtail",
          tier: 5,
          purpose: "memory",
          source: "memory",
          renderedText: "examples",
          tokenEstimate: 300,
        },
      ],
    });

    const lines = explainContext(bundle).join("\n");
    expect(lines).toContain("sec:invariants");
    expect(lines).toContain("omitted");
    expect(lines).toContain("budget");
  });
});
