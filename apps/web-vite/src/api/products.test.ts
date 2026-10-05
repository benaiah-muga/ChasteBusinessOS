import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProductDefaults, fetchProducts, fetchProductsEnabled, importProducts, productActionRequest, ProductsApiError, submitProductAction, undoProductImport, type ProductAction } from "./products";

afterEach(() => vi.unstubAllGlobals());

describe("products API", () => {
  it("validates and returns the catalog response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ totalValueMinor: 800, reorderAlerts: [], items: [{ sku: "MUG-1", name: "Mug", kind: "goods", unitLabel: "unit", onHandThousandths: 2000, valueMinor: 800, avgUnitCostMinor: 400, reorderPointThousandths: 1000, reorderNeeded: false }] })));
    await expect(fetchProducts()).resolves.toMatchObject({ items: [{ sku: "MUG-1", salePriceMinor: 0, tags: [] }], totalValueMinor: 800 });
  });

  it("uses the governed Go stock report for the Products catalog when the Go slice is enabled", async () => {
    const stock = { items: [{ sku: "MUG-1", name: "Mug", kind: "goods", unitLabel: "unit", salePriceMinor: 500, tags: ["kitchen"], barcode: null, imageUrl: null, onHandThousandths: 500, valueMinor: 200, avgUnitCostMinor: 400, reorderPointThousandths: 1000, reorderNeeded: true }], totalValueMinor: 200 };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: stock }));
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProducts()).resolves.toMatchObject({
      items: [{ sku: "MUG-1", salePriceMinor: 500, tags: ["kitchen"] }],
      reorderAlerts: [{
        sku: "MUG-1", name: "Mug", onHandThousandths: 500, reorderPointThousandths: 1000,
        shortfallThousandths: 500, avgUnitCostMinor: 400,
      }],
      totalValueMinor: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "inventory.stockReport", input: { belowReorderOnly: false }, intentId: expect.any(String),
    });
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
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true, reason: "Owner review", approvalId: "approval-123" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitProductAction({ action: "archiveItem", sku: "MUG-1", archive: true })).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { action: string; intentId: string };
    expect(request.action).toBe("archiveItem");
    expect(request.intentId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  const goProductActions: Array<[ProductAction, string]> = [
    [{ action: "createItem", sku: "MUG-1", name: "Mug", kind: "goods", unitLabel: "unit", salePriceMinor: 500, reorderPointThousandths: 0, tags: [] }, "inventory.createItem"],
    [{ action: "updateItem", sku: "MUG-1", name: "Mug Pro", salePriceMinor: 600, barcode: null, imageUrl: null, tags: [] }, "inventory.updateItem"],
    [{ action: "archiveItem", sku: "MUG-1", archive: true }, "inventory.archiveItem"],
  ];

  it.each(goProductActions)("routes supported product action %s through the session capability proxy", (action, capabilityId) => {
    const request = productActionRequest(action, "intent-12345678901234567890", true);
    expect(request.url).toBe("/api/capabilities/execute");
    expect(request.body).toMatchObject({ capabilityId, intentId: "intent-12345678901234567890" });
    expect(request.body).not.toHaveProperty("action");
  });

  it("keeps product actions on the legacy inventory route while the Go slice is disabled", () => {
    const action = { action: "archiveItem", sku: "MUG-1", archive: true } as const;
    expect(productActionRequest(action, "intent-12345678901234567890", false)).toEqual({
      url: "/api/inventory",
      body: { ...action, intentId: "intent-12345678901234567890" },
    });
  });

  it("keeps inventory defaults and batch imports on their legacy routes", async () => {
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ module: "inventory", settings: { defaultUnitLabel: "box" } }))
      .mockResolvedValueOnce(Response.json({ inserted: 0, skippedDuplicates: 0, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProductDefaults();
    await importProducts([{ rowNumber: 2, name: "Tea", type: "goods", salePrice: "3.25", tags: [] }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/module-settings?module=inventory", "/api/import"]);
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
