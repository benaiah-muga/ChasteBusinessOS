import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    { lineNumber: 1, description: "Canvas bag", quantity: 2500, acceptedThousandths: 1000, rejectedThousandths: 250, returnedThousandths: 100, remainingThousandths: 1250, unitPriceMinor: 5000 },
    { lineNumber: 2, description: "Strap", quantity: 1000, acceptedThousandths: 0, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1000, unitPriceMinor: 5000 },
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

function stubReceivingLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn(async <T,>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
    const previous = tails.get(name) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(name, current);
    await previous;
    try { return await callback(); }
    finally {
      release();
      if (tails.get(name) === current) tails.delete(name);
    }
  });
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { locks: { request } }));
  return request;
}

describe("receiving module gate and order lookup", () => {
  it("requires organization scope before checking the module gate", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchReceivingEnabled(null)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit organization before reading orders", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchReceivingOrders(null)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("confirms Purchasing is on before loading orders", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(switchboard))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { baseCurrency: "USD", orders: [order] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReceivingEnabled("org-1")).resolves.toBe(true);
    await expect(fetchReceivingOrders("org-1")).resolves.toEqual({ baseCurrency: "USD", orders: [order] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe("org-1");
    expect(postedBody(fetchMock.mock.calls[1]!)).toMatchObject({ capabilityId: "purchasing.listWorkspace", input: {} });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-Organization-ID")).toBe("org-1");
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "same-origin" && init.cache === "no-store")).toBe(true);
  });

  it("reports Purchasing as off and refuses an inconsistent switchboard", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: [] })));
    await expect(fetchReceivingEnabled("org-1")).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      catalog: [{ id: "purchasing" }],
      enabledModules: ["purchasing", "ghost"],
    })));
    await expect(fetchReceivingEnabled("org-1")).rejects.toMatchObject({
      status: 200,
      message: "The module switchboard returned an invalid Purchasing configuration.",
    });
  });

  it("rejects Go orders that do not match the receipt line contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { baseCurrency: "USD", orders: [{ ...order, lines: [{ lineNumber: 1 }] }] },
    })));
    await expect(fetchReceivingOrders("org-1")).rejects.toMatchObject({
      status: 200,
      message: "The Go Purchasing service returned purchase orders in an unexpected format.",
    });
  });

  it("does not accept a legacy order payload when the Go capability route is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ baseCurrency: "USD", orders: [order] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReceivingOrders("org-1")).rejects.toBeInstanceOf(ReceivingApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });
});

describe("receiving detail rollup", () => {
  it("routes receipt history through purchasing.listReceipts and preserves the detail shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: detail }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReceivingDetail(42, "org-1")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": "org-1" },
      body: expect.stringMatching(/^\{"capabilityId":"purchasing\.listReceipts","input":\{"poNumber":42\},"intentId":"[0-9a-f-]+"\}$/),
    }));
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN])("rejects invalid purchase order number %s before dispatch", async (poNumber) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReceivingDetail(poNumber, "org-1")).rejects.toMatchObject({
      status: 0,
      message: "Enter a valid purchase order number before loading receipt history.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, { error: "capability unavailable" }],
    [200, { ok: true, data: { ...detail, unexpected: true } }],
  ])("fails closed on selected Go receipt history response %i", async (status, body) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReceivingDetail(42, "org-1")).rejects.toBeInstanceOf(ReceivingApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("keeps rejected, returned, and remaining quantities distinct", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: detail })));
    const result = await fetchReceivingDetail(42, "org-1");

    const bag = result.orderLines.find((line) => line.position === 1)!;
    expect(bag).toMatchObject({ orderedThousandths: 2500, acceptedThousandths: 1500, rejectedThousandths: 500, remainingThousandths: 500 });
    expect(result.receipts[0]!.lines[0]!.rejectionNote).toBe("Torn stitching");
  });

  it("refuses a rollup that cannot be validated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { receipts: [], orderLines: [{ position: 1, remainingThousandths: -5 }] },
    })));
    await expect(fetchReceivingDetail(42, "org-1")).rejects.toMatchObject({
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

  beforeEach(() => { stubReceivingLocks(); });

  it("requires actor and organization scope before a Go receipt request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action, undefined, { actorId: "actor-1", organizationId: null }))
      .rejects.toMatchObject({ status: 0, message: expect.stringContaining("organization") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins receipts to the captured organization if the active organization changes in flight", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);

    const pending = submitReceiveGoods(action, undefined, { actorId: "actor-a", organizationId: "org-a" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    document.cookie = "activeOrganization=org-b";
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe("org-a");
    responses[0]?.(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 2 } }));
    await expect(pending).resolves.toMatchObject({ kind: "completed", data: { receiptNumber: 2 } });
  });

  it("routes through Go with the capability envelope and reuses its scoped intent while pending or uncertain", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Overreceipt needs approval." }, { status: 202 }))
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 2 } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action, undefined, retryScope)).rejects.toMatchObject({ status: 0 });
    const first = postedBody(fetchMock.mock.calls[0]!);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(retryScope.organizationId);
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

  it("reserves one receipt intent across concurrent tabs", async () => {
    const lockRequest = stubReceivingLocks();
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);

    const first = submitReceiveGoods(action, undefined, retryScope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = submitReceiveGoods(action, undefined, retryScope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lockRequest).toHaveBeenCalledWith(expect.stringContaining("chaste.purchasing.receive-goods.active.v1:"), { mode: "exclusive" }, expect.any(Function));
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(postedBody(fetchMock.mock.calls[0]!).intentId);

    responses.forEach((resolve) => resolve(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 2 } })));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("keeps a receipt on Go after a missing capability response and retries the same intent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { received: true, fullyReceived: false, receiptNumber: 3 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action, undefined, retryScope)).rejects.toMatchObject({ status: 404 });
    const intentId = postedBody(fetchMock.mock.calls[0]!).intentId;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(submitReceiveGoods(action, undefined, retryScope)).resolves.toMatchObject({ kind: "completed", data: { receiptNumber: 3 } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/capabilities/execute");
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(intentId);
  });

  it("requires the Go success envelope and keeps a malformed result retryable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ received: true, fullyReceived: false, receiptNumber: 3 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { received: true, fullyReceived: false, receiptNumber: 3 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action, undefined, retryScope)).rejects.toMatchObject({ status: 200 });
    const intentId = postedBody(fetchMock.mock.calls[0]!).intentId;
    await expect(submitReceiveGoods(action, undefined, retryScope)).resolves.toMatchObject({ kind: "completed", data: { receiptNumber: 3 } });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(intentId);
  });

  it("rejects Go-incompatible quantities, totals, reasons, and authority values before requests", async () => {
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

  it("requires retry scope and posts a Go capability envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 2 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReceiveGoods(action, undefined, retryScope)).resolves.toEqual({
      kind: "completed",
      data: { received: true, fullyReceived: true, receiptNumber: 2 },
    });
    const body = postedBody(fetchMock.mock.calls[0]!);
    expect(body).toMatchObject({
      capabilityId: "purchasing.receiveGoods",
      input: { poNumber: 42, lines: [{ lineNumber: 1, quantity: 1500, rejected: 500, rejectionNote: "Torn stitching" }] },
    });
    expect(body.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("carries the authority gate through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 3 } }));
    vi.stubGlobal("fetch", fetchMock);

    await submitReceiveGoods({
      ...action,
      overreceiptTolerancePct: 10,
      authorityReason: "site manager approved in writing",
    }, undefined, retryScope);
    expect(postedBody(fetchMock.mock.calls[0]!)).toMatchObject({
      capabilityId: "purchasing.receiveGoods",
      input: { overreceiptTolerancePct: 10, authorityReason: "site manager approved in writing" },
    });
  });

  it("treats a 202 as pending, never as a recorded receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { pendingApproval: true, reason: "Overreceipt needs a second approver." },
      { status: 202 },
    )));

    await expect(submitReceiveGoods({ ...action, overreceiptTolerancePct: 10, authorityReason: "site manager approved" }, undefined, retryScope)).resolves.toEqual({
      kind: "pending",
      reason: "Overreceipt needs a second approver.",
    });
  });

  it("explains a 202 with no reason using the receiving wording", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(submitReceiveGoods(action, undefined, retryScope)).resolves.toEqual({
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
    await expect(submitReceiveGoods(action, undefined, retryScope)).rejects.toMatchObject({
      status: 200,
      message: "The Purchasing service returned an unexpected receipt result.",
    });
  });

  it("keeps an authority error actionable rather than reporting a bad receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: "overreceipt needs explicit authority" },
      { status: 422 },
    )));
    await expect(submitReceiveGoods({ ...action, overreceiptTolerancePct: 5, authorityReason: "site manager approved" }, undefined, retryScope)).rejects.toMatchObject({
      status: 422,
      message: "overreceipt needs explicit authority",
    });
  });
});
