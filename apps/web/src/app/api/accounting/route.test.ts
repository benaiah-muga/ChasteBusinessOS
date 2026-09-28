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
vi.mock("drizzle-orm", () => ({ and: vi.fn(), asc: vi.fn(), desc: vi.fn(), eq: vi.fn(), sql: vi.fn() }));
vi.mock("@chaste/db", () => ({
  customers: {},
  getDb: mocks.getDb,
  invoices: {},
  journalEntries: {},
  journalLines: {},
  payments: {},
  periods: {},
  salesTaxFilings: {},
  organizations: {},
  vendorBills: {},
  vendors: {},
}));
vi.mock("@chaste/erp-core", () => ({ computeAging: vi.fn() }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
}));
vi.mock("@/server/balances", () => ({ documentOutstanding: vi.fn() }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/route-guards", () => ({ missingPermission: vi.fn(() => null) }));
vi.mock("@/server/unit-of-work", () => ({ executeAtomically: vi.fn() }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  email: "owner@example.test",
  name: "Owner",
  permissions: new Set(["accounting.read", "accounting.write", "accounting.post"]),
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
const invoiceId = "f3c65071-356d-48e4-b5cb-cccd4fc06f6d";
const entryId = "7a7b152e-7e80-496b-952c-275067fef54f";
const invoiceOutput = {
  invoiceId,
  invoiceNumber: 104,
  totalMinor: 125000,
  entryId,
  currency: "UGX",
};
const invoiceBody = {
  action: "createInvoice",
  intentId: "intent-invoice-1",
  customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f",
  memo: "September consulting",
  lines: [{ description: "Consulting", quantity: 1, unitPriceMinor: 125000 }],
  currency: "UGX",
  fxRate: "1.00",
  dueAt: "2026-10-27T00:00:00.000Z",
};
const invoiceInput = {
  customerId: invoiceBody.customerId,
  memo: invoiceBody.memo,
  lines: invoiceBody.lines,
  currency: invoiceBody.currency,
  fxRate: invoiceBody.fxRate,
  dueAt: invoiceBody.dueAt,
};

function request(body: unknown) {
  return new Request("http://localhost/api/accounting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/accounting Go invoice bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: invoiceOutput });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps invoice creation on TypeScript by default and preserves normalized input", async () => {
    delete process.env.GO_ACCOUNTING_CREATE_INVOICE;

    const response = await POST(request({ ...invoiceBody, memo: "", currency: "", fxRate: "" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: invoiceOutput });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.createInvoice", actionContext, {
      customerId: invoiceBody.customerId,
      memo: undefined,
      lines: invoiceBody.lines,
      currency: undefined,
      fxRate: undefined,
      dueAt: invoiceBody.dueAt,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches only invoice creation through the signed Go capability bridge when enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: invoiceOutput, replayed: true }),
    });

    const response = await POST(request(invoiceBody));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: invoiceOutput });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: {
        userId: resolved.userId,
        orgId: resolved.orgId,
        authSessionId: resolved.authSessionId,
      },
      capabilityId: "accounting.createInvoice",
      input: invoiceInput,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
  });

  it("normalizes Go approval responses to the public legacy shape", async () => {
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json(
        { ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-approval-id" },
        { status: 202 },
      ),
    });

    const response = await POST(request(invoiceBody));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves capability and permission errors in the legacy contract", async () => {
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "customer not found" }, { status: 422 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: accounting.write" }, { status: 403 }) });

    const capabilityFailure = await POST(request(invoiceBody));
    const permissionFailure = await POST(request(invoiceBody));

    expect(capabilityFailure.status).toBe(422);
    expect(await capabilityFailure.json()).toEqual({ ok: false, error: "customer not found" });
    expect(permissionFailure.status).toBe(422);
    expect(await permissionFailure.json()).toEqual({ ok: false, error: "forbidden: missing permission: accounting.write" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unknown write outcome", result: { kind: "outcome-unknown" } },
    { name: "missing Go dispatch configuration", result: { kind: "not-dispatched" } },
    { name: "malformed successful response", result: { kind: "response", response: Response.json({ ok: true, data: { invoiceId: 5 } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying the TypeScript invoice write", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(invoiceBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check invoice status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("keeps other accounting writes on TypeScript when invoice Go dispatch is enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "1");

    const response = await POST(request({ action: "reverse", entryId }));

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith("accounting.reverseEntry", actionContext, { entryId });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("rejects anonymous and incomplete invoice requests before either write backend", async () => {
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "1");
    mocks.getResolvedUser.mockResolvedValueOnce(null);

    const anonymous = await POST(request(invoiceBody));
    const missingLines = await POST(request({ ...invoiceBody, lines: [] }));

    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized" });
    expect(missingLines.status).toBe(400);
    expect(await missingLines.json()).toEqual({ error: "lines are required" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go quote and recurring template bridges", () => {
  const quoteId = "8c1e6f4a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
  const templateId = "9d2f7a5b-3c4e-4f6a-9b0c-1d2e3f4a5b6c";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "0");
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps quote and recurring template actions on their existing legacy behavior when the flags are off", async () => {
    const response = await POST(request({ action: "createQuote", customerId: invoiceBody.customerId, lines: invoiceBody.lines }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid action" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "createQuote",
      body: { action: "createQuote", intentId: "quote-intent-1", customerId: invoiceBody.customerId, memo: "Q4 pricing", expiresAt: "2026-10-31T23:59:59.999Z", lines: invoiceBody.lines },
      capabilityId: "accounting.createQuote",
      input: { customerId: invoiceBody.customerId, memo: "Q4 pricing", expiresAt: "2026-10-31T23:59:59.999Z", lines: invoiceBody.lines },
      data: { quoteId, quoteNumber: 12, totalMinor: 125000 },
    },
    {
      name: "acceptQuote",
      body: { action: "acceptQuote", quoteId },
      capabilityId: "accounting.acceptQuote",
      input: { quoteId },
      data: { invoiceId, invoiceNumber: 105, totalMinor: 125000 },
    },
    {
      name: "declineQuote",
      body: { action: "declineQuote", quoteId },
      capabilityId: "accounting.declineQuote",
      input: { quoteId },
      data: { status: "declined" },
    },
    {
      name: "expireQuote",
      body: { action: "expireQuote" },
      capabilityId: "accounting.expireQuote",
      input: {},
      data: { expiredCount: 3 },
    },
  ])("dispatches $name to Go when quote writes are enabled", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data, replayed: true }),
    });

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("normalizes quote approvals and capability errors to the legacy accounting shapes", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-approval-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: accounting.write" }, { status: 403 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "quote not found" }, { status: 422 }) });
    const declineRequest = () => request({ action: "declineQuote", quoteId });

    const pending = await POST(declineRequest());
    const unauthorized = await POST(declineRequest());
    const denied = await POST(declineRequest());
    const invalid = await POST(declineRequest());

    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ ok: false, error: "forbidden: missing permission: accounting.write" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ ok: false, error: "quote not found" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: { quoteId: 5 } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on quote $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "createQuote", customerId: invoiceBody.customerId, lines: invoiceBody.lines }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check quote status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed if a quote dispatch throws", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request({ action: "expireQuote" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check quote status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "createRecurringTemplate",
      body: { action: "createRecurringTemplate", intentId: "template-intent-1", customerId: invoiceBody.customerId, frequency: "monthly", memo: "Hosting", lines: invoiceBody.lines, firstRunAt: "2026-10-01T00:00:00.000Z" },
      capabilityId: "accounting.createRecurringTemplate",
      input: { customerId: invoiceBody.customerId, frequency: "monthly", memo: "Hosting", lines: invoiceBody.lines, firstRunAt: "2026-10-01T00:00:00.000Z" },
      data: { templateId, nextRunAt: "2026-10-01T00:00:00.000Z" },
    },
    {
      name: "pauseRecurringTemplate",
      body: { action: "pauseRecurringTemplate", templateId },
      capabilityId: "accounting.pauseRecurringTemplate",
      input: { templateId },
      data: { active: false },
    },
    {
      name: "resumeRecurringTemplate",
      body: { action: "resumeRecurringTemplate", templateId },
      capabilityId: "accounting.resumeRecurringTemplate",
      input: { templateId },
      data: { active: true },
    },
  ])("dispatches $name to Go when recurring writes are enabled", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data }),
    });

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("normalizes recurring approvals and fails closed on unknown outcomes", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "outcome-unknown" });
    const pauseRequest = () => request({ action: "pauseRecurringTemplate", templateId });

    const pending = await POST(pauseRequest());
    const unknown = await POST(pauseRequest());

    expect(pending.status).toBe(202);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toEqual({ error: "accounting service unavailable; check recurring template status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps the two accounting write flags independent of each other", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    const recurringWhileQuotesOnly = await POST(request({ action: "pauseRecurringTemplate", templateId }));
    expect(recurringWhileQuotesOnly.status).toBe(400);
    expect(await recurringWhileQuotesOnly.json()).toEqual({ error: "invalid action" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    const quoteWhileRecurringOnly = await POST(request({ action: "acceptQuote", quoteId }));
    expect(quoteWhileRecurringOnly.status).toBe(400);
    expect(await quoteWhileRecurringOnly.json()).toEqual({ error: "invalid action" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps quote writes behind authentication, onboarding, and body validation", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.getResolvedUser.mockResolvedValueOnce(null);
    const anonymous = await POST(request({ action: "createQuote", customerId: invoiceBody.customerId, lines: invoiceBody.lines }));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized" });

    mocks.actorFromResolved.mockReturnValueOnce(null);
    const onboarding = await POST(request({ action: "createQuote", customerId: invoiceBody.customerId, lines: invoiceBody.lines }));
    expect(onboarding.status).toBe(428);

    mocks.actorFromResolved.mockReturnValue(actionContext);
    const missingLines = await POST(request({ action: "createQuote", customerId: invoiceBody.customerId }));
    expect(missingLines.status).toBe(400);
    expect(await missingLines.json()).toEqual({ error: "invalid action" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
