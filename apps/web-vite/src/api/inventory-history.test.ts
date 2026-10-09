import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInventoryHistory, InventoryHistoryApiError } from "./inventory-history";

const movement = {
  id: "movement-1",
  quantityDelta: -1250,
  reason: "adjustment",
  note: "Damaged during handling",
  refType: null,
  unitCostMinor: 825,
  lotCode: "LOT-9",
  locationCode: "MAIN",
  actorType: "human",
  createdAt: "2026-09-30T10:15:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("fetchInventoryHistory", () => {
  it("loads history through the existing SKU query contract and validates movements", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ movements: [movement] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInventoryHistory("SKU-1")).resolves.toEqual({ kind: "loaded", movements: [movement] });
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory?sku=SKU-1", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
    }));
  });

  it("returns a pending approval outcome without treating it as empty history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, pendingApproval: true, reason: "Manager approval required." }), { status: 202 })));
    await expect(fetchInventoryHistory("SKU-1")).resolves.toEqual({ kind: "pending", reason: "Manager approval required." });
  });

  it("rejects malformed history rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ movements: [{ ...movement, quantityDelta: "-1250" }] }), { status: 200 })));
    await expect(fetchInventoryHistory("SKU-1")).rejects.toMatchObject({
      name: "InventoryHistoryApiError",
      status: 200,
      message: expect.stringContaining("unexpected format"),
    });
  });

  it("rejects an unexpected history envelope or extra movement fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ movements: [movement], extra: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ movements: [{ ...movement, extra: true }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInventoryHistory("SKU-1")).rejects.toMatchObject({
      name: "InventoryHistoryApiError",
      status: 200,
      message: expect.stringContaining("unexpected format"),
    });
    await expect(fetchInventoryHistory("SKU-1")).rejects.toMatchObject({
      name: "InventoryHistoryApiError",
      status: 200,
      message: expect.stringContaining("unexpected format"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces API errors, session expiry, and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Item not found." }), { status: 404 })));
    await expect(fetchInventoryHistory("MISSING")).rejects.toMatchObject({ status: 404, message: "Item not found." });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "No item with this SKU." }), { status: 422 })));
    await expect(fetchInventoryHistory("MISSING")).rejects.toMatchObject({ status: 422, message: "No item with this SKU." });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
    await expect(fetchInventoryHistory("SKU-1")).rejects.toMatchObject({ status: 401, message: expect.stringContaining("session has ended") });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(fetchInventoryHistory("SKU-1")).rejects.toBeInstanceOf(InventoryHistoryApiError);
    await expect(fetchInventoryHistory("SKU-1")).rejects.toMatchObject({ status: 0, message: expect.stringContaining("connection") });
  });

  it("fails a stalled history request after its timeout signal aborts", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Request timed out", "TimeoutError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchInventoryHistory("SKU-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory?sku=SKU-1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    timeoutController.abort();
    await expect(request).rejects.toMatchObject({
      name: "InventoryHistoryApiError",
      status: 0,
      message: expect.stringContaining("connection"),
    });
    timeout.mockRestore();
  });
});
