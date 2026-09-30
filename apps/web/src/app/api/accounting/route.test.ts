import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  executeGoCapability: vi.fn(),
  dispatchGoCapabilityRoute: vi.fn(),
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
vi.mock("@/server/go-route-response", () => ({ dispatchGoCapabilityRoute: mocks.dispatchGoCapabilityRoute }));

import { GET, POST } from "./route";

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

function configureReadDatabase() {
  const rows = [
    [{ baseCurrency: "UGX" }],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  ];
  const terminals = ["limit", "limit", "orderBy", "where", "orderBy", "limit", "orderBy", "limit"];
  let queryIndex = 0;
  const query = (result: unknown[], terminal: string) => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"]) {
      builder[method] = vi.fn().mockImplementation(() => method === terminal ? Promise.resolve(result) : builder);
    }
    return builder;
  };
  mocks.getDb.mockReturnValue({ db: {
    select: vi.fn(() => {
      const index = queryIndex++;
      return query(rows[index] ?? [], terminals[index] ?? "limit");
    }),
  } });
}

const listedInvoice = {
  id: invoiceId,
  number: 104,
  customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f",
  customerName: "Example customer",
  status: "sent",
  currency: "UGX",
  totalMinor: 125000,
  paidMinor: 0,
  creditedMinor: 0,
  outstandingMinor: 125000,
  issuedAt: "2026-09-27T12:00:00.000Z",
};

describe("GET /api/accounting Go invoice read bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_INVOICE_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    configureReadDatabase();
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { invoices: [listedInvoice] } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps the governed TypeScript invoice read by default", async () => {
    delete process.env.GO_ACCOUNTING_INVOICE_READS;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.invoices).toEqual([listedInvoice]);
    expect(mocks.execute).toHaveBeenCalledWith("accounting.listInvoices", actionContext, { limit: 50 });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches only the invoice-list capability to Go and validates its output", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { invoices: [listedInvoice] } }),
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.invoices).toEqual([listedInvoice]);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: {
        userId: resolved.userId,
        orgId: resolved.orgId,
        authSessionId: resolved.authSessionId,
      },
      capabilityId: "accounting.listInvoices",
      input: { limit: 50 },
    });
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves invoice statuses accepted by the legacy capability contract", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_READS", "1");
    const legacyStatusInvoice = { ...listedInvoice, status: "legacyArchived" };
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { invoices: [legacyStatusInvoice] } }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).invoices).toEqual([legacyStatusInvoice]);
  });

  it("keeps a valid Go capability error equivalent to the legacy empty invoice list", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, error: "Invoice list unavailable" }, { status: 422 }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).invoices).toEqual([]);
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves the route permission response when Go denies the read", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ error: "membership or permission denied" }, { status: 403 }),
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden: missing accounting.read" });
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed without a TypeScript retry when the Go read is unavailable or malformed", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_READS", "1");
    mocks.executeGoCapability.mockResolvedValueOnce({ kind: "outcome-unknown" });
    const unavailable = await GET();
    expect(unavailable.status).toBe(503);

    configureReadDatabase();
    mocks.executeGoCapability.mockResolvedValueOnce({
      kind: "response",
      response: Response.json({ ok: true, data: { invoices: [{ id: "bad" }] } }),
    });
    const malformed = await GET();
    expect(malformed.status).toBe(503);
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

const customerStatementOutput = {
  currencies: [{
    currency: "UGX",
    openingBalanceMinor: 0,
    closingBalanceMinor: 80000,
    rows: [{
      date: "2026-09-27T12:00:00.000Z",
      kind: "invoice",
      ref: "Invoice #104",
      amountMinor: 80000,
      balanceMinor: 80000,
    }],
  }],
};

describe("POST /api/accounting Go customer statement read bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_CUSTOMER_STATEMENT_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: customerStatementOutput });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps customer statements on the TypeScript executor by default", async () => {
    delete process.env.GO_ACCOUNTING_CUSTOMER_STATEMENT_READS;

    const response = await POST(request({ action: "customerStatement", customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: customerStatementOutput });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.customerStatement", actionContext, {
      customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches the governed statement read and preserves its validated response", async () => {
    vi.stubEnv("GO_ACCOUNTING_CUSTOMER_STATEMENT_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: customerStatementOutput }),
    });

    const response = await POST(request({ action: "customerStatement", customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: customerStatementOutput });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: {
        userId: resolved.userId,
        orgId: resolved.orgId,
        authSessionId: resolved.authSessionId,
      },
      capabilityId: "accounting.customerStatement",
      input: { customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f" },
    });
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves valid capability errors and fails closed without a TypeScript retry", async () => {
    vi.stubEnv("GO_ACCOUNTING_CUSTOMER_STATEMENT_READS", "1");
    mocks.executeGoCapability.mockResolvedValueOnce({
      kind: "response",
      response: Response.json({ ok: false, error: "forbidden: missing permission: accounting.read" }, { status: 422 }),
    });
    const denied = await POST(request({ action: "customerStatement", customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f" }));
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ ok: false, error: "forbidden: missing permission: accounting.read" });

    mocks.executeGoCapability.mockResolvedValueOnce({ kind: "outcome-unknown" });
    const unavailable = await POST(request({ action: "customerStatement", customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f" }));
    expect(unavailable.status).toBe(503);

    mocks.executeGoCapability.mockResolvedValueOnce({
      kind: "response",
      response: Response.json({ ok: true, data: { currencies: [{ currency: "UGX", rows: [{ amountMinor: 3.5 }] }] } }),
    });
    const malformed = await POST(request({ action: "customerStatement", customerId: "d00d512e-ab21-4f45-9199-f53d81e9597f" }));
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({ error: "accounting customer statement unavailable; reload before retrying" });
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go invoice bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "0");
    vi.stubEnv("GO_ACCOUNTING_PERIOD_CLOSE_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: invoiceOutput });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
    mocks.dispatchGoCapabilityRoute.mockResolvedValue(Response.json({ ok: true, data: { closed: true } }));
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

describe("POST /api/accounting Go invoice ops bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "0");
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_INVOICE_OPS_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("dispatches credit notes and entry reversals through the signed Go bridge when enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_OPS_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: true, data: { entryId: "entry-1", creditedMinor: 25000, invoiceBalanceMinor: 125000 }, replayed: true }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: true, data: { reversalEntryId: "entry-2" } }) });

    const credit = await POST(request({ action: "creditNote", invoiceId: "inv-1", amountMinor: 25000, reason: "Damaged goods" }));
    expect(credit.status).toBe(200);
    expect(await credit.json()).toEqual({ ok: true, data: { entryId: "entry-1", creditedMinor: 25000, invoiceBalanceMinor: 125000 } });
    expect(mocks.executeGoCapability).toHaveBeenNthCalledWith(1, {
      actionContext,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      capabilityId: "accounting.creditNote",
      input: { invoiceId: "inv-1", amountMinor: 25000, reason: "Damaged goods" },
    });

    const reversal = await POST(request({ action: "reverse", entryId: "entry-1" }));
    expect(reversal.status).toBe(200);
    expect(await reversal.json()).toEqual({ ok: true, data: { reversalEntryId: "entry-2" } });
    expect(mocks.executeGoCapability).toHaveBeenNthCalledWith(2, {
      actionContext,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      capabilityId: "accounting.reverseEntry",
      input: { entryId: "entry-1" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps invoice ops on TypeScript while the flag is off", async () => {
    await POST(request({ action: "creditNote", invoiceId: "inv-1", amountMinor: 25000, reason: "Damaged goods" }));
    expect(mocks.execute).toHaveBeenCalledWith("accounting.creditNote", actionContext, {
      invoiceId: "inv-1", amountMinor: 25000, reason: "Damaged goods",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("normalizes Go approval requests without retrying through TypeScript", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_OPS_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-id" }, { status: 202 }),
    });
    const response = await POST(request({ action: "reverse", entryId: "entry-1" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the Go outcome cannot be confirmed", async () => {
    vi.stubEnv("GO_ACCOUNTING_INVOICE_OPS_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
    const response = await POST(request({ action: "creditNote", invoiceId: "inv-1", amountMinor: 25000, reason: "Damaged goods" }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go year close bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_PERIOD_CLOSE_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { closed: true } });
    mocks.dispatchGoCapabilityRoute.mockResolvedValue(Response.json({ ok: true, data: { closed: true } }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("bridges only closeYear when the shared period-close flag is enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_PERIOD_CLOSE_WRITES", "1");
    const response = await POST(request({ action: "closeYear", year: 2025 }));
    expect(response.status).toBe(200);
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "accounting.closeYear",
      input: { year: 2025 },
    }, expect.stringContaining("year close status"));
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go tax return bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "0");
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_INVOICE_OPS_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_TAX_RETURNS_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("dispatches sales tax return filing through the signed Go bridge when enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_TAX_RETURNS_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { filingId: "filing-1", taxReturnId: "return-1", entryId: "entry-9", taxMinor: -25000 } }),
    });

    const response = await POST(request({ action: "fileSalesTaxReturn", taxReturnId: "return-1" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { filingId: "filing-1", taxReturnId: "return-1", entryId: "entry-9", taxMinor: -25000 },
    });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      capabilityId: "accounting.fileSalesTaxReturn",
      input: { taxReturnId: "return-1" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps filing on TypeScript while the flag is off", async () => {
    await POST(request({ action: "fileSalesTaxReturn", taxReturnId: "return-1" }));
    expect(mocks.execute).toHaveBeenCalledWith("accounting.fileSalesTaxReturn", actionContext, { taxReturnId: "return-1" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("fails closed when the Go outcome cannot be confirmed", async () => {
    vi.stubEnv("GO_ACCOUNTING_TAX_RETURNS_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "outcome-unknown" });
    const response = await POST(request({ action: "fileSalesTaxReturn", taxReturnId: "return-1" }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go payment bridge", () => {
  const paymentId = "d02aa498-07c6-451b-bc24-4b7d1ac19523";
  const paymentEntryId = "a1b8d329-9e2d-4e67-a4d6-356e9fd402bb";
  const paymentBody = { action: "recordPayment", invoiceNumber: 104, amountMinor: 50000 };
  const paymentOutput = { paymentId, entryId: paymentEntryId, fullyPaid: false };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: paymentOutput });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps payment recording on TypeScript by default and preserves FX input mapping", async () => {
    delete process.env.GO_ACCOUNTING_RECORD_PAYMENT_WRITE;

    const response = await POST(request({ ...paymentBody, method: "cash", fxRate: "1.25" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: paymentOutput });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.recordPayment", actionContext, {
      invoiceNumber: 104,
      amountMinor: 50000,
      method: "cash",
      settleFxRate: "1.25",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches payment recording through the signed Go bridge and validates its output", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: paymentOutput, replayed: true }),
    });

    const response = await POST(request({ ...paymentBody, fxRate: "1.25" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: paymentOutput });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      capabilityId: "accounting.recordPayment",
      input: {
        invoiceNumber: 104,
        amountMinor: 50000,
        method: "bank_transfer",
        settleFxRate: "1.25",
      },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("normalizes Go approval without retrying the TypeScript write", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-id" }, { status: 202 }),
    });

    const response = await POST(request(paymentBody));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed payment output", result: { kind: "response", response: Response.json({ ok: true, data: { ...paymentOutput, paymentId: "invalid" } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(paymentBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check payment status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go FX rate bridge", () => {
  const rateBody = {
    action: "recordFxRate",
    quoteCurrency: "EUR",
    rate: "1.2500",
    effectiveAt: "2026-09-27T12:00:00.000Z",
  };
  const rateOutput = {
    rateId: "bcdab99d-9220-46f0-8fb9-327246732012",
    num: 5,
    den: 4,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_FX_RATE_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: rateOutput });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps FX rate recording on TypeScript by default", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "1");

    const response = await POST(request(rateBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: rateOutput });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.recordFxRate", actionContext, {
      quoteCurrency: "EUR",
      rate: "1.2500",
      effectiveAt: "2026-09-27T12:00:00.000Z",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches FX rate recording through Go and validates the output shape", async () => {
    vi.stubEnv("GO_ACCOUNTING_FX_RATE_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: rateOutput, replayed: true }),
    });

    const response = await POST(request(rateBody));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: rateOutput });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      capabilityId: "accounting.recordFxRate",
      input: {
        quoteCurrency: "EUR",
        rate: "1.2500",
        effectiveAt: "2026-09-27T12:00:00.000Z",
      },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("preserves legacy approval and capability error response shapes", async () => {
    vi.stubEnv("GO_ACCOUNTING_FX_RATE_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, error: "invalid rate; use a positive decimal like 1.0875" }, { status: 422 }),
      })
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, error: "forbidden: missing permission: accounting.post" }, { status: 422 }),
      });

    const pending = await POST(request(rateBody));
    const invalid = await POST(request(rateBody));
    const forbidden = await POST(request(rateBody));

    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ ok: false, error: "invalid rate; use a positive decimal like 1.0875" });
    expect(forbidden.status).toBe(422);
    expect(await forbidden.json()).toEqual({ ok: false, error: "forbidden: missing permission: accounting.post" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed output", result: { kind: "response", response: Response.json({ ok: true, data: { ...rateOutput, den: "4" } }) } },
    { name: "fractional output", result: { kind: "response", response: Response.json({ ok: true, data: { ...rateOutput, num: 1.5 } }) } },
    { name: "nonpositive output", result: { kind: "response", response: Response.json({ ok: true, data: { ...rateOutput, den: 0 } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_FX_RATE_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(rateBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check FX rate status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("fails closed if the FX rate Go dispatch throws", async () => {
    vi.stubEnv("GO_ACCOUNTING_FX_RATE_WRITE", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request(rateBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check FX rate status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go payment reversal bridge", () => {
  const paymentId = "22345678-1234-4234-8234-123456789abc";
  const reversalEntryId = "32345678-1234-4234-8234-123456789abc";
  const reverseBody = { action: "reversePayment", paymentId, reason: "Duplicate settlement" };
  const reversalOutput = {
    reversalEntryIds: [reversalEntryId],
    refundedMinor: 50000,
    invoiceNumber: 104,
    outstandingMinor: 125000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_REVERSE_PAYMENT_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: reversalOutput });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps payment reversals on TypeScript by default", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECORD_PAYMENT_WRITE", "1");

    const response = await POST(request(reverseBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: reversalOutput });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.reversePayment", actionContext, { paymentId, reason: "Duplicate settlement" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches payment reversal through the signed Go bridge with validated output", async () => {
    vi.stubEnv("GO_ACCOUNTING_REVERSE_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: reversalOutput, replayed: true }),
    });

    const response = await POST(request(reverseBody));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: reversalOutput });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      capabilityId: "accounting.reversePayment",
      input: { paymentId, reason: "Duplicate settlement" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("preserves approval, capability, permission, and membership error mappings", async () => {
    vi.stubEnv("GO_ACCOUNTING_REVERSE_PAYMENT_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Payment reversals require approval", approvalId: "private-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, error: "payment has already been reversed" }, { status: 422 }),
      })
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, error: "forbidden: missing permission: accounting.post" }, { status: 422 }),
      })
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ error: "forbidden" }, { status: 403 }),
      });

    const pending = await POST(request(reverseBody));
    const rejected = await POST(request(reverseBody));
    const permissionDenied = await POST(request(reverseBody));
    const membershipDenied = await POST(request(reverseBody));

    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Payment reversals require approval" });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({ ok: false, error: "payment has already been reversed" });
    expect(permissionDenied.status).toBe(422);
    expect(await permissionDenied.json()).toEqual({ ok: false, error: "forbidden: missing permission: accounting.post" });
    expect(membershipDenied.status).toBe(422);
    expect(await membershipDenied.json()).toEqual({ ok: false, error: "forbidden" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed output", result: { kind: "response", response: Response.json({ ok: true, data: { ...reversalOutput, refundedMinor: 50000.5 } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_REVERSE_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(reverseBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check payment reversal status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("fails closed if the payment reversal Go dispatch throws", async () => {
    vi.stubEnv("GO_ACCOUNTING_REVERSE_PAYMENT_WRITE", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request(reverseBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check payment reversal status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounting Go reminders bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_CREATE_INVOICE", "0");
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_INVOICE_OPS_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_TAX_RETURNS_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_REMINDERS_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { reminders: [] } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("dispatches reminder building through the signed Go bridge when enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_REMINDERS_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { reminders: [{ invoiceId: "inv-1" }] } }),
    });

    const response = await POST(request({ action: "buildReminders" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { reminders: [{ invoiceId: "inv-1" }] } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      capabilityId: "accounting.buildReminders",
      input: {},
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps reminder building on TypeScript while the flag is off", async () => {
    await POST(request({ action: "buildReminders" }));
    expect(mocks.execute).toHaveBeenCalledWith("accounting.buildReminders", actionContext, {});
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("fails closed when the Go outcome cannot be confirmed", async () => {
    vi.stubEnv("GO_ACCOUNTING_REMINDERS_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "outcome-unknown" });
    const response = await POST(request({ action: "buildReminders" }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
