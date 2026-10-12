import { afterEach, describe, expect, it, vi } from "vitest";
import { getPendingInventoryAdjustment, getPendingInventoryItemCreation, submitInventoryItemAction } from "./inventory-items";
import type { InventoryItemAction } from "./inventory-items";

const retryScope = { actorId: "actor-1", organizationId: "org-1" };
const action = {
  action: "adjustStock",
  sku: "BEANS-1KG",
  quantityDelta: -500,
  note: "Damaged in storage",
} as const;
const createAction = {
  action: "createItem",
  sku: "BEANS-1KG",
  name: "Beans 1kg",
  kind: "goods",
  unitLabel: "bag",
  salePriceMinor: 2500,
  reorderPointThousandths: 0,
  tags: [] as string[],
} satisfies InventoryItemAction;

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("inventory item action API client", () => {
  it("recovers the exact Go item creation and intent across approval and retry", async () => {
    const itemId = "40000000-0000-4000-8000-000000000004";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: false,
        pendingApproval: true,
        reason: "Owner review",
        approvalId: "40000000-0000-4000-8000-000000000005",
      }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { itemId } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(createAction, undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    await expect(getPendingInventoryItemCreation(retryScope)).resolves.toEqual(createAction);
    await expect(submitInventoryItemAction({ ...createAction, name: "Different item" }, undefined, retryScope))
      .rejects.toThrow("A previous item creation is unresolved");
    await expect(submitInventoryItemAction(createAction, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { itemId } });

    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(getPendingInventoryItemCreation(retryScope)).resolves.toBeNull();
  });

  it("recovers the exact adjustment and intent across pending approval and retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toEqual(action);
    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { onHandThousandths: 6500 } });

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

  it("fails closed when the Go capability route is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(action, undefined, retryScope)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("retains a Go item creation marker on 404 and fails closed when Go is disabled", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "route not mounted" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { itemId: "40000000-0000-4000-8000-000000000004" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(submitInventoryItemAction(createAction, undefined, retryScope)).rejects.toMatchObject({ status: 404 });
    await expect(getPendingInventoryItemCreation(retryScope)).resolves.toEqual(createAction);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", false);
    await expect(submitInventoryItemAction(createAction, undefined, retryScope))
      .rejects.toThrow("Go inventory item writes are not enabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);
    await expect(submitInventoryItemAction(createAction, undefined, retryScope)).resolves.toEqual({
      kind: "completed",
      data: { itemId: "40000000-0000-4000-8000-000000000004" },
    });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
  });

  it("fails closed for every item write when Go is disabled, including fresh scoped actions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);
    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });

    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", false);
    await expect(submitInventoryItemAction(action, undefined, retryScope))
      .rejects.toThrow("Go inventory item writes are not enabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(getPendingInventoryAdjustment(retryScope)).resolves.toEqual(action);

    const freshScope = { actorId: retryScope.actorId, organizationId: "org-2" };
    await expect(submitInventoryItemAction({ ...action, sku: "FRESH-ITEM" }, undefined, freshScope))
      .rejects.toThrow("Go inventory item writes are not enabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
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
    await expect(submitInventoryItemAction(action, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { onHandThousandths: 6500 } });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
  });
});
