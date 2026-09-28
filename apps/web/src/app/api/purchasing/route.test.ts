import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getResolvedUser: vi.fn(), actorFromResolved: vi.fn(), buildExecutor: vi.fn(), buildRegistry: vi.fn(), execute: vi.fn(), getDb: vi.fn(), executeGoCapability: vi.fn() }));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ asc: vi.fn(), desc: vi.fn(), eq: vi.fn(), inArray: vi.fn(), sql: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, organizations: {}, poLines: {}, purchaseOrders: {}, purchaseRequests: {}, rfqs: {}, vendorBills: {}, vendors: {} }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/balances", () => ({ documentOutstanding: vi.fn() }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", permissions: new Set(["purchasing.write", "purchasing.post"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "buy-intent" };

function request(body: unknown) {
  return new Request("http://localhost/api/purchasing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("purchasing Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_PO_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_RECEIPT_WRITES", "0");
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
    { body: { action: "createVendor", name: "Kampala Supplies", email: "sales@example.test" }, capabilityId: "purchasing.createVendor", input: { name: "Kampala Supplies", email: "sales@example.test" } },
    { body: { action: "createBill", vendorId: "vendor-1", vendorRef: "V-88", memo: "Materials", poNumber: 7, lines: [{ description: "Rice", quantity: 1000, unitPriceMinor: 4500, taxCodeId: "tax-1", poLineNumber: 2 }] }, capabilityId: "purchasing.createBill", input: { vendorId: "vendor-1", vendorRef: "V-88", memo: "Materials", poNumber: 7, lines: [{ description: "Rice", quantity: 1000, unitPriceMinor: 4500, taxCodeId: "tax-1", poLineNumber: 2 }] } },
    { body: { action: "payBill", billNumber: 8, amountMinor: 12000, method: "cash" }, capabilityId: "purchasing.payBill", input: { billNumber: 8, amountMinor: 12000, method: "cash" } },
  ])("dispatches $body.action to Go behind its flag", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { done: true }, replayed: true }) });
    const response = await POST(request({ ...body, intentId: "buy-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { done: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps bill writes on TypeScript while the flag is off", async () => {
    await POST(request({ action: "payBill", billNumber: 8, amountMinor: 12000 }));
    expect(mocks.execute).toHaveBeenCalledWith("purchasing.payBill", ctx, {
      billNumber: 8, amountMinor: 12000, method: "bank_transfer",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps other purchasing actions on TypeScript", async () => {
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "1");
    await POST(request({ action: "createPurchaseRequest", title: "Laptops", justification: "Hiring" }));
    expect(mocks.execute).toHaveBeenCalledWith("purchasing.createPurchaseRequest", ctx, { title: "Laptops", justification: "Hiring", estimatedAmountMinor: undefined });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("bridges only purchase order creation when its independent flag is on", async () => {
    vi.stubEnv("GO_PURCHASING_PO_WRITES", "1");
    const input = {
      vendorId: "vendor-1",
      memo: "Quarterly stock",
      promisedAt: "2030-02-03T04:05:06.123Z",
      lines: [{ description: "Chair frame", quantity: 2500, unitPriceMinor: 4500, sku: "CHAIR" }],
    };
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { poNumber: 7 } }),
    });

    const response = await POST(request({ action: "createPurchaseOrder", ...input, intentId: "buy-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { poNumber: 7 } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.createPurchaseOrder",
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps purchase order creation on TypeScript while its flag is off", async () => {
    await POST(request({
      action: "createPurchaseOrder",
      vendorId: "vendor-1",
      lines: [{ description: "Chair frame", quantity: 2500, unitPriceMinor: 4500 }],
    }));
    expect(mocks.execute).toHaveBeenCalledWith("purchasing.createPurchaseOrder", ctx, {
      vendorId: "vendor-1",
      lines: [{ description: "Chair frame", quantity: 2500, unitPriceMinor: 4500 }],
      memo: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps receiving on TypeScript while its flag is off", async () => {
    const body = {
      action: "receiveGoods",
      poNumber: 14,
      lines: [{ lineNumber: 2, quantity: 1750, rejected: 250, rejectionNote: "Damaged" }],
      overreceiptTolerancePct: 5,
      authorityReason: "Supplier replacement",
      note: "Partial delivery",
    };

    await POST(request(body));

    expect(mocks.execute).toHaveBeenCalledWith("purchasing.receiveGoods", ctx, {
      poNumber: 14,
      lines: body.lines,
      overreceiptTolerancePct: 5,
      authorityReason: "Supplier replacement",
      note: "Partial delivery",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches receiving to Go and preserves the success response", async () => {
    vi.stubEnv("GO_PURCHASING_RECEIPT_WRITES", "1");
    const lines = [{ lineNumber: 2, quantity: 1750, rejected: 250, rejectionNote: "Damaged" }];
    const input = {
      poNumber: 14,
      lines,
      overreceiptTolerancePct: 5,
      authorityReason: "Supplier replacement",
      note: "Partial delivery",
    };
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { receiptNumber: 19, fullyReceived: false } }),
    });

    const response = await POST(request({ action: "receiveGoods", ...input, intentId: "buy-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { receiptNumber: 19, fullyReceived: false } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.receiveGoods",
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves pending approval responses for Go receiving", async () => {
    vi.stubEnv("GO_PURCHASING_RECEIPT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json(
        { ok: false, pendingApproval: true, reason: "Overreceipt requires approval" },
        { status: 202 },
      ),
    });

    const response = await POST(request({
      action: "receiveGoods",
      poNumber: 14,
      lines: [{ lineNumber: 2, quantity: 2200 }],
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      pendingApproval: true,
      reason: "Overreceipt requires approval",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])(
    "does not retry a receiving write on $kind",
    async (result) => {
      vi.stubEnv("GO_PURCHASING_RECEIPT_WRITES", "1");
      mocks.executeGoCapability.mockResolvedValue(result);

      const response = await POST(request({
        action: "receiveGoods",
        poNumber: 14,
        lines: [{ lineNumber: 2, quantity: 1750 }],
      }));

      expect(response.status).toBe(503);
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("does not retry a bill write on $kind", async (result) => {
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "payBill", billNumber: 8, amountMinor: 12000 }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("purchasing Go request workflow bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_PO_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_RECEIPT_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_REQUEST_WRITES", "0");
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
    { body: { action: "createPurchaseRequest", title: "Forklift battery", justification: "Failed load test", estimatedAmountMinor: 800000 }, capabilityId: "purchasing.createPurchaseRequest", input: { title: "Forklift battery", justification: "Failed load test", estimatedAmountMinor: 800000 } },
    { body: { action: "decidePurchaseRequest", requestId: "pr-1", decision: "approve", reason: "Budget open" }, capabilityId: "purchasing.decidePurchaseRequest", input: { requestId: "pr-1", decision: "approve", reason: "Budget open" } },
    { body: { action: "createRfq", requestId: "pr-1", vendorIds: ["vendor-1", "vendor-2"] }, capabilityId: "purchasing.createRfq", input: { requestId: "pr-1", vendorIds: ["vendor-1", "vendor-2"] } },
    { body: { action: "recordQuote", rfqId: "rfq-1", amountMinor: 750000, leadTimeDays: 14, notes: "Includes delivery" }, capabilityId: "purchasing.recordQuote", input: { rfqId: "rfq-1", amountMinor: 750000, leadTimeDays: 14, notes: "Includes delivery" } },
    { body: { action: "selectWinningQuote", rfqId: "rfq-1" }, capabilityId: "purchasing.selectWinningQuote", input: { rfqId: "rfq-1" } },
  ])("dispatches $body.action to Go behind GO_PURCHASING_REQUEST_WRITES", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_PURCHASING_REQUEST_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { done: true }, replayed: true }) });
    const response = await POST(request({ ...body, intentId: "buy-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { done: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps request workflow writes on TypeScript while the flag is off", async () => {
    await POST(request({ action: "createPurchaseRequest", title: "Forklift battery", justification: "Failed load test" }));
    expect(mocks.execute).toHaveBeenCalledWith("purchasing.createPurchaseRequest", ctx, {
      title: "Forklift battery", justification: "Failed load test", estimatedAmountMinor: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("fails closed without retrying through TypeScript when Go is unavailable", async () => {
    vi.stubEnv("GO_PURCHASING_REQUEST_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "outcome-unknown" });
    const response = await POST(request({ action: "selectWinningQuote", rfqId: "rfq-1" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
