import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProductDefaults, fetchProducts, fetchProductsEnabled, importProducts, productActionRequest, productImportRequest, productUndoImportRequest, ProductsApiError, recoverProductImport, restoreProductImport, submitProductAction, undoProductImport, type ProductAction } from "./products";

const retryScope = { actorId: "10000000-0000-4000-8000-000000000010", organizationId: "10000000-0000-4000-8000-000000000011" };
const otherRetryScope = { actorId: "10000000-0000-4000-8000-000000000012", organizationId: "10000000-0000-4000-8000-000000000013" };

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

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
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", false);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ module: "inventory", settings: { defaultUnitLabel: "box" } }))
      .mockResolvedValueOnce(Response.json({ inserted: 0, skippedDuplicates: 0, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProductDefaults();
    await importProducts([{ rowNumber: 2, name: "Tea", type: "goods", salePrice: "3.25", tags: [] }], undefined, retryScope);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/module-settings?module=inventory", "/api/import"]);
  });

  it("maps a Go product import contract while preserving row numbers, duplicate rows, and created IDs", async () => {
    const createdID = "10000000-0000-4000-8000-000000000001";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: {
      createdIds: [createdID], imported: 1, skippedDuplicateRows: [5],
    } }));
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(importProducts([{ rowNumber: 4, name: " Tea ", sku: " TEA-1 ", type: "goods", unit: " box ", salePrice: "3.25", barcode: "4000000000006", tags: [" Pantry "] }], undefined, retryScope)).resolves.toEqual({
      inserted: 1, skippedDuplicates: 1, skippedDuplicateRows: [5], errors: [], createdIds: [createdID],
    });
    const [path, options] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      capabilityId: "inventory.importItems",
      input: { rows: [{ rowNumber: 4, name: "Tea", sku: "TEA-1", kind: "goods", unitLabel: "box", salePriceMinor: 325, barcode: "4000000000006", tags: ["Pantry"] }] },
      intentId: expect.any(String),
    });
  });

  it("reuses a product import intent and generated service SKU after a network failure", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { createdIds: [], imported: 0, skippedDuplicateRows: [] } }));
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", fetchMock);
    const rows = [{ rowNumber: 2, name: "Install", type: "service" as const, salePrice: "12.00", tags: [] }];

    await expect(importProducts(rows, undefined, retryScope)).rejects.toBeInstanceOf(ProductsApiError);
    await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ pendingRows: rows });
    await expect(recoverProductImport(otherRetryScope)).resolves.toMatchObject({ pendingRows: null });
    await importProducts(rows, undefined, retryScope);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string; input: { rows: Array<{ sku: string }> } };
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string; input: { rows: Array<{ sku: string }> } };
    expect(second.intentId).toBe(first.intentId);
    expect(second.input.rows[0]?.sku).toBe(first.input.rows[0]?.sku);
  });

  it("blocks the legacy route while a scoped Go import result is unresolved", async () => {
    const rows = [{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods" as const, salePrice: "3.25", tags: [] }];
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network lost"));
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", fetchMock);
    await expect(importProducts(rows, undefined, retryScope)).rejects.toBeInstanceOf(ProductsApiError);

    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", false);
    await expect(importProducts([{ ...rows[0]!, sku: "TEA-2" }], undefined, retryScope)).rejects.toThrow(/unresolved for this account and organization/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it.each([
    ["import", async (fetchMock: ReturnType<typeof vi.fn>) => {
      const rows = [{ rowNumber: 2, name: "Tea", sku: "TEA-404", type: "goods" as const, salePrice: "3.25", tags: [] }];
      vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
      vi.stubGlobal("fetch", fetchMock);
      await expect(importProducts(rows, undefined, retryScope)).rejects.toMatchObject({ status: 404 });
      await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ pendingRows: rows });
      await importProducts(rows, undefined, retryScope);
      return [fetchMock.mock.calls[0]?.[1]?.body, fetchMock.mock.calls[1]?.[1]?.body];
    }],
    ["undo", async (fetchMock: ReturnType<typeof vi.fn>) => {
      const ids = ["10000000-0000-4000-8000-000000000041"];
      vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
      vi.stubGlobal("fetch", fetchMock);
      await expect(undoProductImport(ids, undefined, retryScope)).rejects.toMatchObject({ status: 404 });
      await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ pendingUndoIds: ids });
      await undoProductImport(ids, undefined, retryScope);
      return [fetchMock.mock.calls[0]?.[1]?.body, fetchMock.mock.calls[1]?.[1]?.body];
    }],
    ["restore", async (fetchMock: ReturnType<typeof vi.fn>) => {
      const ids = ["10000000-0000-4000-8000-000000000042"];
      vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
      vi.stubGlobal("fetch", fetchMock);
      await expect(restoreProductImport(ids, undefined, retryScope)).rejects.toMatchObject({ status: 404 });
      await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ pendingRestoreIds: ids });
      await restoreProductImport(ids, undefined, retryScope);
      return [fetchMock.mock.calls[0]?.[1]?.body, fetchMock.mock.calls[1]?.[1]?.body];
    }],
  ])("retains the exact %s intent after a missing Go route", async (_operation, exercise) => {
    const itemId = "10000000-0000-4000-8000-000000000041";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockImplementation(async (_url: RequestInfo | URL, options?: RequestInit) => {
        const body = JSON.parse(String(options?.body)) as { capabilityId: string; input?: { itemIds?: string[] } };
        const requestedID = body.input?.itemIds?.[0] ?? itemId;
        if (body.capabilityId === "inventory.importItems") return Response.json({ ok: true, data: { createdIds: [itemId], imported: 1, skippedDuplicateRows: [] } });
        if (body.capabilityId === "inventory.undoItemImport") return Response.json({ ok: true, data: { itemIds: [requestedID], archived: 1 } });
        return Response.json({ ok: true, data: { itemIds: [requestedID], restored: 1 } });
      });
    const bodies = await exercise(fetchMock);
    const first = JSON.parse(String(bodies[0])) as { intentId: string };
    const second = JSON.parse(String(bodies[1])) as { intentId: string };
    expect(second.intentId).toBe(first.intentId);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
  });

  it.each([
    [{ createdIds: ["not-a-uuid"], imported: 1, skippedDuplicateRows: [] }],
    [{ createdIds: ["10000000-0000-4000-8000-000000000051"], imported: 2, skippedDuplicateRows: [] }],
    [{ createdIds: ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000051"], imported: 2, skippedDuplicateRows: [] }],
  ])("keeps an import marker when Go returns an inconsistent or duplicated created ID set", async (data) => {
    const rows = [{ rowNumber: 2, name: "Tea", sku: "TEA-BAD-IMPORT", type: "goods" as const, salePrice: "3.25", tags: [] }];
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data })));
    await expect(importProducts(rows, undefined, retryScope)).rejects.toThrow(/unexpected format|inconsistent or duplicate item IDs/);
    await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ pendingRows: rows, recovery: null });
  });

  it.each([
    [{ itemIds: ["not-a-uuid"], archived: 1 }],
    [{ itemIds: ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"], archived: 1 }],
    [{ itemIds: ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000061"], archived: 2 }],
    [{ itemIds: ["10000000-0000-4000-8000-000000000063"], archived: 1 }],
  ])("rejects malformed Go undo IDs without updating recovery or clearing the marker", async (data) => {
    const ids = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data })));
    await expect(undoProductImport(ids, undefined, retryScope)).rejects.toThrow(/unexpected format|invalid or inconsistent item IDs/);
    await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ pendingUndoIds: ids, recovery: null });
  });

  it.each([
    [{ itemIds: ["not-a-uuid"], restored: 1 }],
    [{ itemIds: ["10000000-0000-4000-8000-000000000071", "10000000-0000-4000-8000-000000000072"], restored: 1 }],
    [{ itemIds: ["10000000-0000-4000-8000-000000000071", "10000000-0000-4000-8000-000000000071"], restored: 2 }],
    [{ itemIds: ["10000000-0000-4000-8000-000000000073"], restored: 1 }],
  ])("rejects malformed Go restore IDs without updating recovery or clearing the marker", async (data) => {
    const ids = ["10000000-0000-4000-8000-000000000071", "10000000-0000-4000-8000-000000000072"];
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data })));
    await expect(restoreProductImport(ids, undefined, retryScope)).rejects.toThrow(/unexpected format|invalid or inconsistent item IDs/);
    await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ pendingRestoreIds: ids, recovery: null });
  });

  it("keeps Go import approval responses visible to the caller", async () => {
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true, reason: "Owner review", approvalId: "approval-123" }, { status: 202 })));
    await expect(importProducts([{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods", salePrice: "3.25", tags: [] }], undefined, retryScope))
      .rejects.toMatchObject({ status: 202, message: "Owner review" });
  });

  it("rejects Go import requests that exceed its body and row limits without dispatching to legacy", async () => {
    const id = "intent-12345678901234567890";
    const tooManyTags = [{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods" as const, salePrice: "3.25", tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }];
    expect(productImportRequest(tooManyTags, id, true).url).toBe("/api/capabilities/execute");
    expect(productImportRequest(tooManyTags, id, true).unsupportedReason).toMatch(/20 tags/);
    const oversized = Array.from({ length: 200 }, (_, index) => ({ rowNumber: index + 2, name: "Tea", sku: `TEA-${index}`, type: "goods" as const, salePrice: "3.25", tags: Array.from({ length: 20 }, () => "x".repeat(30)) }));
    expect(productImportRequest(oversized, id, true).url).toBe("/api/capabilities/execute");
    expect(productImportRequest(oversized, id, true).unsupportedReason).toMatch(/64 KiB/);
    const fetchMock = vi.fn();
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", fetchMock);
    await expect(importProducts(tooManyTags, undefined, retryScope)).rejects.toThrow(/20 tags/);
    await expect(importProducts(oversized, undefined, retryScope)).rejects.toThrow(/64 KiB/);
    await expect(importProducts(Array.from({ length: 5001 }, (_, index) => ({ rowNumber: index + 2, name: "Tea", sku: `TEA-${index}`, type: "goods" as const, salePrice: "3.25", tags: [] })), undefined, retryScope)).rejects.toThrow(/5,000 rows/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the Go undo capability and maps archived counts and approval responses", async () => {
    const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { itemIds: [ids[0]], archived: 1 } }));
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", fetchMock);
    await expect(undoProductImport(ids, undefined, retryScope)).resolves.toEqual({ kind: "completed", undone: 1, remaining: 1, itemIds: [ids[0]] });
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      body: expect.stringContaining('"capabilityId":"inventory.undoItemImport"'),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ input: { itemIds: ids }, intentId: expect.any(String) });
  });

  it("returns the Go undo approval reason without losing the pending state", async () => {
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true, reason: "Owner review", approvalId: "approval-456" }, { status: 202 })));
    await expect(undoProductImport(["10000000-0000-4000-8000-000000000001"], undefined, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "Owner review" });
  });

  it("rejects product undo batches beyond the Go ID cap without legacy fallback", async () => {
    const ids = Array.from({ length: 5001 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(productUndoImportRequest(ids, "intent-12345678901234567890", true).url).toBe("/api/capabilities/execute");
    const fetchMock = vi.fn();
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", fetchMock);
    await expect(undoProductImport(ids, undefined, retryScope)).rejects.toThrow(/1 and 5,000/);
    expect(fetchMock).not.toHaveBeenCalled();
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
    const imported = await importProducts([{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods", unit: "box", salePrice: "3.25", tags: ["Pantry"] }], undefined, retryScope);
    expect(imported.inserted).toBe(1);
    await expect(undoProductImport(imported.createdIds ?? [], undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Owner review" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ entity: "products", rows: [{ sku: "TEA-1" }] });
  });

  it("recovers exact import IDs only inside their actor and organization scope", async () => {
    const createdID = "10000000-0000-4000-8000-000000000021";
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { createdIds: [createdID], imported: 1, skippedDuplicateRows: [] } })));
    await importProducts([{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods", salePrice: "3.25", tags: [] }], undefined, retryScope);
    await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ recovery: { activeIds: [createdID], archivedIds: [], result: { createdIds: [createdID] } } });
    await expect(recoverProductImport(otherRetryScope)).resolves.toMatchObject({ recovery: null, pendingRows: null });
  });

  it("routes restore through Go and retains the exact IDs returned by undo and restore", async () => {
    const id = "10000000-0000-4000-8000-000000000031";
    vi.stubGlobal("__GO_INVENTORY_IMPORT_SLICE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { createdIds: [id], imported: 1, skippedDuplicateRows: [] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { itemIds: [id], archived: 1 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { itemIds: [id], restored: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const imported = await importProducts([{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods", salePrice: "3.25", tags: [] }], undefined, retryScope);
    await expect(undoProductImport(imported.createdIds ?? [], undefined, retryScope)).resolves.toMatchObject({ itemIds: [id], undone: 1 });
    await expect(restoreProductImport([id], undefined, retryScope)).resolves.toEqual({ kind: "completed", restored: 1, itemIds: [id] });
    await expect(recoverProductImport(retryScope)).resolves.toMatchObject({ recovery: { activeIds: [id], archivedIds: [] } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ capabilityId: "inventory.restoreItemImport", input: { itemIds: [id] } });
  });
});
