import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getResolvedUser: vi.fn(), actorFromResolved: vi.fn(), buildExecutor: vi.fn(), buildRegistry: vi.fn(), execute: vi.fn(), getDb: vi.fn(), executeGoCapability: vi.fn() }));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ desc: vi.fn(), eq: vi.fn(), inArray: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, cycleCountLines: {}, cycleCounts: {}, items: {}, lots: {}, stockLocations: {}, stockReservations: {}, stockTransferLines: {}, stockTransfers: {} }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", permissions: new Set(["inventory.write"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "inventory-intent" };

function request(body: unknown) {
  return new Request("http://localhost/api/inventory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("inventory Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INVENTORY_STOCK_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { body: { action: "adjustStock", sku: "MUG-1", quantityDelta: 3000, note: "Opening stock", lotCode: "L1" }, capabilityId: "inventory.adjustStock", input: { sku: "MUG-1", quantityDelta: 3000, note: "Opening stock", lotCode: "L1" } },
    { body: { action: "createTransfer", fromLocationCode: "MAIN", toLocationCode: "SHOP", lines: [{ sku: "MUG-1", quantityThousandths: 1000 }], note: "Restock" }, capabilityId: "inventory.createTransfer", input: { fromLocationCode: "MAIN", toLocationCode: "SHOP", lines: [{ sku: "MUG-1", quantityThousandths: 1000 }], note: "Restock" } },
    { body: { action: "confirmTransfer", transferId: "transfer-1", lines: [{ lineId: "line-1", quantityThousandths: 1000 }] }, capabilityId: "inventory.confirmTransfer", input: { transferId: "transfer-1", lines: [{ lineId: "line-1", quantityThousandths: 1000 }] } },
    { body: { action: "cancelTransfer", transferId: "transfer-1" }, capabilityId: "inventory.cancelTransfer", input: { transferId: "transfer-1" } },
    { body: { action: "reverseTransfer", transferId: "transfer-1" }, capabilityId: "inventory.reverseTransfer", input: { transferId: "transfer-1" } },
  ])("dispatches $body.action to Go behind its flag", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_INVENTORY_STOCK_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { done: true } }) });
    const response = await POST(request({ ...body, intentId: "inventory-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { done: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps stock adjustments on TypeScript while the flag is off", async () => {
    await POST(request({ action: "adjustStock", sku: "MUG-1", quantityDelta: 3000, note: "Opening stock" }));
    expect(mocks.execute).toHaveBeenCalledWith("inventory.adjustStock", ctx, {
      sku: "MUG-1", quantityDelta: 3000, note: "Opening stock", lotCode: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps item creation on TypeScript when the flag is enabled", async () => {
    vi.stubEnv("GO_INVENTORY_STOCK_WRITES", "1");
    await POST(request({ action: "createItem", sku: "MUG-1", name: "Mug" }));
    expect(mocks.execute).toHaveBeenCalledWith("inventory.createItem", ctx, {
      sku: "MUG-1", name: "Mug", kind: "goods", unitLabel: "unit", salePriceMinor: 0,
      reorderPointThousandths: 0, imageUrl: undefined, tags: [], barcode: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("does not retry stock writes on $kind", async (result) => {
    vi.stubEnv("GO_INVENTORY_STOCK_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "adjustStock", sku: "MUG-1", quantityDelta: 3000, note: "Cycle count" }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
