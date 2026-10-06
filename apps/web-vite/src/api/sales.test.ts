import { afterEach, describe, expect, it, vi } from "vitest";
import { restorePendingSalesOrderCreate, SalesApiError, submitSalesOrderWrite } from "./sales";

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
