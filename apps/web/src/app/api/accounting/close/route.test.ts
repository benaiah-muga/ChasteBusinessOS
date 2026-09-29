import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  missingPermission: vi.fn(),
  getDb: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  dispatchGoCapabilityRoute: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/route-guards", () => ({ missingPermission: mocks.missingPermission }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/go-route-response", () => ({ dispatchGoCapabilityRoute: mocks.dispatchGoCapabilityRoute }));

import { POST } from "./route";

const session = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  permissions: new Set(["accounting.post", "accounting.admin"]),
};
const actionContext = { actor: { type: "human", id: session.userId, orgId: session.orgId }, intentId: "fx-close-intent" };
const output = {
  revaluationId: "f3c65071-356d-48e4-b5cb-cccd4fc06f6d",
  entryId: "7a7b152e-7e80-496b-952c-275067fef54f",
  totalAdjustmentMinor: 15000,
  currencies: [{
    currency: "EUR",
    foreignMinor: 150000,
    historicalBaseMinor: 165000,
    closeBaseMinor: 180000,
    adjustmentMinor: 15000,
    rateNum: 12,
    rateDen: 10,
  }],
  alreadyReviewed: false,
};

function request(body: unknown) {
  return new Request("http://localhost/api/accounting/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("accounting FX revaluation Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_FX_REVALUATION_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_PERIOD_CLOSE_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(session);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.missingPermission.mockReturnValue(null);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: output });
    mocks.dispatchGoCapabilityRoute.mockResolvedValue(Response.json({ ok: true, data: output }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps revaluation on TypeScript by default", async () => {
    const response = await POST(request({ action: "revalue", year: 2026, month: 8, intentId: "fx-close-intent" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: output });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.revalueForeignReceivables", actionContext, { year: 2026, month: 8 });
    expect(mocks.dispatchGoCapabilityRoute).not.toHaveBeenCalled();
  });

  it("dispatches only the revaluation action through Go with its validated contract", async () => {
    vi.stubEnv("GO_ACCOUNTING_FX_REVALUATION_WRITE", "1");

    const response = await POST(request({ action: "revalue", year: 2026, month: 8, intentId: "fx-close-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: output });
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith({
      actionContext,
      session,
      capabilityId: "accounting.revalueForeignReceivables",
      input: { year: 2026, month: 8 },
    }, "accounting service unavailable; check FX rate status before retrying");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not let the FX flag opt period close actions into Go", async () => {
    vi.stubEnv("GO_ACCOUNTING_FX_REVALUATION_WRITE", "1");

    await POST(request({ action: "close", year: 2026, month: 8 }));

    expect(mocks.dispatchGoCapabilityRoute).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith("accounting.closePeriod", actionContext, { year: 2026, month: 8 });
  });

  it.each([
    ["incomplete currency rows", { ...output, currencies: [{ currency: "EUR" }] }],
    ["non-positive rate numerators", { ...output, currencies: [{ ...output.currencies[0], rateNum: 0 }] }],
    ["negative rate denominators", { ...output, currencies: [{ ...output.currencies[0], rateDen: -1 }] }],
    ["negative exposure amounts", { ...output, currencies: [{ ...output.currencies[0], foreignMinor: -1 }] }],
    ["invalid currency codes", { ...output, currencies: [{ ...output.currencies[0], currency: "EURO" }] }],
    ["invalid revaluation identifiers", { ...output, revaluationId: "not-a-uuid" }],
    ["unexpected fields", { ...output, extra: true }],
  ])("fails closed on %s without retrying through TypeScript", async (_label, data) => {
    vi.stubEnv("GO_ACCOUNTING_FX_REVALUATION_WRITE", "1");
    mocks.dispatchGoCapabilityRoute.mockResolvedValue(Response.json({ ok: true, data }));

    const response = await POST(request({ action: "revalue", year: 2026, month: 8 }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "accounting service unavailable; check FX rate status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { status: 202, body: { ok: false, pendingApproval: true, reason: "approval required" } },
    { status: 422, body: { ok: false, error: "no EUR/USD rate effective at period end" } },
  ])("preserves Go response status $status", async ({ status, body }) => {
    vi.stubEnv("GO_ACCOUNTING_FX_REVALUATION_WRITE", "1");
    mocks.dispatchGoCapabilityRoute.mockResolvedValue(Response.json(body, { status }));

    const response = await POST(request({ action: "revalue", year: 2026, month: 8 }));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("retains the accounting.post permission check before Go dispatch", async () => {
    vi.stubEnv("GO_ACCOUNTING_FX_REVALUATION_WRITE", "1");
    const denied = Response.json({ error: "forbidden" }, { status: 403 });
    mocks.missingPermission.mockReturnValue(denied);

    const response = await POST(request({ action: "revalue", year: 2026, month: 8 }));

    expect(response).toBe(denied);
    expect(mocks.missingPermission).toHaveBeenCalledWith(session, "accounting.post");
    expect(mocks.dispatchGoCapabilityRoute).not.toHaveBeenCalled();
  });
});
