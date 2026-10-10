import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPurchasingPaymentRunBills,
  fetchPurchasingPaymentRuns,
  readPendingPaymentRunAction,
  submitPurchasingPaymentRunAction,
  type PurchasingPaymentRunsApiError,
} from "./purchasing-payment-runs";

const run = {
  id: "11111111-1111-4111-8111-111111111111",
  reference: "PR-2026-0042",
  currency: "BHD",
  totalMinor: 1234,
  status: "draft",
  createdAt: "2026-09-29T08:15:00.000Z",
  instructedAt: null,
  confirmedAt: null,
  entryId: null,
  lines: [{
    billId: "33333333-3333-4333-8333-333333333333",
    billNumber: 17,
    vendorName: "Harbor Supplies",
    vendorRef: null,
    amountMinor: 1234,
  }],
};
const bill = {
  id: "33333333-3333-4333-8333-333333333333",
  number: 17,
  vendorName: "Harbor Supplies",
  vendorRef: "HS-17",
  currency: "BHD",
  dueMinor: 1234,
};
const scope = { actorId: "44444444-4444-4444-8444-444444444444", organizationId: "55555555-5555-4555-8555-555555555555" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubPaymentRunLocks(): void {
  const tails = new Map<string, Promise<void>>();
  const locks = {
    request: async <T>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release = (): void => {};
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, current);
      await previous;
      try { return await callback(); }
      finally {
        release();
        if (tails.get(name) === current) tails.delete(name);
      }
    },
  };
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { locks }));
}

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

beforeEach(stubPaymentRunLocks);

describe("Purchasing payment run Go API", () => {
  it("lists runs and eligible bills through their Go read capabilities", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: unknown; intentId: string };
      expect(init?.method).toBe("POST");
      expect(body.input).toEqual({});
      expect(body.intentId).toEqual(expect.any(String));
      return body.capabilityId === "purchasing.listPaymentRuns"
        ? jsonResponse({ ok: true, data: { runs: [run] } })
        : jsonResponse({ ok: true, data: { bills: [bill] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingPaymentRuns()).resolves.toEqual([run]);
    await expect(fetchPurchasingPaymentRunBills()).resolves.toEqual([bill]);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
  });

  it("rejects malformed Go read responses and does not use a compatibility route", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { bills: [{ ...bill, dueMinor: Number.MAX_SAFE_INTEGER + 1 }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPurchasingPaymentRunBills()).rejects.toMatchObject({ status: 200 } satisfies Partial<PurchasingPaymentRunsApiError>);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/api/purchasing"))).toBe(false);
  });

  it("retries a pending create with its exact intent after Go 404 and blocks selector-off rollback", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const action = { action: "create" as const, memo: "September payables", lines: [{ billId: bill.id, amountMinor: 900 }] };
    const intents: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
      intents.push(body.intentId);
      expect(body).toMatchObject({ capabilityId: "purchasing.createPaymentRun", input: { memo: action.memo, lines: action.lines } });
      if (intents.length === 1) return jsonResponse({ pendingApproval: true, reason: "Approval required." }, 202);
      if (intents.length === 2) return jsonResponse({ error: "capability not found" }, 404);
      return jsonResponse({ ok: true, data: { paymentRunId: run.id, reference: run.reference, currency: "BHD", totalMinor: 900, billCount: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPurchasingPaymentRunAction(action, scope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitPurchasingPaymentRunAction(action, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingPaymentRunAction(scope)).resolves.toEqual(action);
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", false);
    await expect(submitPurchasingPaymentRunAction(action, scope)).rejects.toMatchObject({ status: 503, requestMayHaveReachedServer: true });
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    await expect(submitPurchasingPaymentRunAction(action, scope)).resolves.toMatchObject({ kind: "success" });

    expect(intents).toHaveLength(3);
    expect(intents[1]).toBe(intents[0]);
    expect(intents[2]).toBe(intents[0]);
    expect(fetchMock.mock.calls.every(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });

  it("maps draft lifecycle and reversal actions to exact Go input/output contracts", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const seen: Array<{ capabilityId: string; input: Record<string, unknown>; intentId: string }> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
      seen.push(body);
      if (body.capabilityId === "purchasing.instructPaymentRun") return jsonResponse({ ok: true, data: { paymentRunId: run.id, reference: run.reference, currency: "BHD", totalMinor: 1234, entryId: "66666666-6666-4666-8666-666666666666", billCount: 1, status: "instructed" } });
      if (body.capabilityId === "purchasing.reversePaymentRun") return jsonResponse({ ok: true, data: { paymentRunId: run.id, reversalEntryId: "77777777-7777-4777-8777-777777777777", status: "reversed" } });
      return jsonResponse({ ok: true, data: { paymentRunId: run.id } });
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const action of [
      { action: "cancel" as const, paymentRunId: run.id },
      { action: "restore" as const, paymentRunId: run.id },
      { action: "instruct" as const, paymentRunId: run.id },
      { action: "reverse" as const, paymentRunId: run.id, reason: "Bank rejected the instruction" },
    ]) await expect(submitPurchasingPaymentRunAction(action, scope)).resolves.toMatchObject({ kind: "success" });

    expect(seen).toEqual([
      { capabilityId: "purchasing.cancelPaymentRunDraft", input: { paymentRunId: run.id }, intentId: expect.any(String) },
      { capabilityId: "purchasing.restorePaymentRunDraft", input: { paymentRunId: run.id }, intentId: expect.any(String) },
      { capabilityId: "purchasing.instructPaymentRun", input: { paymentRunId: run.id }, intentId: expect.any(String) },
      { capabilityId: "purchasing.reversePaymentRun", input: { paymentRunId: run.id, reason: "Bank rejected the instruction" }, intentId: expect.any(String) },
    ]);
  });

  it("serializes cross-tab payment run reservations for one actor and organization", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const action = { action: "create" as const, memo: "September payables", lines: [{ billId: bill.id, amountMinor: 900 }] };
    const alternateAction = { ...action, lines: [{ billId: bill.id, amountMinor: 800 }] };
    const fetchMock = vi.fn(async () => jsonResponse({ pendingApproval: true }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const outcomes = await Promise.allSettled([
      submitPurchasingPaymentRunAction(action, scope),
      submitPurchasingPaymentRunAction(alternateAction, scope),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([action, alternateAction]).toContainEqual(await readPendingPaymentRunAction(scope));
  });

  it("does not let a delayed success clear a newer payment run intent", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const action = { action: "create" as const, memo: "September payables", lines: [{ billId: bill.id, amountMinor: 900 }] };
    const nextAction = { ...action, lines: [{ billId: bill.id, amountMinor: 800 }] };
    const respond: Array<(response: Response) => void> = [];
    const intentIds: string[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      intentIds.push((JSON.parse(String(init?.body)) as { intentId: string }).intentId);
      return new Promise<Response>((resolve) => { respond.push(resolve); });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = submitPurchasingPaymentRunAction(action, scope);
    const duplicate = submitPurchasingPaymentRunAction(action, scope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(intentIds[1]).toBe(intentIds[0]);
    respond[0]?.(jsonResponse({ ok: true, data: { paymentRunId: run.id, reference: run.reference, currency: "BHD", totalMinor: 900, billCount: 1 } }));
    await expect(first).resolves.toMatchObject({ kind: "success" });

    const next = submitPurchasingPaymentRunAction(nextAction, scope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(intentIds[2]).not.toBe(intentIds[0]);
    respond[1]?.(jsonResponse({ ok: true, data: { paymentRunId: run.id, reference: run.reference, currency: "BHD", totalMinor: 900, billCount: 1 } }));
    await expect(duplicate).resolves.toMatchObject({ kind: "success" });
    await expect(readPendingPaymentRunAction(scope)).resolves.toEqual(nextAction);

    respond[2]?.(jsonResponse({ pendingApproval: true }, 202));
    await expect(next).resolves.toMatchObject({ kind: "pending" });
  });

  it("fails closed when browser-wide payment run locks are unavailable", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    vi.stubGlobal("navigator", {} as Navigator);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { paymentRunId: run.id } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPurchasingPaymentRunAction({ action: "cancel", paymentRunId: run.id }, scope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("cannot safely reserve a supplier payment run action"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});
