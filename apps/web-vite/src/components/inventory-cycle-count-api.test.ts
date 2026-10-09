import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupInventoryBarcode, submitInventoryCycleCountAction, type InventoryCycleCountAction } from "../api/inventory-cycle-count";

let retryScopeNumber = 0;
function nextRetryScope() {
  retryScopeNumber += 1;
  return { actorId: `actor-${retryScopeNumber}`, organizationId: `org-${retryScopeNumber}` };
}
let retryScope = nextRetryScope();

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  retryScope = nextRetryScope();
});

describe("inventory cycle count API", () => {
  it("keeps the legacy route available when the Go selector is disabled", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { countId: "count-1", lineCount: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitInventoryCycleCountAction({ action: "createCycleCount", note: "Monthly audit", skus: ["MUG-1"], locationId: "loc-1" }, undefined, false, retryScope)).resolves.toEqual({ kind: "completed" });
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
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" }, undefined, true, retryScope)).resolves.toEqual({ kind: "pending" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" }, undefined, true, retryScope)).rejects.toThrow("unexpected approval response");
  });

  it("surfaces BFF errors and rejects unexpected 2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "count is already posted" }), { status: 422 })));
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" }, undefined, true, retryScope)).rejects.toThrow("count is already posted");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" }, undefined, true, retryScope)).rejects.toThrow("unexpected action response");
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
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope))
      .rejects.toThrow("Check count history before retrying");
    const attemptEntries = Object.keys(localStorage).filter((key) => key.startsWith("chaste.inventory.cycle-count.intent.v2:") && !key.includes(":scope:"));
    expect(attemptEntries).toHaveLength(1);
    const firstAttemptId = localStorage.getItem(attemptEntries[0]!);
    await vi.resetModules();
    const reloadedClient = await import("../api/inventory-cycle-count");
    await expect(reloadedClient.submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "completed" });
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
      await submitInventoryCycleCountAction(action, undefined, true, retryScope);
    }

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(Array(4).fill("/api/capabilities/execute"));
    expect(bodies.map((body) => body.capabilityId)).toEqual(capabilityIds);
    expect(bodies[0]).toMatchObject({ input: { note: "Weekly", skus: ["SKU-1"], locationId: "loc-1" } });
    expect(bodies[1]).toMatchObject({ input: { countId: "count-1", counts: [{ sku: "SKU-1", countedThousandths: 12_000 }] } });
  });

  it("does not fall back on a Go 404 and keeps the exact attempt for retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { posted: true, postedVariances: 1, netVarianceThousandths: 500 } }));
    vi.stubGlobal("fetch", fetchMock);

    const action = { action: "postCycleCount", countId: "count-1" } as const;
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).rejects.toThrow("not found");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute"]);
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies[0]?.intentId).toEqual(expect.any(String));
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
  });

  it("keeps the scoped intent when a Go error response is malformed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "invalid response envelope" }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { cancelled: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancelCycleCount", countId: "count-1" } as const;

    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).rejects.toThrow("invalid response envelope");
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "completed" });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies[0]?.intentId).toBe(bodies[1]?.intentId);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
  });

  it("does not fall back on malformed approvals or business errors", async () => {
    const pendingFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", pendingFetch);
    const action = { action: "cancelCycleCount", countId: "count-1" } as const;
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).rejects.toThrow("unexpected approval response");
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "pending" });
    expect(pendingFetch.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const pendingIds = pendingFetch.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as Record<string, unknown>).intentId);
    expect(pendingIds[0]).toBe(pendingIds[1]);

    localStorage.clear();
    retryScope = nextRetryScope();
    const errorFetch = vi.fn(async (_path: RequestInfo | URL) => Response.json({ ok: false, error: "count is already posted" }, { status: 422 }));
    vi.stubGlobal("fetch", errorFetch);
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" }, undefined, true, retryScope)).rejects.toThrow("count is already posted");
    expect(errorFetch).toHaveBeenCalledTimes(1);
    expect(errorFetch.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("does not fall back on non-404 errors and reuses the persisted attempt id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "service unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { cancelled: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancelCycleCount", countId: "count-1" } as const;

    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).rejects.toThrow("service unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "completed" });
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
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "pending" });
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "pending" });
    const pendingIds = pendingFetch.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as Record<string, unknown>).intentId);
    expect(pendingIds[0]).toBe(pendingIds[1]);

    localStorage.clear();
    const malformedFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { cancelled: "yes" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { cancelled: true } }));
    vi.stubGlobal("fetch", malformedFetch);
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).rejects.toThrow("unexpected action response");
    expect(malformedFetch).toHaveBeenCalledTimes(1);
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).resolves.toEqual({ kind: "completed" });
    const malformedIds = malformedFetch.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as Record<string, unknown>).intentId);
    expect(malformedIds[0]).toBe(malformedIds[1]);
  });

  it("scopes Go retries to the actor and organization and blocks a different unresolved action", async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => { throw new DOMException("Timed out", "TimeoutError"); });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "postCycleCount", countId: "count-1" } as const;
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).rejects.toThrow("Check count history");
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" }, undefined, true, retryScope))
      .rejects.toThrow("Retry that exact action");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const otherScope = { actorId: `actor-${crypto.randomUUID()}`, organizationId: `org-${crypto.randomUUID()}` };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { posted: true, postedVariances: 0, netVarianceThousandths: 0 } })));
    await expect(submitInventoryCycleCountAction(action, undefined, true, otherScope)).resolves.toEqual({ kind: "completed" });
  });

  it("requires a loaded actor and organization before a Go cycle-count write", async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" }, undefined, true))
      .rejects.toThrow("account and organization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a loaded actor and organization before a legacy rollback write", async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" }, undefined, false))
      .rejects.toThrow("account and organization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks legacy rollback while a Go write outcome is unresolved", async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => { throw new DOMException("Timed out", "TimeoutError"); });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "postCycleCount", countId: "count-1" } as const;
    await expect(submitInventoryCycleCountAction(action, undefined, true, retryScope)).rejects.toThrow("Check count history");
    await expect(submitInventoryCycleCountAction(action, undefined, false, retryScope)).rejects.toThrow("unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });
});
