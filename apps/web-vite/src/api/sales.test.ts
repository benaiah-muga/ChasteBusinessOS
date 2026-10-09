import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSalesOrders, restorePendingSalesOrderCreate, SalesApiError, submitSalesOrderWrite } from "./sales";

const scope = { actorId: "actor-1", organizationId: "org-1" };
const orderId = "10000000-0000-4000-8000-000000000001";
const customerId = "20000000-0000-4000-8000-000000000001";

function goWrites() {
  vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
}

function success(data: unknown) {
  return Response.json({ ok: true, data });
}

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("sales order writes", () => {
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

  it("falls back to the legacy action only on a missing Go route and keeps the intent", async () => {
    goWrites();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(success({ status: "cancelled", releasedThousandths: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSalesOrderWrite({ action: "cancel", orderId }, scope)).resolves.toMatchObject({ kind: "completed" });
    const goBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const legacyBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { action: string; orderId: string; intentId: string };
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/sales"]);
    expect(legacyBody).toMatchObject({ action: "cancel", orderId, intentId: goBody.intentId });
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
