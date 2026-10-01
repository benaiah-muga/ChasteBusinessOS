import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpensesApiError, fetchExpenses, submitExpenseAction } from "./expenses";

const claim = {
  id: "11111111-1111-4111-8111-111111111111",
  claimantUserId: "22222222-2222-4222-8222-222222222222",
  amountMinor: 12500,
  status: "submitted",
  memo: "Taxi to the client kickoff",
};

afterEach(() => {
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
});
