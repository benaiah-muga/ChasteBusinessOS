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

import { GET, POST } from "./route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", permissions: new Set(["expenses.write"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "expense-intent" };

function request(body: unknown) {
  return new Request("http://localhost/api/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function readRequest(url = "http://localhost/api/expenses") {
  return new Request(url, { method: "GET" });
}

describe("expenses Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "0");
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { claimId: "claim-1" } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("combines Go claims and policy reads into the existing GET response behind its own flag", async () => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_READS", "1");
    mocks.executeGoCapability.mockImplementation(async ({ capabilityId }: { capabilityId: string }) => {
      if (capabilityId === "accounting.listExpensePolicies") {
        return { kind: "response", response: Response.json({ ok: true, data: { policies: [{ category: "travel", limitMinor: 50000 }] } }) };
      }
      return { kind: "response", response: Response.json({ ok: true, data: { claims: [{ id: "claim-1", status: "submitted" }] } }) };
    });

    const response = await GET(readRequest("http://localhost/api/expenses?status=submitted"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      claims: [{ id: "claim-1", status: "submitted" }],
      policies: [{ category: "travel", limitMinor: 50000 }],
    });
    expect(mocks.executeGoCapability).toHaveBeenCalledTimes(2);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "accounting.listExpenseClaims",
      input: { status: "submitted" },
    });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "accounting.listExpensePolicies",
      input: {},
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("fails closed for Go expense reads on $kind", async (result) => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_READS", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await GET(readRequest());
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      body: { action: "submit", amountMinor: 12500, memo: "Client travel" },
      capabilityId: "accounting.submitExpenseClaim",
      input: { amountMinor: 12500, memo: "Client travel", accountCode: undefined },
      data: { claimId: "claim-1", status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null },
    },
    {
      body: { action: "decide", claimId: "33333333-3333-4333-8333-333333333333", decision: "approved", reason: "Valid" },
      capabilityId: "accounting.decideExpenseClaim",
      input: { claimId: "33333333-3333-4333-8333-333333333333", decision: "approved", reason: "Valid" },
      data: { claimId: "claim-1", status: "approved" },
    },
    {
      body: { action: "pay", claimId: "33333333-3333-4333-8333-333333333333", amountMinor: 12500 },
      capabilityId: "accounting.payExpenseClaim",
      input: { claimId: "33333333-3333-4333-8333-333333333333", amountMinor: 12500 },
      data: { claimId: "claim-1", entryId: "entry-1", paidMinor: 12500 },
    },
  ])("dispatches $body.action to Go behind its flag", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data }) });
    const response = await POST(request({ ...body, intentId: "expense-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { body: { action: "submit", amountMinor: 12500, memo: "Client travel" } },
    { body: { action: "decide", claimId: "33333333-3333-4333-8333-333333333333", decision: "approved" } },
    { body: { action: "pay", claimId: "33333333-3333-4333-8333-333333333333", amountMinor: 12500 } },
    { body: { action: "setPolicy", category: "Travel", limitMinor: 50000 } },
  ])("fails closed for an invalid $body.action Go success payload", async ({ body }) => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: {} }) });
    const response = await POST(request(body));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps expense claim writes on TypeScript while the flag is off", async () => {
    await POST(request({ action: "submit", amountMinor: 12500, memo: "Client travel" }));
    expect(mocks.execute).toHaveBeenCalledWith("accounting.submitExpenseClaim", ctx, {
      amountMinor: 12500, memo: "Client travel", accountCode: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps policy writes on TypeScript while the expense flag is off", async () => {
    await POST(request({ action: "setPolicy", category: "Travel", limitMinor: 50000 }));
    expect(mocks.execute).toHaveBeenCalledWith("accounting.setExpensePolicy", ctx, {
      category: "Travel", limitMinor: 50000,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches policy writes to Go when the expense flag is enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { set: true, category: "Travel", limitMinor: 50000 } }) });
    const response = await POST(request({ action: "setPolicy", category: "Travel", limitMinor: 50000 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { set: true, category: "Travel", limitMinor: 50000 } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx, session: user, capabilityId: "accounting.setExpensePolicy",
      input: { category: "Travel", limitMinor: 50000 },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("does not retry via TypeScript on $kind", async (result) => {
    vi.stubEnv("GO_ACCOUNTING_EXPENSE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "pay", claimId: "33333333-3333-4333-8333-333333333333", amountMinor: 12500 }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
