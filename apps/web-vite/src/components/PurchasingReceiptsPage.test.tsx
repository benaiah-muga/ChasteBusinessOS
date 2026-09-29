import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PurchasingReceiptsPage } from "./PurchasingReceiptsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ordersResponse = {
  baseCurrency: "USD",
  orders: [
    {
      id: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
      number: 42,
      vendorName: "Harbor Supplies",
      status: "received",
      memo: null,
      orderedMinor: 12500,
      lines: [{ lineNumber: 1, description: "Canvas bag", quantity: 2500, unitPriceMinor: 5000 }],
    },
    {
      id: "32c0016b-835f-4d6d-a032-05bf8d81d2a4",
      number: 41,
      vendorName: "Harbor Supplies",
      status: "approved",
      memo: null,
      orderedMinor: 10000,
      lines: [{ lineNumber: 1, description: "Cotton roll", quantity: 1000, unitPriceMinor: 10000 }],
    },
  ],
};

const firstReceiptResponse = {
  ok: true,
  data: {
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
  },
};

function stubPurchasing(receiptsFor42: unknown = firstReceiptResponse) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/modules") {
      return Response.json({ catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] });
    }
    if (url === "/api/purchasing" && init?.method !== "POST") return Response.json(ordersResponse);
    if (url === "/api/purchasing" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { poNumber: number };
      if (body.poNumber === 42) return Response.json(receiptsFor42);
      return Response.json({ ok: true, data: { receipts: [], orderLines: [] } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PurchasingReceiptsPage", () => {
  it("loads order history and renders precise accepted and rejected quantities", async () => {
    const fetchMock = stubPurchasing();
    render(<PurchasingReceiptsPage />);

    expect(await screen.findByRole("heading", { name: "Purchase receipt history" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Receipt #7" })).toBeTruthy();
    expect(screen.getByText("Torn stitching")).toBeTruthy();
    expect(screen.getByText("One carton damaged")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full receiving workspace" }).getAttribute("href")).toContain("/purchasing/receiving");

    const orderSummary = screen.getByRole("table", { name: "Quantities received, rejected, returned, and remaining for each order line" });
    expect(within(orderSummary).getByText("2.500")).toBeTruthy();
    expect(within(orderSummary).getByText("2.000")).toBeTruthy();
    expect(within(orderSummary).getByText("0.500")).toBeTruthy();
    expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("$125.00") === true)).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "receiptDetail", poNumber: 42 }),
    })));
  });

  it("loads receipt history for the newly selected purchase order", async () => {
    const fetchMock = stubPurchasing();
    render(<PurchasingReceiptsPage />);

    await screen.findByRole("heading", { name: "Receipt #7" });
    fireEvent.change(screen.getByRole("combobox", { name: "Purchase order" }), { target: { value: "41" } });
    expect(await screen.findByRole("heading", { name: "No receipts recorded for this purchase order" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "receiptDetail", poNumber: 41 }),
    }));
  });

  it("keeps pre-receipt stock movement totals visible when no receipt documents exist", async () => {
    const legacyMovementResponse = {
      ok: true,
      data: {
        receipts: [],
        orderLines: [{
          position: 1,
          description: "Canvas bag",
          orderedThousandths: 2500,
          acceptedThousandths: 1000,
          rejectedThousandths: 0,
          returnedThousandths: 0,
          remainingThousandths: 1500,
        }],
      },
    };
    stubPurchasing(legacyMovementResponse);
    render(<PurchasingReceiptsPage />);

    expect(await screen.findByText(/stock movements recorded before receipt documents were introduced/)).toBeTruthy();
    const orderSummary = screen.getByRole("table", { name: "Quantities received, rejected, returned, and remaining for each order line" });
    expect(within(orderSummary).getByText("1.000")).toBeTruthy();
    expect(within(orderSummary).getByText("1.500")).toBeTruthy();
  });

  it("does not fetch purchase orders when Purchasing is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingReceiptsPage />);

    expect(await screen.findByRole("heading", { name: "Purchasing is turned off" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
  });

  it("reports empty purchase order history without making a receipt request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] }))
      .mockResolvedValueOnce(Response.json({ baseCurrency: "USD", orders: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingReceiptsPage />);

    expect(await screen.findByRole("heading", { name: "No purchase orders yet" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows a recoverable authorization error for receipt history", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] });
      if (url === "/api/purchasing" && init?.method !== "POST") return Response.json(ordersResponse);
      return Response.json({ error: "unauthorized" }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingReceiptsPage />);

    expect(await screen.findByRole("heading", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/login");
  });
});
