import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchInventoryValuationEntries,
  readPendingInventoryValuationAction,
  submitInventoryValuationAction,
} from "./inventory-valuation";

const scope = { actorId: "actor-valuation-test", organizationId: "10000000-0000-4000-8000-000000000001" };
const postedEntryId = "20000000-0000-4000-8000-000000000002";
const reversalEntryId = "30000000-0000-4000-8000-000000000003";

function executeResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function installLocks() {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name: string, _options: unknown, callback: () => unknown) => callback() },
  });
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Go inventory valuation client", () => {
  it("loads recent entries and strictly validates the journal projection", async () => {
    const entry = {
      id: postedEntryId,
      memo: "Inventory valuation summary",
      sourceType: "inventory-valuation",
      reversalOfId: null,
      postedAt: "2026-10-14T10:00:00Z",
      actorType: "human",
      currency: "UGX",
      amountMinor: 2500,
      debitMinor: 2500,
    };
    const fetchMock = vi.fn().mockResolvedValue(executeResponse({ ok: true, data: { entries: [entry] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInventoryValuationEntries(scope.organizationId)).resolves.toEqual([entry]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Organization-ID": scope.organizationId }),
      body: expect.stringContaining('"capabilityId":"accounting.overview"'),
    }));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(executeResponse({ ok: true, data: { entries: [{ ...entry, unexpected: true }] } })));
    await expect(fetchInventoryValuationEntries(scope.organizationId)).rejects.toThrow("unexpected format");
  });

  it("treats zero variance as a successful no-op without retaining an attempt", async () => {
    installLocks();
    const fetchMock = vi.fn().mockResolvedValue(executeResponse({ ok: true, data: {
      posted: false, entryId: null, varianceMinor: 0, ledgerValueMinor: 900, glBalanceMinor: 900,
    } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitInventoryValuationAction({ action: "post", memo: "Reconcile October stock" }, scope)).resolves.toMatchObject({
      kind: "completed", data: { posted: false, entryId: null, varianceMinor: 0 },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "inventory.postValuationSummary", input: { memo: "Reconcile October stock" } });
    await expect(readPendingInventoryValuationAction(scope)).resolves.toBeNull();
  });

  it("preserves approval pending as a recoverable action", async () => {
    installLocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(executeResponse({ ok: false, pendingApproval: true, reason: "Manager approval required" }, 202)));

    await expect(submitInventoryValuationAction({ action: "post", memo: "Reconcile October stock" }, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingInventoryValuationAction(scope)).resolves.toEqual({ action: "post", memo: "Reconcile October stock" });
  });

  it("accepts a posted valuation only when the output reconciles and has an entry id", async () => {
    installLocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(executeResponse({ ok: true, data: {
      posted: true, entryId: postedEntryId, varianceMinor: 2500, ledgerValueMinor: 12500, glBalanceMinor: 10000,
    } })));

    await expect(submitInventoryValuationAction({ action: "post", memo: "Reconcile October stock" }, scope)).resolves.toMatchObject({
      kind: "completed", data: { posted: true, entryId: postedEntryId, varianceMinor: 2500 },
    });
    await expect(readPendingInventoryValuationAction(scope)).resolves.toBeNull();
  });

  it("reverses a selected valuation entry through its Go inverse capability", async () => {
    installLocks();
    const fetchMock = vi.fn().mockResolvedValue(executeResponse({ ok: true, data: { reversed: true, reversalEntryId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitInventoryValuationAction({ action: "reverse", entryId: postedEntryId }, scope)).resolves.toMatchObject({
      kind: "completed", data: { reversed: true, reversalEntryId },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "inventory.reverseValuationSummary", input: { entryId: postedEntryId } });
  });

  it("retries an uncertain post with the same intent id and exact action", async () => {
    installLocks();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(executeResponse({ ok: true, data: {
        posted: true, entryId: postedEntryId, varianceMinor: -500, ledgerValueMinor: 9500, glBalanceMinor: 10000,
      } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "post" as const, memo: "Reconcile October stock" };

    await expect(submitInventoryValuationAction(action, scope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    expect(await readPendingInventoryValuationAction(scope)).toEqual(action);
    await expect(submitInventoryValuationAction(action, scope)).resolves.toMatchObject({ kind: "completed", data: { posted: true } });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(second.intentId).toBe(first.intentId);
    expect(second).toMatchObject({ capabilityId: first.capabilityId, input: first.input });
    await expect(readPendingInventoryValuationAction(scope)).resolves.toBeNull();
  });
});
