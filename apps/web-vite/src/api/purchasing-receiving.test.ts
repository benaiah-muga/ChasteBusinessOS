import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchReceivingDetail,
  fetchReceivingEnabled,
  fetchReceivingOrders,
  ReceivingApiError,
  submitReceiveGoods,
} from "./purchasing-receiving";

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const switchboard = { catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] };

const order = {
  id: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
  number: 42,
  vendorName: "Harbor Supplies",
  status: "partial",
  memo: "Spring reorder",
  orderedMinor: 12500,
  lines: [
    { lineNumber: 1, description: "Canvas bag", quantity: 2500, unitPriceMinor: 5000 },
    { lineNumber: 2, description: "Strap", quantity: 1000, unitPriceMinor: 5000 },
  ],
};

const detail = {
  receipts: [{
    number: 1,
    receivedAt: "2026-08-12T09:30:00.000Z",
    note: "One carton damaged",
    lines: [{
      position: 1,
      description: "Canvas bag",
      acceptedThousandths: 1500,
      rejectedThousandths: 500,
      returnedThousandths: 0,
      rejectionNote: "Torn stitching",
    }],
  }],
  orderLines: [
    {
      position: 1,
      description: "Canvas bag",
      orderedThousandths: 2500,
      acceptedThousandths: 1500,
      rejectedThousandths: 500,
      returnedThousandths: 0,
      remainingThousandths: 500,
    },
    {
      position: 2,
      description: "Strap",
      orderedThousandths: 1000,
      acceptedThousandths: 0,
      rejectedThousandths: 0,
      returnedThousandths: 0,
      remainingThousandths: 1000,
    },
  ],
};

function postedBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe("receiving module gate and order lookup", () => {
  it("confirms Purchasing is on before loading orders", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(switchboard))
      .mockResolvedValueOnce(Response.json({ baseCurrency: "USD", orders: [order] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReceivingEnabled()).resolves.toBe(true);
    await expect(fetchReceivingOrders()).resolves.toEqual({ baseCurrency: "USD", orders: [order] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/purchasing"]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "same-origin" && init.cache === "no-store")).toBe(true);
  });

  it("reports Purchasing as off and refuses an inconsistent switchboard", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: [] })));
    await expect(fetchReceivingEnabled()).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      catalog: [{ id: "purchasing" }],
      enabledModules: ["purchasing", "ghost"],
    })));
    await expect(fetchReceivingEnabled()).rejects.toMatchObject({
      status: 200,
      message: "The module switchboard returned an invalid Purchasing configuration.",
    });
  });

  it("rejects orders that do not match the receipt line contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      baseCurrency: "USD",
      orders: [{ ...order, lines: [{ lineNumber: 1 }] }],
    })));
    await expect(fetchReceivingOrders()).rejects.toMatchObject({
      status: 200,
      message: "The Purchasing service returned purchase orders in an unexpected format.",
    });
  });
});

describe("receiving detail rollup", () => {
  it("posts the legacy receiptDetail action and returns the aggregated per-line rollup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: detail }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReceivingDetail(42)).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "receiptDetail", poNumber: 42 }),
      headers: { accept: "application/json", "content-type": "application/json" },
    }));
  });

  it("keeps rejected, returned, and remaining quantities distinct", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: detail })));
    const result = await fetchReceivingDetail(42);

    const bag = result.orderLines.find((line) => line.position === 1)!;
    expect(bag).toMatchObject({ orderedThousandths: 2500, acceptedThousandths: 1500, rejectedThousandths: 500, remainingThousandths: 500 });
    expect(result.receipts[0]!.lines[0]!.rejectionNote).toBe("Torn stitching");
  });

  it("refuses a rollup that cannot be validated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { receipts: [], orderLines: [{ position: 1, remainingThousandths: -5 }] },
    })));
    await expect(fetchReceivingDetail(42)).rejects.toMatchObject({
      status: 200,
      message: "The Purchasing service returned receipt history in an unexpected format.",
    });
  });
});

describe("recording a receipt", () => {
  const action = {
    action: "receiveGoods" as const,
    poNumber: 42,
    lines: [{ lineNumber: 1, quantity: 1500, rejected: 500, rejectionNote: "Torn stitching" }],
  };
  const retryScope = { actorId: "actor-1", organizationId: "org-1" };

  it("requires actor and organization scope before a Go receipt request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_PURCHASING_RECEIVE_GOODS__", true);

    await expect(submitReceiveGoods(action, undefined, { actorId: "actor-1", organizationId: null }))
      .rejects.toMatchObject({ status: 0, message: expect.stringContaining("organization") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes through Go with the capability envelope and reuses its scoped intent while pending or uncertain", async () => {
    vi.stubGlobal("__GO_PURCHASING_RECEIVE_GOODS__", true);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Overreceipt needs approval." }, { status: 202 }))
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 2 } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action, undefined, retryScope)).rejects.toMatchObject({ status: 0 });
    const first = postedBody(fetchMock.mock.calls[0]!);
    await expect(submitReceiveGoods(action, undefined, retryScope)).resolves.toEqual({
      kind: "pending",
      reason: "Overreceipt needs approval.",
    });
    const second = postedBody(fetchMock.mock.calls[1]!);
    expect(second).toMatchObject({
      capabilityId: "purchasing.receiveGoods",
      input: { poNumber: 42, lines: action.lines },
      intentId: first.intentId,
    });
    expect(second.input).not.toHaveProperty("action");
    await expect(submitReceiveGoods(action, undefined, retryScope)).resolves.toEqual({
      kind: "completed",
      data: { received: true, fullyReceived: true, receiptNumber: 2 },
    });
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(first.intentId);
  });

  it("falls back to the legacy receipt route with the same intent when Go is unavailable", async () => {
    vi.stubGlobal("__GO_PURCHASING_RECEIVE_GOODS__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { received: true, fullyReceived: false, receiptNumber: 3 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action, undefined, retryScope)).resolves.toMatchObject({ kind: "completed", data: { receiptNumber: 3 } });
    const intentId = postedBody(fetchMock.mock.calls[0]!).intentId;
    expect(postedBody(fetchMock.mock.calls[1]!)).toMatchObject({ action: "receiveGoods", poNumber: 42, intentId });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/purchasing");
  });

  it("rejects Go-incompatible quantities, totals, reasons, and authority values before requests", async () => {
    vi.stubGlobal("__GO_PURCHASING_RECEIVE_GOODS__", true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tooLarge = 2_147_483_648;

    for (const invalid of [
      { ...action, poNumber: tooLarge },
      { ...action, lines: [{ lineNumber: 1, quantity: tooLarge }] },
      { ...action, lines: [{ lineNumber: 1, quantity: 1, rejected: 1 }] },
      { ...action, lines: [{ lineNumber: 1, quantity: tooLarge }, { lineNumber: 1, quantity: 1 }] },
      { ...action, overreceiptTolerancePct: 10, authorityReason: "short" },
      { ...action, overreceiptTolerancePct: 11, authorityReason: "site manager approved" },
    ]) {
      await expect(submitReceiveGoods(invalid, undefined, retryScope)).rejects.toMatchObject({ status: 0 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stamps an intentId and returns the receipt result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 2 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action)).resolves.toEqual({
      kind: "completed",
      data: { received: true, fullyReceived: true, receiptNumber: 2 },
    });
    const body = postedBody(fetchMock.mock.calls[0]!);
    expect(body.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.lines).toEqual([{ lineNumber: 1, quantity: 1500, rejected: 500, rejectionNote: "Torn stitching" }]);
  });

  it("carries the authority gate through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 3 } }));
    vi.stubGlobal("fetch", fetchMock);

    await submitReceiveGoods({
      ...action,
      overreceiptTolerancePct: 10,
      authorityReason: "site manager approved in writing",
    });
    expect(postedBody(fetchMock.mock.calls[0]!)).toMatchObject({
      overreceiptTolerancePct: 10,
      authorityReason: "site manager approved in writing",
    });
  });

  it("treats a 202 as pending, never as a recorded receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { pendingApproval: true, reason: "Overreceipt needs a second approver." },
      { status: 202 },
    )));

    await expect(submitReceiveGoods({ ...action, overreceiptTolerancePct: 10, authorityReason: "site manager approved" })).resolves.toEqual({
      kind: "pending",
      reason: "Overreceipt needs a second approver.",
    });
  });

  it("explains a 202 with no reason using the receiving wording", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(submitReceiveGoods(action)).resolves.toEqual({
      kind: "pending",
      reason: "This receiving action is gated; it completes once someone approves it.",
    });
  });

  it("refuses an empty or malformed line list before any request is sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods({ action: "receiveGoods", poNumber: 42, lines: [] })).rejects.toMatchObject({
      name: "ReceivingApiError",
      status: 0,
      message: "Check what arrived on each line and try again.",
    });
    await expect(submitReceiveGoods({
      action: "receiveGoods",
      poNumber: 42,
      lines: [{ lineNumber: 0, quantity: 10 }],
    })).rejects.toBeInstanceOf(ReceivingApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a completed result that is not a receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { received: false, receiptNumber: 2 } })));
    await expect(submitReceiveGoods(action)).rejects.toMatchObject({
      status: 200,
      message: "The Purchasing service returned an unexpected receipt result.",
    });
  });

  it("keeps an authority error actionable rather than reporting a bad receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: "overreceipt needs explicit authority" },
      { status: 422 },
    )));
    await expect(submitReceiveGoods({ ...action, overreceiptTolerancePct: 5, authorityReason: "site manager approved" })).rejects.toMatchObject({
      status: 422,
      message: "overreceipt needs explicit authority",
    });
  });
});
