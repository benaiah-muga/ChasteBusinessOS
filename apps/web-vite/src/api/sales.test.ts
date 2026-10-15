import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRouteLessSalesOrderAttempt, fetchSalesCustomers, fetchSalesEnabled, fetchSalesOrders, findRouteLessSalesOrderAction, restorePendingSalesOrderAction, restorePendingSalesOrderCreate, SalesApiError, submitSalesOrderWrite } from "./sales";

const scope = { actorId: "actor-1", organizationId: "org-1" };
const orderId = "10000000-0000-4000-8000-000000000001";
const customerId = "20000000-0000-4000-8000-000000000001";

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

describe("Sales customer lookup", () => {
  it("fails closed unless the captured organization is a UUID", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSalesCustomers(null)).rejects.toThrow("Wait for the active organization");
    await expect(fetchSalesCustomers("org-not-a-uuid")).rejects.toThrow("Wait for the active organization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the Sales Go lookup with the captured organization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ customers: [{ id: customerId, name: "Amina" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSalesCustomers("40000000-0000-4000-8000-000000000004")).resolves.toEqual([{ id: customerId, name: "Amina" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sales/customers", expect.objectContaining({
      headers: { accept: "application/json", "X-Organization-ID": "40000000-0000-4000-8000-000000000004" },
      cache: "no-store",
    }));
  });

  it("rejects a malformed minimal customer response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ customers: [{ id: customerId, name: "Amina", email: "extra@example.test" }] })));
    await expect(fetchSalesCustomers("40000000-0000-4000-8000-000000000004")).rejects.toThrow("unexpected format");
  });
});

describe("sales order writes", () => {
  const goWrite404Cases: Array<[string, Parameters<typeof submitSalesOrderWrite>[0], unknown]> = [
    ["create", { action: "create", customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] }, { orderId, orderNumber: 46 }],
    ["update", { action: "update", orderId, customerId, lines: [{ description: "Coffee revised", quantity: 1000, unitPriceMinor: 1500 }] }, { orderId, before: { customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] } }],
    ["deliver", { action: "deliver", orderId }, { invoiceId: orderId, invoiceNumber: 901, invoiceTotalMinor: 5000, orderStatus: "delivered" }],
    ["cancel", { action: "cancel", orderId }, { status: "cancelled", releasedThousandths: 1000 }],
  ];
  const routeLessActionCases: Array<[string, Parameters<typeof submitSalesOrderWrite>[0]]> = [
    ["create", { action: "create", customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] }],
    ["update", { action: "update", orderId, customerId, lines: [{ description: "Coffee revised", quantity: 1000, unitPriceMinor: 1500 }] }],
    ["deliver", { action: "deliver", orderId }],
    ["cancel", { action: "cancel", orderId }],
  ];

  it("fails closed without actor and organization scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSalesOrderWrite({ action: "cancel", orderId }, { actorId: null, organizationId: "org-1" })).rejects.toThrow("Wait for your account and organization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends create through sales.createOrder and keeps the intent while approval is pending", async () => {
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 })));
    const action = { action: "create" as const, customerId, note: "Friday", lines: [{ description: "Coffee", quantity: 2500, unitPriceMinor: 1250, taxMinor: 10, sku: "COFFEE-1" }] };
    await submitSalesOrderWrite(action, scope);
    await expect(restorePendingSalesOrderCreate(scope)).resolves.toEqual(action);
    await expect(restorePendingSalesOrderCreate({ ...scope, actorId: "different-actor" })).resolves.toBeNull();
  });

  it("fails closed on corrupt retry marker JSON and shapes", async () => {
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

  it("sends selected partial delivery quantities and preserves the exact retry payload", async () => {
    const lineId = "30000000-0000-4000-8000-000000000001";
    const action = { action: "deliver" as const, orderId, lines: [{ lineId, quantityThousandths: 1250 }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Delivery review required" }, { status: 202 }))
      .mockResolvedValueOnce(success({ invoiceId: orderId, invoiceNumber: 901, invoiceTotalMinor: 2500, orderStatus: "confirmed" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSalesOrderWrite(action, scope)).resolves.toEqual({ kind: "pending", reason: "Delivery review required" });
    await expect(submitSalesOrderWrite(action, scope)).resolves.toMatchObject({ kind: "completed", action: "deliver" });
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> });
    expect(requests[0]).toMatchObject({ capabilityId: "sales.deliverOrder", input: { orderId, lines: [{ lineId, quantityThousandths: 1250 }] } });
    expect(requests[1]?.intentId).toBe(requests[0]?.intentId);
    expect(requests[1]?.input).toEqual(requests[0]?.input);
  });

  it("restores pending delivery and cancellation actions with their exact payloads", async () => {
    const partialDelivery = { action: "deliver" as const, orderId, lines: [{ lineId: "30000000-0000-4000-8000-000000000001", quantityThousandths: 1250 }] };
    const cancellation = { action: "cancel" as const, orderId };
    const fetchMock = vi.fn(async () => Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitSalesOrderWrite(partialDelivery, scope);
    await expect(restorePendingSalesOrderAction(scope)).resolves.toEqual(partialDelivery);
    await expect(restorePendingSalesOrderCreate(scope)).resolves.toBeNull();
    window.localStorage.clear();

    await submitSalesOrderWrite(cancellation, scope);
    await expect(restorePendingSalesOrderAction(scope)).resolves.toEqual(cancellation);
  });

  it.each(goWrite404Cases)("fails closed on Go 404 for %s and retries the exact action through Go", async (_name, action, output) => {
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

  it.each(goWrite404Cases)("rejects extra fields in the Go %s response and preserves the retry marker", async (_name, action, output) => {
    const malformedOutput = { ...(output as Record<string, unknown>), unexpected: true };
    const fetchMock = vi.fn().mockResolvedValue(success(malformedOutput));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSalesOrderWrite(action, scope)).rejects.toThrow(/unexpected (?:order|draft update) response/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(window.localStorage).some((key) => key.startsWith("chaste:sales-order-write-attempt:"))).toBe(true);
  });

  it("always uses the Go action when the old Go selector is off", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", false);
    const fetchMock = vi.fn().mockResolvedValue(success({ status: "cancelled", releasedThousandths: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSalesOrderWrite({ action: "cancel", orderId }, scope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "sales.cancelOrder", input: { orderId } });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(scope.organizationId);
  });

  it("keeps an unresolved Go 404 on Go when the old selector is rolled back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "capability not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "cancel" as const, orderId };

    await expect(submitSalesOrderWrite(action, scope)).rejects.toMatchObject({ status: 404 });
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", false);
    await expect(submitSalesOrderWrite(action, scope)).rejects.toMatchObject({ status: 404 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
  });

  it("blocks route-less pre-upgrade markers with history and cleanup guidance", async () => {
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

  it("requires history review before clearing an unresolved legacy-route marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "create" as const, customerId, lines: [{ description: "Coffee", quantity: 1000, unitPriceMinor: 1250 }] };
    await submitSalesOrderWrite(action, scope);
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith("chaste:sales-order-write-attempt:"));
    expect(key).toBeDefined();
    const stored = JSON.parse(window.localStorage.getItem(key!) ?? "null") as Record<string, unknown>;
    stored.route = "legacy";
    window.localStorage.setItem(key!, JSON.stringify(stored));

    const ambiguous = await findRouteLessSalesOrderAction(scope);
    expect(ambiguous).toMatchObject({ action: "create" });
    await expect(restorePendingSalesOrderCreate(scope)).rejects.toThrow("retired backend route");
    await expect(submitSalesOrderWrite(action, scope)).rejects.toThrow("retired backend route");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(clearRouteLessSalesOrderAttempt(scope, ambiguous!)).resolves.toBe(true);
  });

  it("never clears valid route-pinned or damaged markers through route-less recovery", async () => {
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
      lines: [{
        lineId: "30000000-0000-4000-8000-000000000001",
        description: "Coffee beans",
        quantityThousandths: 2500,
        deliveredThousandths: 500,
        deliverableThousandths: 2000,
        unitPriceMinor: 0,
        taxMinor: 0,
      }],
    }],
  };

  it("loads module status with the captured organization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "sales" }], enabledModules: ["sales"] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSalesEnabled(scope.organizationId)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      headers: expect.objectContaining({ "X-Organization-ID": scope.organizationId }),
    }));
    await expect(fetchSalesEnabled(null)).rejects.toBeInstanceOf(SalesApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads through sales.listOrders with the active organization", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: goOrders }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesOrders(scope.organizationId)).resolves.toEqual(goOrders.orders);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({ "X-Organization-ID": scope.organizationId }),
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

    await expect(fetchSalesOrders(scope.organizationId)).rejects.toBeInstanceOf(SalesApiError);
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
    await expect(fetchSalesOrders(scope.organizationId)).rejects.toBeInstanceOf(SalesApiError);
  });

  it("always uses the Go sales read when the old selector is off", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_READS__", false);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { orders: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesOrders(scope.organizationId)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("fails closed before fetching without organization scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSalesOrders(null)).rejects.toBeInstanceOf(SalesApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
