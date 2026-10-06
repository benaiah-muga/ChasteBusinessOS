import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closePurchasingOrder,
  createPurchasingBill,
  createPurchasingOrder,
  createPurchasingVendor,
  creditPurchasingBill,
  fetchPurchasingEnabled,
  fetchPurchasingInputTaxCodes,
  fetchPurchasingPriceHistory,
  fetchPurchasingProducts,
  fetchPurchasingSupplierStatement,
  fetchPurchasingWorkspace,
  payPurchasingBill,
  PurchasingApiError,
  receivePurchasingGoods,
  returnPurchasingGoods,
} from "./purchasing";

afterEach(() => vi.unstubAllGlobals());

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
  }],
  requests: [],
};

const switchboard = { catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] };

function postedBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe("purchasing API module gate", () => {
  it("confirms the module is enabled and every enabled id is in the catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(switchboard));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    }));
  });

  it("reports Purchasing as off when the switchboard omits it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: [] })));
    await expect(fetchPurchasingEnabled()).resolves.toBe(false);
  });

  it("refuses a switchboard whose enabled ids are not all catalogued", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      catalog: [{ id: "purchasing" }],
      enabledModules: ["purchasing", "ghost"],
    })));
    await expect(fetchPurchasingEnabled()).rejects.toMatchObject({
      name: "PurchasingApiError",
      status: 200,
      message: "The module switchboard returned an invalid Purchasing configuration.",
    });
  });
});

describe("purchasing workspace reads", () => {
  it("returns the validated workspace and rejects an unexpected shape", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(workspace));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPurchasingWorkspace()).resolves.toEqual(workspace);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...workspace, orders: [{ number: 1 }] })));
    await expect(fetchPurchasingWorkspace()).rejects.toMatchObject({
      status: 200,
      message: "The Purchasing service returned the purchasing workspace in an unexpected format.",
    });
  });

  it("defaults missing requests to an empty list", async () => {
    const { requests: _requests, ...withoutRequests } = workspace;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(withoutRequests)));
    await expect(fetchPurchasingWorkspace()).resolves.toMatchObject({ requests: [] });
  });

  it("keeps stocked products that carry more columns than the form reads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      items: [
        { sku: "RC-BAG", name: "Canvas bag", avgUnitCostMinor: 5000, kind: "goods", onHand: 12 },
        { sku: "RC-SVC", name: "Consulting", kind: "service" },
      ],
    })));
    await expect(fetchPurchasingProducts()).resolves.toEqual([
      { sku: "RC-BAG", name: "Canvas bag", avgUnitCostMinor: 5000, kind: "goods", onHand: 12 },
      { sku: "RC-SVC", name: "Consulting", kind: "service" },
    ]);
  });

  it("keeps only active input tax codes for a vendor bill", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      codes: [
        { id: "3c9e3c30-1e5c-4b3c-9d4a-5b3c4d5e6f70", code: "VAT-IN", name: "Input VAT", direction: "input", rateBasisPoints: 500, priceIncludesTax: true, active: true },
        { id: "4daf4d41-2f6d-4c4d-8e5b-6c4d5e6f7081", code: "VAT-OUT", name: "Output VAT", direction: "output", rateBasisPoints: 500, priceIncludesTax: true, active: true },
        { id: "5eb05e52-307e-4d5e-9f6c-7d5e6f708192", code: "OLD", name: "Retired", direction: "input", rateBasisPoints: 100, priceIncludesTax: false, active: false },
      ],
    })));
    await expect(fetchPurchasingInputTaxCodes()).resolves.toHaveLength(1);
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

  it("requires actor and organization scope before a Go purchase order request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_PURCHASING_CREATE_ORDER__", true);

    await expect(createPurchasingOrder(poAction, undefined, { actorId: "actor-1", organizationId: null }))
      .rejects.toMatchObject({ status: 0, message: expect.stringContaining("organization") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends purchase orders through Go with scoped stable intent across pending and uncertain retries", async () => {
    vi.stubGlobal("__GO_PURCHASING_CREATE_ORDER__", true);
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
    await expect(createPurchasingOrder(poAction, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { poNumber: 42 } });
    expect(postedBody(fetchMock.mock.calls[2]!).intentId).toBe(first.intentId);

    await createPurchasingOrder(poAction, undefined, retryScope);
    expect(postedBody(fetchMock.mock.calls[3]!).intentId).not.toBe(first.intentId);
  });

  it("falls back to the legacy route with the same purchase order intent", async () => {
    vi.stubGlobal("__GO_PURCHASING_CREATE_ORDER__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { poNumber: 43 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingOrder(poAction, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { poNumber: 43 } });
    const goIntent = postedBody(fetchMock.mock.calls[0]!).intentId;
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/purchasing");
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(goIntent);
    expect(postedBody(fetchMock.mock.calls[1]!).action).toBe("createPurchaseOrder");
  });

  it("clears a terminal purchase order rejection so a corrected draft gets a new intent", async () => {
    vi.stubGlobal("__GO_PURCHASING_CREATE_ORDER__", true);
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
    vi.stubGlobal("__GO_PURCHASING_CREATE_ORDER__", true);
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

  it("uses the established Purchasing write only when the Go capability route is absent", async () => {
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { vendorId: "vendor-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies" }, undefined, retryScope))
      .resolves.toEqual({ kind: "completed", data: { vendorId: "vendor-1" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/purchasing");
    expect(postedBody(fetchMock.mock.calls[1]!)).toMatchObject({ action: "createVendor", name: "Kampala Supplies" });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(postedBody(fetchMock.mock.calls[0]!).intentId);
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

  it("keeps legacy vendor creation as the default when the Go slice flag is off", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { vendorId: "vendor-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPurchasingVendor({ action: "createVendor", name: "Kampala Supplies" }))
      .resolves.toEqual({ kind: "completed", data: { vendorId: "vendor-1" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/purchasing");
  });

  it("reuses the vendor intent after an uncertain response and rejects malformed Go output", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
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
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
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

  it("routes bill credits through Go, reuses the intent after pending, and validates the result", async () => {
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

    const fallbackFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Go route missing" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { entryId, creditedMinor: 5000, billBalanceMinor: 7500 } }));
    vi.stubGlobal("fetch", fallbackFetch);
    await expect(creditPurchasingBill(action, undefined, retryScope)).resolves.toMatchObject({ kind: "completed" });
    expect(fallbackFetch).toHaveBeenCalledTimes(2);
    expect(postedBody(fallbackFetch.mock.calls[0]!).intentId).toBe(postedBody(fallbackFetch.mock.calls[1]!).intentId);
    expect(postedBody(fallbackFetch.mock.calls[1]!)).toMatchObject({ action: "billCreditNote", billId: action.billId, reason: action.reason });
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
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { entryId: "e-1", creditedMinor: 100, billBalanceMinor: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await creditPurchasingBill({ action: "billCreditNote", billId: "b-1", amountMinor: 100, reason: "damaged" });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = postedBody(fetchMock.mock.calls[0]!);
    expect(init.method).toBe("POST");
    expect(body.action).toBe("billCreditNote");
    expect(body.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("keeps a 202 as pending and surfaces the reason instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { pendingApproval: true, reason: "Over the payment threshold." },
      { status: 202 },
    )));

    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 5000 })).resolves.toEqual({
      kind: "pending",
      reason: "Over the payment threshold.",
    });
  });

  it("falls back to the kernel error field, then to a generic reason, for a 202", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true, error: "Needs a second approver." }, { status: 202 })));
    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 5000 }))
      .resolves.toEqual({ kind: "pending", reason: "Needs a second approver." });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(payPurchasingBill({ action: "payBill", billNumber: 7, amountMinor: 5000 }))
      .resolves.toEqual({ kind: "pending", reason: "This action is waiting for approval." });
  });

  it("parses the receipt result and the short-close result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({
      ok: true,
      data: { received: true, fullyReceived: false, receiptNumber: 3 },
    })));
    await expect(receivePurchasingGoods({
      action: "receiveGoods",
      poNumber: 42,
      lines: [{ lineNumber: 1, quantity: 2500 }],
    })).resolves.toEqual({ kind: "completed", data: { received: true, fullyReceived: false, receiptNumber: 3 } });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { closed: true, backordered: true, shortThousandths: 1500 },
    })));
    await expect(closePurchasingOrder({ action: "closePurchaseOrder", poNumber: 42 })).resolves.toEqual({
      kind: "completed",
      data: { closed: true, backordered: true, shortThousandths: 1500 },
    });
  });

  it("routes returns and close through Go with exact outputs and stable scoped intent", async () => {
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", true);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Approval required." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { returned: true, lines: 1 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { closed: true, backordered: true, shortThousandths: 1500 } }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "actor-return", organizationId: "org-return" };
    const returnAction = { action: "returnGoods" as const, poNumber: 42, receiptNumber: 4, lines: [{ lineNumber: 1, quantity: 250, reason: "damaged carton" }] };

    await expect(returnPurchasingGoods(returnAction, undefined, scope)).rejects.toMatchObject({ status: 0 });
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

  it("uses the same scoped intent for Go 404 fallback and rejects malformed Go output", async () => {
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "route absent" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { returned: true, lines: 1 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { closed: true, backordered: false, shortThousandths: 0, extra: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "actor-return", organizationId: "org-return" };

    await expect(returnPurchasingGoods({ action: "returnGoods", poNumber: 42, lines: [{ lineNumber: 1, quantity: 5, reason: "damaged" }] }, undefined, scope))
      .resolves.toMatchObject({ kind: "completed" });
    expect(postedBody(fetchMock.mock.calls[1]!).intentId).toBe(postedBody(fetchMock.mock.calls[0]!).intentId);
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
    });
    expect(postedBody(fetchMock.mock.calls[0]!)).toMatchObject({
      overreceiptTolerancePct: 10,
      authorityReason: "site manager approved in writing",
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
    await expect(receivePurchasingGoods({ action: "receiveGoods", poNumber: 42, lines: [{ lineNumber: 1, quantity: 10 }] }))
      .rejects.toMatchObject({
        status: 200,
        message: "The Purchasing service returned an unexpected result: could not recording the receipt.",
      });
  });
});

describe("purchasing intel reads", () => {
  it("omits a blank SKU filter and trims a supplied one", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ ok: true, data: { rows: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingPriceHistory("   ")).resolves.toEqual([]);
    expect(postedBody(fetchMock.mock.calls[0]!)).toEqual({ action: "priceHistory", intentId: expect.any(String) });

    await fetchPurchasingPriceHistory("  RC-BAG  ");
    expect(postedBody(fetchMock.mock.calls[1]!)).toMatchObject({ action: "priceHistory", sku: "RC-BAG" });
  });

  it("returns an empty statement when the kernel parks the read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(fetchPurchasingSupplierStatement("v-1")).resolves.toEqual({ closingBalanceMinor: 0, rows: [] });
  });

  it("returns the statement rows when the read completes", async () => {
    const statement = {
      closingBalanceMinor: 4200,
      rows: [{ date: "2026-08-12T09:30:00.000Z", kind: "bill", ref: "#7", amountMinor: 12500, balanceMinor: 12500 }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: statement })));
    await expect(fetchPurchasingSupplierStatement("v-1")).resolves.toEqual(statement);
  });
});

describe("purchasing error mapping", () => {
  it("prefers the service message and falls back per status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "Vendor is deactivated." }, { status: 400 })));
    await expect(createPurchasingVendor({ action: "createVendor", name: "X" }))
      .rejects.toMatchObject({ status: 400, message: "Vendor is deactivated." });

    for (const [status, expected] of [
      [401, "Your session has expired. Sign in again to open Purchasing."],
      [403, "Your account does not have permission to use Purchasing."],
      [428, "Finish setting up your workspace before using Purchasing."],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status })));
      await expect(createPurchasingVendor({ action: "createVendor", name: "X" }))
        .rejects.toMatchObject({ status, message: expected });
    }
  });

  it("reports an unreachable service as a zero-status error rather than a crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    const error = await fetchPurchasingWorkspace().catch((caught: unknown) => caught);
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

    await expect(fetchPurchasingWorkspace(controller.signal)).rejects.toBe(abortError);
  });
});
