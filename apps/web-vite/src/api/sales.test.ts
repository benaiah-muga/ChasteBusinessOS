import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRouteLessSalesOrderAttempt, fetchSalesOrders, findRouteLessSalesOrderAction, restorePendingSalesOrderCreate, SalesApiError, submitSalesOrderWrite } from "./sales";

const scope = { actorId: "actor-1", organizationId: "org-1" };
const orderId = "10000000-0000-4000-8000-000000000001";
const customerId = "20000000-0000-4000-8000-000000000001";

function goWrites() {
  vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
}

function success(data: unknown) {
  return Response.json({ ok: true, data });
}

function stubWebLocks() {
  const testNavigator = Object.create(navigator) as Navigator;
  Object.defineProperty(testNavigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback(),
    },
  });
  vi.stubGlobal("navigator", testNavigator);
}

beforeEach(() => {
  stubWebLocks();
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("sales order writes", () => {
  const goWrite404Cases: Array<[string, Parameters<typeof submitSalesOrderWrite>[0], unknown]> = [
    ["create", { action: "create", customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] }, { orderId, orderNumber: 46 }],
    ["deliver", { action: "deliver", orderId }, { invoiceId: orderId, invoiceNumber: 901, invoiceTotalMinor: 5000, orderStatus: "delivered" }],
    ["cancel", { action: "cancel", orderId }, { status: "cancelled", releasedThousandths: 1000 }],
  ];
  const routeLessActionCases: Array<[string, Parameters<typeof submitSalesOrderWrite>[0]]> = [
    ["create", { action: "create", customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] }],
    ["deliver", { action: "deliver", orderId }],
    ["cancel", { action: "cancel", orderId }],
  ];

  it("fails closed without actor and organization scope", async () => {
    goWrites();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSalesOrderWrite({ action: "cancel", orderId }, { actorId: null, organizationId: "org-1" })).rejects.toThrow("Wait for your account and organization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends create through sales.createOrder and keeps the intent while approval is pending", async () => {
    goWrites();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: false, pendingApproval: true, reason: "Manager review", approvalId: "30000000-0000-4000-8000-000000000001",
      }, { status: 202 }))
      .mockResolvedValueOnce(success({ orderId, orderNumber: 44 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = {
      action: "create" as const,
      customerId,
      note: "Deliver after Friday",
      lines: [{ description: "Coffee beans", quantity: 2500, unitPriceMinor: 1250, taxMinor: 0, sku: "COFFEE-1" }],
    };
    await expect(submitSalesOrderWrite(action, scope)).resolves.toEqual({ kind: "pending", reason: "Manager review" });
    await expect(submitSalesOrderWrite(action, scope)).resolves.toMatchObject({ kind: "completed", data: { orderId, orderNumber: 44 } });
    const requests = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    expect(requests[0]).toMatchObject({
      capabilityId: "sales.createOrder",
      input: { customerId, note: "Deliver after Friday", lines: [{ description: "Coffee beans", quantity: 2500, unitPriceMinor: 1250, taxMinor: 0, sku: "COFFEE-1" }] },
    });
    expect(requests[1]?.intentId).toBe(requests[0]?.intentId);
  });

  it("restores only the exact scoped pending create payload", async () => {
    goWrites();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 })));
    const action = { action: "create" as const, customerId, note: "Friday", lines: [{ description: "Coffee", quantity: 2500, unitPriceMinor: 1250, taxMinor: 10, sku: "COFFEE-1" }] };
    await submitSalesOrderWrite(action, scope);
    await expect(restorePendingSalesOrderCreate(scope)).resolves.toEqual(action);
    await expect(restorePendingSalesOrderCreate({ ...scope, actorId: "different-actor" })).resolves.toBeNull();
  });

  it("fails closed on corrupt retry marker JSON and shapes", async () => {
    goWrites();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "create" as const, customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] };
    await submitSalesOrderWrite(action, scope);
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith("chaste:sales-order-write-attempt:"));
    expect(key).toBeDefined();

    window.localStorage.setItem(key!, "{");
    await expect(submitSalesOrderWrite(action, scope)).rejects.toThrow("saved sales order retry marker is damaged");
    await expect(restorePendingSalesOrderCreate(scope)).rejects.toThrow("saved sales order retry marker is damaged");
    expect(window.localStorage.getItem(key!)).toBe("{");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.localStorage.setItem(key!, JSON.stringify({ fingerprint: "not-a-digest", intentId: crypto.randomUUID(), action }));
    await expect(submitSalesOrderWrite(action, scope)).rejects.toThrow("saved sales order retry marker is damaged");
    await expect(restorePendingSalesOrderCreate(scope)).rejects.toThrow("saved sales order retry marker is damaged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses create intent after an uncertain network result", async () => {
    goWrites();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(success({ orderId, orderNumber: 45 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "create" as const, customerId, lines: [{ description: "Service", quantity: 1000, unitPriceMinor: 0 }] };
    await expect(submitSalesOrderWrite(action, scope)).rejects.toBeInstanceOf(SalesApiError);
    await expect(submitSalesOrderWrite(action, scope)).resolves.toMatchObject({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
  });

  it("delivers all remaining reserved lines by omitting lines and sends cancel through its capability", async () => {
    goWrites();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success({ invoiceId: orderId, invoiceNumber: 900, invoiceTotalMinor: 5000, orderStatus: "delivered" }))
      .mockResolvedValueOnce(success({ status: "cancelled", releasedThousandths: 1000 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSalesOrderWrite({ action: "deliver", orderId }, scope)).resolves.toMatchObject({ kind: "completed" });
    await expect(submitSalesOrderWrite({ action: "cancel", orderId }, scope)).resolves.toMatchObject({ kind: "completed" });
    const requests = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { capabilityId: string; input: Record<string, unknown> });
    expect(requests[0]).toMatchObject({ capabilityId: "sales.deliverOrder", input: { orderId } });
    expect(requests[0]?.input).not.toHaveProperty("lines");
    expect(requests[1]).toMatchObject({ capabilityId: "sales.cancelOrder", input: { orderId } });
  });

  it.each(goWrite404Cases)("fails closed on Go 404 for %s and retries the exact action through Go", async (_name, action, output) => {
    goWrites();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "capability not found" }, { status: 404 }))
      .mockResolvedValueOnce(success(output));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSalesOrderWrite(action, scope)).rejects.toMatchObject({ status: 404 });
    await expect(submitSalesOrderWrite(action, scope)).resolves.toMatchObject({ kind: "completed" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it("uses the legacy action only when the Go write selector is off", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", false);
    const fetchMock = vi.fn().mockResolvedValue(success({ status: "cancelled", releasedThousandths: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSalesOrderWrite({ action: "cancel", orderId }, scope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sales");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: "cancel", orderId });
  });

  it("pins an unresolved Go 404 to Go when the selector is rolled back", async () => {
    goWrites();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "capability not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancel" as const, orderId };

    await expect(submitSalesOrderWrite(action, scope)).rejects.toMatchObject({ status: 404 });
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", false);
    await expect(submitSalesOrderWrite(action, scope)).rejects.toThrow("unresolved on the Go route");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("rejects selector changes while a legacy write result is unresolved", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", false);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancel" as const, orderId };

    await expect(submitSalesOrderWrite(action, scope)).rejects.toBeInstanceOf(SalesApiError);
    goWrites();
    await expect(submitSalesOrderWrite(action, scope)).rejects.toThrow("unresolved on the legacy route");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sales");
  });

  it("blocks route-less pre-upgrade markers with history and cleanup guidance", async () => {
    goWrites();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "create" as const, customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] };
    await submitSalesOrderWrite(action, scope);
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith("chaste:sales-order-write-attempt:"));
    expect(key).toBeDefined();
    const stored = JSON.parse(window.localStorage.getItem(key!) ?? "null") as Record<string, unknown>;
    delete stored.route;
    window.localStorage.setItem(key!, JSON.stringify(stored));

    await expect(submitSalesOrderWrite(action, scope)).rejects.toThrow("predates route tracking");
    await expect(restorePendingSalesOrderCreate(scope)).rejects.toThrow("predates route tracking");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(routeLessActionCases)("discovers and clears only a valid route-less %s marker", async (_name, action) => {
    goWrites();
    stubWebLocks();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await submitSalesOrderWrite(action, scope);
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith("chaste:sales-order-write-attempt:"));
    expect(key).toBeDefined();
    const stored = JSON.parse(window.localStorage.getItem(key!) ?? "null") as Record<string, unknown>;
    delete stored.route;
    window.localStorage.setItem(key!, JSON.stringify(stored));

    const marker = await findRouteLessSalesOrderAction(scope);
    expect(marker).toMatchObject({ action: action.action });
    await expect(clearRouteLessSalesOrderAttempt({ ...scope, organizationId: "org-2" }, marker!)).resolves.toBe(false);
    expect(window.localStorage.getItem(key!)).not.toBeNull();
    await expect(clearRouteLessSalesOrderAttempt(scope, marker!)).resolves.toBe(true);
    await expect(findRouteLessSalesOrderAction(scope)).resolves.toBeNull();
    expect(window.localStorage.getItem(key!)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never clears valid route-pinned or damaged markers through route-less recovery", async () => {
    goWrites();
    stubWebLocks();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancel" as const, orderId };
    await submitSalesOrderWrite(action, scope);
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith("chaste:sales-order-write-attempt:"));
    expect(key).toBeDefined();
    const stored = JSON.parse(window.localStorage.getItem(key!) ?? "null") as { fingerprint: string; intentId: string; action: { action: "cancel" } };
    const marker = { action: stored.action.action, fingerprint: stored.fingerprint, intentId: stored.intentId };

    await expect(findRouteLessSalesOrderAction(scope)).resolves.toBeNull();
    await expect(clearRouteLessSalesOrderAttempt(scope, marker)).resolves.toBe(false);
    expect(window.localStorage.getItem(key!)).not.toBeNull();

    window.localStorage.setItem(key!, "{");
    await expect(clearRouteLessSalesOrderAttempt(scope, marker)).rejects.toThrow("saved sales order retry marker is damaged");
    expect(window.localStorage.getItem(key!)).toBe("{");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears only the exact route-less marker that was reviewed", async () => {
    goWrites();
    stubWebLocks();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancel" as const, orderId };
    await submitSalesOrderWrite(action, scope);
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith("chaste:sales-order-write-attempt:"));
    expect(key).toBeDefined();
    const stored = JSON.parse(window.localStorage.getItem(key!) ?? "null") as { fingerprint: string; intentId: string; action: typeof action; route?: string };
    delete stored.route;
    window.localStorage.setItem(key!, JSON.stringify(stored));
    const reviewed = await findRouteLessSalesOrderAction(scope);
    expect(reviewed).not.toBeNull();

    window.localStorage.setItem(key!, JSON.stringify({ ...stored, intentId: crypto.randomUUID() }));
    await expect(clearRouteLessSalesOrderAttempt(scope, reviewed!)).resolves.toBe(false);
    expect(window.localStorage.getItem(key!)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Web Locks is unavailable for marker cleanup", async () => {
    goWrites();
    stubWebLocks();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancel" as const, orderId };
    await submitSalesOrderWrite(action, scope);
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith("chaste:sales-order-write-attempt:"));
    expect(key).toBeDefined();
    const stored = JSON.parse(window.localStorage.getItem(key!) ?? "null") as { fingerprint: string; intentId: string; action: { action: "cancel" } };
    const marker = { action: stored.action.action, fingerprint: stored.fingerprint, intentId: stored.intentId };
    const unsupportedNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(unsupportedNavigator, "locks", { configurable: true, value: undefined });
    vi.stubGlobal("navigator", unsupportedNavigator);

    await expect(clearRouteLessSalesOrderAttempt(scope, marker)).rejects.toThrow("Web Locks support");
    expect(window.localStorage.getItem(key!)).not.toBeNull();
  });
});

describe("sales order reads", () => {
  const goOrders = {
    orders: [{
      id: "10000000-0000-4000-8000-000000000001",
      number: 41,
      customerId: "20000000-0000-4000-8000-000000000001",
      status: "draft",
      backordered: false,
      totalMinor: 3250,
      createdAt: "2026-09-27T10:15:00.000Z",
    }],
  };

  it("loads through sales.listOrders when the Go read selector is enabled", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: goOrders }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesOrders()).resolves.toEqual(goOrders.orders);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: expect.any(String),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "sales.listOrders",
      input: {},
      intentId: expect.any(String),
    });
  });

  it("fails closed on Go 404 and does not fall back to the legacy sales route", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "missing capability" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesOrders()).rejects.toBeInstanceOf(SalesApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it.each([
    ["pending response", Response.json({ ok: false, pendingApproval: true }, { status: 202 })],
    ["malformed envelope", Response.json({ ok: true, data: goOrders, extra: true })],
    ["malformed order output", Response.json({ ok: true, data: { orders: [{ ...goOrders.orders[0], unexpected: true }] } })],
  ])("rejects a %s from Go", async (_name, response) => {
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(fetchSalesOrders()).rejects.toBeInstanceOf(SalesApiError);
  });

  it("keeps the legacy sales route when the Go read selector is off", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_READS__", false);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ orders: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesOrders()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sales", expect.objectContaining({ method: "GET" }));
  });
});
