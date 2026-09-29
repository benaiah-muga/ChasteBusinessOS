import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSalesEnabled, fetchSalesOrders, SalesApiError } from "./sales";

const order = {
  id: "order-1",
  number: 41,
  customerId: "customer-1",
  status: "confirmed",
  backordered: false,
  totalMinor: 129900,
  createdAt: "2026-09-27T10:15:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("sales API client", () => {
  it("validates the sales switchboard entry and enabled state", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      catalog: [{ id: "sales" }],
      enabledModules: ["sales"],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      catalog: [{ id: "sales" }],
      enabledModules: [],
    })));
    await expect(fetchSalesEnabled()).resolves.toBe(false);
  });

  it("rejects a switchboard that omits the sales catalog entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: [], enabledModules: [] })));
    await expect(fetchSalesEnabled()).rejects.toMatchObject({ status: 200, message: "The module switchboard returned an invalid sales configuration." });
  });

  it("loads and validates the Go-compatible order list from the same-origin API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ orders: [order] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesOrders()).resolves.toEqual([order]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sales", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    }));
  });

  it("preserves session and authorization failures for the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    await expect(fetchSalesOrders()).rejects.toMatchObject({ status: 401, message: "Your session has ended. Sign in again to continue." });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing sales.read" }, { status: 403 })));
    await expect(fetchSalesOrders()).rejects.toMatchObject({ status: 403, message: "forbidden: missing sales.read" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing sales.read" }, { status: 422 })));
    await expect(fetchSalesOrders()).rejects.toMatchObject({ status: 422, message: "forbidden: missing sales.read" });
  });

  it("rejects malformed successful responses instead of rendering partial data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ orders: [{ ...order, totalMinor: "129900" }] })));
    await expect(fetchSalesOrders()).rejects.toEqual(expect.objectContaining({
      status: 200,
      message: "The sales service returned data in an unexpected format.",
    }));
  });

  it("maps unavailable service responses to a recoverable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    await expect(fetchSalesOrders()).rejects.toBeInstanceOf(SalesApiError);
    await expect(fetchSalesOrders()).rejects.toMatchObject({ status: 503, message: "The sales service is unavailable. Try again." });
  });
});
