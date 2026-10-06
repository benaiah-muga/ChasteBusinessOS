import { afterEach, describe, expect, it, vi } from "vitest";
import { getPendingInventoryAdjustment, submitInventoryItemAction } from "./inventory-items";

const retryScope = { actorId: "actor-1", organizationId: "org-1" };
const action = {
  action: "adjustStock",
  sku: "BEANS-1KG",
  quantityDelta: -500,
  note: "Damaged in storage",
} as const;

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("inventory item action API client", () => {
  it("recovers the exact adjustment and intent across pending approval and retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toEqual(action);
    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toEqual({ kind: "completed" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as { capabilityId: string; input: unknown; intentId: string },
    }));
    expect(requests.map(({ url }) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(requests[0]?.body).toMatchObject({ capabilityId: "inventory.adjustStock", input: { sku: action.sku, quantityDelta: -500, note: action.note } });
    expect(requests[1]?.body.intentId).toBe(requests[0]?.body.intentId);
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toBeNull();
  });

  it("keeps an uncertain adjustment recoverable and rejects a changed payload", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, retryScope)).rejects.toThrow("Could not reach the inventory service");
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toEqual(action);
    await expect(submitInventoryItemAction({ ...action, quantityDelta: -750 }, undefined, retryScope))
      .rejects.toThrow("A previous stock adjustment is unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed until the actor and organization scope is available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, { actorId: null, organizationId: "org-1" }))
      .rejects.toThrow("Wait for your account and organization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an empty corrupt retry marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);
    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("chaste.inventory.adjust-stock.pending.v1:"));
    expect(key).toBeDefined();
    localStorage.setItem(key!, "");

    await expect(getPendingInventoryAdjustment(retryScope)).rejects.toThrow("Enable browser storage to recover the pending stock adjustment safely");
    await expect(submitInventoryItemAction(action, undefined, retryScope)).rejects.toThrow("Enable browser storage before adjusting stock");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the same intent when only the Go capability route is missing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toEqual({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string; action: string };
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/inventory"]);
    expect(second).toMatchObject({ intentId: first.intentId, action: "adjustStock" });
  });

  it("retains a Go retry marker across rollback while allowing fresh scoped legacy adjustments", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);
    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });

    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", false);
    await expect(submitInventoryItemAction(action, undefined, retryScope))
      .rejects.toThrow("A Go stock adjustment is unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toEqual(action);

    const freshScope = { actorId: retryScope.actorId, organizationId: "org-2" };
    await expect(submitInventoryItemAction({ ...action, sku: "FRESH-ITEM" }, undefined, freshScope)).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/inventory"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ action: "adjustStock", sku: "FRESH-ITEM" });
  });

  it("clears an adjustment intent after a terminal client error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, error: "Invalid location" }, { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, retryScope)).rejects.toThrow("Invalid location");
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toBeNull();
  });

  it.each([408, 429])("retains the adjustment intent after retryable HTTP %i", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, error: "Try again" }, { status }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, retryScope)).rejects.toThrow("Try again");
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toEqual(action);
    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toEqual({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
  });
});
