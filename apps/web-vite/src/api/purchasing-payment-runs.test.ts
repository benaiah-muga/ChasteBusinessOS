import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPurchasingEnabled, fetchPurchasingPaymentRuns, type PurchasingPaymentRunsApiError } from "./purchasing-payment-runs";

const run = {
  id: "11111111-1111-4111-8111-111111111111",
  reference: "PR-2026-0042",
  currency: "BHD",
  totalMinor: 1234,
  status: "instructed",
  createdAt: "2026-09-29T08:15:00.000Z",
  instructedAt: "2026-09-29T08:20:00.000Z",
  confirmedAt: null,
  entryId: "22222222-2222-4222-8222-222222222222",
  lines: [{
    billId: "33333333-3333-4333-8333-333333333333",
    billNumber: 17,
    vendorName: "Harbor Supplies",
    vendorRef: null,
    amountMinor: 1234,
  }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchPurchasingPaymentRuns", () => {
  it("validates whether the Purchasing module is enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("uses the authenticated same-origin read endpoint and parses the legacy envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { runs: [run] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingPaymentRuns()).resolves.toEqual([run]);
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing/payment-runs", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    }));
  });

  it("rejects malformed or unsafe payment amounts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { runs: [{ ...run, totalMinor: Number.MAX_SAFE_INTEGER + 1 }] },
    })));

    await expect(fetchPurchasingPaymentRuns()).rejects.toMatchObject({
      name: "PurchasingPaymentRunsApiError",
      status: 200,
    });
  });

  it("preserves permission and service errors from the authenticated endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "purchasing service unavailable" }, 503)));

    await expect(fetchPurchasingPaymentRuns()).rejects.toEqual(expect.objectContaining({
      name: "PurchasingPaymentRunsApiError",
      status: 503,
      message: "purchasing service unavailable",
    } satisfies Partial<PurchasingPaymentRunsApiError>));
  });
});
