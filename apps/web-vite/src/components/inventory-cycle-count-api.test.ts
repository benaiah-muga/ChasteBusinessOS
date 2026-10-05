import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupInventoryBarcode, submitInventoryCycleCountAction, type InventoryCycleCountAction } from "../api/inventory-cycle-count";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("inventory cycle count API", () => {
  it("submits governed cycle count actions to the same-origin BFF", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { countId: "count-1", lineCount: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitInventoryCycleCountAction({ action: "createCycleCount", note: "Monthly audit", skus: ["MUG-1"], locationId: "loc-1" })).resolves.toEqual({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
    }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "createCycleCount", note: "Monthly audit", skus: ["MUG-1"], locationId: "loc-1" });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("distinguishes approval-pending responses and rejects malformed approvals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, pendingApproval: true, reason: "Needs a manager" }, { status: 202 })));
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" })).resolves.toEqual({ kind: "pending" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" })).rejects.toThrow("unexpected approval response");
  });

  it("surfaces BFF errors and rejects unexpected 2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "count is already posted" }), { status: 422 })));
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" })).rejects.toThrow("count is already posted");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" })).rejects.toThrow("unexpected action response");
  });

  it("returns a matched barcode item or an explicit null", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { item: { sku: "MUG-1", name: "Ceramic mug", tags: [] } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(lookupInventoryBarcode("MUG-CODE")).resolves.toEqual({ sku: "MUG-1", name: "Ceramic mug" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({ body: JSON.stringify({ action: "lookupByBarcode", barcode: "MUG-CODE" }) }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { item: null } })));
    await expect(lookupInventoryBarcode("UNKNOWN-CODE")).resolves.toBeNull();
  });

  it("persists the same Go intent across a timeout and module reload", async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { posted: true, postedVariances: 1, netVarianceThousandths: 500 } }))
      .mockImplementationOnce(async () => { throw new DOMException("Timed out", "TimeoutError"); })
      .mockResolvedValueOnce(Response.json({ ok: true, data: { posted: true, postedVariances: 1, netVarianceThousandths: 500 } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "postCycleCount", countId: "count-1" } as const;
    await expect(submitInventoryCycleCountAction(action, undefined, true))
      .rejects.toThrow("Check count history before retrying");
    const attemptEntries = Object.keys(localStorage).filter((key) => key.startsWith("chaste.inventory.cycle-count.intent.v1:"));
    expect(attemptEntries).toHaveLength(1);
    const firstAttemptId = localStorage.getItem(attemptEntries[0]!);
    await vi.resetModules();
    const reloadedClient = await import("../api/inventory-cycle-count");
    await expect(reloadedClient.submitInventoryCycleCountAction(action, undefined, true)).resolves.toEqual({ kind: "completed" });
    const intentIds = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as Record<string, unknown>).intentId);
    expect(intentIds[0]).toBe(firstAttemptId);
    expect(intentIds[0]).toBe(intentIds[1]);
  });

  it("maps only the four supported actions to their Go capability ids", async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string };
      const data = body.capabilityId === "inventory.createCycleCount"
        ? { countId: "count-1", lineCount: 1 }
        : body.capabilityId === "inventory.recordCycleCounts"
          ? { recorded: 1 }
          : body.capabilityId === "inventory.postCycleCount"
            ? { posted: true, postedVariances: 1, netVarianceThousandths: 500 }
            : { cancelled: true };
      return Response.json({ ok: true, data });
    });
    vi.stubGlobal("fetch", fetchMock);
    const actions: InventoryCycleCountAction[] = [
      { action: "createCycleCount", note: "Weekly", skus: ["SKU-1"], locationId: "loc-1" },
      { action: "recordCycleCounts", countId: "count-1", counts: [{ sku: "SKU-1", countedThousandths: 12_000 }] },
      { action: "postCycleCount", countId: "count-1" },
      { action: "cancelCycleCount", countId: "count-1" },
    ];
    const capabilityIds = [
      "inventory.createCycleCount",
      "inventory.recordCycleCounts",
      "inventory.postCycleCount",
      "inventory.cancelCycleCount",
    ];

    for (const action of actions) {
      await submitInventoryCycleCountAction(action, undefined, true);
    }

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(Array(4).fill("/api/capabilities/execute"));
    expect(bodies.map((body) => body.capabilityId)).toEqual(capabilityIds);
    expect(bodies[0]).toMatchObject({ input: { note: "Weekly", skus: ["SKU-1"], locationId: "loc-1" } });
    expect(bodies[1]).toMatchObject({ input: { countId: "count-1", counts: [{ sku: "SKU-1", countedThousandths: 12_000 }] } });
  });

  it("falls back only on a Go 404 and preserves the same intent id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { posted: true, postedVariances: 1, netVarianceThousandths: 500 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" }, undefined, true)).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/inventory"]);
    const goBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const legacyBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(goBody.intentId).toEqual(expect.any(String));
    expect(legacyBody.intentId).toBe(goBody.intentId);
    expect(legacyBody).toMatchObject({ action: "postCycleCount", countId: "count-1" });
  });

  it("does not fall back on malformed approvals or business errors", async () => {
    const pendingFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", pendingFetch);
    const action = { action: "cancelCycleCount", countId: "count-1" } as const;
    await expect(submitInventoryCycleCountAction(action, undefined, true)).rejects.toThrow("unexpected approval response");
    await expect(submitInventoryCycleCountAction(action, undefined, true)).resolves.toEqual({ kind: "pending" });
    expect(pendingFetch.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const pendingIds = pendingFetch.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as Record<string, unknown>).intentId);
    expect(pendingIds[0]).toBe(pendingIds[1]);

    localStorage.clear();
    const errorFetch = vi.fn(async (_path: RequestInfo | URL) => Response.json({ ok: false, error: "count is already posted" }, { status: 422 }));
    vi.stubGlobal("fetch", errorFetch);
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" }, undefined, true)).rejects.toThrow("count is already posted");
    expect(errorFetch).toHaveBeenCalledTimes(1);
    expect(errorFetch.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("does not fall back on non-404 errors and reuses the persisted attempt id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "service unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { cancelled: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancelCycleCount", countId: "count-1" } as const;

    await expect(submitInventoryCycleCountAction(action, undefined, true)).rejects.toThrow("service unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(submitInventoryCycleCountAction(action, undefined, true)).resolves.toEqual({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(first.intentId).toBe(second.intentId);
  });

  it("keeps the same attempt identity for pending approvals and malformed success responses", async () => {
    const pendingFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", pendingFetch);
    const action = { action: "cancelCycleCount", countId: "count-1" } as const;
    await expect(submitInventoryCycleCountAction(action, undefined, true)).resolves.toEqual({ kind: "pending" });
    await expect(submitInventoryCycleCountAction(action, undefined, true)).resolves.toEqual({ kind: "pending" });
    const pendingIds = pendingFetch.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as Record<string, unknown>).intentId);
    expect(pendingIds[0]).toBe(pendingIds[1]);

    localStorage.clear();
    const malformedFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { cancelled: "yes" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { cancelled: true } }));
    vi.stubGlobal("fetch", malformedFetch);
    await expect(submitInventoryCycleCountAction(action, undefined, true)).rejects.toThrow("unexpected action response");
    expect(malformedFetch).toHaveBeenCalledTimes(1);
    await expect(submitInventoryCycleCountAction(action, undefined, true)).resolves.toEqual({ kind: "completed" });
    const malformedIds = malformedFetch.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as Record<string, unknown>).intentId);
    expect(malformedIds[0]).toBe(malformedIds[1]);
  });
});
