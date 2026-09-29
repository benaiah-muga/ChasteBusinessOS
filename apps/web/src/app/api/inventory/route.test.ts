import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getResolvedUser: vi.fn(), actorFromResolved: vi.fn(), buildExecutor: vi.fn(), buildRegistry: vi.fn(), execute: vi.fn(), getDb: vi.fn(), executeGoCapability: vi.fn() }));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ desc: vi.fn(), eq: vi.fn(), inArray: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, cycleCountLines: {}, cycleCounts: {}, items: {}, lots: {}, stockLocations: {}, stockReservations: {}, stockTransferLines: {}, stockTransfers: {} }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", permissions: new Set(["inventory.write"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "inventory-intent" };

function request(body: unknown) {
  return new Request("http://localhost/api/inventory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function readRequest(query = "") {
  return new Request(`http://localhost/api/inventory${query}`);
}

function inventoryReadDb(rows: unknown[][] = [[], [], [], [], [], []]) {
  const pendingRows = [...rows];
  return {
    select: vi.fn(() => {
      const data = pendingRows.shift() ?? [];
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(() => query),
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(data).then(resolve, reject),
      };
      return query;
    }),
  };
}

const stockReportItem = {
  sku: "MUG-1",
  name: "Mug",
  kind: "goods",
  unitLabel: "each",
  salePriceMinor: 5000,
  imageUrl: null,
  tags: ["core"],
  barcode: null,
  onHandThousandths: 500,
  valueMinor: 2000,
  avgUnitCostMinor: 4000,
  reservedThousandths: 100,
  availableThousandths: 400,
  reorderPointThousandths: 1000,
  reorderNeeded: true,
};

describe("inventory Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INVENTORY_STOCK_WRITES", "0");
    vi.stubEnv("GO_INVENTORY_CYCLE_COUNTS", "0");
    vi.stubEnv("GO_INVENTORY_RESERVATION_WRITES", "0");
    vi.stubEnv("GO_INVENTORY_ITEM_HISTORY_READS", "0");
    vi.stubEnv("GO_INVENTORY_STOCK_REPORT_READS", "0");
    vi.stubEnv("GO_INVENTORY_TRANSFER_READS", "0");
    vi.stubEnv("GO_INVENTORY_LOTS_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps item history on TypeScript while the Go read flag is off", async () => {
    const movements = [{ id: "movement-1", quantityDelta: 1000, reason: "purchase", note: null, refType: null, unitCostMinor: 400, lotCode: null, locationCode: "MAIN", actorType: "human", createdAt: "2026-09-29T10:00:00.000Z" }];
    mocks.execute.mockResolvedValue({ ok: true, data: { movements } });
    const response = await GET(readRequest("?sku=MUG-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ movements });
    expect(mocks.execute).toHaveBeenCalledWith("inventory.itemHistory", ctx, { sku: "MUG-1", limit: 100 });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps the main stock report on TypeScript while the Go read flag is off", async () => {
    const db = inventoryReadDb();
    mocks.getDb.mockReturnValue({ db });
    mocks.execute.mockImplementation(async (_id: string, _ctx: unknown, input: { belowReorderOnly: boolean }) => ({
      ok: true,
      data: { items: input.belowReorderOnly ? [stockReportItem] : [stockReportItem], totalValueMinor: 2000 },
    }));

    const response = await GET(readRequest());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items).toEqual([{ ...stockReportItem, totalValueMinor: 2000 }]);
    expect(result.totalValueMinor).toBe(2000);
    expect(result.reorderAlerts).toEqual([{
      sku: "MUG-1",
      name: "Mug",
      onHandThousandths: 500,
      reorderPointThousandths: 1000,
      shortfallThousandths: 500,
      avgUnitCostMinor: 4000,
    }]);
    expect(mocks.execute).toHaveBeenCalledWith("inventory.stockReport", ctx, { belowReorderOnly: false });
    expect(mocks.execute).toHaveBeenCalledWith("inventory.stockReport", ctx, { belowReorderOnly: true });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps lot rows on TypeScript by default", async () => {
    const expiresAt = new Date("2026-10-01T00:00:00.000Z");
    const db = inventoryReadDb([[], [], [], [], [{ id: "lot-1", itemId: "item-1", lotCode: "BATCH-1", expiresAt }]]);
    mocks.getDb.mockReturnValue({ db });
    mocks.execute.mockImplementation(async (_id: string, _ctx: unknown, input: { belowReorderOnly: boolean }) => ({
      ok: true,
      data: { items: input.belowReorderOnly ? [stockReportItem] : [stockReportItem], totalValueMinor: 2000 },
    }));

    const response = await GET(readRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).lots).toEqual([{ id: "lot-1", lotCode: "BATCH-1", sku: "", expiresAt: "2026-10-01T00:00:00.000Z" }]);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("bridges the existing lot list through Go and returns only legacy lot fields", async () => {
    vi.stubEnv("GO_INVENTORY_LOTS_READS", "1");
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.execute.mockImplementation(async (_id: string, _ctx: unknown, input: { belowReorderOnly: boolean }) => ({
      ok: true,
      data: { items: input.belowReorderOnly ? [stockReportItem] : [stockReportItem], totalValueMinor: 2000 },
    }));
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({
      ok: true,
      data: { lots: [{ id: "lot-1", sku: "MUG-1", lotCode: "BATCH-1", balanceThousandths: 400, expiresAt: "2026-10-01T00:00:00.000Z" }] },
    }) });

    const response = await GET(readRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).lots).toEqual([{ id: "lot-1", lotCode: "BATCH-1", sku: "MUG-1", expiresAt: "2026-10-01T00:00:00.000Z" }]);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "inventory.listLots",
      input: {},
    });
  });

  it("preserves the 200-lot limit for Go results", async () => {
    vi.stubEnv("GO_INVENTORY_LOTS_READS", "1");
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.execute.mockImplementation(async (_id: string, _ctx: unknown, input: { belowReorderOnly: boolean }) => ({
      ok: true,
      data: { items: input.belowReorderOnly ? [stockReportItem] : [stockReportItem], totalValueMinor: 2000 },
    }));
    const lots = Array.from({ length: 201 }, (_, index) => ({
      id: `lot-${index}`,
      sku: "MUG-1",
      lotCode: `BATCH-${index}`,
      balanceThousandths: 400,
      expiresAt: null,
    }));
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { lots } }) });

    const response = await GET(readRequest());
    expect(response.status).toBe(200);
    const returnedLots = (await response.json()).lots;
    expect(returnedLots).toHaveLength(200);
    expect(returnedLots[0]).toEqual({ id: "lot-0", lotCode: "BATCH-0", sku: "MUG-1", expiresAt: null });
    expect(returnedLots.at(-1)?.id).toBe("lot-199");
  });

  it("preserves the Go inventory-read permission denial", async () => {
    vi.stubEnv("GO_INVENTORY_LOTS_READS", "1");
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.execute.mockImplementation(async (_id: string, _ctx: unknown, input: { belowReorderOnly: boolean }) => ({
      ok: true,
      data: { items: input.belowReorderOnly ? [stockReportItem] : [stockReportItem], totalValueMinor: 2000 },
    }));
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ error: "missing permission: inventory.read" }, { status: 403 }),
    });

    const response = await GET(readRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "missing permission: inventory.read" });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "inventory.listLots" }));
  });

  it("fails closed for an unavailable or malformed Go lot read without retrying in TypeScript", async () => {
    vi.stubEnv("GO_INVENTORY_LOTS_READS", "1");
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.execute.mockImplementation(async (_id: string, _ctx: unknown, input: { belowReorderOnly: boolean }) => ({
      ok: true,
      data: { items: input.belowReorderOnly ? [stockReportItem] : [stockReportItem], totalValueMinor: 2000 },
    }));
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({
      ok: true,
      data: { lots: [{ id: "lot-1", sku: "MUG-1", lotCode: "BATCH-1", balanceThousandths: 400, expiresAt: "not-a-date" }] },
    }) });

    const response = await GET(readRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledTimes(1);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "inventory.listLots" }));
  });

  it("bridges the main stock report through Go and preserves legacy report fields", async () => {
    vi.stubEnv("GO_INVENTORY_STOCK_REPORT_READS", "1");
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: true, data: { items: [stockReportItem], totalValueMinor: 2000 } }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: true, data: { items: [stockReportItem], totalValueMinor: 2000 } }) });

    const response = await GET(readRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
    const result = await response.json();
    expect(result.items).toEqual([{ ...stockReportItem, totalValueMinor: 2000 }]);
    expect(result.totalValueMinor).toBe(2000);
    expect(result.reorderAlerts).toEqual([{
      sku: "MUG-1",
      name: "Mug",
      onHandThousandths: 500,
      reorderPointThousandths: 1000,
      shortfallThousandths: 500,
      avgUnitCostMinor: 4000,
    }]);
    expect(mocks.executeGoCapability).toHaveBeenNthCalledWith(1, {
      actionContext: ctx,
      session: user,
      capabilityId: "inventory.stockReport",
      input: { belowReorderOnly: false },
    });
    expect(mocks.executeGoCapability).toHaveBeenNthCalledWith(2, {
      actionContext: ctx,
      session: user,
      capabilityId: "inventory.stockReport",
      input: { belowReorderOnly: true },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Go unavailable", first: { kind: "not-dispatched" }, second: { kind: "not-dispatched" } },
    { label: "malformed report", first: { kind: "response", response: Response.json({ ok: true, data: { items: [{ sku: "MUG-1" }], totalValueMinor: 0 } }) }, second: { kind: "response", response: Response.json({ ok: true, data: { items: [], totalValueMinor: 0 } }) } },
    { label: "malformed reorder report", first: { kind: "response", response: Response.json({ ok: true, data: { items: [stockReportItem], totalValueMinor: 2000 } }) }, second: { kind: "response", response: Response.json({ ok: true, data: { items: [{ sku: "MUG-1" }], totalValueMinor: 0 } }) } },
  ])("fails closed on $label without retrying through TypeScript", async ({ first, second }) => {
    vi.stubEnv("GO_INVENTORY_STOCK_REPORT_READS", "1");
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.executeGoCapability.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const response = await GET(readRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, body: { error: "session assertion expired" }, expectedError: "session assertion expired" },
    { status: 403, body: { error: "organization membership is inactive" }, expectedError: "organization membership is inactive" },
    { status: 422, body: { ok: false, error: "missing permission: inventory.read" }, expectedError: "missing permission: inventory.read" },
  ])("preserves Go authorization failure status $status", async ({ status, body, expectedError }) => {
    vi.stubEnv("GO_INVENTORY_STOCK_REPORT_READS", "1");
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json(body, { status }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: true, data: { items: [stockReportItem], totalValueMinor: 2000 } }) });

    const response = await GET(readRequest());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: expectedError });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("bridges item history through Go and preserves the movement response shape", async () => {
    vi.stubEnv("GO_INVENTORY_ITEM_HISTORY_READS", "1");
    const movements = [{ id: "movement-1", quantityDelta: 1000, reason: "purchase", note: null, refType: null, unitCostMinor: 400, lotCode: null, locationCode: "MAIN", actorType: "human", createdAt: "2026-09-29T10:00:00.000Z" }];
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { movements } }) });

    const response = await GET(readRequest("?sku=MUG-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ movements });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "inventory.itemHistory",
      input: { sku: "MUG-1", limit: 100 },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: "not-dispatched", result: { kind: "not-dispatched" } },
    { label: "outcome-unknown", result: { kind: "outcome-unknown" } },
    { label: "malformed response", result: { kind: "response", response: Response.json({ ok: true, data: { movements: [{ id: "missing-fields" }] } }) } },
  ])("fails closed on $label without falling back to TypeScript", async ({ result }) => {
    vi.stubEnv("GO_INVENTORY_ITEM_HISTORY_READS", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await GET(readRequest("?sku=MUG-1"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves the legacy not-found status for an unknown SKU", async () => {
    vi.stubEnv("GO_INVENTORY_ITEM_HISTORY_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: false, error: "no item with SKU MISSING" }, { status: 422 }) });

    const response = await GET(readRequest("?sku=MISSING"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no item with SKU MISSING" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps a Go 403 denial to the legacy item-history not-found response", async () => {
    vi.stubEnv("GO_INVENTORY_ITEM_HISTORY_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ error: "forbidden" }, { status: 403 }) });

    const response = await GET(readRequest("?sku=MUG-1"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

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

describe("inventory Go transfer-list bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INVENTORY_ITEM_HISTORY_READS", "0");
    vi.stubEnv("GO_INVENTORY_STOCK_REPORT_READS", "0");
    vi.stubEnv("GO_INVENTORY_TRANSFER_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: inventoryReadDb() });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { items: [], totalValueMinor: 0 } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("preserves transfer routes and confirmed line quantities from Go", async () => {
    vi.stubEnv("GO_INVENTORY_TRANSFER_READS", "1");
    const transfers = [{
      id: "transfer-1",
      number: 7,
      status: "partial",
      note: "front counter",
      createdAt: "2026-09-28T08:00:00.000Z",
      from: "MAIN",
      to: "SHOP",
      lines: [{ sku: "MUG-1", quantityThousandths: 5000, confirmedThousandths: 2000 }],
    }];
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { transfers } }) });

    const response = await GET(readRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).transfers).toEqual([{
      id: "transfer-1",
      number: 7,
      status: "partial",
      note: "front counter",
      from: "MAIN",
      to: "SHOP",
      lines: [{ sku: "MUG-1", quantityThousandths: 5000, confirmedThousandths: 2000 }],
    }]);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "inventory.listTransfers",
      input: { openOnly: false },
    });
  });

  it.each([
    { label: "Go unavailable", result: { kind: "not-dispatched" } },
    { label: "malformed transfer line", result: { kind: "response", response: Response.json({ ok: true, data: { transfers: [{ id: "transfer-1", number: 1, status: "pending", note: null, createdAt: "2026-09-28T08:00:00.000Z", from: "MAIN", to: "SHOP", lines: [{ sku: "MUG-1" }] }] } }) } },
  ])("fails closed on $label without retrying the transfer list", async ({ result }) => {
    vi.stubEnv("GO_INVENTORY_TRANSFER_READS", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await GET(readRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledTimes(1);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "inventory.listTransfers" }));
  });

  it("preserves the legacy 50-transfer limit", async () => {
    vi.stubEnv("GO_INVENTORY_TRANSFER_READS", "1");
    const transfers = Array.from({ length: 51 }, (_, index) => ({
      id: `transfer-${index}`,
      number: index,
      status: "pending",
      note: null,
      createdAt: "2026-09-28T08:00:00.000Z",
      from: "MAIN",
      to: "SHOP",
      lines: [],
    }));
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { transfers } }) });

    const response = await GET(readRequest());
    expect((await response.json()).transfers).toHaveLength(50);
  });

  it("preserves a Go inventory-read permission denial", async () => {
    vi.stubEnv("GO_INVENTORY_TRANSFER_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ error: "missing permission: inventory.read" }, { status: 403 }),
    });

    const response = await GET(readRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "missing permission: inventory.read" });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ session: user, capabilityId: "inventory.listTransfers" }));
  });
});

describe("inventory valuation summary Go bridge", () => {
  const valuationOutput = {
    posted: true,
    entryId: "f3c65071-356d-48e4-b5cb-cccd4fc06f6d",
    varianceMinor: 2000,
    ledgerValueMinor: 12000,
    glBalanceMinor: 10000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INVENTORY_VALUATION_SUMMARY_WRITE", "0");
    vi.stubEnv("GO_INVENTORY_ITEM_WRITES", "0");
    vi.stubEnv("GO_INVENTORY_STOCK_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: valuationOutput });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps valuation posting on TypeScript by default", async () => {
    const response = await POST(request({ action: "postValuationSummary", memo: "Monthly stock valuation" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: valuationOutput });
    expect(mocks.execute).toHaveBeenCalledWith("inventory.postValuationSummary", ctx, { memo: "Monthly stock valuation" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches valuation posting through Go and preserves the full output contract", async () => {
    vi.stubEnv("GO_INVENTORY_VALUATION_SUMMARY_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: valuationOutput, replayed: false }),
    });

    const response = await POST(request({ action: "postValuationSummary", memo: "Monthly stock valuation", intentId: "valuation-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: valuationOutput });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "inventory.postValuationSummary",
      input: { memo: "Monthly stock valuation" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves the Go no-op valuation result", async () => {
    vi.stubEnv("GO_INVENTORY_VALUATION_SUMMARY_WRITE", "1");
    const noOp = { posted: false, entryId: null, varianceMinor: 0, ledgerValueMinor: 12000, glBalanceMinor: 12000 };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: noOp }) });

    const response = await POST(request({ action: "postValuationSummary" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: noOp });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "inventory.postValuationSummary",
      input: { memo: undefined },
    }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves the legacy approval reason for Go valuation approvals", async () => {
    vi.stubEnv("GO_INVENTORY_VALUATION_SUMMARY_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, pendingApproval: true, reason: "Inventory posting requires a reviewer" }, { status: 202 }),
    });

    const response = await POST(request({ action: "postValuationSummary" }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "pending human approval" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Go output without retrying through TypeScript", async () => {
    vi.stubEnv("GO_INVENTORY_VALUATION_SUMMARY_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { ...valuationOutput, ledgerValueMinor: "12000" } }),
    });

    const response = await POST(request({ action: "postValuationSummary" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "approval", result: { kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "Inventory posting requires a reviewer" }, { status: 202 }) }, status: 202, body: { ok: false, pendingApproval: true, reason: "pending human approval" } },
    { kind: "capability error", result: { kind: "response", response: Response.json({ ok: false, error: "inventory account is unavailable" }, { status: 422 }) }, status: 422, body: { ok: false, error: "inventory account is unavailable" } },
    { kind: "unknown Go outcome", result: { kind: "outcome-unknown" }, status: 503, body: { ok: false, error: "inventory service unavailable; check stock status before retrying" } },
  ])("preserves $kind and never retries through TypeScript", async ({ result, status, body }) => {
    vi.stubEnv("GO_INVENTORY_VALUATION_SUMMARY_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "postValuationSummary" }));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
