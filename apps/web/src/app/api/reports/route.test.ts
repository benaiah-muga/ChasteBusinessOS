import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  getDb: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
}));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));
vi.mock("@chaste/db", () => ({
  getDb: mocks.getDb,
  journalEntries: { currency: "currency", orgId: "orgId" },
  organizations: { baseCurrency: "baseCurrency", id: "id" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  sql: Object.assign(() => "sql", { raw: () => "sql" }),
}));

import { GET } from "./route";

const user = {
  userId: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  authSessionId: "session-1",
};

function success(data: Record<string, unknown>) {
  return { kind: "response", response: Response.json({ ok: true, data }) };
}

function configureDatabase() {
  const orgQuery = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue([{ baseCurrency: "UGX" }]),
  };
  orgQuery.from.mockReturnValue(orgQuery);
  orgQuery.where.mockReturnValue(orgQuery);
  const currencyQuery = {
    from: vi.fn(),
    where: vi.fn().mockResolvedValue([{ currency: "USD" }, { currency: "EUR" }]),
  };
  currencyQuery.from.mockReturnValue(currencyQuery);
  mocks.getDb.mockReturnValue({ db: {
    select: vi.fn().mockReturnValue(orgQuery),
    selectDistinct: vi.fn().mockReturnValue(currencyQuery),
  } });
}

describe("GET /api/reports Go bridge", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("GO_ACCOUNTING_REPORTS_READ", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue({ actor: { type: "human", id: user.userId } });
    configureDatabase();
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { revenueMinor: 10 } })
      .mockResolvedValueOnce({ ok: true, data: { assetsMinor: 20 } })
      .mockResolvedValueOnce({ ok: false, error: "cash flow unavailable" })
      .mockResolvedValueOnce({ ok: true, data: { exposures: [] } }) });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps the TypeScript executor as the default owner", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      baseCurrency: "UGX",
      unsupportedCurrencies: ["EUR", "USD"],
      pnl: { revenueMinor: 10 },
      balanceSheet: { assetsMinor: 20 },
      cashFlow: null,
      fxExposure: { exposures: [] },
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.buildExecutor).toHaveBeenCalledOnce();
  });

  it("dispatches all four read capabilities to Go and preserves the response", async () => {
    process.env.GO_ACCOUNTING_REPORTS_READ = "1";
    const reportData = [
      { revenueMinor: 10 },
      { assetsMinor: 20 },
      { netMinor: 30 },
      { exposures: [{ currency: "USD" }] },
    ];
    mocks.executeGoCapability.mockImplementation(({ capabilityId }: { capabilityId: string }) =>
      Promise.resolve(success(reportData[[
        "accounting.incomeStatement",
        "accounting.balanceSheet",
        "accounting.cashFlow",
        "accounting.unrealizedFxExposure",
      ].indexOf(capabilityId)] ?? {})));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      baseCurrency: "UGX",
      unsupportedCurrencies: ["EUR", "USD"],
      pnl: reportData[0],
      balanceSheet: reportData[1],
      cashFlow: reportData[2],
      fxExposure: reportData[3],
    });
    expect(mocks.executeGoCapability).toHaveBeenCalledTimes(4);
    expect(mocks.executeGoCapability.mock.calls.map(([input]) => input.capabilityId)).toEqual([
      "accounting.incomeStatement",
      "accounting.balanceSheet",
      "accounting.cashFlow",
      "accounting.unrealizedFxExposure",
    ]);
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
  });

  it("fails closed when a Go read is unavailable", async () => {
    process.env.GO_ACCOUNTING_REPORTS_READ = "1";
    mocks.executeGoCapability
      .mockResolvedValueOnce(success({ revenueMinor: 10 }))
      .mockResolvedValueOnce(success({ assetsMinor: 20 }))
      .mockResolvedValueOnce({ kind: "outcome-unknown" })
      .mockResolvedValueOnce(success({ exposures: [] }));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Accounting reports service unavailable" });
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
  });

  it("keeps required report errors fatal", async () => {
    process.env.GO_ACCOUNTING_REPORTS_READ = "1";
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "P&L failed" }, { status: 422 }) })
      .mockResolvedValueOnce(success({ assetsMinor: 20 }))
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "Cash flow failed" }, { status: 422 }) })
      .mockResolvedValueOnce(success({ exposures: [] }));

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "P&L failed" });
  });

  it("keeps optional report errors nullable", async () => {
    process.env.GO_ACCOUNTING_REPORTS_READ = "1";
    mocks.executeGoCapability
      .mockResolvedValueOnce(success({ revenueMinor: 10 }))
      .mockResolvedValueOnce(success({ assetsMinor: 20 }))
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "Cash flow failed" }, { status: 422 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "FX exposure failed" }, { status: 422 }) });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cashFlow: null, fxExposure: null });
  });
});
