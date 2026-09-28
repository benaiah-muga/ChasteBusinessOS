import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), desc: vi.fn(), eq: vi.fn() }));
vi.mock("@chaste/db", () => ({ bankAccounts: {}, bankTransactions: {}, customers: {}, getDb: mocks.getDb, invoices: {}, payments: {} }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  email: "owner@example.test",
  name: "Owner",
  permissions: new Set(["accounting.read", "accounting.write"]),
  allOrgIds: ["a5cb2579-9d6e-41ee-96d6-9af1c89bf250"],
  emailVerified: true,
};
const actionContext = {
  actor: {
    type: "human",
    id: resolved.userId,
    orgId: resolved.orgId,
    permissions: resolved.permissions,
  },
  now: new Date("2026-09-27T12:00:00.000Z"),
  services: {},
};

function request(body: unknown) {
  return new Request("http://localhost/api/banking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/banking Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_BANKING_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps banking writes on the TypeScript executor by default and preserves normalized input", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { bankAccountId: "bank-1" } });

    const response = await POST(request({ action: "addBankAccount", name: "Ops Account", balanceMinor: 500000 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { bankAccountId: "bank-1" } });
    expect(mocks.execute).toHaveBeenCalledWith(
      "accounting.addBankAccount",
      actionContext,
      { name: "Ops Account", currencyCode: undefined, last4: undefined, balanceMinor: 500000 },
    );
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "addBankAccount",
      body: { action: "addBankAccount", name: "Ops Account", currencyCode: "UGX", last4: "1234", balanceMinor: 500000 },
      capabilityId: "accounting.addBankAccount",
      input: { name: "Ops Account", currencyCode: "UGX", last4: "1234", balanceMinor: 500000 },
    },
    {
      name: "importBankFeed",
      body: { action: "importBankFeed", bankAccountId: "bank-1", rows: [{ postedAt: "2026-09-20", amountMinor: -45000, description: "Utility bill" }] },
      capabilityId: "accounting.importBankFeed",
      input: { bankAccountId: "bank-1", rows: [{ postedAt: "2026-09-20", amountMinor: -45000, description: "Utility bill" }] },
    },
    {
      name: "matchBankTransaction",
      body: { action: "matchBankTransaction", transactionId: "txn-1", entryId: "entry-1", amountMinor: 45000 },
      capabilityId: "accounting.matchBankTransaction",
      input: { transactionId: "txn-1", entryId: "entry-1" },
    },
    {
      name: "unmatchBankTransaction",
      body: { action: "unmatchBankTransaction", transactionId: "txn-1" },
      capabilityId: "accounting.unmatchBankTransaction",
      input: { transactionId: "txn-1" },
    },
    {
      name: "excludeBankTransaction",
      body: { action: "excludeBankTransaction", transactionId: "txn-1" },
      capabilityId: "accounting.excludeBankTransaction",
      input: { transactionId: "txn-1" },
    },
    {
      name: "unexcludeBankTransaction",
      body: { action: "unexcludeBankTransaction", transactionId: "txn-1" },
      capabilityId: "accounting.unexcludeBankTransaction",
      input: { transactionId: "txn-1" },
    },
    {
      name: "deleteBankTransaction",
      body: { action: "deleteBankTransaction", transactionId: "txn-1" },
      capabilityId: "accounting.deleteBankTransaction",
      input: { transactionId: "txn-1" },
    },
  ])("dispatches $name through the signed Go bridge when enabled", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_BANKING_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { done: true }, replayed: true }),
    });

    const response = await POST(request({ ...body, intentId: "bank-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { done: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("normalizes Go approvals and capability errors without retrying through TypeScript", async () => {
    vi.stubEnv("GO_BANKING_WRITES", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: accounting.write" }, { status: 403 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "transaction not found or already matched/excluded" }, { status: 422 }) });
    const matchRequest = () => request({ action: "unmatchBankTransaction", transactionId: "txn-1" });

    const pending = await POST(matchRequest());
    const unauthorized = await POST(matchRequest());
    const denied = await POST(matchRequest());
    const invalid = await POST(matchRequest());

    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ ok: false, error: "forbidden: missing permission: accounting.write" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ ok: false, error: "transaction not found or already matched/excluded" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_BANKING_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "addBankAccount", name: "Ops Account", balanceMinor: 500000 }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: "banking service unavailable; check transaction status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the Go dispatch throws", async () => {
    vi.stubEnv("GO_BANKING_WRITES", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request({ action: "excludeBankTransaction", transactionId: "txn-1" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "banking service unavailable; check transaction status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps writes behind authentication, onboarding, and body validation", async () => {
    vi.stubEnv("GO_BANKING_WRITES", "1");
    mocks.getResolvedUser.mockResolvedValue(null);
    const anonymous = await POST(request({ action: "addBankAccount", name: "Ops Account", balanceMinor: 0 }));
    expect(anonymous.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await POST(request({ action: "addBankAccount", name: "Ops Account", balanceMinor: 0 }));
    expect(onboarding.status).toBe(428);

    mocks.actorFromResolved.mockReturnValue(actionContext);
    const invalid = await POST(request({ action: "addBankAccount", balanceMinor: 0 }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "name is required" });
    const matchWithoutTarget = await POST(request({ action: "matchBankTransaction", transactionId: "txn-1" }));
    expect(matchWithoutTarget.status).toBe(400);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

});

