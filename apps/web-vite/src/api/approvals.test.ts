import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchApprovals, submitApprovalDecision } from "./approvals";

afterEach(() => vi.unstubAllGlobals());

describe("approvals API client", () => {
  it("reads the exact Go pending queue and history response", async () => {
    const payload = {
      approvals: [{
        id: "ad23b8f5-5c6b-4ff0-9fc0-e3c4dd0d155a",
        orgId: "3196834e-9b90-4a20-9263-a3391fdc4329",
        sessionId: null,
        requestedByUserId: "c0f4707d-1e6c-4627-9ce5-a80b7b95a16e",
        capabilityId: "crm.createCustomer",
        riskClass: "write",
        payload: { name: "Ada" },
        rationale: "Create a customer",
        status: "pending",
        decidedByUserId: null,
        decisionComment: null,
        expiresAt: null,
        decidedAt: null,
        createdAt: "2026-09-27T10:15:00.000Z",
        raisedBy: { name: "Ada Lovelace", kind: "human" },
        decidedBy: null,
        relatedDocuments: [],
      }],
      history: [],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchApprovals();

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/approvals", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("sends only the decision field accepted by the legacy route", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, status: "rejected" }));
    vi.stubGlobal("fetch", fetchMock);

    await submitApprovalDecision("approval 1", "reject");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/approvals?id=approval+1");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ decision: "reject" });
  });

  it("rejects a malformed Go inbox row and undeclared fields", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      approvals: [{ id: "approval-1", capabilityId: "crm.createCustomer", riskClass: "write", payload: {} }],
      history: [],
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchApprovals()).rejects.toMatchObject({ status: 200, message: "The approvals service returned data in an unexpected format." });

    const payload = {
      approvals: [{
        id: "ad23b8f5-5c6b-4ff0-9fc0-e3c4dd0d155a",
        orgId: "3196834e-9b90-4a20-9263-a3391fdc4329",
        sessionId: null,
        requestedByUserId: null,
        capabilityId: "crm.createCustomer",
        riskClass: "write",
        payload: {},
        rationale: null,
        status: "pending",
        decidedByUserId: null,
        decisionComment: null,
        expiresAt: null,
        decidedAt: null,
        createdAt: "2026-09-27T10:15:00.000Z",
        raisedBy: { name: "Visitor", kind: "human" },
        decidedBy: null,
        relatedDocuments: [],
        unexpected: true,
      }],
      history: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    await expect(fetchApprovals()).rejects.toMatchObject({ status: 200, message: "The approvals service returned data in an unexpected format." });
  });

  it("rejects undeclared fields in a successful Go decision response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, status: "rejected", internal: "unexpected" })));
    await expect(submitApprovalDecision("approval-1", "reject")).rejects.toMatchObject({
      status: 200,
      message: "The approvals service returned an unexpected decision response.",
    });
  });

  it("describes 422 as a held action that did not execute", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "The period is closed" }, { status: 422 })));

    await expect(submitApprovalDecision("approval-1", "approve")).rejects.toMatchObject({
      name: "ApprovalApiError",
      status: 422,
      message: "Approval execution failed. The action did not run. The accounting period is closed. Resolve the period issue and try again.",
    });
  });

  it("does not expose raw server details in an execution error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: false, error: "private-token-value <script>" }, { status: 422 })));

    await expect(submitApprovalDecision("approval-1", "approve")).rejects.toMatchObject({
      status: 422,
      message: "Approval execution failed. The action did not run. Review the action in the existing application, then try again.",
    });
  });

  it("keeps authentication failures explicit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));

    await expect(fetchApprovals()).rejects.toMatchObject({
      name: "ApprovalApiError",
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });
  });
});
