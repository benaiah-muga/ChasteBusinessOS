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
  type ManufacturingWriteAction,
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

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

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

  it("routes planning reads through their Go capabilities when selected", async () => {
    vi.stubGlobal("__GO_MANUFACTURING_PLANNING_READS__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: {
        producible: true,
        plannedThousandths: 2000,
        expectedGoodThousandths: 2000,
        lines: [],
        totalCostMinor: 0,
        resultingAvgFinishedUnitCostMinor: 0,
      } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: {
        producible: true,
        maxProducibleThousandths: 3000,
        estimatedLeadTimeDays: null,
        lines: [],
      } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: {
        producible: true,
        totalShortfallThousandths: 0,
        lines: [],
      } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProductionCostPreview("DESK-1", 2000)).resolves.toMatchObject({ plannedThousandths: 2000 });
    await expect(fetchProductionFeasibility("DESK-1", 2000)).resolves.toMatchObject({ producible: true });
    await expect(fetchManufacturingBomReport("DESK-1", 2000)).resolves.toMatchObject({ totalShortfallThousandths: 0 });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    expect(requests.map(({ url }) => url)).toEqual(Array(3).fill("/api/capabilities/execute"));
    expect(requests.map(({ body }) => body.capabilityId)).toEqual([
      "manufacturing.costPreview",
      "manufacturing.checkProductionFeasibility",
      "manufacturing.bomReport",
    ]);
    expect(requests[0]?.body.input).toEqual({ assemblySku: "DESK-1", quantityThousandths: 2000 });
    expect(requests.every(({ body }) => typeof body.intentId === "string")).toBe(true);
  });

  it("validates planning read inputs before sending a request", async () => {
    vi.stubGlobal("__GO_MANUFACTURING_PLANNING_READS__", true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProductionCostPreview("  ", 1000)).rejects.toThrow("Check the production details");
    await expect(fetchProductionFeasibility("DESK-1", 0)).rejects.toThrow("Check the production details");
    await expect(fetchManufacturingBomReport("DESK-1", Number.NaN)).rejects.toThrow("Check the production details");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ expectedGoodThousandths: 1000, producible: true, lines: [], totalCostMinor: 0, resultingAvgFinishedUnitCostMinor: 0 }],
    [{ plannedThousandths: 1000, producible: true, lines: [], totalCostMinor: 0, resultingAvgFinishedUnitCostMinor: 0 }],
  ])("requires planned and expected-good quantities in a Go cost preview response", async (data) => {
    vi.stubGlobal("__GO_MANUFACTURING_PLANNING_READS__", true);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProductionCostPreview("DESK-1", 1000)).rejects.toThrow("unexpected format");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it.each([
    [202, { ok: false, pendingApproval: true, reason: "unexpected" }, "unexpectedly requires approval"],
    [200, { ok: true, data: { producible: "yes", lines: [] } }, "unexpected format"],
    [404, { error: "capability unavailable" }, "capability unavailable"],
  ])("fails closed on selected Go planning read response %i without legacy fallback", async (status, body, expected) => {
    vi.stubGlobal("__GO_MANUFACTURING_PLANNING_READS__", true);
    const fetchMock = stubSequenced([Response.json(body, { status })]);
    await expect(fetchProductionCostPreview("DESK-1", 1000)).rejects.toThrow(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("fails closed on empty or corrupt saved Go work order attempts", async () => {
    const scope = { actorId: "actor-1", organizationId: "org-1" };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(scope)));
    const scopeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const key = `chaste:manufacturing-work-order-attempt:${scopeHash}`;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const marker of ["", "{", "{}", JSON.stringify({ fingerprint: "not-a-digest", intentId: "not-a-uuid" })]) {
      window.localStorage.setItem(key, marker);
      await expect(submitManufacturingAction(
        { action: "releaseWorkOrder", workOrderId: "10000000-0000-4000-8000-000000000001" },
        undefined,
        { useGoWorkOrders: true, retryScope: scope },
      )).rejects.toThrow("Enable browser storage before changing manufacturing data");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(key)).toBe(marker);
    }
  });

  it("blocks selector rollback to legacy after an uncertain Go manufacturing write", async () => {
    const scope = { actorId: "actor-1", organizationId: "org-1" };
    const action = { action: "createWorkOrder" as const, assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000 };
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitManufacturingAction(action, undefined, { useGoWorkOrders: true, retryScope: scope }))
      .rejects.toBeInstanceOf(ManufacturingApiError);
    await expect(submitManufacturingAction(action, undefined, { useGoWorkOrders: false, retryScope: scope }))
      .rejects.toThrow("Restore Go manufacturing writes and retry that exact action");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("blocks selector rollback after Go 404 for BOM, work-order, and production writes", async () => {
    const actions: ManufacturingWriteAction[] = [
      { action: "defineBom", assemblySku: "DESK-1", components: [{ sku: "LEG-1", quantityThousandths: 1000, scrapPctThousandths: 0 }] },
      { action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: 1000, yieldPctThousandths: 1_000_000 },
      { action: "produceFromBom", assemblySku: "DESK-1", quantityThousandths: 1000 },
    ];
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "capability unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const [index, action] of actions.entries()) {
      const scope = { actorId: `actor-${index}`, organizationId: `org-${index}` };
      const goOptions = { useGoDefineBom: true, useGoWorkOrders: true, useGoProductionActions: true, retryScope: scope };
      const legacyOptions = { useGoDefineBom: false, useGoWorkOrders: false, useGoProductionActions: false, retryScope: scope };
      await expect(submitManufacturingAction(action, undefined, goOptions)).rejects.toMatchObject({ status: 404 });
      await expect(submitManufacturingAction(action, undefined, legacyOptions)).rejects.toThrow("Restore Go manufacturing writes and retry that exact action");
    }

    expect(fetchMock).toHaveBeenCalledTimes(actions.length);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });

  it("blocks legacy manufacturing writes when scope is unavailable and any Go attempt is unresolved", async () => {
    const scope = { actorId: "actor-1", organizationId: "org-1" };
    const action = { action: "produceFromBom" as const, assemblySku: "DESK-1", quantityThousandths: 2000, lotCode: "LOT-1" };
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitManufacturingAction(action, undefined, { useGoProductionActions: true, retryScope: scope }))
      .rejects.toBeInstanceOf(ManufacturingApiError);
    await expect(submitManufacturingAction(action, undefined, { useGoProductionActions: false }))
      .rejects.toThrow("A previous manufacturing result may be unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it.each([
    { action: { action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: 1000, yieldPctThousandths: 1_000_000 }, expectedAction: "createWorkOrder" },
    { action: { action: "produceFromBom", assemblySku: "DESK-1", quantityThousandths: 1000 }, expectedAction: "produceFromBom" },
  ] as const)("keeps $expectedAction on legacy when its Go selector is off", async ({ action, expectedAction }) => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: {} })]);
    await expect(submitManufacturingAction(action, undefined, {
      useGoDefineBom: false,
      useGoWorkOrders: false,
      useGoProductionActions: false,
      retryScope: { actorId: "actor-1", organizationId: "org-1" },
    })).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/manufacturing"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: expectedAction });
  });

  it("maps all four work order actions to their Go capability envelopes", () => {
    const cases = [
      [{ action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000 }, "manufacturing.createWorkOrder", { assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000 }],
      [{ action: "releaseWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111" }, "manufacturing.releaseWorkOrder", { workOrderId: "11111111-1111-4111-8111-111111111111" }],
      [{ action: "completeWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111", quantityThousandths: 1000, lotCode: "LOT-1" }, "manufacturing.completeWorkOrder", { workOrderId: "11111111-1111-4111-8111-111111111111", quantityThousandths: 1000, lotCode: "LOT-1" }],
      [{ action: "cancelWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111" }, "manufacturing.cancelWorkOrder", { workOrderId: "11111111-1111-4111-8111-111111111111" }],
    ] as const;
    for (const [action, capabilityId, input] of cases) {
      expect(manufacturingActionRequest(action, "intent-12345678901234567890", false, true)).toEqual({
        url: "/api/capabilities/execute",
        body: { capabilityId, input, intentId: "intent-12345678901234567890" },
      });
      expect(manufacturingActionRequest(action, "intent-12345678901234567890", false)).toMatchObject({ url: "/api/manufacturing" });
    }
  });

  it("fails closed before a Go work order request when actor or organization scope is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitManufacturingAction({ action: "cancelWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111" }, undefined, {
      useGoWorkOrders: true,
      retryScope: { actorId: null, organizationId: "org-1" },
    })).rejects.toThrow("Wait for your account and organization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps BOM production and run reversal to their Go capability inputs", () => {
    expect(manufacturingActionRequest({
      action: "produceFromBom", assemblySku: "DESK-1", quantityThousandths: 2000, lotCode: "LOT-1",
    }, "intent-12345678901234567890", false, false, true)).toEqual({
      url: "/api/capabilities/execute",
      body: { capabilityId: "manufacturing.produceFromBom", input: { assemblySku: "DESK-1", quantityThousandths: 2000, lotCode: "LOT-1" }, intentId: "intent-12345678901234567890" },
    });
    expect(manufacturingActionRequest({
      action: "reverseProductionRun", runId: "33333333-3333-4333-8333-333333333333",
    }, "intent-12345678901234567890", false, false, true)).toEqual({
      url: "/api/capabilities/execute",
      body: { capabilityId: "manufacturing.reverseProductionRun", input: { runRef: "33333333-3333-4333-8333-333333333333" }, intentId: "intent-12345678901234567890" },
    });
  });

  it("keeps BOM production identity through uncertain and pending outcomes and validates Go output", async () => {
    const action = { action: "produceFromBom" as const, assemblySku: "DESK-1", quantityThousandths: 2000, lotCode: "LOT-1" };
    const options = { useGoProductionActions: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Supervisor review" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: {
        runRef: "33333333-3333-4333-8333-333333333333", producedThousandths: 2000,
        consumedComponents: [{ sku: "LEG-1", quantityThousandths: 8000 }], costRolledUpMinor: 24000,
      } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitManufacturingAction(action, undefined, options)).rejects.toBeInstanceOf(ManufacturingApiError);
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toMatchObject({ kind: "pending", reason: "Supervisor review" });
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toEqual({ kind: "completed" });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; capabilityId: string });
    expect(bodies).toHaveLength(3);
    expect(bodies.every((body) => body.capabilityId === "manufacturing.produceFromBom" && body.intentId === bodies[0]?.intentId)).toBe(true);
  });

  it("validates reversal output and fails closed before Go when scope or run UUID is invalid", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: {
      reversedMovements: 3, removedFinishedThousandths: 2000,
      restoredComponents: [{ sku: "LEG-1", quantityThousandths: 8000 }],
      removedProduced: [{ sku: "DESK-1", quantityThousandths: 2000 }],
    } })]);
    const action = { action: "reverseProductionRun" as const, runId: "33333333-3333-4333-8333-333333333333" };
    const options = { useGoProductionActions: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toEqual({ kind: "completed" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "manufacturing.reverseProductionRun", input: { runRef: action.runId },
    });

    const noRequest = vi.fn();
    vi.stubGlobal("fetch", noRequest);
    await expect(submitManufacturingAction(action, undefined, { ...options, retryScope: { actorId: null, organizationId: "org-1" } })).rejects.toThrow("Wait for your account and organization");
    await expect(submitManufacturingAction({ ...action, runId: "run-1" }, undefined, options)).rejects.toThrow("valid ID");
    expect(noRequest).not.toHaveBeenCalled();
  });

  it("rejects malformed Go production output and keeps the unresolved retry identity", async () => {
    const action = { action: "reverseProductionRun" as const, runId: "33333333-3333-4333-8333-333333333333" };
    const options = { useGoProductionActions: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };
    const fetchMock = stubSequenced([Response.json({ ok: true, data: { reversedMovements: 3 } })]);
    await expect(submitManufacturingAction(action, undefined, options)).rejects.toThrow("unexpected production response");
    await expect(submitManufacturingAction({ action: "produceFromBom", assemblySku: "DESK-1", quantityThousandths: 1000 }, undefined, options)).rejects.toThrow("previous manufacturing result is unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      action: { action: "produceFromBom", assemblySku: "DESK-1", quantityThousandths: 1000 },
      capabilityId: "manufacturing.produceFromBom",
      data: { runRef: "33333333-3333-4333-8333-333333333333", producedThousandths: 1000, consumedComponents: [], costRolledUpMinor: 0 },
    },
    {
      action: { action: "reverseProductionRun", runId: "33333333-3333-4333-8333-333333333333" },
      capabilityId: "manufacturing.reverseProductionRun",
      data: { reversedMovements: 0, removedFinishedThousandths: 0, restoredComponents: [], removedProduced: [] },
    },
  ] as const)("keeps the exact Go production write on Go after a 404: $capabilityId", async ({ action, capabilityId, data }) => {
    const fetchMock = stubSequenced([
      Response.json({ error: "capability unavailable" }, { status: 404 }),
      Response.json({ ok: true, data }),
    ]);
    const options = { useGoProductionActions: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };

    await expect(submitManufacturingAction(action, undefined, options)).rejects.toMatchObject({ status: 404 });
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toEqual({ kind: "completed" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string });
    expect(bodies[0]).toMatchObject({ capabilityId, input: expect.any(Object), intentId: expect.any(String) });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("retains the exact Go intent through network uncertainty and approval pending, then clears on success", async () => {
    const action = { action: "createWorkOrder" as const, assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000 };
    const options = { useGoWorkOrders: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(Response.json({
        ok: false,
        pendingApproval: true,
        reason: "amount 50001 exceeds autonomous threshold 50000",
        approvalId: "33333333-3333-4333-8333-333333333333",
      }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { workOrderId: "33333333-3333-4333-8333-333333333333", number: 10, expectedGoodThousandths: 4000 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { workOrderId: "44444444-4444-4444-8444-444444444444", number: 11, expectedGoodThousandths: 4000 } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitManufacturingAction(action, undefined, options)).rejects.toBeInstanceOf(ManufacturingApiError);
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toEqual({ kind: "completed" });
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { intentId: string; capabilityId: string });
    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => body.intentId)).toEqual([bodies[0]?.intentId, bodies[0]?.intentId, bodies[0]?.intentId]);
    expect(bodies[0]?.capabilityId).toBe("manufacturing.createWorkOrder");
    await submitManufacturingAction(action, undefined, options);
    const newAttempt = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as { intentId: string };
    expect(newAttempt.intentId).not.toBe(bodies[0]?.intentId);
  });

  it.each([
    {
      action: { action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000 },
      capabilityId: "manufacturing.createWorkOrder",
      data: { workOrderId: "33333333-3333-4333-8333-333333333333", number: 10, expectedGoodThousandths: 4000 },
    },
    {
      action: { action: "releaseWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111" },
      capabilityId: "manufacturing.releaseWorkOrder",
      data: { released: true },
    },
    {
      action: { action: "completeWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111", quantityThousandths: 1000 },
      capabilityId: "manufacturing.completeWorkOrder",
      data: { runRef: "33333333-3333-4333-8333-333333333333", completed: true, producedTotalThousandths: 1000, status: "completed", producedThousandths: 1000, consumedComponents: [], costRolledUpMinor: 0 },
    },
    {
      action: { action: "cancelWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111" },
      capabilityId: "manufacturing.cancelWorkOrder",
      data: { cancelled: true },
    },
  ] as const)("keeps the exact Go work order write on Go after a 404: $capabilityId", async ({ action, capabilityId, data }) => {
    const fetchMock = stubSequenced([
      Response.json({ error: "capability unavailable" }, { status: 404 }),
      Response.json({ ok: true, data }),
    ]);
    const options = { useGoWorkOrders: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };

    await expect(submitManufacturingAction(action, undefined, options)).rejects.toMatchObject({ status: 404 });
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toEqual({ kind: "completed" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string });
    expect(bodies[0]).toMatchObject({ capabilityId, input: expect.any(Object), intentId: expect.any(String) });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("retires a Go retry intent after a terminal client rejection", async () => {
    const fetchMock = stubSequenced([
      Response.json({ error: "work order not found" }, { status: 422 }),
      Response.json({ ok: true, data: { cancelled: true } }),
    ]);
    const action = { action: "cancelWorkOrder" as const, workOrderId: "11111111-1111-4111-8111-111111111111" };
    const options = { useGoWorkOrders: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };
    await expect(submitManufacturingAction(action, undefined, options)).rejects.toThrow("work order not found");
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toEqual({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(second.intentId).not.toBe(first.intentId);
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

  it("submits defineBom through Go with scoped exact retry identity", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: { assemblyItemId: "item-1", componentCount: 1 } })]);
    await expect(submitManufacturingAction({
      action: "defineBom",
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    }, undefined, { useGoDefineBom: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } })).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "manufacturing.defineBom",
      input: { assemblySku: "DESK-1", components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }] },
    });
  });

  it("keeps defineBom on Go after 404 and retries with the exact scoped intent", async () => {
    const fetchMock = stubSequenced([
      Response.json({ error: "capability unavailable" }, { status: 404 }),
      Response.json({ ok: true, data: { assemblyItemId: "item-1", componentCount: 1 } }),
    ]);
    const action: ManufacturingWriteAction = {
      action: "defineBom",
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    };
    const options = { useGoDefineBom: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };
    await expect(submitManufacturingAction(action, undefined, options)).rejects.toMatchObject({ status: 404 });
    await expect(submitManufacturingAction(action, undefined, options)).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
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
    }, undefined, { useGoDefineBom: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } })).rejects.toThrow("capability is disabled on this Go route");
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
    await expect(submitManufacturingAction({ action: "completeWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111", quantityThousandths: 0 })).rejects.toThrow("Check the production details");
    await expect(submitManufacturingAction({ action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: Number.MAX_SAFE_INTEGER, yieldPctThousandths: 1_000_000 })).rejects.toThrow("Check the production details");
    await expect(submitManufacturingAction({ action: "defineBom", assemblySku: "DESK-1", components: [] })).rejects.toBeInstanceOf(ManufacturingApiError);
    await expect(submitManufacturingAction({ action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: 2_147_483_648, yieldPctThousandths: 1_000_000 })).rejects.toThrow("Check the production details");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts MaxInt32 planned quantity and rejects the next integer", async () => {
    const fetchMock = stubSequenced([Response.json({ ok: true, data: {
      workOrderId: "33333333-3333-4333-8333-333333333333", number: 10, expectedGoodThousandths: 2_147_483_647,
    } })]);
    const options = { useGoWorkOrders: true, retryScope: { actorId: "actor-1", organizationId: "org-1" } };
    await expect(submitManufacturingAction({
      action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: 2_147_483_647, yieldPctThousandths: 1_000_000,
    }, undefined, options)).resolves.toEqual({ kind: "completed" });
    await expect(submitManufacturingAction({
      action: "createWorkOrder", assemblySku: "DESK-1", plannedQtyThousandths: 2_147_483_648, yieldPctThousandths: 1_000_000,
    }, undefined, options)).rejects.toThrow("Check the production details");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports governed write failures with the server message", async () => {
    stubSequenced([Response.json({ ok: false, error: "DESK-1 has no bill of materials" }, { status: 422 })]);
    await expect(submitManufacturingAction({ action: "releaseWorkOrder", workOrderId: "11111111-1111-4111-8111-111111111111" })).rejects.toThrow("DESK-1 has no bill of materials");
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
