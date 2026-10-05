import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, orgBranding: {} }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
  hasPermissionFor: vi.fn(),
}));

import { POST } from "./route";

const resolved = {
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  permissions: new Set(["iam.admin"]),
};
const actionContext = { actor: { id: resolved.userId }, intentId: undefined };

function request(body: unknown): Request {
  return new Request("http://localhost/api/branding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/branding request parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { saved: true } });
  });

  it("strips unknown object keys before governed execution", async () => {
    const response = await POST(request({ accentColor: "#AABBCC", ignoredLegacyKey: true }));

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith("iam.setOrgBranding", actionContext, { accentColor: "#AABBCC" });
  });

  it("validates footer limits in UTF-16 code units", async () => {
    const valid = await POST(request({ invoiceFooter: "😀".repeat(150) }));
    expect(valid.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    const invalid = await POST(request({ invoiceFooter: "😀".repeat(151) }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid body" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects intent IDs with control characters or over 200 UTF-16 units", async () => {
    for (const intentId of ["bad\nintent", "x".repeat(201), "😀".repeat(101)]) {
      const response = await POST(request({ layout: "modern", intentId }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid body" });
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns pending approvals before mapping the executor's not-ok state to 422", async () => {
    mocks.execute.mockResolvedValue({ ok: false, pendingApproval: { rationale: "review needed" }, error: "pending human approval" });

    const response = await POST(request({ layout: "modern" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      pendingApproval: true,
      hint: "Branding changes proposed by the workmate wait for approval in the Approvals inbox.",
    });
  });
});
