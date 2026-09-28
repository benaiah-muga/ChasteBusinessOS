import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(), actorFromResolved: vi.fn(), buildExecutor: vi.fn(), buildRegistry: vi.fn(),
  execute: vi.fn(), getDb: vi.fn(), executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ desc: vi.fn(), eq: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, expensePolicies: {} }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", permissions: new Set(["expenses.write"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "expense-intent" };

function request(body: unknown) {
  return new Request("http://localhost/api/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("expenses Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { claimId: "claim-1" } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { body: { action: "submit", amountMinor: 12500, memo: "Client travel" }, capabilityId: "accounting.submitExpenseClaim", input: { amountMinor: 12500, memo: "Client travel", accountCode: undefined } },
    { body: { action: "decide", claimId: "33333333-3333-4333-8333-333333333333", decision: "approved", reason: "Valid" }, capabilityId: "accounting.decideExpenseClaim", input: { claimId: "33333333-3333-4333-8333-333333333333", decision: "approved", reason: "Valid" } },
    { body: { action: "pay", claimId: "33333333-3333-4333-8333-333333333333", amountMinor: 12500 }, capabilityId: "accounting.payExpenseClaim", input: { claimId: "33333333-3333-4333-8333-333333333333", amountMinor: 12500 } },
  ])("dispatches $body.action to Go behind its flag", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { claimId: "claim-1" } }) });
    const response = await POST(request({ ...body, intentId: "expense-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { claimId: "claim-1" } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps expense claim writes on TypeScript while the flag is off", async () => {
    await POST(request({ action: "submit", amountMinor: 12500, memo: "Client travel" }));
    expect(mocks.execute).toHaveBeenCalledWith("accounting.submitExpenseClaim", ctx, {
      amountMinor: 12500, memo: "Client travel", accountCode: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps policy writes on TypeScript when the expense flag is enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "1");
    await POST(request({ action: "setPolicy", category: "Travel", limitMinor: 50000 }));
    expect(mocks.execute).toHaveBeenCalledWith("accounting.setExpensePolicy", ctx, { category: "Travel", limitMinor: 50000 });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("does not retry via TypeScript on $kind", async (result) => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "pay", claimId: "33333333-3333-4333-8333-333333333333", amountMinor: 12500 }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
