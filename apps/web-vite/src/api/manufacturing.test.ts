import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManufacturingApiError,
  fetchManufacturingBomReport,
  fetchManufacturingEnabled,
  fetchManufacturingReport,
  fetchProductionCostPreview,
  fetchProductionFeasibility,
  manufacturingActionRequest,
  submitManufacturingAction,
} from "./manufacturing";

const report = {
  boms: [{ assemblySku: "DESK-1", componentSku: "LEG-1", componentName: "Oak leg", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
  assemblies: [{ sku: "DESK-1", name: "Oak desk" }],
  workOrders: [{
    id: "wo-1",
    number: 7,
    assemblySku: "DESK-1",
    assemblyName: "Oak desk",
    status: "released",
    plannedQtyThousandths: 10_000,
    producedQtyThousandths: 4_000,
    yieldPctThousandths: 1_000_000,
    expectedGoodThousandths: 10_000,
    note: null,
    createdAt: "2026-05-12T10:30:00.000Z",
    completedAt: null,
  }],
  productionRuns: [{
    runId: "run-1",
    occurredAt: "2026-05-12T11:00:00.000Z",
    assemblySku: "DESK-1",
    producedThousandths: 2_000,
    unitCostMinor: 12_000,
    costTotalMinor: 24_000,
    reversed: false,
    components: [{ sku: "LEG-1", quantityThousandths: 8_000, lotCode: "LEG-MAY" }],
  }],
  lots: [{ id: "lot-1", sku: "LEG-1", lotCode: "LEG-MAY", expiresAt: "2026-06-01T00:00:00.000Z", balanceThousandths: 8_000 }],
};

const switchboard = { catalog: [{ id: "manufacturing" }], enabledModules: ["manufacturing"] };

function stubSequenced(responses: Array<Response | (() => Response)>) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockImplementationOnce(typeof response === "function" ? response : () => Promise.resolve(response));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("manufacturing API", () => {
  it("validates the manufacturing report payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(report)));
    const result = await fetchManufacturingReport();
    expect(result.boms[0]?.assemblySku).toBe("DESK-1");
    expect(result.workOrders[0]?.status).toBe("released");
    expect(result.productionRuns[0]?.components[0]?.lotCode).toBe("LEG-MAY");
    expect(result.lots[0]?.balanceThousandths).toBe(8_000);
  });

  it("defaults missing collections so a sparse payload still renders", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ boms: report.boms })));
    const result = await fetchManufacturingReport();
    expect(result).toEqual({ boms: report.boms, assemblies: [], workOrders: [], productionRuns: [], lots: [] });
  });

  it("rejects a report whose shapes drifted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...report, workOrders: [{ ...report.workOrders[0], createdAt: "not-a-date" }] })));
    await expect(fetchManufacturingReport()).rejects.toBeInstanceOf(ManufacturingApiError);
  });

  it("surfaces the server message when the report cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "manufacturing.write missing" }, { status: 403 })));
    await expect(fetchManufacturingReport()).rejects.toThrow("manufacturing.write missing");
  });

  it("checks the manufacturing module switchboard", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(switchboard)));
    await expect(fetchManufacturingEnabled()).resolves.toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...switchboard, enabledModules: [] })));
    await expect(fetchManufacturingEnabled()).resolves.toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "inventory" }], enabledModules: ["inventory"] })));
    await expect(fetchManufacturingEnabled()).rejects.toThrow("invalid manufacturing configuration");
  });

  it("accepts the real switchboard payload, whose catalog entries carry more than an id", async () => {
    // /api/modules returns the whole MODULE_CATALOG, so every entry also has
    // label, description, href, and protected. Rejecting those extra keys made
    // the live page report an unexpected format for a perfectly valid response.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      catalog: [{
        id: "manufacturing",
        label: "Manufacturing",
        description: "BOMs, work orders, production runs, traceability",
        href: "/manufacturing",
      }],
      enabledModules: ["manufacturing"],
    })));
    await expect(fetchManufacturingEnabled()).resolves.toBe(true);
  });

  it("preserves approval-pending writes and stamps a fresh intent id", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 })]);
    await expect(submitManufacturingAction({ action: "deleteBom", assemblySku: "DESK-1" })).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { action: string; intentId: string };
    expect(body.action).toBe("deleteBom");
    expect(body.intentId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("keeps defineBom on the legacy route by default", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: { componentCount: 1 } })]);
    await expect(submitManufacturingAction({
      action: "defineBom",
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    })).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/manufacturing");
  });

  it("maps defineBom to the authenticated Go capability contract when opted in", () => {
    const action = {
      action: "defineBom" as const,
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    };
    const request = manufacturingActionRequest(action, "intent-1", true);
    expect(request).toEqual({
      url: "/api/capabilities/execute",
      body: {
        capabilityId: "manufacturing.defineBom",
        input: { assemblySku: "DESK-1", components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }] },
        intentId: "intent-1",
      },
    });
  });

  it("submits defineBom through Go when explicitly opted in", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: { assemblyItemId: "item-1", componentCount: 1 } })]);
    await expect(submitManufacturingAction({
      action: "defineBom",
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    }, undefined, { useGoDefineBom: true })).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "manufacturing.defineBom",
      input: { assemblySku: "DESK-1", components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }] },
    });
  });

  it("falls back from a missing Go endpoint with the same intent ID", async () => {
    const fetchMock = stubSequenced([
      Response.json({ error: "not found" }, { status: 404 }),
      Response.json({ ok: true, data: { assemblyItemId: "item-1", componentCount: 1 } }),
    ]);
    await expect(submitManufacturingAction({
      action: "defineBom",
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    }, undefined, { useGoDefineBom: true })).resolves.toEqual({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/manufacturing"]);
    expect(first.intentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.intentId).toBe(first.intentId);
  });

  it("does not fall back to legacy when Go reports the slice disabled", async () => {
    const fetchMock = stubSequenced([
      Response.json({ error: "capability is disabled on this Go route" }, { status: 503 }),
    ]);
    await expect(submitManufacturingAction({
      action: "defineBom",
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    }, undefined, { useGoDefineBom: true })).rejects.toThrow("capability is disabled on this Go route");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("falls back to a readable reason when approval carries none", async () => {
    stubSequenced([Response.json({ ok: false, pendingApproval: true }, { status: 202 })]);
    await expect(submitManufacturingAction({ action: "reverseProductionRun", runId: "run-1" })).resolves.toEqual({ kind: "pending", reason: "This action is waiting for approval." });
  });

  it("completes governed writes and reloads the caller afterwards", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: { reversed: true } })]);
    await expect(submitManufacturingAction({ action: "produceFromBom", assemblySku: "DESK-1", quantityThousandths: 2000, lotCode: "DESK-MAY" })).resolves.toEqual({ kind: "completed" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: "produceFromBom", lotCode: "DESK-MAY" });
  });

  it("refuses write payloads that would not pass the capability contract", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitManufacturingAction({ action: "completeWorkOrder", workOrderId: "wo-1", quantityThousandths: 0 })).rejects.toThrow("Check the production details");
    await expect(submitManufacturingAction({ action: "defineBom", assemblySku: "DESK-1", components: [] })).rejects.toBeInstanceOf(ManufacturingApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports governed write failures with the server message", async () => {
    stubSequenced([Response.json({ ok: false, error: "DESK-1 has no bill of materials" }, { status: 422 })]);
    await expect(submitManufacturingAction({ action: "releaseWorkOrder", workOrderId: "wo-1" })).rejects.toThrow("DESK-1 has no bill of materials");
  });

  it("reads cost previews, feasibility, and BOM reports through the read envelope", async () => {
    const preview = {
      plannedThousandths: 2000,
      expectedGoodThousandths: 2000,
      producible: true,
      lines: [{ sku: "LEG-1", name: "Oak leg", requiredThousandths: 8000, unitCostMinor: 3000, costMinor: 24000 }],
      totalCostMinor: 24_000,
      resultingAvgFinishedUnitCostMinor: 12_000,
    };
    stubSequenced([Response.json({ ok: true, data: preview })]);
    await expect(fetchProductionCostPreview("DESK-1", 2000)).resolves.toMatchObject({ producible: true, totalCostMinor: 24_000 });

    stubSequenced([Response.json({
      ok: true,
      data: {
        producible: false,
        maxProducibleThousandths: 5000,
        estimatedLeadTimeDays: 4,
        lines: [{ itemId: "item-leg", requiredThousandths: 8000, onHandThousandths: 5000, shortfallThousandths: 3000 }],
      },
    })]);
    await expect(fetchProductionFeasibility("DESK-1", 2000)).resolves.toMatchObject({ maxProducibleThousandths: 5000, estimatedLeadTimeDays: 4 });

    stubSequenced([Response.json({
      ok: true,
      data: {
        producible: false,
        totalShortfallThousandths: 3000,
        lines: [{ sku: "LEG-1", name: "Oak leg", requiredThousandths: 8000, onHandThousandths: 5000, shortfallThousandths: 3000 }],
      },
    })]);
    await expect(fetchManufacturingBomReport("DESK-1", 2000)).resolves.toMatchObject({ totalShortfallThousandths: 3000 });
  });

  it("keeps read actions on the same-origin POST path with an intent id", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: { producible: true, lines: [], totalCostMinor: 0, resultingAvgFinishedUnitCostMinor: 0 } })]);
    await fetchProductionCostPreview("DESK-1", 1000);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/manufacturing");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ action: "costPreview", assemblySku: "DESK-1", quantityThousandths: 1000 });
  });

  it("rejects read responses that drift from the capability output", async () => {
    stubSequenced([Response.json({ ok: true, data: { producible: "yes", lines: [] } })]);
    await expect(fetchProductionCostPreview("DESK-1", 1000)).rejects.toThrow("unexpected format");
  });

  it("maps unreachable services to a retryable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(fetchManufacturingReport()).rejects.toThrow("Could not reach the manufacturing service");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(report)));
    await expect(fetchManufacturingReport()).resolves.toBeTruthy();
  });
});
