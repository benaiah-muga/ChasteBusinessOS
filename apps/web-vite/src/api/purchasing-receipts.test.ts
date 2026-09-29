import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPurchaseOrderReceipts,
  fetchPurchasingOrders,
  fetchPurchasingReceiptsEnabled,
  PurchasingReceiptsApiError,
} from "./purchasing-receipts";

afterEach(() => vi.unstubAllGlobals());

const order = {
  id: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
  number: 42,
  vendorName: "Harbor Supplies",
  status: "received",
  memo: null,
  orderedMinor: 12500,
  lines: [{ lineNumber: 1, description: "Canvas bag", quantity: 2500, unitPriceMinor: 5000 }],
};

const receiptData = {
  receipts: [{
    number: 7,
    receivedAt: "2026-08-12T09:30:00.000Z",
    note: "One carton damaged",
    lines: [{
      position: 1,
      description: "Canvas bag",
      acceptedThousandths: 2000,
      rejectedThousandths: 500,
      returnedThousandths: 0,
      rejectionNote: "Torn stitching",
    }],
  }],
  orderLines: [{
    position: 1,
    description: "Canvas bag",
    orderedThousandths: 2500,
    acceptedThousandths: 2000,
    rejectedThousandths: 500,
    returnedThousandths: 0,
    remainingThousandths: 0,
  }],
};

describe("purchasing receipts API", () => {
  it("validates the switchboard and returns the existing Purchasing GET orders", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] }))
      .mockResolvedValueOnce(Response.json({ baseCurrency: "USD", orders: [order] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingReceiptsEnabled()).resolves.toBe(true);
    await expect(fetchPurchasingOrders()).resolves.toEqual({ baseCurrency: "USD", orders: [order] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/purchasing"]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "same-origin" && init.cache === "no-store")).toBe(true);
  });

  it("posts the legacy receipt-detail action and validates accepted, rejected, returned, and outstanding quantities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: receiptData }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchaseOrderReceipts(42)).resolves.toEqual(receiptData);
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "receiptDetail", poNumber: 42 }),
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    }));
  });

  it("rejects malformed receipt payloads and keeps authorization errors actionable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { receipts: [], orderLines: [{ position: 1 }] } })));

    await expect(fetchPurchaseOrderReceipts(42)).rejects.toMatchObject({
      name: "PurchasingReceiptsApiError",
      status: 200,
      message: "The purchasing service returned receipt history in an unexpected format.",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 })));
    await expect(fetchPurchaseOrderReceipts(42)).rejects.toBeInstanceOf(PurchasingReceiptsApiError);
    await expect(fetchPurchaseOrderReceipts(42)).rejects.toMatchObject({ status: 401, message: "Your session has expired. Sign in again to view purchase receipts." });
  });
});
