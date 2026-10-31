import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationPanel } from "./EvaluationPanel";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

const passedResult = {
  scenarioId: "inventory-proposal-low-stock",
  status: "passed",
  model: "deepseek-flash",
  finalAnswer: "CEM-1 is below its reorder point. I prepared the purchase order and it is awaiting approval.",
  durationMs: 7730,
  usage: { input: 100, output: 50, cachedInput: 0 },
  toolCalls: [{ name: "inventory_replenishmentPlan", arguments: {}, result: { status: "reorder" } }],
  checks: [
    { id: "planned", label: "Reads the live replenishment plan", passed: true, detail: "inventory_replenishmentPlan was called" },
    { id: "proposed", label: "Prepares the purchase order", passed: true, detail: "purchasing_createPurchaseOrder was called" },
  ],
  error: "",
};

const historicalPassed = {
  ...passedResult,
  durationMs: 6100,
  model: "deepseek-chat",
  finalAnswer: "Historical run that passed.",
  toolCalls: [],
  checks: [],
  persisted: true,
  createdAt: "2026-10-18T09:30:00Z",
};

const historicalFailed = {
  ...passedResult,
  scenarioId: "inventory-incoming-covers",
  status: "failed",
  durationMs: 8300,
  model: "deepseek-chat",
  finalAnswer: "Historical run that failed.",
  toolCalls: [],
  checks: [],
  persisted: true,
  createdAt: "2026-10-17T14:05:00Z",
};

const catalog = {
  live: true,
  model: "deepseek-flash",
  baselinePassRate: 90,
  scenarios: [
    {
      id: "inventory-proposal-low-stock",
      title: "Prepare a low-stock purchase proposal",
      description: "The plan shows a real shortfall. The agent should prepare the gated commitment.",
      checks: ["Reads the live replenishment plan", "Prepares the purchase order"],
    },
    {
      id: "inventory-incoming-covers",
      title: "Avoid duplicate ordering when supply is incoming",
      description: "Incoming stock covers the gap, so the agent should not order again.",
      checks: ["Reads the live replenishment plan", "Does not prepare a duplicate order"],
    },
  ],
  recentRuns: [historicalPassed, historicalFailed],
};

const LOW_STOCK_SCENARIO = "inventory-proposal-low-stock";
const INCOMING_SCENARIO = "inventory-incoming-covers";

function seededRun(
  scenarioId: string,
  status: "passed" | "failed",
  createdAt: string,
  withDetail = false,
) {
  return {
    ...passedResult,
    scenarioId,
    status,
    model: "deepseek-chat",
    durationMs: 6100,
    finalAnswer: withDetail
      ? "Incoming stock already covers the shortfall, so I did not place another order."
      : `Historical ${status} run recorded at ${createdAt}.`,
    toolCalls: withDetail
      ? [{ name: "inventory_replenishmentPlan", arguments: { sku: "CEM-1" }, result: { status: "covered" } }]
      : [],
    checks: withDetail
      ? [
          {
            id: "covers",
            label: "Confirms incoming stock covers the gap",
            passed: true,
            detail: "The fixture plan shows incoming units.",
          },
        ]
      : [],
    persisted: true,
    createdAt,
  };
}

const metHistoryCatalog = {
  ...catalog,
  recentRuns: [
    seededRun(INCOMING_SCENARIO, "passed", "2026-10-19T11:00:00Z", true),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T10:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T09:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T08:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T07:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T06:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T05:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T04:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T03:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T02:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "failed", "2026-10-19T01:00:00Z"),
  ],
};

const failedHistoryCatalog = {
  ...catalog,
  recentRuns: [
    seededRun(LOW_STOCK_SCENARIO, "failed", "2026-10-19T11:00:00Z"),
    seededRun(LOW_STOCK_SCENARIO, "passed", "2026-10-19T10:00:00Z"),
    seededRun(INCOMING_SCENARIO, "failed", "2026-10-19T09:00:00Z", true),
  ],
};

function releaseRun(
  scenarioId: string,
  status: "passed" | "failed",
  model: string,
  durationMs: number,
  input: number,
  output: number,
  createdAt: string,
) {
  return {
    ...passedResult,
    scenarioId,
    status,
    model,
    durationMs,
    usage: { input, output, cachedInput: 0 },
    finalAnswer: `Release metric run at ${createdAt}.`,
    toolCalls: [],
    checks: [],
    persisted: true,
    createdAt,
  };
}

const releaseMetricsCatalog = {
  ...catalog,
  recentRuns: [
    releaseRun(LOW_STOCK_SCENARIO, "passed", "deepseek-flash", 2000, 100, 50, "2026-10-19T12:00:00Z"),
    releaseRun(LOW_STOCK_SCENARIO, "failed", "deepseek-flash", 4000, 200, 100, "2026-10-19T11:00:00Z"),
    releaseRun(INCOMING_SCENARIO, "passed", "deepseek-flash", 6000, 300, 150, "2026-10-19T10:00:00Z"),
    releaseRun(INCOMING_SCENARIO, "passed", "deepseek-chat", 8000, 400, 200, "2026-10-19T09:00:00Z"),
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function stubEvaluationFetch(
  overrides: {
    catalog?: unknown;
    run?: (scenarioId: string) => unknown;
    baseline?: (passRate: number) => unknown;
  } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/evaluations" && (init?.method ?? "GET") === "GET") {
      return jsonResponse(overrides.catalog ?? catalog);
    }
    if (path === "/api/evaluations/run" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { scenarioId: string };
      const result = overrides.run?.(body.scenarioId) ?? {
        ...passedResult,
        scenarioId: body.scenarioId,
      };
      return jsonResponse(result);
    }
    if (path === "/api/evaluations/baseline" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { passRate: number };
      return jsonResponse(overrides.baseline?.(body.passRate) ?? { baselinePassRate: body.passRate });
    }
    return jsonResponse({ error: "not stubbed" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function runBodies(fetchMock: { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }) {
  return fetchMock.mock.calls
    .filter(([path, init]) => String(path) === "/api/evaluations/run" && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as { scenarioId: string });
}

function baselineCalls(fetchMock: { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }) {
  return fetchMock.mock.calls.filter(
    ([path, init]) => String(path) === "/api/evaluations/baseline" && init?.method === "POST",
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EvaluationPanel", () => {
  it("renders the catalogue and a passed run with check detail and token usage", async () => {
    const fetchMock = stubEvaluationFetch();
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByText("Prepare a low-stock purchase proposal")).not.toBeNull();
    expect(screen.getByText("Avoid duplicate ordering when supply is incoming")).not.toBeNull();
    expect(screen.getByText("The plan shows a real shortfall. The agent should prepare the gated commitment.")).not.toBeNull();
    expect(screen.getAllByText("Reads the live replenishment plan")).toHaveLength(2);
    expect(screen.getByText(/deepseek-flash/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Run Prepare a low-stock purchase proposal" }));

    expect(await screen.findByText("passed")).not.toBeNull();
    expect(screen.getByText("inventory_replenishmentPlan was called")).not.toBeNull();
    expect(screen.getByText("purchasing_createPurchaseOrder was called")).not.toBeNull();
    expect(screen.getByText(/awaiting approval/)).not.toBeNull();
    expect(screen.getByText("100 input tokens")).not.toBeNull();
    expect(screen.getAllByText("7.7s").length).toBeGreaterThan(0);

    await waitFor(() => expect(runBodies(fetchMock)).toHaveLength(1));
    expect(runBodies(fetchMock)[0]).toEqual({ scenarioId: "inventory-proposal-low-stock" });
    const runCall = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/evaluations/run" && init?.method === "POST");
    expect(runCall?.[1]?.credentials).toBe("same-origin");
    expect(runCall?.[1]?.headers).toMatchObject({
      "X-Organization-ID": ORGANIZATION_ID,
      "content-type": "application/json",
    });
  }, 20_000);

  it("runs every scenario sequentially from the Run all control", async () => {
    const fetchMock = stubEvaluationFetch();
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Run all" }));

    await waitFor(() => expect(runBodies(fetchMock)).toHaveLength(2));
    expect(runBodies(fetchMock).map((body) => body.scenarioId)).toEqual([
      "inventory-proposal-low-stock",
      "inventory-incoming-covers",
    ]);
    expect(await screen.findAllByText("passed")).toHaveLength(2);
  }, 20_000);

  it("keeps scenarios visible but disables runs when no live model is configured", async () => {
    stubEvaluationFetch({ catalog: { ...catalog, live: false, model: "" } });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByText("Prepare a low-stock purchase proposal")).not.toBeNull();
    expect(screen.getByText(/DEEPSEEK_API_KEY/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "Run all" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Run Prepare a low-stock purchase proposal" }) as HTMLButtonElement).disabled).toBe(true);
  }, 20_000);

  it("shows an admin-only message when the catalogue returns 403", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "evaluation runs require an organization admin" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByText(/limited to organization admins/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Run all" })).toBeNull();
    expect(screen.queryByText("Prepare a low-stock purchase proposal")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  }, 20_000);
  it("sanitizes em dashes from model output", async () => {
    stubEvaluationFetch({
      run: (scenarioId) => ({
        ...passedResult,
        scenarioId,
        finalAnswer: "The order is not placed \u2014 it is waiting for approval.",
      }),
    });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run Prepare a low-stock purchase proposal" }));
    expect(await screen.findByText(/not placed/)).not.toBeNull();
    expect(document.body.textContent ?? "").not.toContain("\u2014");
  }, 20_000);

  it("clears results when the active organization changes", async () => {
    stubEvaluationFetch();
    const { rerender } = render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run Prepare a low-stock purchase proposal" }));
    expect(await screen.findByText("passed")).not.toBeNull();

    rerender(<EvaluationPanel organizationId={"22222222-2222-4222-8222-222222222222"} />);
    await waitFor(() => expect(screen.queryByText("passed")).toBeNull());
  }, 20_000);

  it("renders seeded run history with summary, per-scenario trends, and recent runs", async () => {
    stubEvaluationFetch();
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByRole("heading", { name: "Run history" })).not.toBeNull();
    expect(screen.getByText("Baseline 90%: below")).not.toBeNull();
    expect(screen.getByText("2 runs, 1 passed, 50% pass rate.")).not.toBeNull();
    expect(screen.getByText("1/1 passed")).not.toBeNull();
    expect(screen.getByText("0/1 passed")).not.toBeNull();

    const list = screen.getByRole("list", { name: "Recent evaluation runs" });
    const runs = within(list).getAllByRole("listitem");
    expect(runs).toHaveLength(2);
    const [firstRun, secondRun] = runs;
    if (!firstRun || !secondRun) throw new Error("Expected two seeded runs");
    expect(firstRun.textContent).toContain("Prepare a low-stock purchase proposal");
    expect(firstRun.textContent).toContain("deepseek-chat");
    expect(firstRun.textContent).toContain("Passed");
    expect(firstRun.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-18T09:30:00Z");
    expect(secondRun.textContent).toContain("Avoid duplicate ordering when supply is incoming");
    expect(secondRun.textContent).toContain("Failed");
    expect(secondRun.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-17T14:05:00Z");

    expect(
      screen.getByRole("img", { name: "Run 1 for Prepare a low-stock purchase proposal: passed" }),
    ).not.toBeNull();
    expect(screen.getByRole("img", { name: "Run 1 for Avoid duplicate ordering when supply is incoming: failed" })).not.toBeNull();
  }, 20_000);

  it("shows a met baseline and per-scenario trends from a longer history", async () => {
    stubEvaluationFetch({ catalog: metHistoryCatalog });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByText("Baseline 90%: met")).not.toBeNull();
    expect(screen.getByText("11 runs, 10 passed, 91% pass rate.")).not.toBeNull();
    expect(screen.getByText("improving")).not.toBeNull();
    expect(screen.getByText("Latest 5: 5/5 passed. Previous 5: 4/5 passed.")).not.toBeNull();
    expect(screen.getByText("5/5 passed")).not.toBeNull();
    expect(screen.getByText("1/1 passed")).not.toBeNull();
    expect(screen.getByText("steady")).not.toBeNull();
  }, 20_000);

  it("shows a below baseline and a failed history case", async () => {
    stubEvaluationFetch({ catalog: failedHistoryCatalog });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByText("Baseline 90%: below")).not.toBeNull();
    expect(screen.getByText("3 runs, 1 passed, 33% pass rate.")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Prepare a low-stock purchase proposal, Failed/ }),
    ).not.toBeNull();
  }, 20_000);

  it("saves a new baseline and recomputes the verdict without refetching", async () => {
    const fetchMock = stubEvaluationFetch({ catalog: metHistoryCatalog });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByText("Baseline 90%: met")).not.toBeNull();
    const input = screen.getByRole("spinbutton", { name: "Baseline" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "Save baseline" }));

    expect(await screen.findByText("Baseline 95%: below", {}, { timeout: 5000 })).not.toBeNull();

    const calls = baselineCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const init = calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ passRate: 95 });
    expect(init?.headers).toMatchObject({
      "X-Organization-ID": ORGANIZATION_ID,
      "content-type": "application/json",
    });
    expect(init?.credentials).toBe("same-origin");

    const catalogReads = fetchMock.mock.calls.filter(
      ([path, readInit]) => String(path) === "/api/evaluations" && (readInit?.method ?? "GET") === "GET",
    );
    expect(catalogReads).toHaveLength(1);
  }, 20_000);

  it("reports recent release metrics and compares two models", async () => {
    stubEvaluationFetch({ catalog: releaseMetricsCatalog });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    const region = await screen.findByRole("region", { name: "Release metrics" });
    expect(within(region).getByText("Recent history only, not lifetime totals.")).not.toBeNull();
    expect(within(region).getByText("4")).not.toBeNull();
    expect(within(region).getByText("75%")).not.toBeNull();
    expect(within(region).getByText("5.0s")).not.toBeNull();
    expect(within(region).getByText("1,500")).not.toBeNull();
    expect(within(region).getByText("2")).not.toBeNull();

    const table = within(region).getByRole("table", { name: "Model comparison" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain("deepseek-flash");
    expect(rows[1]?.textContent).toContain("3");
    expect(rows[1]?.textContent).toContain("67%");
    expect(rows[1]?.textContent).toContain("4.0s");
    expect(rows[2]?.textContent).toContain("deepseek-chat");
    expect(rows[2]?.textContent).toContain("1");
    expect(rows[2]?.textContent).toContain("100%");
    expect(rows[2]?.textContent).toContain("8.0s");
  }, 20_000);

  it("opens a historical run detail from the last eight and collapses it", async () => {
    stubEvaluationFetch({ catalog: metHistoryCatalog });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    const runButton = await screen.findByRole("button", {
      name: /Avoid duplicate ordering when supply is incoming, Passed/,
    });
    expect(runButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(runButton);
    expect(
      await screen.findByText("Incoming stock already covers the shortfall, so I did not place another order."),
    ).not.toBeNull();
    expect(screen.getByText("inventory_replenishmentPlan")).not.toBeNull();
    expect(screen.getByText("Confirms incoming stock covers the gap")).not.toBeNull();
    expect(runButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close run detail for Avoid duplicate ordering when supply is incoming",
      }),
    );
    expect(
      screen.queryByText("Incoming stock already covers the shortfall, so I did not place another order."),
    ).toBeNull();
    expect(runButton.getAttribute("aria-expanded")).toBe("false");
  }, 20_000);

  it("clears a selected historical run when the organization changes", async () => {
    stubEvaluationFetch({ catalog: metHistoryCatalog });
    const { rerender } = render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);

    const runButton = await screen.findByRole("button", {
      name: /Avoid duplicate ordering when supply is incoming, Passed/,
    });
    fireEvent.click(runButton);
    expect(await screen.findByText(/Incoming stock already covers the shortfall/)).not.toBeNull();

    rerender(<EvaluationPanel organizationId={"22222222-2222-4222-8222-222222222222"} />);
    await waitFor(() => expect(screen.queryByText(/Incoming stock already covers the shortfall/)).toBeNull());
    expect(screen.queryByRole("button", { name: /Close run detail/ })).toBeNull();
  }, 20_000);

  it("adds a completed run to history once", async () => {
    stubEvaluationFetch({
      run: (scenarioId) => ({
        ...passedResult,
        scenarioId,
        persisted: true,
        createdAt: "2026-10-19T18:00:00Z",
      }),
    });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run Prepare a low-stock purchase proposal" }));

    expect(await screen.findByText("3 runs, 2 passed, 67% pass rate.")).not.toBeNull();
    expect(screen.getByText("2/2 passed")).not.toBeNull();

    const list = screen.getByRole("list", { name: "Recent evaluation runs" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(list.querySelectorAll('time[datetime="2026-10-19T18:00:00Z"]')).toHaveLength(1);
    expect(screen.queryByText("Not saved to history")).toBeNull();
  }, 20_000);

  it("does not duplicate a completed run that is already in recentRuns", async () => {
    stubEvaluationFetch({ run: () => historicalPassed });
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run Prepare a low-stock purchase proposal" }));

    await waitFor(() => expect(screen.getByText("2 runs, 1 passed, 50% pass rate.")).not.toBeNull());
    const list = screen.getByRole("list", { name: "Recent evaluation runs" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list.querySelectorAll('time[datetime="2026-10-18T09:30:00Z"]')).toHaveLength(1);
  }, 20_000);

  it("marks a completed run that was not persisted as not saved", async () => {
    stubEvaluationFetch();
    render(<EvaluationPanel organizationId={ORGANIZATION_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run Prepare a low-stock purchase proposal" }));

    expect(await screen.findByText("Not saved to history")).not.toBeNull();
    expect(screen.getByText("3 runs, 2 passed, 67% pass rate.")).not.toBeNull();
  }, 20_000);

});
