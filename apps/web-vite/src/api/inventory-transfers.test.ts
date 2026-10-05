import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmInventoryTransfer, createInventoryTransfer } from "./inventory-transfers";

const transferId = "40000000-0000-4000-8000-000000000004";
const lineId = "50000000-0000-4000-8000-000000000005";

afterEach(() => vi.unstubAllGlobals());

describe("inventory transfer API client", () => {
  it("sends create and confirm actions through Go with their declared inputs and fresh intents", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: true,
      data: { transferId, number: 12, status: "pending" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);

    await expect(createInventoryTransfer({
      fromLocationCode: "MAIN",
      toLocationCode: "SHOP",
      sku: "ITEM-1",
      quantityThousandths: 2500,
      note: "Move to shop floor",
    })).resolves.toEqual({ kind: "completed" });
    await expect(confirmInventoryTransfer(transferId, [{ lineId, quantityThousandths: 1000 }]))
      .resolves.toEqual({ kind: "completed" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string },
    }));
    expect(requests.map((request) => request.url)).toEqual([
      "/api/capabilities/execute",
      "/api/capabilities/execute",
    ]);
    expect(requests.map((request) => request.body.capabilityId)).toEqual([
      "inventory.createTransfer",
      "inventory.confirmTransfer",
    ]);
    expect(requests[0]?.body.input).toEqual({
      fromLocationCode: "MAIN",
      toLocationCode: "SHOP",
      lines: [{ sku: "ITEM-1", quantityThousandths: 2500 }],
      note: "Move to shop floor",
    });
    expect(requests[1]?.body.input).toEqual({
      transferId,
      lines: [{ lineId, quantityThousandths: 1000 }],
    });
    expect(requests[0]?.body.intentId).not.toBe(requests[1]?.body.intentId);
  });

  it("keeps create and confirm on the legacy inventory action route when disabled", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: true,
      data: { transferId, number: 12, status: "pending" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", false);

    await createInventoryTransfer({
      fromLocationCode: "MAIN",
      toLocationCode: "SHOP",
      sku: "ITEM-1",
      quantityThousandths: 2500,
    });
    await confirmInventoryTransfer(transferId);

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    expect(requests.map((request) => request.url)).toEqual(["/api/inventory", "/api/inventory"]);
    expect(requests[0]?.body).toMatchObject({
      action: "createTransfer",
      fromLocationCode: "MAIN",
      toLocationCode: "SHOP",
      lines: [{ sku: "ITEM-1", quantityThousandths: 2500 }],
    });
    expect(requests[1]?.body).toMatchObject({ action: "confirmTransfer", transferId });
    expect(requests[0]?.body.intentId).not.toBe(requests[1]?.body.intentId);
  });

  it("preserves pending approval reasons and capability errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, pendingApproval: true, reason: "Manager approval required." }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "Source location has insufficient stock." }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);

    await expect(createInventoryTransfer({
      fromLocationCode: "MAIN",
      toLocationCode: "SHOP",
      sku: "ITEM-1",
      quantityThousandths: 2500,
    })).resolves.toEqual({ kind: "pending", reason: "Manager approval required." });
    await expect(confirmInventoryTransfer(transferId)).rejects.toMatchObject({
      name: "InventoryTransferApiError",
      status: 422,
      message: "Source location has insufficient stock.",
    });
  });
});
