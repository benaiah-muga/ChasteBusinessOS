import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoStockReport, InventoryApiError } from "./inventory";

afterEach(() => vi.unstubAllGlobals());

describe("Go inventory stock report client", () => {
  it("calls the authenticated capability endpoint and validates its response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: {
        items: [{
          sku: "BEANS-1KG",
          name: "Coffee beans",
          kind: "goods",
          unitLabel: "bag",
          onHandThousandths: 3000,
          reservedThousandths: 500,
          availableThousandths: 2500,
          valueMinor: 12000,
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { items: [] } })));

    await expect(fetchGoStockReport()).rejects.toBeInstanceOf(InventoryApiError);
  });
});
