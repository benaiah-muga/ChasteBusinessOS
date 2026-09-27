import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  getDb: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  hasPermissionFor: vi.fn(),
  actorFromResolved: vi.fn(),
  decideApproval: vi.fn(),
  decideGoApproval: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  desc: (column: unknown) => column,
  eq: (left: unknown, right: unknown) => [left, right],
  inArray: (column: unknown, values: unknown[]) => [column, values],
}));

vi.mock("@chaste/db", () => ({
  approvals: { id: "approvals.id", orgId: "approvals.orgId", capabilityId: "approvals.capabilityId", payload: "approvals.payload", status: "approvals.status", createdAt: "approvals.createdAt", decidedAt: "approvals.decidedAt", requestedByUserId: "approvals.requestedByUserId", decidedByUserId: "approvals.decidedByUserId", sessionId: "approvals.sessionId" },
  documents: { id: "documents.id", orgId: "documents.orgId", title: "documents.title" },
  users: { id: "users.id", name: "users.name", email: "users.email" },
  getDb: mocks.getDb,
}));

vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
  hasPermissionFor: mocks.hasPermissionFor,
}));

vi.mock("@/server/approvals", () => ({ decideApproval: mocks.decideApproval }));
vi.mock("@/server/go-bridge", () => ({ decideGoApproval: mocks.decideGoApproval }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));

import { POST } from "./route";

const approvalId = "8201e7d5-0a84-4f53-8a7c-470b0aaf47c8";
const actor = {
  actor: {
    type: "human",
    id: "64f0d8af-4b2b-48dc-92d1-1c736ca5ef59",
    orgId: "d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5",
    permissions: new Set(["accounting.post"]),
  },
  now: new Date("2026-09-27T00:00:00.000Z"),
  services: {},
};
const resolved = {
  userId: actor.actor.id,
  email: "approver@example.test",
  name: "Approver",
  orgId: actor.actor.orgId,
  permissions: actor.actor.permissions,
  authSessionId: "better-auth-session-1",
  emailVerified: true,
  allOrgIds: [actor.actor.orgId],
};
const storedPayload = { invoiceNumber: 17, amountMinor: 50_001, method: "bank_transfer" };

function setApprovalLookup(row: { capabilityId: string; payload: unknown } | undefined) {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  const db = { select: vi.fn(() => query) };
  mocks.getDb.mockReturnValue({ db });
  return { db, query };
}

function decisionRequest(decision: "approve" | "reject" = "approve", comment?: string) {
  return new Request(`http://localhost/api/approvals?id=${approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, ...(comment === undefined ? {} : { comment }) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GO_APPROVAL_DECISION", "0");
  mocks.getResolvedUser.mockResolvedValue(resolved);
  mocks.actorFromResolved.mockReturnValue(actor);
  mocks.buildRegistry.mockReturnValue({});
  mocks.buildExecutor.mockReturnValue({});
  mocks.decideApproval.mockResolvedValue({ ok: true, status: "executed", result: { ok: true, data: { id: "payment-1" } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/approvals", () => {
  it("keeps the existing TypeScript decision path as the default", async () => {
    const { db } = setApprovalLookup({ capabilityId: "accounting.recordPayment", payload: storedPayload });
    const response = await POST(decisionRequest("approve", "Checked"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "executed", result: { ok: true, data: { id: "payment-1" } } });
    expect(mocks.decideApproval).toHaveBeenCalledOnce();
    expect(mocks.decideGoApproval).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("signs the active human and exact stored payload for the opt-in Go decision", async () => {
    vi.stubEnv("GO_APPROVAL_DECISION", "1");
    const { query } = setApprovalLookup({ capabilityId: "accounting.recordPayment", payload: storedPayload });
    mocks.decideGoApproval.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, status: "executed", result: { ok: true, data: { id: "payment-1" } } }),
    });

    const response = await POST(decisionRequest("approve", "Checked"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "executed", result: { ok: true, data: { id: "payment-1" } } });
    expect(query.limit).toHaveBeenCalledOnce();
    expect(mocks.decideGoApproval).toHaveBeenCalledWith({
      actionContext: actor,
      session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
      approvalId,
      capabilityId: "accounting.recordPayment",
      input: storedPayload,
      decision: "approve",
      comment: "Checked",
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("returns not found for approvals outside the active organization", async () => {
    vi.stubEnv("GO_APPROVAL_DECISION", "1");
    setApprovalLookup(undefined);

    const response = await POST(decisionRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "not found" });
    expect(mocks.decideGoApproval).not.toHaveBeenCalled();
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("fails closed after an unknown Go outcome without retrying in TypeScript", async () => {
    vi.stubEnv("GO_APPROVAL_DECISION", "1");
    setApprovalLookup({ capabilityId: "accounting.recordPayment", payload: storedPayload });
    mocks.decideGoApproval.mockResolvedValue({ kind: "outcome-unknown" });

    const response = await POST(decisionRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "approval decision outcome unknown; refresh before retrying" });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("fails closed when the Go decision service is not configured", async () => {
    vi.stubEnv("GO_APPROVAL_DECISION", "1");
    setApprovalLookup({ capabilityId: "accounting.recordPayment", payload: storedPayload });
    mocks.decideGoApproval.mockResolvedValue({ kind: "not-dispatched" });

    const response = await POST(decisionRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "approval decision service unavailable" });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });
});
