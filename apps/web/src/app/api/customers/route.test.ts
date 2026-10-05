import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(), actorFromResolved: vi.fn(), buildExecutor: vi.fn(), buildRegistry: vi.fn(),
  execute: vi.fn(), getDb: vi.fn(), executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), asc: vi.fn(), count: vi.fn(), eq: vi.fn(), isNotNull: vi.fn(), isNull: vi.fn(), lt: vi.fn(), lte: vi.fn(), max: vi.fn(), sql: vi.fn() }));
vi.mock("drizzle-orm/pg-core", () => ({ alias: vi.fn() }));
vi.mock("@chaste/db", () => ({ customers: {}, deals: {}, documents: {}, getDb: mocks.getDb, invoices: {}, quotes: {}, tasks: {}, users: {} }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/route-guards", () => ({ missingPermission: vi.fn() }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const user = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  authSessionId: "auth-session",
  permissions: new Set(["crm.write"]),
};
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "customer-intent" };
const customerId = "33333333-3333-4333-8333-333333333333";
const otherCustomerId = "44444444-4444-4444-8444-444444444444";

const mergeSnapshot = {
  customerId,
  email: null,
  phone: null,
  preferredContactMethod: "email",
  doNotContact: false,
  reminderOptOut: false,
  marketingOptOut: false,
  ownerUserId: null,
  tags: [],
  notes: null,
  creditLimitMinor: null,
  paymentTermDays: null,
  deactivatedAt: null,
  mergedIntoCustomerId: null,
  mergedAt: null,
};
const mergeOutput = {
  survivorCustomerId: customerId,
  duplicateCustomerId: otherCustomerId,
  previous: [mergeSnapshot, { ...mergeSnapshot, customerId: otherCustomerId }],
};

function request(body: unknown) {
  return new Request("http://localhost/api/customers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("customer Go write adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_CRM_CUSTOMER_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { customerId } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      body: { action: "create", name: "Ada Customer", email: "ada@example.test", phone: "+256700000000", preferredContactMethod: "phone", doNotContact: true },
      capabilityId: "crm.createCustomer",
      input: { name: "Ada Customer", email: "ada@example.test", phone: "+256700000000", preferredContactMethod: "phone", doNotContact: true },
      data: { customerId, duplicateWarning: null },
    },
    {
      body: { action: "deactivate", customerId },
      capabilityId: "crm.deactivateCustomer",
      input: { customerId },
      data: { deactivated: true },
    },
    {
      body: { action: "merge", survivorCustomerId: customerId, duplicateCustomerId: otherCustomerId },
      capabilityId: "crm.mergeCustomers",
      input: { survivorCustomerId: customerId, duplicateCustomerId: otherCustomerId },
      data: mergeOutput,
    },
    {
      body: { action: "undoMerge", ...mergeOutput },
      capabilityId: "crm.restoreCustomerMerge",
      input: mergeOutput,
      data: mergeOutput,
    },
    {
      body: { action: "updateProfile", customerIds: [customerId], name: "Ada Lovelace", addTags: ["priority"], notes: null },
      capabilityId: "crm.updateCustomerProfiles",
      input: { customerIds: [customerId], name: "Ada Lovelace", addTags: ["priority"], notes: null },
      data: { updatedCount: 1, previous: [{ customerId, ownerUserId: null, tags: [], notes: null, phone: null, preferredContactMethod: "email", doNotContact: false }] },
    },
  ])("dispatches $body.action to Go and preserves its public response", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_CRM_CUSTOMER_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data }) });
    const response = await POST(request({ ...body, intentId: "customer-intent" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext: ctx, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps customer writes on TypeScript while the flag is off", async () => {
    await POST(request({ action: "deactivate", customerId }));
    expect(mocks.execute).toHaveBeenCalledWith("crm.deactivateCustomer", ctx, { customerId });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("returns the legacy create success envelope consumed by postApi", async () => {
    const data = { customerId, duplicateWarning: null };
    mocks.execute.mockResolvedValue({ ok: true, data });

    const response = await POST(request({ action: "create", name: "Ada Customer" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.execute).toHaveBeenCalledWith("crm.createCustomer", ctx, {
      name: "Ada Customer",
      email: undefined,
      phone: undefined,
      preferredContactMethod: undefined,
      doNotContact: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("preserves approval-pending responses from Go", async () => {
    vi.stubEnv("GO_CRM_CUSTOMER_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required" }, { status: 202 }) });
    const response = await POST(request({ action: "deactivate", customerId }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
  });

  it.each([{ kind: "not-dispatched" }, { kind: "outcome-unknown" }])("fails closed without TypeScript retry on $kind", async (result) => {
    vi.stubEnv("GO_CRM_CUSTOMER_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "deactivate", customerId }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when Go returns a malformed action result", async () => {
    vi.stubEnv("GO_CRM_CUSTOMER_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { deactivated: "yes" } }) });
    const response = await POST(request({ action: "deactivate", customerId }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
