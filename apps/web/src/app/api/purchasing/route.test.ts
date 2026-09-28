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

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("does not retry a bill write on $kind", async (result) => {
    vi.stubEnv("GO_PURCHASING_BILL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "payBill", billNumber: 8, amountMinor: 12000 }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
