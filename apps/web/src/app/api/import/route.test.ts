import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  hasPermission: vi.fn(),
  checkRateLimit: vi.fn(),
  setOnboardingStep: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@chaste/kernel", () => ({ hasPermission: mocks.hasPermission }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/server/onboarding", () => ({ setOnboardingStep: mocks.setOnboardingStep }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const user = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  permissions: new Set(["crm.write"]),
};
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "import-intent" };

function request(body: unknown) {
  return new Request("http://localhost/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("customer import Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_CRM_IMPORT_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.buildRegistry.mockReturnValue({});
    mocks.execute.mockResolvedValue({ ok: true, data: { imported: 1, createdIds: ["33333333-3333-4333-8333-333333333333"], skippedDuplicateRows: [] } });
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.hasPermission.mockReturnValue(true);
    mocks.checkRateLimit.mockReturnValue({ allowed: true });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the legacy customer import path when its flag is off", async () => {
    const response = await POST(request({ entity: "customers", rows: [{ name: "Acme", creditLimit: "12.50" }] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      inserted: 1,
      skippedDuplicates: 0,
      skippedDuplicateRows: [],
      errors: [],
      createdIds: ["33333333-3333-4333-8333-333333333333"],
    });
    expect(mocks.execute).toHaveBeenCalledWith("crm.importCustomers", ctx, {
      rows: [{ rowNumber: 2, name: "Acme", creditLimitMinor: 1250, paymentTermDays: null, allowDuplicate: false }],
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches prepared customer rows and preserves import result and row errors", async () => {
    vi.stubEnv("GO_CRM_IMPORT_WRITES", "1");
    const createdId = "33333333-3333-4333-8333-333333333333";
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({
      ok: true,
      data: { createdIds: [createdId], imported: 1, skippedDuplicateRows: [4] },
    }) });

    const response = await POST(request({
      entity: "customers",
      rows: [
        { rowNumber: 3, name: "Acme", email: "a@example.test", creditLimit: "12.50", paymentTermDays: "30.9" },
        { rowNumber: 4, name: "Bad credit", creditLimit: "1.234" },
      ],
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      inserted: 1,
      skippedDuplicates: 1,
      skippedDuplicateRows: [4],
      errors: [{ row: 4, field: "creditLimit", message: '"1.234" is not a valid non-negative amount with at most two decimals.' }],
      createdIds: [createdId],
    });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "crm.importCustomers",
      input: { rows: [{ rowNumber: 3, name: "Acme", email: "a@example.test", creditLimitMinor: 1250, paymentTermDays: 30, allowDuplicate: false }] },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("dispatches customer undo and preserves the remaining count", async () => {
    vi.stubEnv("GO_CRM_IMPORT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { customerIds: ["33333333-3333-4333-8333-333333333333"], deactivated: 1 } }) });

    const response = await POST(request({ entity: "customers", action: "undo", importIds: [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ undone: 1, remaining: 1 });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "crm.undoCustomerImport",
      input: { customerIds: ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"] },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("fails closed for customer undo on $kind without a TypeScript write retry", async (result) => {
    vi.stubEnv("GO_CRM_IMPORT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ entity: "customers", action: "undo", importIds: ["33333333-3333-4333-8333-333333333333"] }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("fails closed on $kind without a TypeScript write retry", async (result) => {
    vi.stubEnv("GO_CRM_IMPORT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ entity: "customers", rows: [{ name: "Acme" }] }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps approval-required customer imports to the existing pending response", async () => {
    vi.stubEnv("GO_CRM_IMPORT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "identity approval required" }, { status: 202 }) });

    const response = await POST(request({ entity: "customers", rows: [{ name: "Acme" }] }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ error: "identity approval required", pendingApproval: true });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps Go permission denials to the legacy validation status", async () => {
    vi.stubEnv("GO_CRM_IMPORT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ error: "forbidden: missing permission: crm.write" }, { status: 403 }) });

    const response = await POST(request({ entity: "customers", rows: [{ name: "Acme" }] }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "forbidden: missing permission: crm.write", code: "invalid" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
