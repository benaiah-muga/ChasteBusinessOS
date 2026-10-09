import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpensesApiError, fetchExpenses, readPendingExpenseAction, submitExpenseAction, type ExpenseAction } from "./expenses";

const claim = {
  id: "11111111-1111-4111-8111-111111111111",
  claimantUserId: "22222222-2222-4222-8222-222222222222",
  amountMinor: 12500,
  status: "submitted",
  memo: "Taxi to the client kickoff",
};
const scope = { actorId: "33333333-3333-4333-8333-333333333333", organizationId: "44444444-4444-4444-8444-444444444444" };

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Expenses API", () => {
  it("loads validated claims and policy limits through the same-origin session", async () => {
    const fetchMock = vi.fn(async () => Response.json({ claims: [claim], policies: [{ category: "travel", limitMinor: 25000 }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExpenses()).resolves.toEqual({ claims: [claim], policies: [{ category: "travel", limitMinor: 25000 }] });
    expect(fetchMock).toHaveBeenCalledWith("/api/expenses", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }));
  });

  it("rejects malformed read payloads and retains permission-denied responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ claims: [{ ...claim, amountMinor: 1.5 }], policies: [] })));
    await expect(fetchExpenses()).rejects.toMatchObject({ name: "ExpensesApiError", status: 200, message: expect.stringContaining("unexpected format") });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing expenses.decide" }, { status: 403 })));
    await expect(fetchExpenses()).rejects.toMatchObject({ name: "ExpensesApiError", status: 403, message: "forbidden: missing expenses.decide" });
  });

  it("submits integer minor units with an idempotent intent and validates success", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ action: "submit", amountMinor: 12500, memo: "Taxi", intentId: expect.any(String) });
      expect(payload.intentId).not.toBe("");
      return Response.json({ ok: true, data: { claimId: claim.id, status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: 25000 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitExpenseAction({ action: "submit", amountMinor: 12500, memo: "Taxi" })).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/expenses", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store" }));
  });

  it("surfaces pending approval without treating it as a completed action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "policy approval required", pendingApproval: true }, { status: 202 })));

    await expect(submitExpenseAction({ action: "pay", claimId: claim.id, amountMinor: 12500 })).resolves.toEqual({ kind: "pending", reason: "policy approval required" });
  });

  it("reuses the same intent ID when a write response is lost and the action is retried", async () => {
    const intentIds: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      intentIds.push((JSON.parse(String(init?.body)) as { intentId: string }).intentId);
      if (intentIds.length === 1) throw new TypeError("connection dropped");
      return Response.json({ ok: true, data: { claimId: claim.id, status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "submit" as const, amountMinor: 12501, memo: "retry identity proof" };

    await expect(submitExpenseAction(action)).rejects.toBeInstanceOf(ExpensesApiError);
    await expect(submitExpenseAction(action)).resolves.toMatchObject({ kind: "completed" });
    expect(intentIds[1]).toBe(intentIds[0]);
  });

  it("reports authorization and rejects malformed pending responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing accounting.post" }, { status: 403 })));
    await expect(submitExpenseAction({ action: "pay", claimId: claim.id, amountMinor: 12500 })).rejects.toMatchObject({ name: "ExpensesApiError", status: 403 });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "approval required" }, { status: 202 })));
    await expect(submitExpenseAction({ action: "pay", claimId: claim.id, amountMinor: 12500 })).rejects.toBeInstanceOf(ExpensesApiError);
  });

  it("loads claims and policies directly through their Go read capabilities", async () => {
    vi.stubGlobal("__GO_HR_EXPENSES__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { claims: [claim] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { policies: [{ category: "travel", limitMinor: 25000 }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExpenses()).resolves.toEqual({ claims: [claim], policies: [{ category: "travel", limitMinor: 25000 }] });
    expect(fetchMock.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
      ["/api/capabilities/execute", expect.objectContaining({ capabilityId: "accounting.listExpenseClaims", input: {}, intentId: expect.any(String) })],
      ["/api/capabilities/execute", expect.objectContaining({ capabilityId: "accounting.listExpensePolicies", input: {}, intentId: expect.any(String) })],
    ]);
  });

  it("maps all expense writes to Go capabilities with their exact input contracts", async () => {
    vi.stubGlobal("__GO_HR_EXPENSES__", true);
    const actions: Array<{ action: ExpenseAction; capabilityId: string; input: Record<string, unknown>; data: Record<string, unknown> }> = [
      { action: { action: "submit", amountMinor: 12500, memo: "Taxi", accountCode: "6900" }, capabilityId: "accounting.submitExpenseClaim", input: { amountMinor: 12500, memo: "Taxi", accountCode: "6900" }, data: { claimId: claim.id, status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null } },
      { action: { action: "decide", claimId: claim.id, decision: "approved" }, capabilityId: "accounting.decideExpenseClaim", input: { claimId: claim.id, decision: "approved" }, data: { claimId: claim.id, status: "approved" } },
      { action: { action: "pay", claimId: claim.id, amountMinor: 12500 }, capabilityId: "accounting.payExpenseClaim", input: { claimId: claim.id, amountMinor: 12500 }, data: { claimId: claim.id, entryId: "55555555-5555-4555-8555-555555555555", paidMinor: 12500 } },
      { action: { action: "setPolicy", category: "travel", limitMinor: 25000 }, capabilityId: "accounting.setExpensePolicy", input: { category: "travel", limitMinor: 25000 }, data: { set: true, category: "travel", limitMinor: 25000 } },
    ];
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string };
      const action = actions.find((candidate) => candidate.capabilityId === body.capabilityId);
      return Response.json({ ok: true, data: action?.data });
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const item of actions) {
      await expect(submitExpenseAction(item.action, undefined, scope)).resolves.toMatchObject({ kind: "completed", data: item.data });
    }
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(requests.map(({ capabilityId, input }) => ({ capabilityId, input }))).toEqual(actions.map(({ capabilityId, input }) => ({ capabilityId, input })));
    expect(requests.every((body) => typeof body.intentId === "string" && body.intentId.length > 30)).toBe(true);
  });

  it("matches Go memo and policy category length boundaries before sending a write", async () => {
    vi.stubGlobal("__GO_HR_EXPENSES__", true);
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: { category?: string } };
      return body.capabilityId === "accounting.submitExpenseClaim"
        ? Response.json({ ok: true, data: { claimId: claim.id, status: "submitted", category: "other", overPolicyLimit: false, policyLimitMinor: null } })
        : Response.json({ ok: true, data: { set: true, category: body.input.category, limitMinor: 25000 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const memo of ["ab", "x".repeat(501)]) {
      await expect(submitExpenseAction({ action: "submit", amountMinor: 1, memo }, undefined, scope))
        .rejects.toMatchObject({ status: 0, message: expect.stringContaining("3 and 500") });
    }
    for (const category of ["a", "x".repeat(41)]) {
      await expect(submitExpenseAction({ action: "setPolicy", category, limitMinor: 0 }, undefined, scope))
        .rejects.toMatchObject({ status: 0, message: expect.stringContaining("2 and 40") });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    for (const memo of ["abc", "x".repeat(500)]) {
      await expect(submitExpenseAction({ action: "submit", amountMinor: 1, memo }, undefined, scope)).resolves.toMatchObject({ kind: "completed" });
    }
    for (const category of ["ab", "x".repeat(40)]) {
      await expect(submitExpenseAction({ action: "setPolicy", category, limitMinor: 0 }, undefined, scope)).resolves.toMatchObject({ kind: "completed" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retains an actor/org-scoped exact retry through pending, Go 404, and selector rollback", async () => {
    vi.stubGlobal("__GO_HR_EXPENSES__", true);
    const action: ExpenseAction = { action: "pay", claimId: claim.id, amountMinor: 12500 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { claimId: claim.id, entryId: "55555555-5555-4555-8555-555555555555", paidMinor: 12500 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitExpenseAction(action, undefined, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingExpenseAction(scope)).resolves.toEqual(action);
    await expect(submitExpenseAction({ action: "setPolicy", category: "travel", limitMinor: 20000 }, undefined, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    await expect(submitExpenseAction(action, undefined, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });

    vi.stubGlobal("__GO_HR_EXPENSES__", false);
    await expect(submitExpenseAction(action, undefined, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("__GO_HR_EXPENSES__", true);
    await expect(submitExpenseAction(action, undefined, scope)).resolves.toMatchObject({ kind: "completed" });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string });
    expect(bodies.map((body) => body.intentId)).toEqual([bodies[0]?.intentId, bodies[0]?.intentId, bodies[0]?.intentId]);
    await expect(readPendingExpenseAction(scope)).resolves.toBeNull();
  });

  it("isolates pending expense actions between organizations and actors", async () => {
    vi.stubGlobal("__GO_HR_EXPENSES__", true);
    const action: ExpenseAction = { action: "pay", claimId: claim.id, amountMinor: 12500 };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "connection lost" }, { status: 503 })));
    await expect(submitExpenseAction(action, undefined, scope)).rejects.toMatchObject({ status: 503, requestMayHaveReachedServer: true });
    await expect(readPendingExpenseAction({ actorId: scope.actorId, organizationId: "66666666-6666-4666-8666-666666666666" })).resolves.toBeNull();
    await expect(readPendingExpenseAction({ actorId: "77777777-7777-4777-8777-777777777777", organizationId: scope.organizationId })).resolves.toBeNull();
  });
});
