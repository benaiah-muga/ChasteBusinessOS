import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getResolvedUser: vi.fn(), actorFromResolved: vi.fn(), buildExecutor: vi.fn(), buildRegistry: vi.fn(), execute: vi.fn(), getDb: vi.fn(), executeGoCapability: vi.fn() }));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), desc: vi.fn(), eq: vi.fn(), inArray: vi.fn(), isNotNull: vi.fn() }));
vi.mock("@chaste/db", () => ({ customers: {}, getDb: mocks.getDb, invoiceLines: {}, invoices: {}, payments: {}, posReturnLines: {}, posReturns: {}, posSessions: { id: "session.id", orgId: "session.org_id", status: "session.status" }, stockMovements: {} }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/route-guards", () => ({ missingPermission: vi.fn(() => null) }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", permissions: new Set(["pos.read", "pos.write", "pos.sell"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "pos-intent" };
const invoiceId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";

function request(body: unknown) {
  return new Request("http://localhost/api/pos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POS Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_POS_WRITES", "0");
    vi.stubEnv("GO_POS_SHIFT_SUMMARY_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ status: "open" }]) })) })) })),
    };
    mocks.getDb.mockReturnValue({ db });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { body: { action: "open", openingFloatMinor: 20000 }, capabilityId: "pos.openSession", input: { register: "main", openingFloatMinor: 20000 } },
    { body: { action: "sale", sessionId, method: "cash", lines: [{ description: "Mug", quantity: 1000, unitPriceMinor: 2500, sku: "MUG-1" }] }, capabilityId: "pos.completeSale", input: { sessionId, method: "cash", lines: [{ description: "Mug", quantity: 1000, unitPriceMinor: 2500, sku: "MUG-1", taxMinor: 0 }] } },
    { body: { action: "close", sessionId, countedCashMinor: 35000, varianceReason: "Drawer count" }, capabilityId: "pos.closeSession", input: { sessionId, countedCashMinor: 35000, varianceReason: "Drawer count" } },
    { body: { action: "returnSale", invoiceId, reason: "Damaged item", refundMethod: "cash", lines: [{ invoiceLineId: "55555555-5555-4555-8555-555555555555", quantity: 1000 }] }, capabilityId: "pos.returnSale", input: { invoiceId, reason: "Damaged item", refundMethod: "cash", lines: [{ invoiceLineId: "55555555-5555-4555-8555-555555555555", quantity: 1000 }] } },
    { body: { action: "shiftSummary", sessionId }, capabilityId: "pos.shiftSummary", input: { sessionId } },
  ])("dispatches $body.action to Go behind its flag", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_POS_WRITES", "1");
    const data = capabilityId === "pos.shiftSummary"
      ? { register: "main", status: "open", salesCount: 0, takingsMinor: 0, tenderTotals: [], refundTotals: [], expectedCashMinor: 0, countedCashMinor: null, varianceMinor: null }
      : { done: true };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data, replayed: true }) });
    const response = await POST(request({ ...body, intentId: "pos-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps POS session writes on TypeScript while the flag is off", async () => {
    await POST(request({ action: "open", openingFloatMinor: 20000 }));
    expect(mocks.execute).toHaveBeenCalledWith("pos.openSession", ctx, { openingFloatMinor: 20000 });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps shift summary reads on TypeScript while the Go read flag is off", async () => {
    await POST(request({ action: "shiftSummary", sessionId }));
    expect(mocks.execute).toHaveBeenCalledWith("pos.shiftSummary", ctx, { sessionId });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches only the shift summary read through Go behind its own flag", async () => {
    vi.stubEnv("GO_POS_SHIFT_SUMMARY_READS", "1");
    const data = {
      register: "main",
      status: "open",
      salesCount: 2,
      takingsMinor: 5500,
      tenderTotals: [{ method: "cash", amountMinor: 3500 }],
      refundTotals: [],
      expectedCashMinor: 3500,
      countedCashMinor: null,
      varianceMinor: null,
    };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data }) });

    const response = await POST(request({ action: "shiftSummary", sessionId, intentId: "pos-intent" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "pos.shiftSummary",
      input: { sessionId },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed Go shift summary without retrying through TypeScript", async () => {
    vi.stubEnv("GO_POS_SHIFT_SUMMARY_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { register: "main", status: "open" } }),
    });

    const response = await POST(request({ action: "shiftSummary", sessionId, intentId: "pos-intent" }));

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves the pending-approval response without exposing its internal ID", async () => {
    vi.stubEnv("GO_POS_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "Human approval required", approvalId: "private-id" }, { status: 202 }) });
    const response = await POST(request({ action: "returnSale", invoiceId, reason: "Damaged item", refundMethod: "cash" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Human approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("does not retry a sale via TypeScript on $kind", async (result) => {
    vi.stubEnv("GO_POS_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "sale", sessionId, lines: [{ description: "Mug", quantity: 1000, unitPriceMinor: 2500 }] }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
