import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryCycleCountApiError, lookupInventoryBarcode } from "./inventory-cycle-count";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("inventory barcode lookup", () => {
  it("uses the legacy inventory action when Go is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { item: { sku: "SKU-1", name: "Widget" } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupInventoryBarcode("12345", undefined, false)).resolves.toEqual({ sku: "SKU-1", name: "Widget" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/inventory");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ action: "lookupByBarcode", barcode: "12345" });
  });

  it("uses the Go capability and preserves the not-found null result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { item: null } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupInventoryBarcode("12345", undefined, true)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      capabilityId: "inventory.lookupByBarcode",
      input: { barcode: "12345" },
    });
  });

  it("falls back to the legacy action when the Go capability route is missing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { item: { sku: "SKU-1", name: "Widget" } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupInventoryBarcode("12345", undefined, true)).resolves.toEqual({ sku: "SKU-1", name: "Widget" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/inventory");
  });

  it("rejects an unexpected capability response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { item: { sku: "SKU-1" } } })));

    await expect(lookupInventoryBarcode("12345", undefined, true)).rejects.toBeInstanceOf(InventoryCycleCountApiError);
  });
});
