import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationPanel } from "./EvaluationPanel";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

const catalog = {
  live: true,
  model: "deepseek-flash",
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
};

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

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function stubEvaluationFetch(overrides: { catalog?: unknown; run?: (scenarioId: string) => unknown } = {}) {
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
    expect(screen.getByText("7.7s")).not.toBeNull();

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

});
