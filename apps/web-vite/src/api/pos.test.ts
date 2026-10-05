import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPosSessions, fetchPosShiftSummary, PosApiError } from "./pos";

const id = "10000000-0000-4000-8000-000000000001";
const session = {
  id,
  register: "Front register",
  status: "closed",
  openingFloatMinor: 10000,
  openedAt: "2026-09-27T10:15:00.000Z",
  closedAt: "2026-09-27T18:30:00.000Z",
};
const summary = {
  register: "Front register",
  status: "closed",
  salesCount: 3,
  takingsMinor: 129900,
  tenderTotals: [{ method: "cash", amountMinor: 89900 }],
  refundTotals: [{ method: "cash", amountMinor: 1000 }],
  expectedCashMinor: 88900,
  countedCashMinor: 88000,
  varianceMinor: -900,
};

afterEach(() => vi.unstubAllGlobals());

describe("POS API client", () => {
  it("loads validated sessions from the same-origin, uncached route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ sessions: [session], sales: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosSessions()).resolves.toEqual([session]);
    expect(fetchMock).toHaveBeenCalledWith("/api/pos", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    }));
  });

  it("posts only the shift-summary capability to Go and validates its response envelope", async () => {
    vi.stubGlobal("__GO_POS_SHIFT_SUMMARY_ROUTE__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: summary }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosShiftSummary(id)).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/pos/shift-summary", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }));
    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toEqual({
      capabilityId: "pos.shiftSummary",
      input: { sessionId: id },
      intentId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  it("falls back to the legacy POS action only when the Go route is missing", async () => {
    vi.stubGlobal("__GO_POS_SHIFT_SUMMARY_ROUTE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: summary }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosShiftSummary(id)).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/pos/shift-summary");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/pos");
    const first = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { intentId: string };
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      action: "shiftSummary",
      sessionId: id,
      intentId: first.intentId,
    });
  });

  it("does not retry a Go response other than 404", async () => {
    vi.stubGlobal("__GO_POS_SHIFT_SUMMARY_ROUTE__", true);
    const fetchMock = vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosShiftSummary(id)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy route when the Go selector is disabled", async () => {
    vi.stubGlobal("__GO_POS_SHIFT_SUMMARY_ROUTE__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: summary }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosShiftSummary(id)).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/pos");
  });

  it("rejects invalid IDs before issuing a request and rejects malformed response data", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { ...summary, salesCount: "3" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPosShiftSummary("bad-id")).rejects.toBeInstanceOf(PosApiError);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetchPosShiftSummary(id)).rejects.toMatchObject({
      status: 200,
      message: "The POS service returned a shift summary in an unexpected format.",
    });
  });

  it("preserves authentication and access errors as actionable messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    await expect(fetchPosSessions()).rejects.toMatchObject({ status: 401, message: "Your session has ended. Sign in again to continue." });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing pos.read" }, { status: 422 })));
    await expect(fetchPosShiftSummary(id)).rejects.toMatchObject({ status: 422, message: "forbidden: missing pos.read" });
  });
});
