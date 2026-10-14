import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closePurchasingOrder,
  createPurchasingBill,
  createPurchasingOrder,
  createPurchasingRequest,
  createPurchasingRfq,
  createPurchasingVendor,
  creditPurchasingBill,
  fetchPurchasingEnabled,
  fetchGoPurchasingWorkflowRequests,
  fetchPurchasingInputTaxCodes,
  fetchPurchasingPriceHistory,
  fetchPurchasingProducts,
  fetchPurchasingSupplierPerformance,
  fetchPurchasingSupplierStatement,
  fetchPurchasingWorkspace,
  payPurchasingBill,
  reversePurchasingBillPayment,
  readPendingPurchasingPaymentReversal,
  readPendingPurchasingBillPayment,
  readPendingPurchasingRequest,
  PurchasingApiError,
  receivePurchasingGoods,
  returnPurchasingGoods,
  decidePurchasingRequest,
  recordPurchasingQuote,
  selectPurchasingWinningQuote,
} from "./purchasing";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const workspace = {
  baseCurrency: "USD",
  vendors: [{
    id: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
    name: "Harbor Supplies",
    email: null,
    paymentTermDays: 30,
    deactivatedAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  }],
  orders: [{
    id: "1a7c1a1e-9c3a-4f1a-9b2f-3f1c2d4e5a6b",
    number: 42,
    vendorName: "Harbor Supplies",
    status: "ordered",
    memo: null,
    orderedMinor: 12500,
    lines: [{ lineNumber: 1, description: "Canvas bag", quantity: 2500, unitPriceMinor: 5000 }],
  }],
  bills: [{
    id: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f",
    number: 7,
    vendorName: "Harbor Supplies",
    vendorRef: "INV-9",
    memo: null,
    totalMinor: 12500,
    currency: "USD",
    paidMinor: 0,
    creditedMinor: 0,
    status: "open",
    dueMinor: 12500,
    createdAt: "2026-08-12T09:30:00.000Z",
    payments: [],
  }],
  apAging: { buckets: { current: 12500, d30: 0, d60: 0, d90plus: 0, totalOutstanding: 12500 } },
  requests: [{
    id: "request-1",
    title: "Packaging stock",
    justification: "Existing supply will run out before replenishment.",
    estimatedAmountMinor: 24000,
    status: "pending_review",
    decisionReason: null,
    createdAt: "2026-08-13T09:30:00.000Z",
    rfqs: [],
  }],
  priceHistory: { rows: [{ vendorName: "Harbor Supplies", itemSku: "CANVAS-1", itemDescription: "Canvas bag", unitPriceMinor: 5000, orderedAt: "2026-08-12T09:30:00.000Z" }] },
  supplierPerformance: { vendors: [{ vendorId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce", vendorName: "Harbor Supplies", orders: 2, avgLeadTimeDays: 4, onTimeRate: 100, fillRate: 95, backorderedOrders: 0 }] },
};

const switchboard = { catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] };

function postedBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body));
}

function stubPurchasingLocks() {
  const tails = new Map<string, Promise<void>>();
  const locks = {
    request: vi.fn(async <T,>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
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
    }),
  };
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { locks }));
  return locks.request;
}

describe("purchasing API module gate", () => {
  it("requires organization scope before checking the module gate", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPurchasingEnabled(null)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms the module is enabled and every enabled id is in the catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(switchboard));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingEnabled("org-test")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      headers: { accept: "application/json", "X-Organization-ID": "org-test" },
      credentials: "same-origin",
      cache: "no-store",
    }));
  });

  it("reports Purchasing as off when the switchboard omits it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: [] })));
    await expect(fetchPurchasingEnabled("org-test")).resolves.toBe(false);
  });

  it("refuses a switchboard whose enabled ids are not all catalogued", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      catalog: [{ id: "purchasing" }],
      enabledModules: ["purchasing", "ghost"],
    })));
    await expect(fetchPurchasingEnabled("org-test")).rejects.toMatchObject({
      name: "PurchasingApiError",
      status: 200,
      message: "The module switchboard returned an invalid Purchasing configuration.",
    });
  });
});

describe("purchasing workspace reads", () => {
  it("requires and pins organization scope for reads even after the active organization changes", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingWorkspace(null)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    const pending = fetchPurchasingWorkspace("org-read-a");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    document.cookie = "activeOrganization=org-read-b";
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe("org-read-a");
    responses[0]?.(Response.json({ ok: true, data: workspace }));
    await expect(pending).resolves.toEqual(workspace);
  });

  it("loads the validated workspace through the Go capability", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, data: workspace }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPurchasingWorkspace("org-test")).resolves.toEqual(workspace);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": "org-test" },
    });
    expect(postedBody(fetchMock.mock.calls[0] ?? [])).toMatchObject({
      capabilityId: "purchasing.listWorkspace",
      input: {},
      intentId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { ...workspace, orders: [{ number: 1 }] } })));
    await expect(fetchPurchasingWorkspace("org-test")).rejects.toMatchObject({
      status: 200,
      message: "The Go Purchasing service returned the purchasing workspace in an unexpected format.",
    });
  });

  it("defaults missing requests to an empty list", async () => {
    const { requests: _requests, ...withoutRequests } = workspace;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: withoutRequests })));
    await expect(fetchPurchasingWorkspace("org-test")).resolves.toMatchObject({ requests: [] });
  });

  it("keeps stocked products that carry more columns than the form reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      items: [
        { sku: "RC-BAG", name: "Canvas bag", avgUnitCostMinor: 5000, kind: "goods", onHand: 12 },
        { sku: "RC-SVC", name: "Consulting", kind: "service" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPurchasingProducts("org-test")).resolves.toEqual([
      { sku: "RC-BAG", name: "Canvas bag", avgUnitCostMinor: 5000, kind: "goods", onHand: 12 },
      { sku: "RC-SVC", name: "Consulting", kind: "service" },
    ]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe("org-test");
  });

  it("keeps only active input tax codes for a vendor bill", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { codes: [
        { id: "3c9e3c30-1e5c-4b3c-9d4a-5b3c4d5e6f70", code: "VAT-IN", name: "Input VAT", direction: "input", rateBasisPoints: 500, priceIncludesTax: true, active: true },
        { id: "4daf4d41-2f6d-4c4d-8e5b-6c4d5e6f7081", code: "VAT-OUT", name: "Output VAT", direction: "output", rateBasisPoints: 500, priceIncludesTax: true, active: true },
        { id: "5eb05e52-307e-4d5e-9f6c-7d5e6f708192", code: "OLD", name: "Retired", direction: "input", rateBasisPoints: 100, priceIncludesTax: false, active: false },
      ] },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPurchasingInputTaxCodes("org-test")).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe("org-test");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(request).toMatchObject({ capabilityId: "accounting.listTaxCodes", input: {} });
    expect(request.intentId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("Go purchasing workflow reads", () => {
  it("validates the Go requests contract and drops only the extra RFQ vendor id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: {
        requests: [{
          id: "request-1",
          title: "Packaging materials",
          justification: "Restock the warehouse packaging supplies.",
          estimatedAmountMinor: 32000,
          status: "approved",
          decisionReason: null,
          createdAt: "2026-09-25T12:15:00.000Z",
          rfqs: [{
            id: "rfq-1",
            vendorId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
            vendorName: "Harbor Supplies",
            status: "quoted",
            quoteAmountMinor: 30000,
            quoteLeadTimeDays: 5,
            quoteNotes: "Ships next week",
          }],
        }],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoPurchasingWorkflowRequests("org-test")).resolves.toEqual([{
      id: "request-1",
      title: "Packaging materials",
      justification: "Restock the warehouse packaging supplies.",
      estimatedAmountMinor: 32000,
      status: "approved",
      decisionReason: null,
      createdAt: "2026-09-25T12:15:00.000Z",
      rfqs: [{
        id: "rfq-1",
        vendorName: "Harbor Supplies",
        status: "quoted",
        quoteAmountMinor: 30000,
        quoteLeadTimeDays: 5,
        quoteNotes: "Ships next week",
      }],
    }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": "org-test" },
    }));
    expect(postedBody(fetchMock.mock.calls[0]!)).toMatchObject({
      capabilityId: "purchasing.listPurchaseWorkflow",
      input: {},
      intentId: expect.any(String),
    });
  });

  it("fails closed on an unavailable Go route without requesting the legacy aggregate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "route disabled" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoPurchasingWorkflowRequests("org-test")).rejects.toMatchObject({ name: "PurchasingApiError", status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("rejects malformed workflow output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { requests: [{ id: "bad" }] } })));
    await expect(fetchGoPurchasingWorkflowRequests("org-test")).rejects.toMatchObject({
      status: 200,
      message: "The Go Purchasing service returned purchase requests in an unexpected format.",
    });
  });
});

describe("governed purchasing writes", () => {
  const poAction = {
    action: "createPurchaseOrder" as const,
    vendorId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
    memo: "March stock",
    lines: [{ description: "Canvas bag", quantity: 2500, unitPriceMinor: 0, sku: "CB-01" }],
  };
  const retryScope = {
    actorId: "actor-1",
    organizationId: "org-1",
  };

  beforeEach(() => { stubPurchasingLocks(); });

  it("pins uncertain writes to their captured organization across an active-org switch", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPurchasingOrder(poAction, undefined, { actorId: "actor-race", organizationId: "org-write-a" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    document.cookie = "activeOrganization=org-write-b";
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe("org-write-a");
    responses[0]?.(Response.json({ ok: true, data: { poNumber: 47 } }));
    await expect(pending).resolves.toEqual({ kind: "completed", data: { poNumber: 47 } });
  });

  it("always creates purchase requests through the Go capability when other sourcing writes are disabled", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", false);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { requestId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingRequest(
      { action: "createPurchaseRequest", title: "Need packaging", justification: "Stock is too low for confirmed orders." },
      undefined,
      { actorId: "actor-request-go", organizationId: "org-request-go" },
    )).resolves.toMatchObject({ kind: "completed", data: { requestId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": "org-request-go" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(postedBody(fetchMock.mock.calls[0]!).capabilityId).toBe("purchasing.createPurchaseRequest");
    expect(postedBody(fetchMock.mock.calls[0]!).intentId).toEqual(expect.any(String));
  });

  it("routes all sourcing actions through scoped Go capabilities with strict output shapes", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", false);
    const requestId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const rfqId = "1a7c1a1e-9c3a-4f1a-9b2f-3f1c2d4e5a6b";
    const vendorId = "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f";
    const results = [
      { requestId },
      { status: "approved" },
      { rfqIds: [rfqId] },
      { status: "quoted" },
      { poNumber: 73, vendorId, quoteAmountMinor: 4200 },
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ok: true, data: results.shift() })));
    vi.stubGlobal("fetch", fetchMock);
    const scoped = { actorId: "actor-sourcing-contract", organizationId: "org-sourcing-contract" };

    await expect(createPurchasingRequest({ action: "createPurchaseRequest", title: "Need packaging", justification: "Stock is too low for confirmed orders." }, undefined, scoped)).resolves.toMatchObject({ kind: "completed", data: { requestId } });
    await expect(decidePurchasingRequest({ action: "decidePurchaseRequest", requestId, decision: "approve" }, undefined, scoped)).resolves.toMatchObject({ kind: "completed", data: { status: "approved" } });
    await expect(createPurchasingRfq({ action: "createRfq", requestId, vendorIds: [vendorId] }, undefined, scoped)).resolves.toMatchObject({ kind: "completed", data: { rfqIds: [rfqId] } });
    await expect(recordPurchasingQuote({ action: "recordQuote", rfqId, amountMinor: 4200 }, undefined, scoped)).resolves.toMatchObject({ kind: "completed", data: { status: "quoted" } });
    await expect(selectPurchasingWinningQuote({ action: "selectWinningQuote", rfqId }, undefined, scoped)).resolves.toMatchObject({ kind: "completed", data: { poNumber: 73, vendorId, quoteAmountMinor: 4200 } });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map((call) => postedBody(call).capabilityId)).toEqual([
      "purchasing.createPurchaseRequest", "purchasing.decidePurchaseRequest", "purchasing.createRfq", "purchasing.recordQuote", "purchasing.selectWinningQuote",
    ]);
    expect(fetchMock.mock.calls.map((call) => postedBody(call).intentId)).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-Organization-ID"))).toEqual(Array(5).fill("org-sourcing-contract"));
  });

  it("requires scope, preserves a sourcing intent across uncertainty, pending, and Go 404", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const action = { action: "createPurchaseRequest" as const, title: "Need packaging", justification: "Stock is too low for confirmed orders." };
    const scoped = { actorId: "actor-sourcing-retry", organizationId: "org-sourcing-retry" };
    const noScopeFetch = vi.fn();
    vi.stubGlobal("fetch", noScopeFetch);
    await expect(createPurchasingRequest(action, undefined, { ...scoped, organizationId: null })).rejects.toMatchObject({ status: 0 });
    expect(noScopeFetch).not.toHaveBeenCalled();

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Approval required." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ error: "route missing" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { requestId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createPurchasingRequest(action, undefined, scoped)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    const firstIntent = postedBody(fetchMock.mock.calls[0]!).intentId;
    await expect(createPurchasingRequest(action, undefined, scoped)).resolves.toMatchObject({ kind: "pending" });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(firstIntent);
    await expect(readPendingPurchasingRequest(scoped)).resolves.toEqual(action);
    await expect(createPurchasingRequest(action, undefined, scoped)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(firstIntent);
    await expect(createPurchasingRequest(action, undefined, scoped)).resolves.toMatchObject({ kind: "completed" });
    expect(postedBody(fetchMock.mock.calls[3]!).intentId).toBe(firstIntent);
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/capabilities/execute");
    await expect(readPendingPurchasingRequest(scoped)).resolves.toBeNull();
  });

  it("reserves one sourcing intent across concurrent tabs", async () => {
    const lockRequest = stubPurchasingLocks();
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    const responses: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "createPurchaseRequest" as const, title: "Need packaging", justification: "Stock is too low for confirmed orders." };
    const scope = { actorId: "actor-sourcing-tabs", organizationId: "org-sourcing-tabs" };

    const first = createPurchasingRequest(action, undefined, scope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = createPurchasingRequest(action, undefined, scope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lockRequest).toHaveBeenCalledWith(expect.stringContaining("chaste.purchasing.sourcing.active.v1:"), { mode: "exclusive" }, expect.any(Function));
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(postedBody(fetchMock.mock.calls[0]!).intentId);

    responses.forEach((resolve) => resolve(Response.json({ ok: true, data: { requestId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce" } })));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("requires actor and organization scope before a Go purchase order request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingOrder(poAction, undefined, { actorId: "actor-1", organizationId: null }))
      .rejects.toMatchObject({ status: 0, message: expect.stringContaining("organization") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Web Locks are unavailable for purchase order retry protection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { locks: undefined }));

    await expect(createPurchasingOrder(poAction, undefined, retryScope))
      .rejects.toMatchObject({ status: 0, message: expect.stringContaining("Web Locks") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes concurrent exact purchase order drafts to one scoped intent", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    const responses: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", fetchMock);

    const first = createPurchasingOrder(poAction, undefined, retryScope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = createPurchasingOrder(poAction, undefined, retryScope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const firstIntent = postedBody(fetchMock.mock.calls[0]!).intentId;
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(firstIntent);

    responses.forEach((resolve) => resolve(Response.json({ ok: true, data: { poNumber: 46 } })));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "completed", data: { poNumber: 46 } },
      { kind: "completed", data: { poNumber: 46 } },
    ]);
  });

  it("sends purchase orders through Go with scoped stable intent across pending and uncertain retries", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Approval required." }, { status: 202 }))
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true, data: { poNumber: 42 } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingOrder(poAction, undefined, retryScope)).rejects.toMatchObject({ status: 0 });
    const first = postedBody(fetchMock.mock.calls[0]!);
    await expect(createPurchasingOrder(poAction, undefined, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "Approval required." });
    const second = postedBody(fetchMock.mock.calls[1]!);
    expect(second.intentId).toBe(first.intentId);
    expect(second).toMatchObject({
      capabilityId: "purchasing.createPurchaseOrder",
      input: { vendorId: poAction.vendorId, memo: "March stock", lines: poAction.lines },
    });
    expect(second.input).not.toHaveProperty("actorId");
    expect(second.input).not.toHaveProperty("organizationId");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("X-Organization-ID") === retryScope.organizationId)).toBe(true);
    await expect(createPurchasingOrder(poAction, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { poNumber: 42 } });
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(first.intentId);

    await createPurchasingOrder(poAction, undefined, retryScope);
    expect(postedBody(fetchMock.mock.calls[3]!).intentId).not.toBe(first.intentId);
  });

  it("keeps a purchase order intent on Go 404 and retries only through Go", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { poNumber: 43 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingOrder(poAction, undefined, retryScope))
      .rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    const goIntent = postedBody(fetchMock.mock.calls[0]!).intentId;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(createPurchasingOrder(poAction, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { poNumber: 43 } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/capabilities/execute");
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(goIntent);
  });

  it("clears a terminal purchase order rejection so a corrected draft gets a new intent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "invalid line" }, { status: 422 }))
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true, data: { poNumber: 45 } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingOrder(poAction, undefined, retryScope)).rejects.toMatchObject({ status: 422 });
    const rejectedIntent = postedBody(fetchMock.mock.calls[0]!).intentId;
    await expect(createPurchasingOrder({ ...poAction, memo: "Corrected draft" }, undefined, retryScope))
      .resolves.toMatchObject({ kind: "completed" });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).not.toBe(rejectedIntent);
  });

  it("rejects zero quantity and negative price while allowing an explicit zero price", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { poNumber: 44 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingOrder({ ...poAction, lines: [{ ...poAction.lines[0]!, quantity: 0 }] }, undefined, retryScope))
      .rejects.toMatchObject({ status: 0 });
    await expect(createPurchasingOrder({ ...poAction, lines: [{ ...poAction.lines[0]!, unitPriceMinor: -1 }] }, undefined, retryScope))
      .rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(createPurchasingOrder(poAction, undefined, retryScope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed Go purchase order output and retains the exact retry intent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { poNumber: "44" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { poNumber: 44 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingOrder(poAction, undefined, retryScope)).rejects.toMatchObject({ status: 200 });
    const firstIntent = postedBody(fetchMock.mock.calls[0]!).intentId;
    await expect(createPurchasingOrder(poAction, undefined, retryScope)).resolves.toEqual({
      kind: "completed",
      data: { poNumber: 44 },
    });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(firstIntent);
  });

  it("creates vendors through the authenticated Go capability endpoint", async () => {
    const vendorId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { vendorId } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", true);

    await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies", email: "sales@example.test" }, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { vendorId } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }));
    expect(postedBody(fetchMock.mock.calls[0]!)).toMatchObject({
      capabilityId: "purchasing.createVendor",
      input: { name: "Kampala Supplies", email: "sales@example.test" },
      intentId: expect.any(String),
    });
  });

  it("preserves a Go approval response for vendor creation", async () => {
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { ok: false, pendingApproval: true, reason: "Purchasing writes require approval." },
      { status: 202 },
    )));

    await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies" }, undefined, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "Purchasing writes require approval." });
  });

  it("keeps vendor creation on Go after a missing capability response", async () => {
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", true);
    const vendorId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { vendorId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies" }, undefined, retryScope))
      .rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const intentId = postedBody(fetchMock.mock.calls[0]!).intentId;
    await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies" }, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { vendorId } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/capabilities/execute");
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(intentId);
  });

  it("does not retry Go vendor creation on authentication or server errors", async () => {
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", true);
    for (const status of [401, 500]) {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "request failed" }, { status }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies" }, undefined, retryScope))
        .rejects.toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("creates vendors through Go even when purchasing route selectors are off", async () => {
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", false);
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", false);
    const vendorId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { vendorId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies" }, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { vendorId } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(postedBody(fetchMock.mock.calls[0]!).capabilityId).toBe("purchasing.createVendor");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(retryScope.organizationId);
  });

  it("reuses the vendor intent after an uncertain response and rejects malformed Go output", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", false);
    const vendorId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { vendorId, unexpected: true } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { vendorId } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "createVendor" as const, name: "Kampala Supplies" };

    await expect(createPurchasingVendor(action, undefined, retryScope)).rejects.toMatchObject({ status: 0 });
    const first = postedBody(fetchMock.mock.calls[0]!);
    await expect(createPurchasingVendor(action, undefined, retryScope)).rejects.toMatchObject({ status: 200 });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(first.intentId);
    await expect(createPurchasingVendor(action, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { vendorId } });
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(first.intentId);
  });

  it("routes bill creation and payment through Go with stable scoped attempts and strict results", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", false);
    const billNumber = 73;
    const entryId = "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f";
    const paymentId = "3c9e3c30-1e5c-4b3c-9d4b-5b3c4d5e6f70";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { billNumber, totalMinor: 5000, entryId } }))
      .mockRejectedValueOnce(new TypeError("payment response lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Payment needs approval." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { paymentId, entryId, fullyPaid: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const billAction = {
      action: "createBill" as const,
      vendorId: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
      vendorRef: "INV-73",
      lines: [{ description: "Replacement parts", quantity: 1000, unitPriceMinor: 5000 }],
    };
    const paymentAction = { action: "payBill" as const, billNumber, amountMinor: 5000, method: "cash" as const };

    await expect(createPurchasingBill(billAction, undefined, retryScope)).resolves.toEqual({
      kind: "completed", data: { billNumber, totalMinor: 5000, entryId },
    });
    expect(postedBody(fetchMock.mock.calls[0]!).capabilityId).toBe("purchasing.createBill");
    await expect(payPurchasingBill(paymentAction, undefined, retryScope)).rejects.toMatchObject({ status: 0 });
    const uncertain = postedBody(fetchMock.mock.calls[1]!);
    expect(uncertain).toMatchObject({ capabilityId: "purchasing.payBill", input: { billNumber, amountMinor: 5000, method: "cash" } });
    await expect(payPurchasingBill(paymentAction, undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Payment needs approval." });
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(uncertain.intentId);
    await expect(payPurchasingBill(paymentAction, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { paymentId, entryId, fullyPaid: true } });
    expect(postedBody(fetchMock.mock.calls[3]!).intentId).toBe(uncertain.intentId);
  });

  it("reverses a standalone vendor payment with exact pending recovery and strict output validation", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", false);
    const paymentId = "3c9e3c30-1e5c-4b3c-9d4b-5b3c4d5e6f70";
    const reversalEntryId = "4dae4d41-2f6d-4c4d-ae5c-6c4d5e6f7081";
    const action = { action: "reverseVendorPayment" as const, vendorPaymentId: paymentId, reason: "Duplicate vendor payment" };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, reason: "Reversal needs approval." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reversalEntryId, refundedMinor: 5000, billNumber: 73, outstandingMinor: 5000, extra: true } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reversalEntryId, refundedMinor: 5000, billNumber: 73, outstandingMinor: 5000 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reversePurchasingBillPayment(action, undefined, retryScope)).rejects.toMatchObject({ status: 0 });
    const uncertain = postedBody(fetchMock.mock.calls[0]!);
    expect(uncertain).toMatchObject({ capabilityId: "purchasing.reverseVendorPayment", input: { vendorPaymentId: paymentId, reason: action.reason } });
    await expect(readPendingPurchasingPaymentReversal(retryScope)).resolves.toEqual(action);
    await expect(reversePurchasingBillPayment(action, undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Reversal needs approval." });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(uncertain.intentId);
    await expect(reversePurchasingBillPayment(action, undefined, retryScope)).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected result") });
    await expect(reversePurchasingBillPayment(action, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { reversalEntryId, refundedMinor: 5000, billNumber: 73, outstandingMinor: 5000 } });
    expect(postedBody(fetchMock.mock.calls[3]!).intentId).toBe(uncertain.intentId);
    await expect(readPendingPurchasingPaymentReversal(retryScope)).resolves.toBeNull();
  });

  it("serializes cross-tab bill payment reservations for one actor and organization", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ pendingApproval: true, reason: "Approval required." }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const paymentAction = { action: "payBill" as const, billNumber: 91, amountMinor: 1200, method: "cash" as const };
    const alternatePayment = { ...paymentAction, amountMinor: 1100 };

    const outcomes = await Promise.allSettled([
      payPurchasingBill(paymentAction, undefined, retryScope),
      payPurchasingBill(alternatePayment, undefined, retryScope),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await readPendingPurchasingBillPayment(retryScope);
    expect([paymentAction, alternatePayment]).toContainEqual(stored);
  });

  it("fails closed when browser-wide Purchasing locks are unavailable", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    vi.stubGlobal("navigator", {} as Navigator);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { paymentId: "3c9e3c30-1e5c-4b3c-9d4b-5b3c4d5e6f70", entryId: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f", fullyPaid: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(payPurchasingBill({ action: "payBill", billNumber: 91, amountMinor: 1200 }, undefined, retryScope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("cannot safely reserve a Purchasing action"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("persists the exact omitted-method payment for reload recovery", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const action = { action: "payBill" as const, billNumber: 91, amountMinor: 1200 };
    const paymentId = "3c9e3c30-1e5c-4b3c-9d4b-5b3c4d5e6f70";
    const entryId = "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, reason: "Approval required." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { paymentId, entryId, fullyPaid: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(payPurchasingBill(action, undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Approval required." });
    const first = postedBody(fetchMock.mock.calls[0]!);
    expect(first).toMatchObject({ capabilityId: "purchasing.payBill", input: { billNumber: 91, amountMinor: 1200 } });
    expect(first.input).not.toHaveProperty("method");
    await expect(readPendingPurchasingBillPayment(retryScope)).resolves.toEqual(action);
    await expect(payPurchasingBill(action, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { paymentId, entryId, fullyPaid: true } });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(first.intentId);
    await expect(readPendingPurchasingBillPayment(retryScope)).resolves.toBeNull();
  });

  it("keeps a payBill marker on Go 404 without calling the legacy Purchasing route", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const action = { action: "payBill" as const, billNumber: 92, amountMinor: 850 };
    const paymentId = "3c9e3c30-1e5c-4b3c-9d4b-5b3c4d5e6f70";
    const entryId = "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "capability not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { paymentId, entryId, fullyPaid: false } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(payPurchasingBill(action, undefined, retryScope)).rejects.toMatchObject({
      status: 404,
      requestMayHaveReachedServer: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(await readPendingPurchasingBillPayment(retryScope)).toEqual(action);

    const first = postedBody(fetchMock.mock.calls[0]!);
    await expect(payPurchasingBill(action, undefined, retryScope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/capabilities/execute");
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(first.intentId);
    expect(await readPendingPurchasingBillPayment(retryScope)).toBeNull();
  });

  it("routes bill credits through Go, reuses the intent after pending or 404, and validates the result", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const entryId = "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Credit approval required." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { entryId, creditedMinor: 5000, billBalanceMinor: 7500 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { entryId, creditedMinor: 5000, billBalanceMinor: 7500, extra: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = {
      action: "billCreditNote" as const,
      billId: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f",
      amountMinor: 5000,
      reason: "Damaged delivery",
    };

    await expect(creditPurchasingBill(action, undefined, retryScope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    const uncertainAttempt = postedBody(fetchMock.mock.calls[0]!);
    expect(uncertainAttempt).toMatchObject({
      capabilityId: "purchasing.billCreditNote",
      input: { billId: action.billId, amountMinor: 5000, reason: action.reason },
    });
    await expect(creditPurchasingBill(action, undefined, retryScope)).resolves.toEqual({ kind: "pending", reason: "Credit approval required." });
    const pendingAttempt = postedBody(fetchMock.mock.calls[1]!);
    expect(pendingAttempt.intentId).toBe(uncertainAttempt.intentId);
    await expect(creditPurchasingBill(action, undefined, retryScope)).resolves.toEqual({
      kind: "completed", data: { entryId, creditedMinor: 5000, billBalanceMinor: 7500 },
    });
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(pendingAttempt.intentId);
    await expect(creditPurchasingBill(action, undefined, retryScope)).rejects.toMatchObject({ status: 200 });

    const retryFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Go route missing" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { entryId, creditedMinor: 5000, billBalanceMinor: 7500 } }));
    vi.stubGlobal("fetch", retryFetch);
    await expect(creditPurchasingBill(action, undefined, retryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    const retryIntent = postedBody(retryFetch.mock.calls[0]!).intentId;
    await expect(creditPurchasingBill(action, undefined, retryScope)).resolves.toMatchObject({ kind: "completed" });
    expect(retryFetch).toHaveBeenCalledTimes(2);
    expect(retryFetch.mock.calls.map((call) => call[0])).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(postedBody(retryFetch.mock.calls[1]!).intentId).toBe(retryIntent);
  });

  it("fails closed for Go bill credits without scope or with malformed input", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "billCreditNote" as const, billId: "not-a-uuid", amountMinor: 1, reason: "x" };
    await expect(creditPurchasingBill(action, undefined, retryScope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: false });
    await expect(creditPurchasingBill({ ...action, billId: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f", reason: "valid reason" }, undefined, { actorId: "actor", organizationId: null }))
      .rejects.toMatchObject({ status: 0, message: expect.stringContaining("organization") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires actor and organization scope and rejects Go payment bounds before sending", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 10 }, undefined, { actorId: "actor", organizationId: null }))
      .rejects.toMatchObject({ status: 0, message: expect.stringContaining("organization") });
    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 2_147_483_648 }, undefined, retryScope))
      .rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stamps an intentId on every POST for idempotency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { entryId: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f", creditedMinor: 100, billBalanceMinor: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await creditPurchasingBill({ action: "billCreditNote", billId: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f", amountMinor: 100, reason: "damaged" }, undefined, retryScope);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = postedBody(fetchMock.mock.calls[0]!);
    expect(init.method).toBe("POST");
    expect(body.capabilityId).toBe("purchasing.billCreditNote");
    expect(body.input).toMatchObject({ billId: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f", amountMinor: 100, reason: "damaged" });
    expect(body.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("keeps a 202 as pending and surfaces the reason instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { pendingApproval: true, reason: "Over the payment threshold." },
      { status: 202 },
    )));

    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 5000 }, undefined, retryScope)).resolves.toEqual({
      kind: "pending",
      reason: "Over the payment threshold.",
    });
  });

  it("falls back to the kernel error field, then to a generic reason, for a 202", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true, error: "Needs a second approver." }, { status: 202 })));
    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 5000 }, undefined, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "Needs a second approver." });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 5000 }, undefined, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "This action is waiting for approval." });
  });

  it("parses Go receipt and short-close results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({
      ok: true,
      data: { received: true, fullyReceived: false, receiptNumber: 3 },
    })));
    await expect(receivePurchasingGoods({
      action: "receiveGoods",
      poNumber: 42,
      lines: [{ lineNumber: 1, quantity: 2500 }],
    }, undefined, retryScope)).resolves.toEqual({ kind: "completed", data: { received: true, fullyReceived: false, receiptNumber: 3 } });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { closed: true, backordered: true, shortThousandths: 1500 },
    })));
    await expect(closePurchasingOrder({ action: "closePurchaseOrder", poNumber: 42 }, undefined, retryScope)).resolves.toEqual({
      kind: "completed",
      data: { closed: true, backordered: true, shortThousandths: 1500 },
    });
  });

  it("routes returns and close through Go with exact outputs and stable scoped intent", async () => {
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", false);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Approval required." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { returned: true, lines: 1 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { closed: true, backordered: true, shortThousandths: 1500 } }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "actor-return", organizationId: "org-return" };
    const returnAction = { action: "returnGoods" as const, poNumber: 42, receiptNumber: 4, lines: [{ lineNumber: 1, quantity: 250, reason: "damaged carton" }] };

    await expect(returnPurchasingGoods(returnAction, undefined, scope)).rejects.toMatchObject({ status: 0 });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(scope.organizationId);
    const uncertainRequest = postedBody(fetchMock.mock.calls[0]!);
    await expect(returnPurchasingGoods(returnAction, undefined, scope)).resolves.toEqual({ kind: "pending", reason: "Approval required." });
    const pendingRequest = postedBody(fetchMock.mock.calls[1]!);
    expect(pendingRequest.intentId).toBe(uncertainRequest.intentId);
    expect(pendingRequest).toMatchObject({
      capabilityId: "purchasing.returnGoods",
      input: { poNumber: 42, receiptNumber: 4, lines: returnAction.lines },
      intentId: expect.any(String),
    });
    await expect(returnPurchasingGoods(returnAction, undefined, scope)).resolves.toEqual({ kind: "completed", data: { returned: true, lines: 1 } });
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(pendingRequest.intentId);

    await expect(closePurchasingOrder({ action: "closePurchaseOrder", poNumber: 42 }, undefined, scope)).resolves.toMatchObject({ kind: "completed", data: { closed: true } });
    expect(postedBody(fetchMock.mock.calls[3]!)).toMatchObject({
      capabilityId: "purchasing.closePurchaseOrder",
      input: { poNumber: 42 },
      intentId: expect.any(String),
    });
  });

  it("reserves one lifecycle intent across concurrent tabs", async () => {
    const lockRequest = stubPurchasingLocks();
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", true);
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "closePurchaseOrder" as const, poNumber: 42 };
    const scope = { actorId: "actor-lifecycle-tabs", organizationId: "org-lifecycle-tabs" };

    const first = closePurchasingOrder(action, undefined, scope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = closePurchasingOrder(action, undefined, scope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lockRequest).toHaveBeenCalledWith(expect.stringContaining("chaste.purchasing.lifecycle.active.v1:"), { mode: "exclusive" }, expect.any(Function));
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(postedBody(fetchMock.mock.calls[0]!).intentId);

    responses.forEach((resolve) => resolve(Response.json({ ok: true, data: { closed: true, backordered: false, shortThousandths: 0 } })));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("keeps returns and close on Go after 404 and rejects malformed Go output", async () => {
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "route absent" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { returned: true, lines: 1 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { closed: true, backordered: false, shortThousandths: 0, extra: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "actor-return", organizationId: "org-return" };

    const returnAction = { action: "returnGoods" as const, poNumber: 42, lines: [{ lineNumber: 1, quantity: 5, reason: "damaged" }] };
    await expect(returnPurchasingGoods(returnAction, undefined, scope))
      .rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    const intentId = postedBody(fetchMock.mock.calls[0]!).intentId;
    await expect(returnPurchasingGoods(returnAction, undefined, scope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/capabilities/execute");
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(intentId);
    await expect(closePurchasingOrder({ action: "closePurchaseOrder", poNumber: 42 }, undefined, scope)).rejects.toMatchObject({ status: 200 });
  });

  it("fails closed without actor or organization scope and checks Go bounds", async () => {
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnGoods" as const, poNumber: 42, lines: [{ lineNumber: 1, quantity: 1, reason: "damaged" }] };
    await expect(returnPurchasingGoods(action, undefined, { actorId: "actor-return", organizationId: null })).rejects.toMatchObject({ status: 0 });
    await expect(returnPurchasingGoods({ ...action, lines: [{ ...action.lines[0]!, quantity: 2_147_483_648 }] }, undefined, { actorId: "actor-return", organizationId: "org-return" })).rejects.toMatchObject({ status: 0 });
    await expect(returnPurchasingGoods({ ...action, poNumber: 2_147_483_648 }, undefined, { actorId: "actor-return", organizationId: "org-return" })).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends authority-gated overreceipt fields only when they are supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await receivePurchasingGoods({
      action: "receiveGoods",
      poNumber: 42,
      lines: [{ lineNumber: 1, quantity: 10500, rejected: 0, rejectionNote: undefined }],
      overreceiptTolerancePct: 10,
      authorityReason: "site manager approved in writing",
    }, undefined, retryScope);
    expect(postedBody(fetchMock.mock.calls[0]!)).toMatchObject({
      capabilityId: "purchasing.receiveGoods",
      input: {
      overreceiptTolerancePct: 10,
      authorityReason: "site manager approved in writing",
      },
    });
  });

  it("refuses a write whose shape the capability never declared", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // @ts-expect-error the discriminated union must reject an unknown action.
    await expect(createPurchasingVendor({ action: "nonsense", name: "X" })).rejects.toMatchObject({
      status: 0,
      message: "Check the purchasing details and try again.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a completed result whose data does not match the declared output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { received: true, receiptNumber: 1 } })));
    const result = receivePurchasingGoods({ action: "receiveGoods", poNumber: 42, lines: [{ lineNumber: 1, quantity: 10 }] }, undefined, retryScope);
    await expect(result).rejects.toMatchObject({ status: 200 });
    await expect(result).rejects.toThrow("The Purchasing service returned an unexpected receipt result.");
  });
});

describe("purchasing intel reads", () => {
  it("omits a blank SKU filter and trims a supplied one", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ ok: true, data: { rows: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingPriceHistory("   ", "org-test")).resolves.toEqual([]);
    expect(postedBody(fetchMock.mock.calls[0]!)).toMatchObject({ capabilityId: "purchasing.priceHistory", input: {}, intentId: expect.any(String) });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe("org-test");

    await fetchPurchasingPriceHistory("  RC-BAG  ", "org-test");
    expect(postedBody(fetchMock.mock.calls[1]!)).toMatchObject({ capabilityId: "purchasing.priceHistory", input: { sku: "RC-BAG" }, intentId: expect.any(String) });
  });

  it("does not treat a pending legacy supplier statement as an empty statement", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(fetchPurchasingSupplierStatement(workspace.vendors[0]!.id, "org-test")).rejects.toMatchObject({ status: 202 });
  });

  it("loads price history and supplier performance through the paired Go read selector", async () => {
    vi.stubGlobal("__GO_PURCHASING_INTEL_READS__", false);
    const history = [{ vendorName: "Harbor", itemSku: "WIRE", itemDescription: "Copper wire", unitPriceMinor: 45000, orderedAt: null }];
    const performance = [{ vendorId: workspace.vendors[0]!.id, vendorName: "Harbor", orders: 2, avgLeadTimeDays: 4, onTimeRate: 100, fillRate: 70, backorderedOrders: 0 }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { rows: history } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { vendors: performance } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingPriceHistory(" WIRE ", "org-test")).resolves.toEqual(history);
    await expect(fetchPurchasingSupplierPerformance("org-test")).resolves.toEqual(performance);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("X-Organization-ID") === "org-test")).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "purchasing.priceHistory",
      input: { sku: "WIRE" },
      intentId: expect.any(String),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      capabilityId: "purchasing.supplierPerformance",
      input: {},
      intentId: expect.any(String),
    });
  });

  it("rejects pending, unavailable, and malformed Go analytics instead of returning empty data", async () => {
    vi.stubGlobal("__GO_PURCHASING_INTEL_READS__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ error: "capability unavailable" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { vendors: [{ vendorId: "x" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingPriceHistory(undefined, "org-test")).rejects.toThrow(/pending and did not return analytics/);
    await expect(fetchPurchasingPriceHistory(undefined, "org-test")).rejects.toMatchObject({ status: 404 });
    await expect(fetchPurchasingSupplierPerformance("org-test")).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected result") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });

  it("returns the statement rows when the read completes", async () => {
    const statement = {
      closingBalanceMinor: 4200,
      rows: [{ date: "2026-08-12T09:30:00.000Z", kind: "bill", ref: "#7", amountMinor: 12500, balanceMinor: 12500 }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: statement })));
    await expect(fetchPurchasingSupplierStatement(workspace.vendors[0]!.id, "org-test")).resolves.toEqual(statement);
  });

  it("uses the Go supplierStatement capability with the UUID vendor ID", async () => {
    vi.stubGlobal("__GO_PURCHASING_SUPPLIER_STATEMENT_READS__", true);
    const statement = { closingBalanceMinor: 12500, rows: [] };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: statement }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingSupplierStatement(workspace.vendors[0]!.id, "org-test")).resolves.toEqual(statement);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/capabilities/execute");
    expect(new Headers(init?.headers).get("X-Organization-ID")).toBe("org-test");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      capabilityId: "purchasing.supplierStatement",
      input: { vendorId: workspace.vendors[0]!.id },
      intentId: expect.any(String),
    });
  });

  it("rejects invalid vendor IDs, 202s, and malformed Go statement data", async () => {
    vi.stubGlobal("__GO_PURCHASING_SUPPLIER_STATEMENT_READS__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { closingBalanceMinor: "12500", rows: [] } }))
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingSupplierStatement("vendor-not-uuid", "org-test")).rejects.toMatchObject({ status: 0 });
    await expect(fetchPurchasingSupplierStatement(workspace.vendors[0]!.id, "org-test")).rejects.toMatchObject({ status: 202 });
    await expect(fetchPurchasingSupplierStatement(workspace.vendors[0]!.id, "org-test")).rejects.toMatchObject({ status: 200 });
    await expect(fetchPurchasingSupplierStatement(workspace.vendors[0]!.id, "org-test")).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });
});

describe("purchasing error mapping", () => {
  const retryScope = { actorId: "actor-purchasing-errors", organizationId: "org-purchasing-errors" };
  beforeEach(() => { stubPurchasingLocks(); });

  it("prefers the service message and falls back per status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "Vendor is deactivated." }, { status: 400 })));
    await expect(createPurchasingVendor({ action: "createVendor", name: "X Supplies" }, undefined, retryScope))
      .rejects.toMatchObject({ status: 400, message: "Vendor is deactivated." });

    for (const [status, expected] of [
      [401, "Your session has expired. Sign in again to open Purchasing."],
      [403, "Your account does not have permission to use Purchasing."],
      [428, "Finish setting up your workspace before using Purchasing."],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status })));
      await expect(createPurchasingVendor({ action: "createVendor", name: "X Supplies" }, undefined, retryScope))
        .rejects.toMatchObject({ status, message: expected });
    }
  });

  it("reports an unreachable service as a zero-status error rather than a crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    const error = await fetchPurchasingWorkspace("org-test").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PurchasingApiError);
    expect(error).toMatchObject({
      status: 0,
      message: "Could not reach the Purchasing service. Check your connection and try again.",
    });
  });

  it("lets an aborted caller signal win over the generic transport message", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    controller.abort();

    await expect(fetchPurchasingWorkspace("org-test", controller.signal)).rejects.toBe(abortError);
  });
});
