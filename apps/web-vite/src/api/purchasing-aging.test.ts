import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPurchasingAging } from "./purchasing-aging";

const buckets = { current: 12_000, d30: 3_000, d60: 2_000, d90plus: 1_000, totalOutstanding: 18_000 };

afterEach(() => vi.unstubAllGlobals());

describe("Purchasing A/P aging API", () => {
  it("loads the existing legacy response when Go is not selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ baseCurrency: "UGX", apAging: { buckets } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingAging()).resolves.toEqual({ baseCurrency: "UGX", buckets });
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("loads strict bucket output through the selected Go capability", async () => {
    vi.stubGlobal("__GO_PURCHASING_AP_AGING_READS__", true);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { buckets } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingAging()).resolves.toEqual({ baseCurrency: null, buckets });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/capabilities/execute");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      capabilityId: "purchasing.apAging",
      input: {},
      intentId: expect.any(String),
    });
  });

  it("fails closed on unavailable or malformed Go results without legacy fallback", async () => {
    vi.stubGlobal("__GO_PURCHASING_AP_AGING_READS__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "capability unavailable" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { buckets: { ...buckets, d30: "3000" } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingAging()).rejects.toMatchObject({ status: 404 });
    await expect(fetchPurchasingAging()).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected aging report") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });
});
