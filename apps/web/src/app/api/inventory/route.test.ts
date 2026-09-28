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
    vi.stubEnv("GO_INVENTORY_CYCLE_COUNTS", "0");
    vi.stubEnv("GO_INVENTORY_RESERVATION_WRITES", "0");
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

  it("dispatches reservations through Go only when the reservation flag is enabled", async () => {
    vi.stubEnv("GO_INVENTORY_RESERVATION_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { reservationId: "reservation-1" } }) });
    const response = await POST(request({ action: "reserveStock", sku: "MUG-1", quantityThousandths: 1000, reason: "sales order" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { reservationId: "reservation-1" } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "inventory.reserveStock",
      input: { sku: "MUG-1", quantityThousandths: 1000, reason: "sales order" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { body: { action: "createCycleCount", note: "Quarterly count", skus: ["MUG-1"], locationId: "33333333-3333-4333-8333-333333333333" }, capabilityId: "inventory.createCycleCount", input: { note: "Quarterly count", skus: ["MUG-1"], locationId: "33333333-3333-4333-8333-333333333333" } },
    { body: { action: "recordCycleCounts", countId: "44444444-4444-4444-8444-444444444444", counts: [{ sku: "MUG-1", countedThousandths: 1500 }] }, capabilityId: "inventory.recordCycleCounts", input: { countId: "44444444-4444-4444-8444-444444444444", counts: [{ sku: "MUG-1", countedThousandths: 1500 }] } },
    { body: { action: "postCycleCount", countId: "44444444-4444-4444-8444-444444444444" }, capabilityId: "inventory.postCycleCount", input: { countId: "44444444-4444-4444-8444-444444444444" } },
    { body: { action: "cancelCycleCount", countId: "44444444-4444-4444-8444-444444444444" }, capabilityId: "inventory.cancelCycleCount", input: { countId: "44444444-4444-4444-8444-444444444444" } },
  ])("keeps $body.action on TypeScript with cycle-count flag off", async ({ body, capabilityId, input }) => {
    await POST(request(body));
    expect(mocks.execute).toHaveBeenCalledWith(capabilityId, ctx, input);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([
    { body: { action: "createCycleCount", note: "Quarterly count", skus: ["MUG-1"], locationId: "33333333-3333-4333-8333-333333333333" }, capabilityId: "inventory.createCycleCount", input: { note: "Quarterly count", skus: ["MUG-1"], locationId: "33333333-3333-4333-8333-333333333333" } },
    { body: { action: "recordCycleCounts", countId: "44444444-4444-4444-8444-444444444444", entries: [{ sku: "MUG-1", countedThousandths: 1500 }] }, capabilityId: "inventory.recordCycleCounts", input: { countId: "44444444-4444-4444-8444-444444444444", counts: [{ sku: "MUG-1", countedThousandths: 1500 }] } },
    { body: { action: "postCycleCount", countId: "44444444-4444-4444-8444-444444444444" }, capabilityId: "inventory.postCycleCount", input: { countId: "44444444-4444-4444-8444-444444444444" } },
    { body: { action: "cancelCycleCount", countId: "44444444-4444-4444-8444-444444444444" }, capabilityId: "inventory.cancelCycleCount", input: { countId: "44444444-4444-4444-8444-444444444444" } },
  ])("dispatches $body.action to Go with the existing public input", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_INVENTORY_CYCLE_COUNTS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { saved: true }, replayed: true }) });
    const response = await POST(request({ ...body, intentId: "inventory-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { saved: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves approval response mapping and removes private approval metadata", async () => {
    vi.stubEnv("GO_INVENTORY_CYCLE_COUNTS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "Review required", approvalId: "private-approval-id" }, { status: 202 }) });
    const response = await POST(request({ action: "postCycleCount", countId: "44444444-4444-4444-8444-444444444444" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Review required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "not-dispatched" },
    { kind: "outcome-unknown" },
  ])("fails closed on $kind without retrying a cycle-count write", async (result) => {
    vi.stubEnv("GO_INVENTORY_CYCLE_COUNTS", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "recordCycleCounts", countId: "44444444-4444-4444-8444-444444444444", counts: [{ sku: "MUG-1", countedThousandths: 1500 }] }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps the startCycleCount alias and unrelated actions on TypeScript", async () => {
    vi.stubEnv("GO_INVENTORY_CYCLE_COUNTS", "1");
    await POST(request({ action: "startCycleCount", note: "Legacy alias" }));
    await POST(request({ action: "createLocation", code: "A", name: "Aisle A" }));
    expect(mocks.execute).toHaveBeenNthCalledWith(1, "inventory.createCycleCount", ctx, { note: "Legacy alias", skus: undefined, locationId: undefined });
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "inventory.createLocation", ctx, { code: "A", name: "Aisle A" });
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

describe("inventory Go item master bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INVENTORY_STOCK_WRITES", "0");
    vi.stubEnv("GO_INVENTORY_CYCLE_COUNTS", "0");
    vi.stubEnv("GO_INVENTORY_ITEM_WRITES", "0");
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
    { body: { action: "createItem", sku: "MUG-1", name: "Mug", kind: "goods", unitLabel: "pc", salePriceMinor: 5000, reorderPointThousandths: 1000, tags: ["core"], barcode: "BC-1", imageUrl: "https://example.test/mug.png" }, capabilityId: "inventory.createItem", input: { sku: "MUG-1", name: "Mug", kind: "goods", unitLabel: "pc", salePriceMinor: 5000, reorderPointThousandths: 1000, tags: ["core"], barcode: "BC-1", imageUrl: "https://example.test/mug.png" } },
    { body: { action: "updateItem", sku: "MUG-1", name: "Mug Pro", salePriceMinor: 6000, tags: ["core", "new"] }, capabilityId: "inventory.updateItem", input: { sku: "MUG-1", name: "Mug Pro", salePriceMinor: 6000, tags: ["core", "new"] } },
    { body: { action: "archiveItem", sku: "MUG-1" }, capabilityId: "inventory.archiveItem", input: { sku: "MUG-1", archive: true } },
    { body: { action: "createLocation", code: "SHOP", name: "Shop Floor" }, capabilityId: "inventory.createLocation", input: { code: "SHOP", name: "Shop Floor" } },
  ])("dispatches $body.action to Go behind GO_INVENTORY_ITEM_WRITES", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_INVENTORY_ITEM_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { done: true }, replayed: true }) });
    const response = await POST(request({ ...body, intentId: "inventory-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { done: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps item master writes on TypeScript while the flag is off", async () => {
    await POST(request({ action: "createLocation", code: "SHOP", name: "Shop Floor" }));
    expect(mocks.execute).toHaveBeenCalledWith("inventory.createLocation", ctx, { code: "SHOP", name: "Shop Floor" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("fails closed without retrying through TypeScript when the Go outcome is unknown", async () => {
    vi.stubEnv("GO_INVENTORY_ITEM_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "outcome-unknown" });
    const response = await POST(request({ action: "archiveItem", sku: "MUG-1" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
