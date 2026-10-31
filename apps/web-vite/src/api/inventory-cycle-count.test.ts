import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryCycleCountApiError, lookupInventoryBarcode } from "./inventory-cycle-count";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("inventory barcode lookup", () => {
  it("fails closed when a request explicitly disables the Go capability", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupInventoryBarcode("12345", undefined, false)).rejects.toThrow("Go barcode lookup is not enabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the Go capability and preserves the not-found null result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { item: null } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupInventoryBarcode("12345", undefined, true, "org-inventory-test")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["X-Organization-ID"]).toBe("org-inventory-test");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      capabilityId: "inventory.lookupByBarcode",
      input: { barcode: "12345" },
    });
  });

  it("does not fall back to a legacy action when the Go capability route fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupInventoryBarcode("12345", undefined, true)).rejects.toBeInstanceOf(InventoryCycleCountApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("rejects an unexpected capability response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { item: { sku: "SKU-1" } } })));

    await expect(lookupInventoryBarcode("12345", undefined, true)).rejects.toBeInstanceOf(InventoryCycleCountApiError);
  });
});
