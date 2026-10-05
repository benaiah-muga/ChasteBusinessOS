import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmSalesOrder, SalesApiError } from "./sales";

const orderId = "10000000-0000-4000-8000-000000000003";
const intentId = "30000000-0000-4000-8000-000000000001";

afterEach(() => vi.unstubAllGlobals());

describe("confirmSalesOrder", () => {
  it("posts the order to the governed Go capability endpoint and validates success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { confirmed: true, backordered: false, reservedThousandths: 1000 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(confirmSalesOrder(orderId, intentId)).resolves.toEqual({ kind: "confirmed", backordered: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ capabilityId: "sales.confirmOrder", input: { orderId }, intentId }),
    }));
  });

  it("preserves an approval response and rejects malformed input or output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: false,
      pendingApproval: true,
      reason: "Manager approval required",
    }, { status: 202 })));
    await expect(confirmSalesOrder(orderId, intentId)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });

    await expect(confirmSalesOrder("not-a-uuid", intentId)).rejects.toBeInstanceOf(SalesApiError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: {} })));
    await expect(confirmSalesOrder(orderId, intentId)).rejects.toThrow("unexpected confirmation response");
  });

  it("sends the explicit allow-backorder choice only when selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { confirmed: true, backordered: true, reservedThousandths: 500 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(confirmSalesOrder(orderId, intentId, true)).resolves.toEqual({ kind: "confirmed", backordered: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      body: JSON.stringify({ capabilityId: "sales.confirmOrder", input: { orderId, allowBackorder: true }, intentId }),
    }));
  });
});
