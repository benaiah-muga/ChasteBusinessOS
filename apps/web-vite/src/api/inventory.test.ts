import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoStockReport, fetchInventoryEnabled, fetchInventoryReport, InventoryApiError } from "./inventory";

afterEach(() => vi.unstubAllGlobals());

describe("Go inventory stock report client", () => {
  it("validates the exact Go module switchboard contract", async () => {
    const catalog = [{ id: "inventory", label: "Inventory", description: "Stock ledger", href: "/inventory" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ catalog, enabledModules: ["inventory"], usingDefaults: false }))
      .mockResolvedValueOnce(Response.json({ catalog: [{ ...catalog[0], unexpected: true }], enabledModules: ["inventory"], usingDefaults: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInventoryEnabled()).resolves.toBe(true);
    await expect(fetchInventoryEnabled()).rejects.toThrow("unexpected format");
  });

  it("loads the complete inventory report from the Go reader", async () => {
    const report = {
      items: [{
        id: "10000000-0000-4000-8000-000000000001",
        sku: "BEANS-1KG", name: "Coffee beans", kind: "goods", unitLabel: "bag", salePriceMinor: 2500,
        imageUrl: null, tags: [], barcode: null, onHandThousandths: 3000, valueMinor: 12000,
        avgUnitCostMinor: 4000, reservedThousandths: 500, availableThousandths: 2500, totalValueMinor: 12000,
        reorderPointThousandths: 1000, reorderNeeded: false,
      }],
      totalValueMinor: 12000,
      reorderAlerts: [],
      locations: [{ id: "20000000-0000-4000-8000-000000000002", orgId: "30000000-0000-4000-8000-000000000003", code: "MAIN", name: "Main warehouse", createdAt: "2026-10-14T10:00:00.000Z" }],
      lots: [{ id: "40000000-0000-4000-8000-000000000004", sku: "BEANS-1KG", lotCode: "BATCH-1", balanceThousandths: 3000, expiresAt: null }],
      cycleCounts: [], transfers: [], reservations: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(report));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInventoryReport(undefined, "org-inventory-test")).resolves.toEqual(report);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({
      credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "X-Organization-ID": "org-inventory-test" },
    }));
  });

  it("calls the authenticated capability endpoint and validates its response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: {
        items: [{
          sku: "BEANS-1KG",
          name: "Coffee beans",
          kind: "goods",
          unitLabel: "bag",
          salePriceMinor: 2500,
          imageUrl: null,
          tags: [],
          barcode: null,
          onHandThousandths: 3000,
          valueMinor: 12000,
          avgUnitCostMinor: 4000,
          reservedThousandths: 500,
          availableThousandths: 2500,
          reorderPointThousandths: 1000,
          reorderNeeded: false,
        }],
        totalValueMinor: 12000,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const report = await fetchGoStockReport();

    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: expect.stringMatching(/"capabilityId":"inventory\.stockReport"/),
    }));
    expect(report.items[0]).toMatchObject({ sku: "BEANS-1KG", onHandThousandths: 3000, valueMinor: 12000 });
  });

  it("fails closed when Go returns a malformed report", async () => {
    const report = {
      items: [], totalValueMinor: 0, reorderAlerts: [], locations: [], lots: [], cycleCounts: [], transfers: [], reservations: [],
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ ...report, unexpected: true }))
      .mockResolvedValueOnce(Response.json({ ...report, reservations: undefined }))
      .mockResolvedValueOnce(Response.json({ ...report, lots: [{ id: "40000000-0000-4000-8000-000000000004", sku: "BEANS-1KG", lotCode: "BATCH-1", expiresAt: null }] })));

    await expect(fetchGoStockReport()).rejects.toBeInstanceOf(InventoryApiError);
    await expect(fetchInventoryReport()).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected format") });
    await expect(fetchInventoryReport()).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected format") });
  });

  it("rejects missing and unexpected stock capability fields", async () => {
    const item = {
      sku: "BEANS-1KG", name: "Coffee beans", kind: "goods", unitLabel: "bag", salePriceMinor: 2500,
      imageUrl: null, tags: [], barcode: null, onHandThousandths: 3000, valueMinor: 12000, avgUnitCostMinor: 4000,
      reservedThousandths: 500, availableThousandths: 2500, reorderPointThousandths: 1000, reorderNeeded: false,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { items: [{ ...item, unexpected: true }], totalValueMinor: 12000 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { items: [{ ...item, tags: undefined }], totalValueMinor: 12000 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoStockReport()).rejects.toThrow("unexpected format");
    await expect(fetchGoStockReport()).rejects.toThrow("unexpected format");
  });
});
