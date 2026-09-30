import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getResolvedUser: vi.fn(), actorFromResolved: vi.fn(), buildExecutor: vi.fn(), buildRegistry: vi.fn(), execute: vi.fn(), getDb: vi.fn(), executeGoCapability: vi.fn() }));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ asc: vi.fn(), desc: vi.fn(), eq: vi.fn(), inArray: vi.fn(), sql: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, organizations: {}, poLines: {}, purchaseOrders: {}, purchaseRequests: {}, rfqs: {}, vendorBills: {}, vendors: {} }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/balances", () => ({ documentOutstanding: vi.fn() }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", permissions: new Set(["purchasing.write", "purchasing.post"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "buy-intent" };

function request(body: unknown) {
  return new Request("http://localhost/api/purchasing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

describe("purchasing Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_PO_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_RECEIPT_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "0");
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_BILL_CREDIT_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_RETURN_WRITES", "0");
    vi.stubEnv("GO_PURCHASING_WORKFLOW_READS", "0");
    vi.stubEnv("GO_PURCHASING_AP_AGING_READS", "0");
    vi.stubEnv("GO_PURCHASING_PRICE_HISTORY_READS", "0");
    vi.stubEnv("GO_PURCHASING_SUPPLIER_STATEMENT_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the purchase workflow read on TypeScript by default", async () => {
    const createdAt = new Date("2026-09-26T09:30:00.000Z");
    mocks.getDb.mockReturnValue({
      db: {
        select: vi.fn()
          .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
          .mockReturnValueOnce(selectQuery([{ id: "vendor-1", name: "Acme Supply" }]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([{
            id: "request-1",
            title: "Shelving",
            justification: "Increase storage",
            estimatedAmountMinor: 450000,
            status: "rejected",
            decisionReason: "Budget deferred",
            createdAt,
          }]))
          .mockReturnValueOnce(selectQuery([{
            id: "rfq-1",
            requestId: "request-1",
            vendorId: "vendor-1",
            status: "quoted",
            quoteAmountMinor: 420000,
            quoteLeadTimeDays: 5,
            quoteNotes: "Delivery available next week",
          }])),
      },
    });
    mocks.execute.mockResolvedValue({ ok: true, data: { buckets: {}, rows: [], vendors: [] } });

    const response = await GET();
    const body = await response.json();

    expect(body.requests).toEqual([{
      id: "request-1",
      title: "Shelving",
      justification: "Increase storage",
      estimatedAmountMinor: 450000,
      status: "rejected",
      decisionReason: "Budget deferred",
      createdAt: "2026-09-26T09:30:00.000Z",
      rfqs: [{
        id: "rfq-1",
        vendorName: "Acme Supply",
        status: "quoted",
        quoteAmountMinor: 420000,
        quoteLeadTimeDays: 5,
        quoteNotes: "Delivery available next week",
      }],
    }]);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps supplier statements on TypeScript by default", async () => {
    const statement = {
      closingBalanceMinor: 7500,
      rows: [{
        date: "2026-09-24T10:15:00.000Z",
        kind: "bill",
        ref: "Bill #12",
        amountMinor: 7500,
        balanceMinor: 7500,
      }],
    };
    mocks.execute.mockResolvedValue({ ok: true, data: statement });

    const response = await POST(request({ action: "supplierStatement", vendorId: "33333333-3333-4333-8333-333333333333" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: statement });
    expect(mocks.execute).toHaveBeenCalledWith("purchasing.supplierStatement", ctx, { vendorId: "33333333-3333-4333-8333-333333333333" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches supplier statements to Go behind the opt-in flag with no-store and the legacy response shape", async () => {
    vi.stubEnv("GO_PURCHASING_SUPPLIER_STATEMENT_READS", "1");
    const statement = {
      closingBalanceMinor: 7500,
      rows: [{
        date: "2026-09-24T10:15:00.000Z",
        kind: "bill",
        ref: "Bill #12",
        amountMinor: 7500,
        balanceMinor: 7500,
      }],
    };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: statement }) });

    const response = await POST(request({ action: "supplierStatement", vendorId: "33333333-3333-4333-8333-333333333333" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: statement });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.supplierStatement",
      input: { vendorId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.supplierStatement", ctx, expect.anything());
  });

  it.each([
    { kind: "not-dispatched" },
    { kind: "outcome-unknown" },
  ])("fails closed for supplier statements on $kind without falling back to TypeScript", async (bridgeResult) => {
    vi.stubEnv("GO_PURCHASING_SUPPLIER_STATEMENT_READS", "1");
    mocks.executeGoCapability.mockResolvedValue(bridgeResult);

    const response = await POST(request({ action: "supplierStatement", vendorId: "33333333-3333-4333-8333-333333333333" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing supplier statement service unavailable; reload before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.supplierStatement", ctx, expect.anything());
  });

  it("fails closed for malformed Go supplier statement output without TypeScript fallback", async () => {
    vi.stubEnv("GO_PURCHASING_SUPPLIER_STATEMENT_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: {
        closingBalanceMinor: 7500,
        rows: [{ date: "not-a-date", kind: "bill", ref: "Bill #12", amountMinor: "7500", balanceMinor: 7500 }],
      } }),
    });

    const response = await POST(request({ action: "supplierStatement", vendorId: "33333333-3333-4333-8333-333333333333" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing supplier statement service unavailable; reload before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.supplierStatement", ctx, expect.anything());
  });

  it("keeps price history on TypeScript by default", async () => {
    mocks.getDb.mockReturnValue({ db: { select: vi.fn()
      .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([])),
    } });
    mocks.execute.mockImplementation(async (capabilityId: string) => ({
      ok: true,
      data: capabilityId === "purchasing.priceHistory" ? { rows: [{
        vendorName: "Acme Supply",
        itemSku: "WIRE",
        itemDescription: "Copper wire",
        unitPriceMinor: 45000,
        orderedAt: "2026-09-23T10:30:00.000Z",
      }] } : capabilityId === "purchasing.supplierPerformance" ? { vendors: [] } : { buckets: {} },
    }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).priceHistory).toEqual({ rows: [{
      vendorName: "Acme Supply",
      itemSku: "WIRE",
      itemDescription: "Copper wire",
      unitPriceMinor: 45000,
      orderedAt: "2026-09-23T10:30:00.000Z",
    }] });
    expect(mocks.execute).toHaveBeenCalledWith("purchasing.priceHistory", ctx, {});
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches price history to Go behind its opt-in flag with the legacy response shape", async () => {
    vi.stubEnv("GO_PURCHASING_PRICE_HISTORY_READS", "1");
    mocks.getDb.mockReturnValue({ db: { select: vi.fn()
      .mockReturnValueOnce(selectQuery([{ baseCurrency: "UGX" }]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([])),
    } });
    const history = { rows: [{
      vendorName: "Acme Supply",
      itemSku: "WIRE",
      itemDescription: "Copper wire",
      unitPriceMinor: 45000,
      orderedAt: "2026-09-23T10:30:00.000Z",
    }] };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: history }) });
    mocks.execute.mockImplementation(async (capabilityId: string) => ({
      ok: true,
      data: capabilityId === "purchasing.supplierPerformance" ? { vendors: [] } : { buckets: {} },
    }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ baseCurrency: "UGX", priceHistory: history });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.priceHistory",
      input: {},
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.priceHistory", ctx, {});
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("fails closed for price history on $kind", async (bridgeResult) => {
    vi.stubEnv("GO_PURCHASING_PRICE_HISTORY_READS", "1");
    mocks.getDb.mockReturnValue({ db: { select: vi.fn()
      .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([])),
    } });
    mocks.executeGoCapability.mockResolvedValue(bridgeResult);
    mocks.execute.mockImplementation(async (capabilityId: string) => ({
      ok: true,
      data: capabilityId === "purchasing.priceHistory" ? { rows: [] } : capabilityId === "purchasing.supplierPerformance" ? { vendors: [] } : { buckets: {} },
    }));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing price history service unavailable; reload the page before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.priceHistory", ctx, {});
  });

  it("fails closed for malformed Go price history without falling back to TypeScript", async () => {
    vi.stubEnv("GO_PURCHASING_PRICE_HISTORY_READS", "1");
    mocks.getDb.mockReturnValue({ db: { select: vi.fn()
      .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([])),
    } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { rows: [{ vendorName: "Acme", itemSku: null, itemDescription: "wire", unitPriceMinor: "45000", orderedAt: null }] } }) });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing price history service unavailable; reload the page before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.priceHistory", ctx, {});
  });

  it("dispatches AP aging to Go behind its opt-in flag and keeps the same route shape", async () => {
    vi.stubEnv("GO_PURCHASING_AP_AGING_READS", "1");
    mocks.getDb.mockReturnValue({
      db: {
        select: vi.fn()
          .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([])),
      },
    });
    mocks.execute.mockResolvedValue({ ok: true, data: { rows: [] } });
    const buckets = { current: 100, d30: 200, d60: 300, d90plus: 400, totalOutstanding: 1000 };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { buckets } }) });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.apAging).toEqual({ buckets });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.apAging",
      input: {},
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.apAging", ctx, {});
  });

  it("fails closed on malformed Go AP aging output without falling back to TypeScript", async () => {
    vi.stubEnv("GO_PURCHASING_AP_AGING_READS", "1");
    mocks.getDb.mockReturnValue({
      db: {
        select: vi.fn()
          .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([])),
      },
    });
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { buckets: { current: "100" } } }) });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.apAging", ctx, {});
  });

  it("dispatches the purchasing workflow read to Go and preserves the full route payload", async () => {
    vi.stubEnv("GO_PURCHASING_WORKFLOW_READS", "1");
    mocks.getDb.mockReturnValue({
      db: {
        select: vi.fn()
          .mockReturnValueOnce(selectQuery([{ baseCurrency: "UGX" }]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([])),
      },
    });
    mocks.execute.mockResolvedValue({ ok: true, data: { buckets: {}, rows: [], vendors: [] } });
    const workflow = {
      requests: [{
        id: "request-1",
        title: "Shelving",
        justification: "Increase storage",
        estimatedAmountMinor: 450000,
        status: "rejected",
        decisionReason: "Budget deferred",
        createdAt: "2026-09-26T09:30:00.000Z",
        rfqs: [{
          id: "rfq-1",
          vendorId: "vendor-1",
          vendorName: "Acme Supply",
          status: "quoted",
          quoteAmountMinor: 420000,
          quoteLeadTimeDays: 5,
          quoteNotes: "Delivery available next week",
        }],
      }],
    };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: workflow }) });

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      baseCurrency: "UGX",
      requests: [{
        ...workflow.requests[0],
        rfqs: [{
          id: "rfq-1",
          vendorName: "Acme Supply",
          status: "quoted",
          quoteAmountMinor: 420000,
          quoteLeadTimeDays: 5,
          quoteNotes: "Delivery available next week",
        }],
      }],
    });
    expect(body.requests[0].rfqs[0]).not.toHaveProperty("vendorId");
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.listPurchaseWorkflow",
      input: {},
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.listPurchaseWorkflow", expect.anything(), expect.anything());
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("fails closed for purchasing workflow read on $kind", async (result) => {
    vi.stubEnv("GO_PURCHASING_WORKFLOW_READS", "1");
    mocks.getDb.mockReturnValue({
      db: {
        select: vi.fn()
          .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([])),
      },
    });
    mocks.execute.mockResolvedValue({ ok: true, data: { buckets: {}, rows: [], vendors: [] } });
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing workflow service unavailable; reload the page before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.listPurchaseWorkflow", expect.anything(), expect.anything());
  });

  it("fails closed when Go returns an invalid purchasing workflow payload", async () => {
    vi.stubEnv("GO_PURCHASING_WORKFLOW_READS", "1");
    mocks.getDb.mockReturnValue({
      db: {
        select: vi.fn()
          .mockReturnValueOnce(selectQuery([{ baseCurrency: "USD" }]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([]))
          .mockReturnValueOnce(selectQuery([])),
      },
    });
    mocks.execute.mockResolvedValue({ ok: true, data: { buckets: {}, rows: [], vendors: [] } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { requests: [{ id: "broken" }] } }) });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing workflow service unavailable; reload the page before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalledWith("purchasing.listPurchaseWorkflow", expect.anything(), expect.anything());
  });

  it("keeps receipt detail on TypeScript while the Go read flag is off", async () => {
    await POST(request({ action: "receiptDetail", poNumber: 14 }));

    expect(mocks.execute).toHaveBeenCalledWith("purchasing.listReceipts", ctx, { poNumber: 14 });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches receipt detail to Go and preserves the response shape", async () => {
    vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "1");
    const data = {
      receipts: [{ number: 4, receivedAt: "2026-09-23T10:30:00.000Z", note: null, lines: [] }],
      orderLines: [{ position: 1, description: "Steel rod", orderedThousandths: 5000, acceptedThousandths: 3000, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 2000 }],
    };
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data }),
    });

    const response = await POST(request({ action: "receiptDetail", poNumber: 14, intentId: "buy-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.listReceipts",
      input: { poNumber: 14 },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when Go returns malformed receipt data", async () => {
    vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { receipts: [{ number: 1, lines: [] }], orderLines: [] } }),
    });

    const response = await POST(request({ action: "receiptDetail", poNumber: 14 }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing receipts service unavailable; reload the order before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["negative quantities", {
      receipts: [],
      orderLines: [{ position: 1, description: "Steel rod", orderedThousandths: -1, acceptedThousandths: 0, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1 }],
    }],
    ["fractional quantities", {
      receipts: [],
      orderLines: [{ position: 1, description: "Steel rod", orderedThousandths: 1000, acceptedThousandths: 0.5, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1000 }],
    }],
    ["unsafe integers", {
      receipts: [],
      orderLines: [{ position: 1, description: "Steel rod", orderedThousandths: Number.MAX_SAFE_INTEGER + 1, acceptedThousandths: 0, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1000 }],
    }],
    ["zero positions", {
      receipts: [],
      orderLines: [{ position: 0, description: "Steel rod", orderedThousandths: 1000, acceptedThousandths: 0, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1000 }],
    }],
    ["invalid receipt timestamps", {
      receipts: [{ number: 1, receivedAt: "2026-09-28", note: null, lines: [] }],
      orderLines: [],
    }],
    ["unexpected receipt fields", {
      receipts: [],
      orderLines: [{ position: 1, description: "Steel rod", orderedThousandths: 1000, acceptedThousandths: 0, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1000, unexpected: true }],
    }],
  ])("fails closed when Go returns %s", async (_label, data) => {
    vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data }),
    });

    const response = await POST(request({ action: "receiptDetail", poNumber: 14 }));

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("validates receipt detail input before Go dispatch", async () => {
    vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "1");

    const response = await POST(request({ action: "receiptDetail" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "poNumber is required" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])(
    "fails closed for a receipt read on $kind",
    async (result) => {
      vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "1");
      mocks.executeGoCapability.mockResolvedValue(result);

      const response = await POST(request({ action: "receiptDetail", poNumber: 14 }));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "purchasing receipts service unavailable; reload the order before retrying",
      });
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps receiving writes on TypeScript when only receipt reads are enabled", async () => {
    vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "1");
    await POST(request({
      action: "receiveGoods",
      poNumber: 14,
      lines: [{ lineNumber: 2, quantity: 1750 }],
    }));

    expect(mocks.execute).toHaveBeenCalledWith("purchasing.receiveGoods", ctx, {
      poNumber: 14,
      lines: [{ lineNumber: 2, quantity: 1750 }],
      overreceiptTolerancePct: undefined,
      authorityReason: undefined,
      note: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps purchase order closure on TypeScript while its Go flag is off", async () => {
    await POST(request({ action: "closePurchaseOrder", poNumber: 14 }));

    expect(mocks.execute).toHaveBeenCalledWith("purchasing.closePurchaseOrder", ctx, { poNumber: 14 });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches purchase order closure to Go and preserves its response", async () => {
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "1");
    const data = { closed: true, backordered: true, shortThousandths: 2500 };
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data }),
    });

    const response = await POST(request({ action: "closePurchaseOrder", poNumber: 14, intentId: "buy-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.closePurchaseOrder",
      input: { poNumber: 14 },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when Go returns malformed purchase order closure data", async () => {
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: {} }),
    });

    const response = await POST(request({ action: "closePurchaseOrder", poNumber: 14 }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing order closure service unavailable; check order status before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves approval responses for Go purchase order closure", async () => {
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json(
        { ok: false, pendingApproval: true, reason: "Closing this order requires approval" },
        { status: 202 },
      ),
    });

    const response = await POST(request({ action: "closePurchaseOrder", poNumber: 14 }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      pendingApproval: true,
      reason: "Closing this order requires approval",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves Go purchase order closure errors", async () => {
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, error: "order is already closed" }, { status: 422 }),
    });

    const response = await POST(request({ action: "closePurchaseOrder", poNumber: 14 }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: "order is already closed" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("validates purchase order closure input before Go dispatch", async () => {
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "1");

    const response = await POST(request({ action: "closePurchaseOrder" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "poNumber is required" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])(
    "fails closed for purchase order closure on $kind without retrying TypeScript",
    async (result) => {
      vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "1");
      mocks.executeGoCapability.mockResolvedValue(result);

      const response = await POST(request({ action: "closePurchaseOrder", poNumber: 14 }));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "purchasing order closure service unavailable; check order status before retrying",
      });
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps purchase order creation on TypeScript when only the close flag is enabled", async () => {
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "1");
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

  it("keeps bill credit notes on TypeScript unless their independent flag is enabled", async () => {
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "1");
    const billId = "33333333-3333-4333-8333-333333333333";

    await POST(request({ action: "billCreditNote", billId, amountMinor: 5000, reason: "Damaged delivery" }));

    expect(mocks.execute).toHaveBeenCalledWith("purchasing.billCreditNote", ctx, {
      billId,
      amountMinor: 5000,
      reason: "Damaged delivery",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches bill credit notes to Go with the existing capability contract", async () => {
    vi.stubEnv("GO_PURCHASING_BILL_CREDIT_WRITES", "1");
    const billId = "33333333-3333-4333-8333-333333333333";
    const input = { billId, amountMinor: 5000, reason: "Damaged delivery" };
    const data = { entryId: "44444444-4444-4444-8444-444444444444", creditedMinor: 5000, billBalanceMinor: 7000 };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data, replayed: true }) });

    const response = await POST(request({ action: "billCreditNote", ...input, intentId: "buy-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.billCreditNote",
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("validates bill credit note fields before Go dispatch", async () => {
    vi.stubEnv("GO_PURCHASING_BILL_CREDIT_WRITES", "1");

    const response = await POST(request({ action: "billCreditNote", billId: "33333333-3333-4333-8333-333333333333" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "billId, amountMinor and reason are required" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves bill credit note approval and validation responses from Go", async () => {
    vi.stubEnv("GO_PURCHASING_BILL_CREDIT_WRITES", "1");
    const body = { action: "billCreditNote", billId: "33333333-3333-4333-8333-333333333333", amountMinor: 5000, reason: "Damaged delivery" };
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "Supplier credit requires approval" }, { status: 202 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "bill is void; nothing to credit" }, { status: 422 }) });

    const pending = await POST(request(body));
    expect(pending.status).toBe(202);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Supplier credit requires approval" });

    const rejected = await POST(request(body));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({ ok: false, error: "bill is void; nothing to credit" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: "not dispatched", result: { kind: "not-dispatched" } },
    { label: "outcome unknown", result: { kind: "outcome-unknown" } },
    { label: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: {} }) } },
  ])("fails closed on $label bill credit results without TypeScript retry", async ({ result }) => {
    vi.stubEnv("GO_PURCHASING_BILL_CREDIT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({
      action: "billCreditNote",
      billId: "33333333-3333-4333-8333-333333333333",
      amountMinor: 5000,
      reason: "Damaged delivery",
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing bill credit service unavailable; check bill status before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
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

  it("dispatches vendor returns to Go without changing the public response", async () => {
    vi.stubEnv("GO_PURCHASING_RETURN_WRITES", "1");
    const input = { poNumber: 14, receiptNumber: 3, lines: [{ lineNumber: 1, quantity: 500, reason: "damaged goods" }] };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { returned: true, lines: 1 } }) });
    const response = await POST(request({ action: "returnGoods", ...input, intentId: "return-intent" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { returned: true, lines: 1 } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.returnGoods",
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])(
    "does not retry a vendor return on $kind",
    async (result) => {
      vi.stubEnv("GO_PURCHASING_RETURN_WRITES", "1");
      mocks.executeGoCapability.mockResolvedValue(result);
      const response = await POST(request({
        action: "returnGoods",
        poNumber: 14,
        lines: [{ lineNumber: 1, quantity: 500, reason: "damaged goods" }],
      }));
      expect(response.status).toBe(503);
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

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
    vi.stubEnv("GO_PURCHASING_RECEIPT_READS", "0");
    vi.stubEnv("GO_PURCHASING_PO_CLOSE_WRITES", "0");
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

describe("purchasing Go vendor payment reversal bridge", () => {
  const vendorPaymentId = "d1ab207a-b4f8-4aca-a28c-b8127ae017af";
  const reversalEntryId = "452635a8-2b7b-4da4-93b6-274e44ee1fa9";
  const body = { action: "reverseVendorPayment", vendorPaymentId, reason: "Duplicate payment" };
  const data = { reversalEntryId, refundedMinor: 25000, billNumber: 84, outstandingMinor: 75000 };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_PURCHASING_REVERSE_VENDOR_PAYMENT_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps reversals on the TypeScript capability when the flag is off", async () => {
    delete process.env.GO_PURCHASING_REVERSE_VENDOR_PAYMENT_WRITE;

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.execute).toHaveBeenCalledWith("purchasing.reverseVendorPayment", ctx, {
      vendorPaymentId,
      reason: "Duplicate payment",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches reversals to Go and preserves the legacy output contract", async () => {
    vi.stubEnv("GO_PURCHASING_REVERSE_VENDOR_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data, replayed: true }),
    });

    const response = await POST(request({ ...body, intentId: "reverse-vendor-payment-1" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "purchasing.reverseVendorPayment",
      input: { vendorPaymentId, reason: "Duplicate payment" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves Go approvals and capability errors without retrying through TypeScript", async () => {
    vi.stubEnv("GO_PURCHASING_REVERSE_VENDOR_PAYMENT_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Human approval required" }, { status: 202 }),
      })
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, error: "vendor payment has already been reversed" }, { status: 422 }),
      });

    const approval = await POST(request(body));
    const failure = await POST(request(body));

    expect(approval.status).toBe(202);
    expect(await approval.json()).toEqual({ ok: false, pendingApproval: true, reason: "Human approval required" });
    expect(failure.status).toBe(422);
    expect(await failure.json()).toEqual({ ok: false, error: "vendor payment has already been reversed" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing Go dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed success output", result: { kind: "response", response: Response.json({ ok: true, data: { ...data, refundedMinor: "25000" } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_PURCHASING_REVERSE_VENDOR_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(body));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      error: "purchasing payment reversal service unavailable; check payment status before retrying",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
