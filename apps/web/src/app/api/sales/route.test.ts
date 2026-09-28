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
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  permissions: new Set(["sales.read", "sales.write"]),
};
const actor = {
  type: "human",
  id: resolved.userId,
  orgId: resolved.orgId,
  permissions: resolved.permissions,
};
const actionContext = { actor, intentId: "order-intent-1" };
const customerId = "7a7b152e-7e80-496b-952c-275067fef54f";
const orderId = "f3c65071-356d-48e4-b5cb-cccd4fc06f6d";
const invoiceId = "229cda1d-0ad9-4198-bec0-58858b11610e";
const lines = [{ description: "Widget", quantity: 2, unitPriceMinor: 5000 }];

function request(body: unknown) {
  return new Request("http://localhost/api/sales", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Sales route migration adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_SALES_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.buildRegistry.mockReturnValue({ handle: "legacy-registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { orderId } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps all four order writes on the legacy executor when the flag is off", async () => {
    const requests = [
      { body: { action: "create", intentId: "order-intent-1", customerId, note: "Expedite", lines }, capId: "sales.createOrder", input: { customerId, note: "Expedite", lines } },
      { body: { action: "confirm", orderId, allowBackorder: true }, capId: "sales.confirmOrder", input: { orderId, allowBackorder: true } },
      { body: { action: "deliver", orderId }, capId: "sales.deliverOrder", input: { orderId, lines: undefined } },
      { body: { action: "cancel", orderId }, capId: "sales.cancelOrder", input: { orderId } },
    ];

    for (const { body, capId, input } of requests) {
      const response = await POST(request(body));
      expect(response.status).toBe(200);
      expect(mocks.execute).toHaveBeenLastCalledWith(capId, actionContext, input);
    }
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps order listing on the legacy executor even when the write flag is on", async () => {
    vi.stubEnv("GO_SALES_WRITE", "1");
    mocks.execute.mockResolvedValue({ ok: true, data: { orders: [] } });

    const response = await GET(new Request("http://localhost/api/sales?status=draft"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orders: [] });
    expect(mocks.execute).toHaveBeenCalledWith("sales.listOrders", actionContext, { status: "draft" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "create",
      body: { action: "create", intentId: "order-intent-1", customerId, note: "Expedite", lines },
      capabilityId: "sales.createOrder",
      input: { customerId, note: "Expedite", lines },
      data: { orderId, orderNumber: 42 },
    },
    {
      name: "confirm",
      body: { action: "confirm", orderId, allowBackorder: true },
      capabilityId: "sales.confirmOrder",
      input: { orderId, allowBackorder: true },
      data: { confirmed: true, backordered: true, reservedThousandths: 2000 },
    },
    {
      name: "deliver",
      body: { action: "deliver", orderId },
      capabilityId: "sales.deliverOrder",
      input: { orderId, lines: undefined },
      data: { invoiceId, invoiceNumber: 7, invoiceTotalMinor: 10000, orderStatus: "delivered" },
    },
    {
      name: "cancel",
      body: { action: "cancel", orderId },
      capabilityId: "sales.cancelOrder",
      input: { orderId },
      data: { status: "cancelled", releasedThousandths: 2000 },
    },
  ])("dispatches $name to Go with the exact legacy input when the flag is on", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_SALES_WRITE", "1");
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

  it("normalizes approval, auth, and capability errors to the legacy sales response shapes", async () => {
    vi.stubEnv("GO_SALES_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-approval-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: sales.write" }, { status: 403 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "order not found" }, { status: 422 }) });
    const confirmRequest = () => request({ action: "confirm", orderId });

    const pending = await POST(confirmRequest());
    const unauthorized = await POST(confirmRequest());
    const denied = await POST(confirmRequest());
    const invalid = await POST(confirmRequest());

    expect(pending.status).toBe(202);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await pending.json()).toEqual({ error: "Approval required", pendingApproval: true });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ error: "forbidden: missing permission: sales.write" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "order not found" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "not dispatched", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: { orderId: 42 } }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_SALES_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "create", customerId, lines }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "sales service unavailable; check order status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed if the Go dispatch throws", async () => {
    vi.stubEnv("GO_SALES_WRITE", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request({ action: "cancel", orderId }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "sales service unavailable; check order status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps order writes behind authentication, onboarding, and body validation", async () => {
    vi.stubEnv("GO_SALES_WRITE", "1");
    mocks.getResolvedUser.mockResolvedValue(null);
    const anonymous = await POST(request({ action: "cancel", orderId }));
    expect(anonymous.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await POST(request({ action: "cancel", orderId }));
    expect(onboarding.status).toBe(428);

    mocks.actorFromResolved.mockReturnValue(actionContext);
    const invalid = await POST(request({ action: "cancel", orderId: "not-a-uuid" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid body" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
