import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProductDefaults, fetchProducts, fetchProductsEnabled, importProducts, ProductsApiError, submitProductAction, undoProductImport } from "./products";

afterEach(() => vi.unstubAllGlobals());

describe("products API", () => {
  it("validates and returns the catalog response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ totalValueMinor: 800, reorderAlerts: [], items: [{ sku: "MUG-1", name: "Mug", kind: "goods", unitLabel: "unit", onHandThousandths: 2000, valueMinor: 800, avgUnitCostMinor: 400, reorderPointThousandths: 1000, reorderNeeded: false }] })));
    await expect(fetchProducts()).resolves.toMatchObject({ items: [{ sku: "MUG-1", salePriceMinor: 0, tags: [] }], totalValueMinor: 800 });
  });

  it("checks the inventory module switchboard before displaying products", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "inventory" }], enabledModules: [] })));
    await expect(fetchProductsEnabled()).resolves.toBe(false);
  });

  it("validates inventory module defaults", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ module: "inventory", settings: { defaultUnitLabel: "carton", defaultReorderPointUnits: 12 } })));
    await expect(fetchProductDefaults()).resolves.toEqual({ defaultUnitLabel: "carton", defaultReorderPointUnits: 12 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ module: "accounting", settings: {} })));
    await expect(fetchProductDefaults()).rejects.toBeInstanceOf(ProductsApiError);
  });

  it("preserves pending approval and sends governed action intent IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitProductAction({ action: "archiveItem", sku: "MUG-1", archive: true })).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { action: string; intentId: string };
    expect(request.action).toBe("archiveItem");
    expect(request.intentId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects malformed successful payloads and invalid action inputs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
    await expect(submitProductAction({ action: "archiveItem", sku: "MUG-1", archive: true })).rejects.toBeInstanceOf(ProductsApiError);
    await expect(submitProductAction({ action: "createItem", sku: "", name: "", kind: "goods", unitLabel: "unit", salePriceMinor: 0, reorderPointThousandths: 0, tags: [] })).rejects.toThrow("Check the product details");
  });

  it("uses the governed batch import and supports approval aware undo", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ inserted: 1, skippedDuplicates: 0, errors: [], createdIds: ["10000000-0000-4000-8000-000000000001"] }))
      .mockResolvedValueOnce(Response.json({ error: "Owner review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const imported = await importProducts([{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods", unit: "box", salePrice: "3.25", tags: ["Pantry"] }]);
    expect(imported.inserted).toBe(1);
    await expect(undoProductImport(imported.createdIds ?? [])).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ entity: "products", rows: [{ sku: "TEA-1" }] });
  });
});
