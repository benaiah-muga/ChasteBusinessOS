import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adjustPosItemStock,
  closePosSession,
  createPosQuickProduct,
  fetchPosCatalog,
  fetchPosCustomers,
  fetchPosModules,
  fetchPosRegisterState,
  openPosSession,
  requestPosReturn,
  submitPosSale,
} from "./pos-session";
import { PosApiError } from "./pos";

const openId = "10000000-0000-4000-8000-000000000001";
const saleId = "20000000-0000-4000-8000-000000000002";
const lineId = "30000000-0000-4000-8000-000000000003";

const openSession = {
  id: openId,
  register: "Front register",
  status: "open",
  openingFloatMinor: 10000,
  expectedCashMinor: 4500,
  countedCashMinor: null,
  varianceMinor: null,
  openedAt: "2026-09-28T09:00:00.000Z",
  closedAt: null,
};

const sale = {
  id: saleId,
  number: 41,
  status: "posted",
  totalMinor: 2500,
  creditedMinor: 0,
  memo: null,
  customerId: null,
  customerName: null,
  method: "cash",
  returnMode: "itemized" as const,
  unallocatedCreditMinor: 0,
  lines: [{
    id: lineId,
    itemId: null,
    description: "Boda bread",
    quantity: 1000,
    unitPriceMinor: 2500,
    taxMinor: 0,
    returnedQuantity: 0,
    stockTracked: true,
  }],
  createdAt: "2026-09-28T10:00:00.000Z",
};

const catalogItem = {
  sku: "BRD-001",
  name: "Boda bread",
  kind: "goods",
  unitLabel: "loaf",
  salePriceMinor: 2500,
  barcode: "6001234567890",
  availableThousandths: 12000,
  tags: [] as string[],
};

function saleAction() {
  return {
    action: "sale" as const,
    sessionId: openId,
    method: "cash" as const,
    lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
    tenders: [{ method: "cash" as const, amountMinor: 2500 }],
    cashReceivedMinor: 3000,
  };
}

const saleOutput = {
  invoiceId: saleId,
  invoiceNumber: 41,
  totalMinor: 2500,
  tenderedMinor: 3000,
  changeGivenMinor: 500,
  tenders: [{ method: "cash", amountMinor: 3000 }],
};

afterEach(() => vi.unstubAllGlobals());

describe("POS register session API client", () => {
  it("loads the drawer and the sale list from one uncached read", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ sessions: [openSession], sales: [sale] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosRegisterState()).resolves.toEqual({ sessions: [openSession], sales: [sale] });
    expect(fetchMock).toHaveBeenCalledWith("/api/pos", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    }));
  });

  it("rejects register data whose money fields are not integer minor units", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      sessions: [{ ...openSession, openingFloatMinor: "100.00" }],
      sales: [],
    })));
    await expect(fetchPosRegisterState()).rejects.toMatchObject({
      message: "The POS service returned register data in an unexpected format.",
    });
  });

  it("surfaces an unreadable catalog and customer list as separate failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ items: [catalogItem] })));
    await expect(fetchPosCatalog()).resolves.toEqual([catalogItem]);

    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ customers: [{ id: "c1", name: "Amina", purchaseCount: 2, lifetimeSpendMinor: 100 }] })));
    await expect(fetchPosCustomers()).resolves.toEqual([{ id: "c1", name: "Amina", purchaseCount: 2, lifetimeSpendMinor: 100 }]);

    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ error: "nope" }, { status: 403 })));
    await expect(fetchPosCatalog()).rejects.toMatchObject({ status: 403, message: "nope" });
  });

  it("loads POS customer options from Go and keeps the legacy response schema", async () => {
    const customers = [{ id: "50000000-0000-4000-8000-000000000005", name: "Amina", email: "amina@example.test", purchaseCount: 3, lifetimeSpendMinor: 4500 }];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ customers }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosCustomers(undefined, { useGo: true })).resolves.toEqual(customers);
    expect(fetchMock).toHaveBeenCalledWith("/api/pos/customers", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    }));
  });

  it("falls back to legacy POS customer lookup only when the Go route is missing", async () => {
    const customers = [{ id: "50000000-0000-4000-8000-000000000005", name: "Amina", email: "amina@example.test", purchaseCount: 3, lifetimeSpendMinor: 4500 }];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ customers }));
    fetchMock.mockImplementationOnce(async () => Response.json({ error: "route not mounted" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPosCustomers(undefined, { useGo: true })).resolves.toEqual(customers);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/pos/customers", "/api/customers"]);
  });

  it.each([401, 403, 500])("does not fall back after Go customer lookup HTTP %s", async (status) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ error: "Go rejected customer read" }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPosCustomers(undefined, { useGo: true })).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("derives module gates from the switchboard and rejects an inconsistent one", async () => {
    const catalog = [{ id: "pos" }, { id: "inventory" }, { id: "crm" }];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ catalog, enabledModules: ["pos"] })));
    await expect(fetchPosModules()).resolves.toEqual({ pos: true, inventory: false });

    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ catalog, enabledModules: ["ghost"] })));
    await expect(fetchPosModules()).rejects.toBeInstanceOf(PosApiError);
  });

  it("posts a governed open and keeps a 202 approval envelope pending", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: { sessionId: openId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(openPosSession({ action: "open", openingFloatMinor: 10000 })).resolves.toEqual({
      kind: "completed",
      data: { sessionId: openId },
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/pos");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual(expect.objectContaining({
      action: "open",
      openingFloatMinor: 10000,
      intentId: expect.any(String),
    }));

    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: false, pendingApproval: true, reason: "needs a manager" }, { status: 202 })));
    await expect(openPosSession({ action: "open", openingFloatMinor: 0 })).resolves.toEqual({ kind: "pending", reason: "needs a manager" });
  });

  it("routes register opening through Go when opted in and retries a missing Go route with the same intent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: { sessionId: openId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(openPosSession({ action: "open", openingFloatMinor: 2500 }, undefined, { useGo: true })).resolves.toEqual({
      kind: "completed",
      data: { sessionId: openId },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/capabilities/execute");
    const goBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(goBody).toEqual({
      capabilityId: "pos.openSession",
      input: { openingFloatMinor: 2500 },
      intentId: expect.any(String),
    });

    fetchMock.mockImplementationOnce(async () => Response.json({ error: "route not mounted" }, { status: 404 }));
    await expect(openPosSession({ action: "open", openingFloatMinor: 2500 }, undefined, { useGo: true })).resolves.toEqual({
      kind: "completed",
      data: { sessionId: openId },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/capabilities/execute");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/pos");
    const goIntent = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).intentId;
    const legacyBody = JSON.parse(String(fetchMock.mock.calls[2]![1]?.body));
    expect(legacyBody).toEqual({ action: "open", openingFloatMinor: 2500, intentId: goIntent });
  });

  it("does not retry register opening through legacy after a non-404 Go failure", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "not authorized" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(openPosSession({ action: "open", openingFloatMinor: 0 }, undefined, { useGo: true })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller supplied intent identity across an offline sale retry", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: saleOutput }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPosSale(saleAction(), "40000000-0000-4000-8000-000000000004")).resolves.toEqual({
      kind: "completed",
      data: saleOutput,
    });
    await submitPosSale(saleAction(), "40000000-0000-4000-8000-000000000004");
    const [, first] = fetchMock.mock.calls[0]!;
    const [, second] = fetchMock.mock.calls[1]!;
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/pos");
    expect(JSON.parse(String(first?.body))).toEqual(expect.objectContaining({ action: "sale", intentId: "40000000-0000-4000-8000-000000000004" }));
    expect(JSON.parse(String(second?.body))).toEqual(expect.objectContaining({ action: "sale", intentId: "40000000-0000-4000-8000-000000000004" }));
  });

  it("keeps the legacy default independent of retry persistence", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: saleOutput }));
    vi.stubGlobal("fetch", fetchMock);
    const digest = vi.spyOn(crypto.subtle, "digest");

    await expect(submitPosSale(saleAction())).resolves.toEqual({ kind: "completed", data: saleOutput });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/pos");
    expect(digest).not.toHaveBeenCalled();
    expect(Object.keys(localStorage).some((key) => key.startsWith("chaste.pos.sale-intent.v1:"))).toBe(false);
  });

  it("sends the exact minor-unit sale contract and validates Go's sale output", async () => {
    const action = {
      action: "sale" as const,
      sessionId: openId,
      method: "cash" as const,
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      tenders: [{ method: "cash" as const, amountMinor: 2500 }],
      customerId: "50000000-0000-4000-8000-000000000005",
      cashReceivedMinor: 3000,
    };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: saleOutput }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPosSale(action, undefined, undefined, { useGo: true, scopeId: "user-sale-contract" })).resolves.toEqual({
      kind: "completed",
      data: saleOutput,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/capabilities/execute");
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(request).toEqual({
      capabilityId: "pos.completeSale",
      input: {
        sessionId: openId,
        method: "cash",
        lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
        tenders: [{ method: "cash", amountMinor: 2500 }],
        customerId: "50000000-0000-4000-8000-000000000005",
        cashReceivedMinor: 3000,
      },
      intentId: expect.any(String),
    });
  });

  it.each(["transport uncertainty", "approval pending"] as const)("reuses the sale intent after %s, including after module reload", async (firstOutcome) => {
    const action = { ...saleAction(), cashReceivedMinor: 3100 };
    const pendingBody = { ok: false, pendingApproval: true, reason: "manager review" };
    let requests = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      requests += 1;
      if (requests === 1 && firstOutcome === "transport uncertainty") throw new TypeError("connection reset");
      if (requests === 1) return Response.json(pendingBody, { status: 202 });
      return Response.json({ ok: true, data: saleOutput });
    });
    vi.stubGlobal("fetch", fetchMock);

    const submitWithGo = (sale: typeof action) => submitPosSale(sale, undefined, undefined, { useGo: true, scopeId: "user-retry" });
    if (firstOutcome === "transport uncertainty") {
      await expect(submitWithGo(action)).rejects.toMatchObject({ status: 0 });
    } else {
      await expect(submitWithGo(action)).resolves.toEqual({ kind: "pending", reason: "manager review" });
    }
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const stored = Object.entries(localStorage).find(([key]) => key.startsWith("chaste.pos.sale-intent.v1:"));
    expect(stored).toBeDefined();
    expect(stored![0]).toMatch(/^chaste\.pos\.sale-intent\.v1:[0-9a-f]{64}$/);
    expect(stored![1]).toBe(JSON.stringify({ intentId: firstRequest.intentId }));
    expect(stored![1]).not.toContain("Boda bread");

    vi.resetModules();
    const reloaded = await import("./pos-session");
    await expect(reloaded.submitPosSale(action, undefined, undefined, { useGo: true, scopeId: "user-retry" })).resolves.toEqual({
      kind: "completed",
      data: saleOutput,
    });
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(secondRequest.intentId).toBe(firstRequest.intentId);
    expect(Object.keys(localStorage).some((key) => key.startsWith("chaste.pos.sale-intent.v1:"))).toBe(false);
  });

  it("falls back only on Go 404 and keeps the sale intent identical", async () => {
    const action = { ...saleAction(), cashReceivedMinor: 3200 };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: saleOutput }));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(async () => Response.json({ error: "route not mounted" }, { status: 404 }));

    await expect(submitPosSale(action, undefined, undefined, { useGo: true, scopeId: "user-fallback" })).resolves.toEqual({
      kind: "completed",
      data: saleOutput,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/capabilities/execute");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/pos");
    const goRequest = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const legacyRequest = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(legacyRequest).toEqual({ ...action, intentId: goRequest.intentId });
  });

  it.each([401, 403, 422, 500, 503])("does not fall back to legacy after Go sale HTTP %s", async (status) => {
    const action = { ...saleAction(), cashReceivedMinor: 3300 };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ error: "Go declined the sale" }, { status }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPosSale(action, undefined, undefined, { useGo: true, scopeId: "user-refusal" })).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an opaque sale intent across authenticated users", async () => {
    const action = { ...saleAction(), cashReceivedMinor: 3400 };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: saleOutput }));
    vi.stubGlobal("fetch", fetchMock);

    await submitPosSale(action, undefined, undefined, { useGo: true, scopeId: "user-one" });
    await submitPosSale(action, undefined, undefined, { useGo: true, scopeId: "user-two" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).intentId;
    const second = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).intentId;
    expect(first).not.toBe(second);
  });

  it("refuses a sale the payload schema rejects before any request is sent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: saleOutput }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPosSale({ ...saleAction(), lines: [] })).rejects.toMatchObject({
      message: "Check the sale lines and payment amounts before submitting.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes a session with the counted cash and the variance note", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: true,
      data: { expectedCashMinor: 14500, varianceMinor: -500, flagged: true },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(closePosSession({
      action: "close",
      sessionId: openId,
      countedCashMinor: 14000,
      varianceReason: "one refund entered after the count",
    })).resolves.toEqual({ kind: "completed", data: { expectedCashMinor: 14500, varianceMinor: -500, flagged: true } });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/pos");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual(expect.objectContaining({
      action: "close",
      sessionId: openId,
      countedCashMinor: 14000,
      varianceReason: "one refund entered after the count",
    }));
  });

  it("routes register closing through Go with the exact cash and variance input", async () => {
    const output = { expectedCashMinor: 14500, varianceMinor: -500, flagged: true };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: output }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(closePosSession({
      action: "close",
      sessionId: openId,
      countedCashMinor: 14000,
      varianceReason: "one refund entered after the count",
    }, undefined, { useGo: true })).resolves.toEqual({ kind: "completed", data: output });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/capabilities/execute");
    const goBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(goBody).toEqual({
      capabilityId: "pos.closeSession",
      input: {
        sessionId: openId,
        countedCashMinor: 14000,
        varianceReason: "one refund entered after the count",
      },
      intentId: expect.any(String),
    });
  });

  it("keeps a Go register close pending for approval without calling legacy", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: false, pendingApproval: true, reason: "manager review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(closePosSession({ action: "close", sessionId: openId, countedCashMinor: 14500 }, undefined, { useGo: true }))
      .resolves.toEqual({ kind: "pending", reason: "manager review" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/capabilities/execute");
  });

  it("falls back only on Go 404 and preserves the close intent identity", async () => {
    const output = { expectedCashMinor: 14500, varianceMinor: 0, flagged: false };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: output }));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementationOnce(async () => Response.json({ error: "route not mounted" }, { status: 404 }));

    await expect(closePosSession({ action: "close", sessionId: openId, countedCashMinor: 14500 }, undefined, { useGo: true }))
      .resolves.toEqual({ kind: "completed", data: output });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/capabilities/execute");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/pos");
    const goBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const legacyBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(legacyBody).toEqual({ action: "close", sessionId: openId, countedCashMinor: 14500, intentId: goBody.intentId });
  });

  it.each([403, 422, 503])("does not fall back to legacy after Go returns HTTP %s", async (status) => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Go declined the close" }, { status }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(closePosSession({ action: "close", sessionId: openId, countedCashMinor: 14500 }, undefined, { useGo: true }))
      .rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends itemized return lines and keeps a credit-review sale out of the request", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: true,
      data: { refundEntryId: "e1", refundMinor: 1250, creditedMinor: 1250, restockedLines: 1, refundMethod: "cash" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPosReturn({
      action: "returnSale",
      invoiceId: saleId,
      reason: "damaged on arrival",
      refundMethod: "cash",
      lines: [{ invoiceLineId: lineId, quantity: 500 }],
    })).resolves.toMatchObject({ kind: "completed", data: { restockedLines: 1 } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual(expect.objectContaining({
      action: "returnSale",
      invoiceId: saleId,
      lines: [{ invoiceLineId: lineId, quantity: 500 }],
    }));
  });

  it("routes opted-in returns through Go with the legacy payload mapped exactly", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: true,
      data: { refundEntryId: "e1", refundMinor: 1250, creditedMinor: 1250, restockedLines: 1, refundMethod: "cash" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" as const, lines: [{ invoiceLineId: lineId, quantity: 500 }] };

    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId: "org-1:actor-1" })).resolves.toMatchObject({
      kind: "completed", data: { refundMinor: 1250, restockedLines: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      capabilityId: "pos.returnSale",
      input: { invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash", lines: [{ invoiceLineId: lineId, quantity: 500 }] },
      intentId: expect.any(String),
    });
  });

  it("keeps the same return identity pending across duplicate submission and reload recovery", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      return call <= 2
        ? Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 })
        : Response.json({ ok: true, data: { refundEntryId: "e1", refundMinor: 1250, creditedMinor: 1250, restockedLines: 1, refundMethod: "cash" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" as const, lines: [{ invoiceLineId: lineId, quantity: 500 }] };

    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId: "org-1:actor-1" })).resolves.toMatchObject({ kind: "pending" });
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId: "org-1:actor-1" })).resolves.toMatchObject({ kind: "pending" });
    vi.resetModules();
    const { requestPosReturn: retryReturn, restorePosReturnAttempt: restoreReturn } = await import("./pos-session");
    await expect(restoreReturn("org-1:actor-1")).resolves.toEqual({
      action, intentId: expect.any(String), status: "pending",
    });
    await expect(retryReturn({ ...action, lines: [{ invoiceLineId: lineId, quantity: 250 }] }, undefined, { useGo: true, scopeId: "org-1:actor-1" }))
      .rejects.toThrow(/previous return result is still unknown/i);
    await expect(retryReturn(action, undefined, { useGo: true, scopeId: "org-1:actor-1" })).resolves.toMatchObject({ kind: "completed" });
    const intents = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).intentId);
    expect(intents[0]).toBe(intents[1]);
    expect(intents[1]).toBe(intents[2]);
    await expect(retryReturn(action, undefined, { useGo: true, scopeId: "org-1:actor-1" })).resolves.toMatchObject({ kind: "completed" });
    const laterIntent = JSON.parse(String(fetchMock.mock.calls[3]![1]?.body)).intentId;
    expect(laterIntent).not.toBe(intents[2]);
  });

  it("falls back only on Go 404 and preserves the same return intent", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url === "/api/capabilities/execute"
      ? Response.json({ error: "not found" }, { status: 404 })
      : Response.json({ ok: true, data: { refundEntryId: "e1", refundMinor: 1250, creditedMinor: 1250, restockedLines: 1, refundMethod: "cash" } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" as const, lines: [{ invoiceLineId: lineId, quantity: 500 }] };
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId: "org-1:actor-1" })).resolves.toMatchObject({ kind: "completed" });
    const goIntent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).intentId;
    const legacy = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(legacy).toEqual({ ...action, intentId: goIntent });
  });

  it.each([401, 403, 422, 500])("does not fall back from Go return status %s", async (status) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ error: "rejected" }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestPosReturn({ action: "returnSale", invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" }, undefined, { useGo: true, scopeId: `org-error-${status}:actor-1` })).rejects.toBeInstanceOf(PosApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a return intent after uncertain transport and rotates after completion", async () => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("chaste.pos.return-intent.v1:") || key.startsWith("chaste.pos.return-active.v1:")) localStorage.removeItem(key);
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) throw new TypeError("network lost");
      return Response.json({ ok: true, data: { refundEntryId: call === 2 ? "e1" : "e2", refundMinor: 1250, creditedMinor: call === 2 ? 1250 : 2500, restockedLines: 1, refundMethod: "cash" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" as const, lines: [{ invoiceLineId: lineId, quantity: 500 }] };
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId: "org-retry:actor-1" })).rejects.toBeInstanceOf(PosApiError);
    await expect(requestPosReturn({ ...action, lines: [{ invoiceLineId: lineId, quantity: 250 }] }, undefined, { useGo: true, scopeId: "org-retry:actor-1" }))
      .rejects.toThrow(/previous return result is still unknown/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const { requestPosReturn: retryReturn } = await import("./pos-session");
    await retryReturn(action, undefined, { useGo: true, scopeId: "org-retry:actor-1" });
    await retryReturn({ ...action, lines: [{ invoiceLineId: lineId, quantity: 250 }] }, undefined, { useGo: true, scopeId: "org-retry:actor-1" });
    const intents = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).intentId);
    expect(intents[0]).toBe(intents[1]);
    expect(intents[2]).not.toBe(intents[1]);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("chaste.pos.return-intent.v1:") || key.startsWith("chaste.pos.return-active.v1:"))).toEqual([]);
  });

  it("retires the active return lock after a definitive refusal", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      return call === 1
        ? Response.json({ error: "invalid quantity" }, { status: 422 })
        : Response.json({ ok: true, data: { refundEntryId: "e1", refundMinor: 1250, creditedMinor: 1250, restockedLines: 1, refundMethod: "cash" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" as const, lines: [{ invoiceLineId: lineId, quantity: 500 }] };
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId: "org-2:actor-1" })).rejects.toBeInstanceOf(PosApiError);
    await expect(requestPosReturn({ ...action, lines: [{ invoiceLineId: lineId, quantity: 250 }] }, undefined, { useGo: true, scopeId: "org-2:actor-1" })).resolves.toMatchObject({ kind: "completed" });
    const intents = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).intentId);
    expect(intents[0]).not.toBe(intents[1]);
  });

  it("retires a pending return after a terminal 4xx so a corrected request gets a fresh intent", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Approval required" }, { status: 202 });
      if (call === 2) return Response.json({ error: "Approval expired" }, { status: 403 });
      return Response.json({ ok: true, data: { refundEntryId: "e1", refundMinor: 625, creditedMinor: 625, restockedLines: 1, refundMethod: "cash" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" as const, lines: [{ invoiceLineId: lineId, quantity: 500 }] };
    const scopeId = "org-terminal:actor-1";
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId })).resolves.toMatchObject({ kind: "pending" });
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId })).rejects.toBeInstanceOf(PosApiError);
    await expect(requestPosReturn({ ...action, lines: [{ invoiceLineId: lineId, quantity: 250 }] }, undefined, { useGo: true, scopeId })).resolves.toMatchObject({ kind: "completed" });
    const intents = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).intentId);
    expect(intents[0]).toBe(intents[1]);
    expect(intents[2]).not.toBe(intents[1]);
  });

  it.each([
    { label: "408", status: 408, body: { error: "Timed out" } },
    { label: "503", status: 503, body: { error: "Unavailable" } },
    { label: "malformed 2xx", status: 200, body: { ok: true, data: { refundEntryId: "e1" } } },
  ])("retains pending return identity and snapshot after $label", async ({ label, status, body }) => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 });
      if (call === 2) return Response.json(body, { status });
      return Response.json({ ok: true, data: { refundEntryId: "e2", refundMinor: 625, creditedMinor: 625, restockedLines: 1, refundMethod: "cash" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "card" as const, lines: [{ invoiceLineId: lineId, quantity: 250 }] };
    const scopeId = `org-retry-${label}:actor-1`;
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId })).resolves.toMatchObject({ kind: "pending" });
    await expect(requestPosReturn(action, undefined, { useGo: true, scopeId })).rejects.toBeInstanceOf(PosApiError);
    vi.resetModules();
    const reloadedPosSession = await import("./pos-session");
    const restoredAttempt = await reloadedPosSession.restorePosReturnAttempt(scopeId);
    expect(restoredAttempt).toEqual({ action, intentId: expect.any(String), status: "pending" });
    await expect(reloadedPosSession.requestPosReturn(action, undefined, { useGo: true, scopeId })).resolves.toMatchObject({ kind: "completed" });
    const requests = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { capabilityId: string; input: unknown; intentId: string });
    const expectedInput = { invoiceId: saleId, reason: "damaged on arrival", refundMethod: "card", lines: [{ invoiceLineId: lineId, quantity: 250 }] };
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.capabilityId)).toEqual(Array(3).fill("pos.returnSale"));
    expect(requests.map((request) => request.input)).toEqual(Array(3).fill(expectedInput));
    expect(requests.map((request) => request.intentId)).toEqual(Array(3).fill(restoredAttempt?.intentId));
  });

  it("scopes return retry identities by organization and actor without exposing scope in storage", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: true,
      data: { refundEntryId: "e1", refundMinor: 1250, creditedMinor: 1250, restockedLines: 1, refundMethod: "cash" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "returnSale" as const, invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash" as const };
    await requestPosReturn(action, undefined, { useGo: true, scopeId: "org-private-a:actor-private-a" });
    await requestPosReturn(action, undefined, { useGo: true, scopeId: "org-private-b:actor-private-a" });
    const intents = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).intentId);
    expect(intents[0]).not.toBe(intents[1]);
    expect(Object.keys(localStorage).join(" ")).not.toMatch(/org-private|actor-private/);
  });

  it("writes quick add products and their opening stock through the inventory route", async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      writes += 1;
      return writes === 1 ? Response.json({ ok: true, data: { itemId: "item-1" } }) : Response.json({ ok: true, data: { onHandThousandths: 5000 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", false);

    await expect(createPosQuickProduct({
      action: "createItem",
      sku: "BRD-001",
      name: "Boda bread",
      kind: "goods",
      unitLabel: "loaf",
      salePriceMinor: 2500,
    })).resolves.toEqual({ kind: "completed", data: { itemId: "item-1" } });
    await expect(adjustPosItemStock({
      action: "adjustStock",
      sku: "BRD-001",
      quantityDelta: 5000,
      note: "Opening stock from POS quick add",
    })).resolves.toEqual({ kind: "completed", data: { onHandThousandths: 5000 } });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/inventory", "/api/inventory"]);
  });

  it("routes POS quick add and opening stock through Go inventory capabilities when enabled", async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      writes += 1;
      return writes === 1
        ? Response.json({ ok: true, data: { itemId: "item-1" } })
        : Response.json({ ok: true, data: { onHandThousandths: 5000 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(createPosQuickProduct({
      action: "createItem",
      sku: "BRD-001",
      name: "Boda bread",
      kind: "goods",
      unitLabel: "loaf",
      salePriceMinor: 2500,
    })).resolves.toEqual({ kind: "completed", data: { itemId: "item-1" } });
    await expect(adjustPosItemStock({
      action: "adjustStock",
      sku: "BRD-001",
      quantityDelta: 5000,
      note: "Opening stock from POS quick add",
    })).resolves.toEqual({ kind: "completed", data: { onHandThousandths: 5000 } });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string },
    }));
    expect(requests.map((request) => request.url)).toEqual([
      "/api/capabilities/execute",
      "/api/capabilities/execute",
    ]);
    expect(requests.map((request) => request.body.capabilityId)).toEqual([
      "inventory.createItem",
      "inventory.adjustStock",
    ]);
    expect(requests[0]?.body.input).toEqual({
      sku: "BRD-001",
      name: "Boda bread",
      kind: "goods",
      unitLabel: "loaf",
      salePriceMinor: 2500,
      reorderPointThousandths: 0,
      tags: [],
    });
    expect(requests[1]?.body.input).toEqual({
      sku: "BRD-001",
      quantityDelta: 5000,
      note: "Opening stock from POS quick add",
    });
    expect(requests[0]?.body.intentId).not.toBe(requests[1]?.body.intentId);
  });

  it("keeps approval outcomes visible for Go inventory item actions", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: false,
      pendingApproval: true,
      reason: "Manager approval is required.",
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    await expect(createPosQuickProduct({
      action: "createItem",
      sku: "BRD-001",
      name: "Boda bread",
      kind: "goods",
      unitLabel: "loaf",
      salePriceMinor: 2500,
    })).resolves.toEqual({ kind: "pending", reason: "Manager approval is required." });
    await expect(adjustPosItemStock({
      action: "adjustStock",
      sku: "BRD-001",
      quantityDelta: 5000,
      note: "Opening stock from POS quick add",
    })).resolves.toEqual({ kind: "pending", reason: "Manager approval is required." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("turns an unreachable service and a malformed success body into readable errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => { throw new TypeError("network down"); }));
    await expect(fetchPosRegisterState()).rejects.toMatchObject({
      status: 0,
      message: "Could not reach the POS service. Check your connection and try again.",
    });

    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: { sessionId: "" } })));
    await expect(openPosSession({ action: "open", openingFloatMinor: 0 })).rejects.toMatchObject({
      message: "The POS service returned an unexpected action response.",
    });
  });
});
