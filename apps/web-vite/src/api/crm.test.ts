import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrmApiError, CrmCustomerSchema, CrmDealSchema, fetchCrmCustomers, fetchCrmDeals, fetchCrmFollowUpDraft, fetchCrmTasks, fetchCrmTeamMembers, fetchCrmTimeline, fetchCrmViews, importCrmCustomers, readCrmCustomerImportUndo, readCrmCustomerImportUndos, readCrmCustomerMergeUndo, readPendingCrmCustomerCreate, readPendingCrmCustomerImport, readPendingCrmCustomerImportUndo, readPendingCrmCustomerMerge, readPendingCrmCustomerMergeUndo, readPendingCrmCustomerProfileUpdate, readCrmCustomerProfileUndo, readPendingCrmCustomerProfileRestore, readPendingCrmDealCreate, readPendingCrmLeadConversion, readPendingCrmSavedViewWrite, readPendingCrmTaskCreate, readPendingCrmTaskDetails, readPendingCrmTaskDetailsForScope, submitCrmCustomerCreate, submitCrmCustomerDeactivate, submitCrmCustomerMerge, submitCrmCustomerMergeUndo, submitCrmCustomerProfileUpdate, submitCrmCustomerProfileUndo, submitCrmDealCreate, submitCrmDealStageMove, submitCrmLeadConversion, submitCrmSavedViewWrite, submitCrmTaskMutation, undoCrmImport } from "./crm";

const dealId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const customerId = "2beae091-6921-4e49-97b1-5049196e0ac5";
const conversionIntentId = "f1f60a51-6a9d-41f9-94a7-b1bf73c8a0b2";
const crmRetryScope = { actorId: customerId, organizationId: dealId };
const savedViewFilters = { status: "active" as const, owner: "all", staleOnly: false, duplicateOnly: false, tag: "" };

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

function stubCrmDealStageLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn(async <T,>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
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
  });
  const testNavigator = Object.create(navigator) as Navigator;
  Object.defineProperty(testNavigator, "locks", { configurable: true, value: { request } });
  vi.stubGlobal("navigator", testNavigator);
  return request;
}

function clearCompletedTaskResultMarkers() {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("chaste:crm:task-intent:") && key.endsWith(":completed")) window.localStorage.removeItem(key);
  }
}

describe("CRM API client", () => {
  beforeEach(() => { stubCrmDealStageLocks(); });

  it("reads and validates deals through the authenticated Go capability route", async () => {
    const deal = { id: dealId, title: "Renewal", stage: "proposal", valueMinor: 250000, source: "website", ownerUserId: customerId, ownerName: "Ada Lovelace", note: null, customerId, customerName: "Northwind", updatedAt: "2026-09-29T12:00:00.000Z" };
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { deals: [deal] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmDeals(dealId)).resolves.toEqual([deal]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": dealId }, signal: expect.any(AbortSignal),
      body: expect.stringContaining("crm.listDeals"),
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { deals: [{ id: dealId }] } })));
    await expect(fetchCrmDeals(dealId)).rejects.toBeInstanceOf(CrmApiError);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { deals: [{ ...deal, valueMinor: Number.MAX_SAFE_INTEGER + 1 }] } })));
    await expect(fetchCrmDeals(dealId)).rejects.toThrow("unexpected format");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { deals: [{ ...deal, debug: true }] } })));
    await expect(fetchCrmDeals(dealId)).rejects.toThrow("unexpected format");
  });

  it("keeps the Go customer and deal response contracts closed and reports session errors", async () => {
    const customer = { id: customerId, name: "Northwind", email: null, ownerUserId: null, ownerName: null, ownerEmail: null, phone: null, preferredContactMethod: "email", doNotContact: false, updatedByUserId: null, updatedByName: null, updatedByEmail: null, tags: [], notes: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", deactivatedAt: null, mergedRecords: [], purchaseCount: 0, lifetimeSpendMinor: 0, lastActivityAt: "2026-10-01T00:00:00.000Z", nextStep: null };
    expect(CrmCustomerSchema.safeParse(customer).success).toBe(true);
    expect(CrmCustomerSchema.safeParse({ ...customer, debug: true }).success).toBe(false);
    expect(CrmDealSchema.safeParse({ id: dealId, title: "Renewal", stage: "proposal", valueMinor: 100, updatedAt: "2026-10-01T00:00:00.000Z", debug: true }).success).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    await expect(fetchCrmDeals(dealId)).rejects.toMatchObject({ status: 401, message: "Your session has expired. Sign in again to continue." });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })));
    await expect(fetchCrmCustomers(dealId)).rejects.toMatchObject({ status: 403, message: "Your account does not have access to this CRM information." });
  });

  it("uses Go capabilities for customer collection, tasks, and saved views", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { customers: [{ id: customerId, name: "Northwind" }] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { tasks: [{ id: dealId, title: "Call Northwind" }] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { tasks: [{ id: dealId, title: "Call Northwind" }] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { views: [{ id: dealId, name: "Active", filters: { status: "active", owner: "all", staleOnly: false, duplicateOnly: false, tag: "" } }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmCustomers(dealId)).resolves.toHaveLength(1);
    await expect(fetchCrmTasks(dealId)).resolves.toHaveLength(1);
    await expect(fetchCrmTasks(dealId, undefined, { openOnly: true })).resolves.toHaveLength(1);
    await expect(fetchCrmViews(dealId)).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      expect.objectContaining({ capabilityId: "crm.listCustomerCollection", input: {}, intentId: expect.any(String) }),
      expect.objectContaining({ capabilityId: "crm.listTasks", input: {}, intentId: expect.any(String) }),
      expect.objectContaining({ capabilityId: "crm.listTasks", input: { openOnly: true }, intentId: expect.any(String) }),
      expect.objectContaining({ capabilityId: "crm.listCustomerViews", input: {}, intentId: expect.any(String) }),
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init?.credentials).toBe("same-origin");
    expect(fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["X-Organization-ID"]))
      .toEqual([dealId, dealId, dealId, dealId]);
  });

  it("does not fall back to the legacy customer endpoint when Go CRM reads are disabled", async () => {
    vi.stubGlobal("__GO_CRM_READS__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { customers: [{ id: customerId, name: "Northwind" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmCustomers(dealId)).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("keeps all CRM collection reads on Go when the old selector is disabled", async () => {
    vi.stubGlobal("__GO_CRM_READS__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}))
      .mockImplementationOnce(async () => Response.json({ ok: true, data: { deals: [{ id: dealId, title: "Renewal", stage: "proposal", valueMinor: 250000, updatedAt: "2026-09-29T12:00:00.000Z" }] } }))
      .mockImplementationOnce(async () => Response.json({ ok: true, data: { customers: [{ id: customerId, name: "Northwind" }] } }))
      .mockImplementationOnce(async () => Response.json({ ok: true, data: { views: [{ id: dealId, name: "Active", filters: { status: "active", owner: "all", staleOnly: false, duplicateOnly: false, tag: "" } }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmDeals(dealId)).resolves.toHaveLength(1);
    await expect(fetchCrmCustomers(dealId)).resolves.toHaveLength(1);
    await expect(fetchCrmViews(dealId)).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("/api/capabilities/execute"));
  });

  it("encodes the customer timeline identifier and validates the timeline result", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { entries: [{ kind: "invoice", date: "2026-09-29T12:00:00.000Z", refId: dealId, summary: "Invoice #1" }] } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCrmTimeline(customerId, dealId)).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.customerTimeline", input: { customerId }, intentId: expect.any(String) });
    await expect(fetchCrmTimeline("bad-id", dealId)).rejects.toMatchObject({ name: "CrmApiError" });
  });

  it("fails closed before fetch when a CRM read has no valid organization scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmCustomers(null)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: false });
    await expect(fetchCrmDeals("not-a-uuid")).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds the team lookup to the CRM page organization", async () => {
    const fetchMock = vi.fn(async () => Response.json({ members: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmTeamMembers(dealId)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/team", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json", "X-Organization-ID": dealId },
    }));
  });

  it("surfaces pending approvals without treating them as completed writes", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmDealStageMove({ dealId, stage: "won" }, undefined, true, crmRetryScope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(init?.body))).toMatchObject({ capabilityId: "crm.moveDealStage", input: { dealId, stage: "won" }, intentId: expect.any(String) });
  });

  it("always routes stage moves through crm.moveDealStage", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { moved: true, stage: "lost" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "lost" as const, lostReason: "Customer chose another vendor" };
    await expect(submitCrmDealStageMove(input, undefined, true, { actorId: customerId, organizationId: dealId })).resolves.toEqual({
      kind: "completed",
      data: { moved: true, stage: "lost" },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "crm.moveDealStage",
      input,
      intentId: expect.any(String),
    });

    const selectorDisabledFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { moved: true, stage: "qualified" } }));
    vi.stubGlobal("fetch", selectorDisabledFetch);
    await submitCrmDealStageMove({ dealId, stage: "qualified" }, undefined, false, { actorId: customerId, organizationId: dealId });
    expect(selectorDisabledFetch.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it.each([
    ["create-customer", { dealId, createCustomer: true as const, customerName: "New Northwind" }],
    ["attach-existing", { dealId, customerId }],
  ])("routes %s lead conversion through crm.convertLead with the exact Go input", async (_mode, input) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: true,
      data: { dealId, customerId, stage: "qualified", conversionIntentId },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmLeadConversion(input, undefined, true, crmRetryScope)).resolves.toEqual({
      kind: "completed",
      data: { dealId, customerId, stage: "qualified", conversionIntentId },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "crm.convertLead",
      input,
      intentId: expect.any(String),
    });
    await expect(readPendingCrmLeadConversion(crmRetryScope, dealId)).resolves.toBeNull();
  });

  it("keeps the exact conversion intent for approval and retries, then clears it on success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { dealId, customerId, stage: "qualified", conversionIntentId } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, createCustomer: true as const, customerName: "New Northwind" };

    await expect(submitCrmLeadConversion(input, undefined, true, crmRetryScope)).resolves.toEqual({
      kind: "pending",
      reason: "Manager approval required.",
    });
    const pendingAction = await readPendingCrmLeadConversion(crmRetryScope, dealId);
    expect(pendingAction).toEqual(input);

    await expect(submitCrmLeadConversion(input, undefined, true, crmRetryScope)).resolves.toMatchObject({ kind: "completed" });
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(retryBody).toEqual(firstBody);
    await expect(readPendingCrmLeadConversion(crmRetryScope, dealId)).resolves.toBeNull();
  });

  it("rejects a crm.convertLead DTO with a malformed conversion intent ID", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: { dealId, customerId, stage: "qualified", conversionIntentId: "not-a-uuid" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmLeadConversion({ dealId, customerId }, undefined, true, crmRetryScope)).rejects.toMatchObject({
      message: expect.stringContaining("unexpected lead conversion result"),
      requestMayHaveReachedServer: true,
    });
    await expect(readPendingCrmLeadConversion(crmRetryScope, dealId)).resolves.toEqual({ dealId, customerId });
  });

  it("keeps uncertain Go conversions Go-only when the Go route is unavailable or rolled back", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Go capability unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, customerId };

    await expect(submitCrmLeadConversion(input, undefined, true, crmRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingCrmLeadConversion(crmRetryScope, dealId)).resolves.toEqual(input);
    await expect(submitCrmLeadConversion(input, undefined, false, crmRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId);
  });

  it("fails closed when Go lead conversion is unavailable instead of using the legacy endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Go unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, createCustomer: true as const, customerName: "New Northwind" };

    await expect(submitCrmLeadConversion(input, undefined, false, crmRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.convertLead", input, intentId: expect.any(String) });
  });

  it("fails closed with a recoverable error until Go writes have actor and organization scope", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { moved: true, stage: "won" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmDealStageMove({ dealId, stage: "won" }, undefined, true)).rejects.toMatchObject({
      name: "CrmApiError",
      status: 0,
      message: "CRM is waiting for your account and organization details. Wait for your organization to finish loading, then try again.",
    });
    await expect(submitCrmDealStageMove({ dealId, stage: "won" }, undefined, true, { actorId: customerId, organizationId: " " })).rejects.toBeInstanceOf(CrmApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports opaque Better Auth user IDs for durable Go CRM intents", async () => {
    const scope = { actorId: "auth_user_a5zVJvRUGPkJNBQMEuSH_CkoB7ubSjXd", organizationId: dealId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { moved: true, stage: "won" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readPendingCrmDealCreate(scope)).resolves.toBeNull();
    await expect(submitCrmDealStageMove({ dealId, stage: "won" }, undefined, true, scope)).resolves.toEqual({
      kind: "completed",
      data: { moved: true, stage: "won" },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("reuses the Go stage intent while pending or uncertain, then clears it on success", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "won" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "won" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "won" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "won" as const };
    const scope = { actorId: customerId, organizationId: dealId };

    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status: 0 });
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).resolves.toMatchObject({ kind: "pending" });
    await submitCrmDealStageMove(input, undefined, true, scope);
    await submitCrmDealStageMove(input, undefined, true, scope);
    await submitCrmDealStageMove(input, undefined, true, { actorId: dealId, organizationId: dealId });

    const intentIds = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).intentId as string);
    expect(intentIds[0]).toBe(intentIds[1]);
    expect(intentIds[1]).toBe(intentIds[2]);
    expect(intentIds[2]).toBe(intentIds[3]);
    expect(intentIds[4]).not.toBe(intentIds[3]);
    expect(intentIds[5]).not.toBe(intentIds[4]);
  });

  it("clears a terminal Go 422 intent before a corrected submission", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Add a short reason before marking this deal lost" }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "lost" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "lost" as const, lostReason: "Customer chose another vendor" };
    const scope = { actorId: customerId, organizationId: dealId };

    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status: 422 });
    await submitCrmDealStageMove(input, undefined, true, scope);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId).not.toBe(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId);
  });

  it("fails closed and retains the exact intent when the selected Go route returns 404", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "lost" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "lost" as const, lostReason: "Customer chose another vendor" };

    const scope = { actorId: customerId, organizationId: dealId };
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await submitCrmDealStageMove(input, undefined, true, scope);
    const goBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(goBody).toMatchObject({ capabilityId: "crm.moveDealStage", input, intentId: expect.any(String) });
    expect(retryBody).toEqual(goBody);
  });

  it("normalizes the exact Go payload and rejects unexpected stage results", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { moved: true, stage: "proposal", extra: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "lost" as const, lostReason: "  Customer chose another vendor  " };

    await expect(submitCrmDealStageMove(input, undefined, true, crmRetryScope)).rejects.toMatchObject({
      name: "CrmApiError",
      message: "The CRM service returned an unexpected deal stage result.",
      requestMayHaveReachedServer: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "crm.moveDealStage",
      input: { ...input, lostReason: "Customer chose another vendor" },
    });
    await expect(submitCrmDealStageMove({ ...input, lostReason: "ab" }, undefined, true, crmRetryScope)).rejects.toMatchObject({ status: 0 });
  });

  it("does not fall back to legacy for non-404 Go failures and retains the retry intent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "temporarily unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "proposal" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "proposal" as const };
    const scope = { actorId: customerId, organizationId: dealId };

    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status: 503 });
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).resolves.toMatchObject({ kind: "completed" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const intents = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).intentId);
    expect(intents[0]).toBe(intents[1]);
  });

  it.each([408, 429])("retains the Go deal-stage intent after uncertain HTTP %i", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "retry later" }, { status }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "proposal" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "proposal" as const };
    const scope = { actorId: customerId, organizationId: dealId };

    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status });
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).resolves.toMatchObject({ kind: "completed" });

    const intents = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).intentId);
    expect(intents[0]).toBe(intents[1]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
  });

  it("routes deal creation through Go and strictly validates the deal ID", async () => {
    const input = { title: "Renewal", valueMinor: 25_500, customerId, source: "website", ownerUserId: customerId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmDealCreate(input, undefined, true, { actorId: customerId, organizationId: dealId })).resolves.toEqual({ kind: "completed", data: { dealId } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createDeal", input, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId, extra: true } })));
    await expect(submitCrmDealCreate(input, undefined, true, { actorId: customerId, organizationId: dealId })).rejects.toMatchObject({ name: "CrmApiError", message: "The CRM service returned an unexpected deal result." });
  });

  it("restores exact deal drafts and keeps intent through pending, uncertainty, and Go 404 without legacy fallback", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const input = { title: "Renewal", valueMinor: 25_500, customerId, source: "referral", ownerUserId: customerId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmDealCreate(input, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmDealCreate(scope)).resolves.toEqual(input);
    const intentId = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    await expect(submitCrmDealCreate(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });

    const go404Fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", go404Fetch);
    await expect(submitCrmDealCreate(input, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(go404Fetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
    expect(JSON.parse(String(go404Fetch.mock.calls[0]?.[1]?.body)).intentId).toBe(intentId);
    await expect(readPendingCrmDealCreate(scope)).resolves.toEqual(input);
    await expect(submitCrmDealCreate(input, undefined, false, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(submitCrmDealCreate({ ...input, title: "Changed" }, undefined, false, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: false });
    expect(go404Fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(go404Fetch.mock.calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(go404Fetch.mock.calls[1]?.[1]?.body)).intentId);
    await expect(readPendingCrmDealCreate(scope)).resolves.toEqual(input);

    const retryFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }));
    vi.stubGlobal("fetch", retryFetch);
    await expect(submitCrmDealCreate(input, undefined, true, scope)).resolves.toEqual({ kind: "completed", data: { dealId } });
    expect(retryFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
    expect(JSON.parse(String(retryFetch.mock.calls[0]?.[1]?.body)).intentId).toBe(intentId);
    await expect(readPendingCrmDealCreate(scope)).resolves.toBeNull();
  });

  it("fails closed for deal creation without scope and blocks changed drafts after an uncertain result", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const input = { title: "Renewal", valueMinor: 25_500 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } })).mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmDealCreate(input, undefined, true)).rejects.toMatchObject({ status: 0 });
    await expect(submitCrmDealCreate(input, undefined, false)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(submitCrmDealCreate(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    await expect(submitCrmDealCreate({ ...input, title: "Changed" }, undefined, true, scope)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps deal creation on Go when the retired selector is disabled", async () => {
    const input = { title: "Renewal", valueMinor: 25_500, customerId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }));
    vi.stubGlobal("fetch", fetchMock);
    await submitCrmDealCreate(input, undefined, false, { actorId: customerId, organizationId: dealId });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["X-Organization-ID"]).toBe(dealId);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createDeal", input, intentId: expect.any(String) });
  });

  it("routes task creation and completion through strict Go capability outputs", async () => {
    const taskId = "77e93149-61d7-48ed-929d-754ddfa263b1";
    const scope = { actorId: customerId, organizationId: dealId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { completed: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer", note: "Discuss renewal", refType: "customer", refId: customerId }, undefined, scope)).resolves.toEqual({ kind: "completed", data: { taskId } });
    await expect(submitCrmTaskMutation({ action: "completeTask", taskId }, undefined, scope)).resolves.toEqual({ kind: "completed", data: { completed: true } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["X-Organization-ID"])).toEqual([dealId, dealId]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createTask", input: { title: "Call customer", note: "Discuss renewal", refType: "customer", refId: customerId }, intentId: expect.any(String) });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ capabilityId: "crm.completeTask", input: { taskId }, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { taskId, extra: true } })));
    clearCompletedTaskResultMarkers();
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, scope)).rejects.toMatchObject({ name: "CrmApiError", message: "The CRM service returned an unexpected task result." });
  });

  it("routes task detail updates through Go and keeps the exact pending payload when the Go route is missing", async () => {
    const taskId = "77e93149-61d7-48ed-929d-754ddfa263b1";
    const assigneeUserId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const scope = { actorId: customerId, organizationId: dealId };
    const action = { action: "updateTaskDetails" as const, taskId, title: "Review renewal", note: null, dueAt: null, assigneeUserId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId, previous: { title: "Previous title", note: "Previous note", dueAt: "2026-10-15T12:00:00.000Z", assigneeUserId: null } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation(action, undefined, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmTaskDetails(scope, taskId)).resolves.toEqual(action);
    await expect(readPendingCrmTaskDetailsForScope(scope)).resolves.toEqual([action]);
    await expect(submitCrmTaskMutation(action, undefined, scope)).rejects.toMatchObject({
      status: 404,
      requestMayHaveReachedServer: true,
      message: "The Go CRM task route is unavailable. Ask an administrator to check the Go task route configuration.",
    });

    const goBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(goBody).toMatchObject({ capabilityId: "crm.updateTaskDetails", input: { taskId, title: "Review renewal", note: null, dueAt: null, assigneeUserId }, intentId: expect.any(String) });
    expect(retryBody.intentId).toBe(goBody.intentId);
    await expect(readPendingCrmTaskDetails(scope, taskId)).resolves.toEqual(action);
    await expect(readPendingCrmTaskDetailsForScope(scope)).resolves.toEqual([action]);

    await submitCrmTaskMutation(action, undefined, scope);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).intentId).toBe(goBody.intentId);
    await expect(readPendingCrmTaskDetails(scope, taskId)).resolves.toBeNull();
    await expect(readPendingCrmTaskDetailsForScope(scope)).resolves.toEqual([]);

    const otherTaskId = "4d906ed9-70da-4e66-a8e7-a192cfaf42db";
    const actionWithWrongTaskOutput = { ...action, taskId: otherTaskId };
    const unexpectedTaskId = "6d39b818-fac3-41cb-8e71-3c1b27856f4a";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { taskId: unexpectedTaskId, previous: { title: "Task", note: null, dueAt: null, assigneeUserId: null } } })));
    await expect(submitCrmTaskMutation(actionWithWrongTaskOutput, undefined, scope)).rejects.toMatchObject({ message: "The CRM service returned an unexpected task result." });
    await expect(readPendingCrmTaskDetails(scope, otherTaskId)).resolves.toEqual(actionWithWrongTaskOutput);

    const extraOutputTaskId = "64cd9667-bd03-440e-a20d-11dc639625f0";
    const actionWithExtraOutput = { ...action, taskId: extraOutputTaskId };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { taskId: extraOutputTaskId, previous: { title: "Task", note: null, dueAt: null, assigneeUserId: null }, extra: true } })));
    await expect(submitCrmTaskMutation(actionWithExtraOutput, undefined, scope)).rejects.toMatchObject({ message: "The CRM service returned an unexpected task result." });
  });

  it("binds task capabilities to the selected organization and surfaces Go organization mismatches", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Selected organization does not match this session" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, scope)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["X-Organization-ID"]).toBe(dealId);
  });

  it("serializes identical task submissions across tabs and reuses the completed result", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const taskId = "77e93149-61d7-48ed-929d-754ddfa263b1";
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    const first = submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, scope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, scope);
    resolveResponse(Response.json({ ok: true, data: { taskId } }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "completed", data: { taskId } },
      { kind: "completed", data: { taskId } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains the exact create-task draft and intent while pending and fails closed on a missing Go route", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const action = { action: "createTask" as const, title: "Prepare renewal notes", dueAt: "2026-10-15T12:00:00.000Z", note: "Include updated terms", refType: "customer", refId: customerId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation(action, undefined, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmTaskCreate(scope)).resolves.toEqual(action);
    const pendingIntentId = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    const goFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", goFetch);
    await expect(submitCrmTaskMutation(action, undefined, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    const goBody = JSON.parse(String(goFetch.mock.calls[0]?.[1]?.body));
    expect(goFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
    expect(goBody.intentId).toBe(pendingIntentId);
    await expect(readPendingCrmTaskCreate(scope)).resolves.toEqual(action);

    await submitCrmTaskMutation(action, undefined, scope);
    expect(goFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(goFetch.mock.calls[1]?.[1]?.body)).intentId).toBe(pendingIntentId);
    await expect(readPendingCrmTaskCreate(scope)).resolves.toBeNull();
  });

  it("does not send task completion to legacy when the selected Go route returns 404", async () => {
    const taskId = "77e93149-61d7-48ed-929d-754ddfa263b1";
    const scope = { actorId: customerId, organizationId: dealId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { completed: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation({ action: "completeTask", taskId }, undefined, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    await submitCrmTaskMutation({ action: "completeTask", taskId }, undefined, scope);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId).toBe(first.intentId);
  });

  it("fails closed on missing scope and does not rotate task intents after uncertainty or for changed drafts", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Different title" }, undefined, scope)).rejects.toMatchObject({ status: 0 });
    await submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, scope);
    const bodies = fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities/execute").map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.intentId).toBe(bodies[1]?.intentId);
  });

  it("routes customer creation through Go and preserves the duplicate warning output", async () => {
    const customerCreateInput = { name: "Northwind Ltd", email: "office@northwind.test", phone: "+256 700 111 222", preferredContactMethod: "whatsapp" as const, doNotContact: true };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { customerId, duplicateWarning: 'Looks like existing customer "Northwind" (matched by similar_name). Merge or deactivate one of them.' } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmCustomerCreate(customerCreateInput, undefined, true, { actorId: dealId, organizationId: customerId })).resolves.toEqual({ kind: "completed", data: { customerId, duplicateWarning: 'Looks like existing customer "Northwind" (matched by similar_name). Merge or deactivate one of them.' } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createCustomer", input: customerCreateInput, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { customerId } })));
    await expect(submitCrmCustomerCreate(customerCreateInput, undefined, true, { actorId: dealId, organizationId: customerId })).rejects.toMatchObject({ name: "CrmApiError", message: "The CRM service returned an unexpected customer result." });
  });

  it("restores customer drafts and keeps the same intent through pending, uncertainty, and Go 404 without legacy fallback", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const input = { name: "Northwind", email: "office@northwind.test", preferredContactMethod: "email" as const, doNotContact: false };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmCustomerCreate(input, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmCustomerCreate(scope)).resolves.toEqual(input);
    const pendingIntentId = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    await expect(submitCrmCustomerCreate(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });

    const goFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", goFetch);
    await expect(submitCrmCustomerCreate(input, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingCrmCustomerCreate(scope)).resolves.toEqual(input);
    await expect(submitCrmCustomerCreate(input, undefined, false, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(submitCrmCustomerCreate({ ...input, name: "Changed customer" }, undefined, false, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: false });
    expect(goFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    await expect(readPendingCrmCustomerCreate(scope)).resolves.toEqual(input);

    const retryFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { customerId, duplicateWarning: null } }));
    vi.stubGlobal("fetch", retryFetch);
    await expect(submitCrmCustomerCreate(input, undefined, true, scope)).resolves.toMatchObject({ kind: "completed", data: { customerId, duplicateWarning: null } });
    expect(retryFetch.mock.calls).toHaveLength(1);
    expect(retryFetch.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(retryFetch.mock.calls[0]?.[1]?.body)).intentId).toBe(pendingIntentId);
    await expect(readPendingCrmCustomerCreate(scope)).resolves.toBeNull();
  });

  it("keeps customer creation on Go when the retired selector is disabled", async () => {
    const input = { name: "Northwind", preferredContactMethod: "email" as const, doNotContact: false };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { customerId, duplicateWarning: null } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmCustomerCreate(input, undefined, false, { actorId: dealId, organizationId: customerId })).resolves.toEqual({ kind: "completed", data: { customerId, duplicateWarning: null } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createCustomer", input, intentId: expect.any(String) });
  });

  it("reserves and reuses one durable intent across concurrent stage submissions", async () => {
    const lockRequest = stubCrmDealStageLocks();
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "proposal" as const };

    const first = submitCrmDealStageMove(input, undefined, true, crmRetryScope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = submitCrmDealStageMove(input, undefined, true, crmRetryScope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lockRequest).toHaveBeenCalledWith(expect.stringContaining("chaste.crm.deal-stage.intent.v1:"), { mode: "exclusive" }, expect.any(Function));
    const firstIntent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    const secondIntent = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId;
    expect(secondIntent).toBe(firstIntent);

    responses.forEach((resolve) => resolve(Response.json({ ok: true, data: { moved: true, stage: "proposal" } })));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("blocks a changed stage while the prior stage result is unresolved", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    const scope = crmRetryScope;

    await expect(submitCrmDealStageMove({ dealId, stage: "proposal" }, undefined, true, scope)).rejects.toMatchObject({
      status: 0,
      requestMayHaveReachedServer: true,
    });
    const firstIntent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    await expect(submitCrmDealStageMove({ dealId, stage: "won" }, undefined, true, scope)).rejects.toMatchObject({
      status: 0,
      message: "A previous stage move for this deal is unresolved. Retry that exact move or check the deal before changing it.",
      requestMayHaveReachedServer: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(submitCrmDealStageMove({ dealId, stage: "proposal" }, undefined, true, scope)).rejects.toMatchObject({ status: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId).toBe(firstIntent);
  });

  it("fails closed when Web Crypto, durable storage, or Web Locks are unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = { dealId, stage: "proposal" as const };
    const scope = crmRetryScope;
    const webCrypto = globalThis.crypto;

    const brokenCrypto = Object.create(webCrypto) as Crypto;
    Object.defineProperty(brokenCrypto, "subtle", { configurable: true, value: { digest: vi.fn().mockRejectedValue(new Error("digest unavailable")) } });
    vi.stubGlobal("crypto", brokenCrypto);
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal("crypto", webCrypto);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    const testNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(testNavigator, "locks", { configurable: true, value: undefined });
    vi.stubGlobal("navigator", testNavigator);
    await expect(submitCrmDealStageMove(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for task writes when Web Locks are unavailable or rejected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "createTask" as const, title: "Call customer" };
    const testNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(testNavigator, "locks", { configurable: true, value: undefined });
    vi.stubGlobal("navigator", testNavigator);

    await expect(submitCrmTaskMutation(action, undefined, crmRetryScope)).rejects.toMatchObject({
      status: 0,
      requestMayHaveReachedServer: true,
      message: "This browser cannot safely coordinate CRM task retries across tabs. Enable Web Locks before changing follow-up tasks.",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(testNavigator, "locks", {
      configurable: true,
      value: { request: vi.fn(async () => { throw new Error("lock request rejected"); }) },
    });
    await expect(submitCrmTaskMutation(action, undefined, crmRetryScope)).rejects.toMatchObject({
      status: 0,
      requestMayHaveReachedServer: true,
      message: "The browser could not safely coordinate this CRM task across tabs. Close other CRM tabs and try again.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries Go customer deactivation with its exact scoped intent and never falls back after a 404", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const pending = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", pending);
    await expect(submitCrmCustomerDeactivate(customerId, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(submitCrmCustomerDeactivate(customerId, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    const firstIntent = JSON.parse(String(pending.mock.calls[0]?.[1]?.body)).intentId;

    const unavailable = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", unavailable);
    await expect(submitCrmCustomerDeactivate(customerId, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(unavailable.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
    const noScopeLegacy = vi.fn();
    vi.stubGlobal("fetch", noScopeLegacy);
    await expect(submitCrmCustomerDeactivate(customerId, undefined, false)).rejects.toMatchObject({ status: 0 });
    await expect(submitCrmCustomerDeactivate(customerId, undefined, false, { actorId: "x".repeat(256), organizationId: customerId })).rejects.toMatchObject({ status: 0 });
    expect(noScopeLegacy).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", unavailable);
    await expect(submitCrmCustomerDeactivate(customerId, undefined, false, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(unavailable.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    for (const [, init] of unavailable.mock.calls) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ capabilityId: "crm.deactivateCustomer", input: { customerId }, intentId: firstIntent });
    }

  });

  it("requires resolved actor and organization scope before Go customer deactivation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmCustomerDeactivate(customerId, undefined, true)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists exact merge and undo attempts through pending, uncertain, and 404 results", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const mergeInput = { survivorCustomerId: dealId, duplicateCustomerId: customerId };
    const mergeResult = {
      ...mergeInput,
      previous: [dealId, customerId].map((id) => ({
        customerId: id,
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
      })),
    };
    const first = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", first);
    await expect(submitCrmCustomerMerge(mergeInput, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    expect(await readPendingCrmCustomerMerge(scope)).toEqual(mergeInput);
    const mergeIntentId = JSON.parse(String(first.mock.calls[0]?.[1]?.body)).intentId;
    await expect(submitCrmCustomerMerge(mergeInput, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });

    const mergeRetry = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: mergeResult }));
    vi.stubGlobal("fetch", mergeRetry);
    await expect(submitCrmCustomerMerge(mergeInput, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    const noScopeFallback = vi.fn();
    vi.stubGlobal("fetch", noScopeFallback);
    await expect(submitCrmCustomerMerge(mergeInput, undefined, false)).rejects.toMatchObject({ status: 0 });
    expect(noScopeFallback).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", mergeRetry);
    await expect(submitCrmCustomerMerge(mergeInput, undefined, false, scope)).resolves.toMatchObject({ kind: "completed", data: { ...mergeResult, mergeIntentId } });
    expect(mergeRetry.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const mergeBodies = mergeRetry.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(mergeBodies).toHaveLength(2);
    expect(mergeBodies.map((body) => body.intentId)).toEqual([mergeIntentId, mergeIntentId]);
    expect(mergeBodies[0]).toMatchObject({ capabilityId: "crm.mergeCustomers", input: mergeInput });
    await expect(readPendingCrmCustomerMerge(scope)).resolves.toBeNull();
    await expect(readCrmCustomerMergeUndo(scope)).resolves.toMatchObject({ ...mergeResult, mergeIntentId });
    const undoInput = { ...mergeResult, mergeIntentId };

    const undo = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", undo);
    await expect(submitCrmCustomerMergeUndo(undoInput, undefined, true, scope)).resolves.toMatchObject({ kind: "pending" });
    await expect(readPendingCrmCustomerMergeUndo(scope)).resolves.toEqual(undoInput);
    const undoIntentId = JSON.parse(String(undo.mock.calls[0]?.[1]?.body)).intentId;
    await expect(submitCrmCustomerMergeUndo(undoInput, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });

    const undoRetry = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: mergeResult }));
    vi.stubGlobal("fetch", undoRetry);
    await expect(submitCrmCustomerMergeUndo(undoInput, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(submitCrmCustomerMergeUndo(undoInput, undefined, false, scope)).resolves.toMatchObject({ kind: "completed" });
    const undoBodies = undoRetry.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(undoBodies).toHaveLength(2);
    expect(undoBodies.map((body) => body.intentId)).toEqual([undoIntentId, undoIntentId]);
    expect(undoBodies[0]).toMatchObject({ capabilityId: "crm.restoreCustomerMerge", input: { survivorCustomerId: dealId, duplicateCustomerId: customerId, mergeIntentId } });
    await expect(readPendingCrmCustomerMergeUndo(scope)).resolves.toBeNull();
    await expect(readCrmCustomerMergeUndo(scope)).resolves.toBeNull();
  });

  it("fails closed for customer creation without actor and organization scope", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { customerId, duplicateWarning: null } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmCustomerCreate({ name: "Northwind", preferredContactMethod: "email", doNotContact: false }, undefined, true)).rejects.toMatchObject({ name: "CrmApiError", status: 0 });
    await expect(submitCrmCustomerCreate({ name: "Northwind", preferredContactMethod: "email", doNotContact: false }, undefined, false)).rejects.toMatchObject({ name: "CrmApiError", status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only the established envelope for saved-view writes", async () => {
    const viewId = "8ea6ef66-d321-4be4-a4ee-32fa0b13e5f9";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { viewId, previous: null } })));
    const input = { name: "Active accounts", filters: savedViewFilters, isShared: false, isPinned: false };
    await expect(submitCrmSavedViewWrite(input, undefined, crmRetryScope)).resolves.toEqual({
      kind: "completed",
      data: { viewId, previous: null },
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ viewId, previous: null })));
    await expect(submitCrmSavedViewWrite(input, undefined, crmRetryScope)).rejects.toMatchObject({
      name: "CrmApiError",
      message: "The CRM service returned an unexpected action response.",
    });
  });

  it("imports and undoes customer batches using the existing import contract", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const rows = [2, 3, 4].map((rowNumber) => ({ rowNumber, name: `Customer ${rowNumber}`, allowDuplicate: false }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ inserted: 1, skippedDuplicates: 2, createdIds: [customerId], errors: [] }))
      .mockResolvedValueOnce(Response.json({ undone: 1, remaining: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    let generatedImportIntentId = "";
    const resultFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string };
      if (body.capabilityId === "crm.importCustomers") {
        generatedImportIntentId = body.intentId;
        return Response.json({ ok: true, data: { createdIds: [customerId], imported: 1, skippedDuplicateRows: [3, 4], importIntentId: body.intentId } });
      }
      return Response.json({ ok: true, data: { customerIds: [customerId], deactivated: 1, importIntentId: generatedImportIntentId, undoIntentId: body.intentId } });
    });
    vi.stubGlobal("fetch", resultFetch);
    await expect(importCrmCustomers(rows, undefined, false, scope)).resolves.toEqual({ kind: "completed", data: { inserted: 1, skippedDuplicates: 2, skippedDuplicateRows: [3, 4], createdIds: [customerId] } });
    const importReceipt = await readCrmCustomerImportUndo(scope);
    await expect(undoCrmImport([customerId], undefined, false, scope, importReceipt?.importIntentId)).resolves.toEqual({ kind: "completed", data: { undone: 1, remaining: 0 } });
    expect(resultFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
  });

  it("retains independent Go customer import receipts and clears only the undone batch", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const firstID = "10000000-0000-4000-8000-000000000061";
    const secondID = "10000000-0000-4000-8000-000000000062";
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: { customerIds?: string[]; importIntentId?: string } };
      if (body.capabilityId === "crm.importCustomers") {
        const rows = (JSON.parse(String(init?.body)) as { input: { rows: Array<{ name: string }> } }).input.rows;
        const id = rows[0]?.name === "First batch" ? firstID : secondID;
        return Response.json({ ok: true, data: { createdIds: [id], imported: 1, skippedDuplicateRows: [], importIntentId: body.intentId } });
      }
      return Response.json({ ok: true, data: {
        customerIds: body.input.customerIds,
        deactivated: body.input.customerIds?.length ?? 0,
        importIntentId: body.input.importIntentId,
        undoIntentId: body.intentId,
      } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await importCrmCustomers([{ rowNumber: 2, name: "First batch", allowDuplicate: false }], undefined, true, scope);
    const second = await importCrmCustomers([{ rowNumber: 2, name: "Second batch", allowDuplicate: false }], undefined, true, scope);
    expect(first.kind).toBe("completed");
    expect(second.kind).toBe("completed");
    const receipts = await readCrmCustomerImportUndos(scope);
    expect(receipts.map((receipt) => receipt.createdIds)).toEqual([[firstID], [secondID]]);
    await expect(undoCrmImport([firstID], undefined, true, scope, receipts[0]?.importIntentId)).resolves.toMatchObject({ kind: "completed" });
    await expect(readCrmCustomerImportUndos(scope)).resolves.toEqual([receipts[1]]);
  });

  it("validates approval responses for customer import and undo", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    let importAttemptCount = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string };
      if (body.capabilityId === "crm.importCustomers") {
        importAttemptCount += 1;
        if (importAttemptCount === 1) return Response.json({ pendingApproval: true, error: "Import needs approval" }, { status: 202 });
        if (importAttemptCount === 2) return Response.json({ pendingApproval: "invalid" }, { status: 202 });
        return Response.json({ ok: true, data: { createdIds: [customerId], imported: 1, skippedDuplicateRows: [], importIntentId: body.intentId } });
      }
      return Response.json({ pendingApproval: true, error: "Undo needs approval" }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(importCrmCustomers([{ rowNumber: 2, name: "Northwind", allowDuplicate: false }], undefined, false, scope)).resolves.toEqual({
      kind: "pending",
      reason: "Import needs approval",
    });
    await expect(importCrmCustomers([{ rowNumber: 2, name: "Northwind", allowDuplicate: false }], undefined, false, scope)).rejects.toMatchObject({
      name: "CrmApiError",
      message: "The CRM service returned an unexpected approval response.",
      requestMayHaveReachedServer: true,
    });
    await expect(undoCrmImport([customerId], undefined, false, scope)).rejects.toMatchObject({
      name: "CrmApiError",
      message: expect.stringContaining("Go customer import is unresolved"),
    });
    const result = await importCrmCustomers([{ rowNumber: 2, name: "Northwind", allowDuplicate: false }], undefined, false, scope);
    expect(result.kind).toBe("completed");
    const receipt = await readCrmCustomerImportUndo(scope);
    await expect(undoCrmImport([customerId], undefined, false, scope, receipt?.importIntentId)).resolves.toEqual({ kind: "pending", reason: "Undo needs approval" });
  });

  it("rejects import results with duplicate or unsubmitted skipped row numbers", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const rows = [
      { rowNumber: 2, name: "First", allowDuplicate: false },
      { rowNumber: 3, name: "Second", allowDuplicate: false },
      { rowNumber: 4, name: "Third", allowDuplicate: false },
    ];
    const duplicateSkipped = vi.fn(async () => Response.json({ ok: true, data: { createdIds: [customerId], imported: 1, skippedDuplicateRows: [3, 3], importIntentId: dealId } }));
    vi.stubGlobal("fetch", duplicateSkipped);
    await expect(importCrmCustomers(rows, undefined, true, scope)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });

    const unsubmittedSkipped = vi.fn(async () => Response.json({ ok: true, data: { createdIds: [customerId, dealId], imported: 2, skippedDuplicateRows: [99], importIntentId: dealId } }));
    vi.stubGlobal("fetch", unsubmittedSkipped);
    await expect(importCrmCustomers(rows, undefined, true, scope)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });
  });

  it("keeps saved Go import undo state when the response omits or replaces requested customer IDs", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const rows = [
      { rowNumber: 2, name: "Northwind", allowDuplicate: false },
      { rowNumber: 3, name: "Contoso", allowDuplicate: false },
    ];
    const requestedIds = [dealId, customerId];
    const replacementId = "4aef4162-c9d5-41a8-80a4-0ae002f9d02b";

    for (const returnedIds of [[dealId], [dealId, replacementId]]) {
      window.localStorage.clear();
      vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { intentId: string };
        return Response.json({ ok: true, data: { createdIds: requestedIds, imported: 2, skippedDuplicateRows: [], importIntentId: body.intentId } });
      }));
      await expect(importCrmCustomers(rows, undefined, true, scope)).resolves.toMatchObject({ kind: "completed" });
      const savedUndo = await readCrmCustomerImportUndo(scope);
      expect(savedUndo?.createdIds).toEqual(requestedIds);
      if (!savedUndo) throw new Error("expected saved import undo state");

      const undoResponse = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { intentId: string };
        return Promise.resolve(Response.json({ ok: true, data: {
          customerIds: returnedIds,
          deactivated: requestedIds.length,
          importIntentId: savedUndo.importIntentId,
          undoIntentId: body.intentId,
        } }));
      });
      vi.stubGlobal("fetch", undoResponse);

      await expect(undoCrmImport(requestedIds, undefined, true, scope, savedUndo.importIntentId)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });
      await expect(readCrmCustomerImportUndo(scope)).resolves.toEqual(savedUndo);
    }
  });

  it("requires the Go import receipt to match the scoped intent before saving undo IDs", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const rows = [{ rowNumber: 2, name: "Northwind", allowDuplicate: false }];
    for (const responseReceipt of [undefined, customerId]) {
      window.localStorage.clear();
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: {
        createdIds: [dealId], imported: 1, skippedDuplicateRows: [], ...(responseReceipt ? { importIntentId: responseReceipt } : {}),
      } })));
      await expect(importCrmCustomers(rows, undefined, true, scope)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });
      await expect(readCrmCustomerImportUndo(scope)).resolves.toBeNull();
      await expect(readPendingCrmCustomerImport(scope)).resolves.toEqual(rows);
    }
  });

  it("rejects duplicate customer IDs before requesting a Go import undo", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(undoCrmImport([customerId, customerId], undefined, true, { actorId: dealId, organizationId: customerId }, dealId)).rejects.toMatchObject({
      name: "CrmApiError",
      status: 0,
      message: "The customer import undo IDs are invalid.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps new imports on Go when the retired selector is false, after a prior Go receipt", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const rows = [{ rowNumber: 2, name: "Northwind", allowDuplicate: false }];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { intentId: string };
      return Response.json({ ok: true, data: { createdIds: [customerId], imported: 1, skippedDuplicateRows: [], importIntentId: body.intentId } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(importCrmCustomers(rows, undefined, true, scope)).resolves.toMatchObject({ kind: "completed" });
    const savedUndo = await readCrmCustomerImportUndo(scope);
    expect(savedUndo).not.toBeNull();

    await expect(importCrmCustomers([{ rowNumber: 2, name: "Contoso", allowDuplicate: false }], undefined, false, scope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(await readCrmCustomerImportUndo(scope)).not.toEqual(savedUndo);
  });

  it("retries Go customer imports and undo with scoped intents, blocks rollback, and persists the created IDs", async () => {
    const scope = { actorId: dealId, organizationId: customerId };
    const rows = [
      { rowNumber: 2, name: "Northwind", email: "hello@northwind.test", allowDuplicate: false },
      { rowNumber: 3, name: "Contoso", phone: "+256 700 111 222", allowDuplicate: true },
    ];
    const importPost = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Import needs approval" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", importPost);
    await expect(importCrmCustomers(rows, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Import needs approval" });
    const importIntentId = JSON.parse(String(importPost.mock.calls[0]?.[1]?.body)).intentId;
    await expect(readPendingCrmCustomerImport(scope)).resolves.toEqual(rows);
    await expect(importCrmCustomers(rows, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });

    const noImportFallback = vi.fn(async () => Response.json({ error: "Go unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", noImportFallback);
    await expect(importCrmCustomers(rows, undefined, false, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(noImportFallback).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());

    const importRetry = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockImplementationOnce((_url, init) => {
        const body = JSON.parse(String(init?.body)) as { intentId: string };
        return Promise.resolve(Response.json({ ok: true, data: { createdIds: [dealId], imported: 1, skippedDuplicateRows: [3], importIntentId: body.intentId } }));
      });
    vi.stubGlobal("fetch", importRetry);
    await expect(importCrmCustomers(rows, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(importCrmCustomers(rows, undefined, true, scope)).resolves.toEqual({
      kind: "completed",
      data: { inserted: 1, skippedDuplicates: 1, skippedDuplicateRows: [3], createdIds: [dealId] },
    });
    const importBodies = importRetry.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(importBodies).toHaveLength(2);
    expect(importBodies.map((body) => body.intentId)).toEqual([importIntentId, importIntentId]);
    expect(importBodies[0]).toMatchObject({ capabilityId: "crm.importCustomers", input: { rows } });
    await expect(readPendingCrmCustomerImport(scope)).resolves.toBeNull();
    await expect(readCrmCustomerImportUndo(scope)).resolves.toEqual({ imported: 1, skippedDuplicates: 1, createdIds: [dealId], importIntentId });

    const noCompletedImportUndoFallback = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Go unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", noCompletedImportUndoFallback);
    await expect(undoCrmImport([dealId], undefined, false, scope, importIntentId)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(noCompletedImportUndoFallback.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);

    const undo = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Undo needs approval" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", undo);
    await expect(undoCrmImport([dealId], undefined, true, scope, importIntentId)).resolves.toEqual({ kind: "pending", reason: "Undo needs approval" });
    const undoIntentId = JSON.parse(String(undo.mock.calls[0]?.[1]?.body)).intentId;
    await expect(readPendingCrmCustomerImportUndo(scope)).resolves.toEqual({ action: "undoCustomerImport", customerIds: [dealId], importIntentId });
    await expect(undoCrmImport([dealId], undefined, true, scope, importIntentId)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });

    const noUndoFallback = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Go unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", noUndoFallback);
    await expect(undoCrmImport([dealId], undefined, false, scope, importIntentId)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(noUndoFallback.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);

    const undoRetry = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockImplementationOnce((_url, init) => {
        const body = JSON.parse(String(init?.body)) as { intentId: string };
        return Promise.resolve(Response.json({ ok: true, data: { customerIds: [dealId], deactivated: 1, importIntentId, undoIntentId: body.intentId } }));
      });
    vi.stubGlobal("fetch", undoRetry);
    await expect(undoCrmImport([dealId], undefined, true, scope, importIntentId)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(undoCrmImport([dealId], undefined, true, scope, importIntentId)).resolves.toEqual({ kind: "completed", data: { undone: 1, remaining: 0 } });
    const undoBodies = undoRetry.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(undoBodies).toHaveLength(2);
    expect(undoBodies.map((body) => body.intentId)).toEqual([undoIntentId, undoIntentId]);
    expect(undoBodies[0]).toMatchObject({ capabilityId: "crm.undoCustomerImport", input: { customerIds: [dealId], importIntentId } });
    await expect(readPendingCrmCustomerImportUndo(scope)).resolves.toBeNull();
    await expect(readCrmCustomerImportUndo(scope)).resolves.toBeNull();
  });

  it("requests the Go follow-up draft route and strictly validates its grounded sources", async () => {
    const draft = { draft: "Hello Northwind, should we review the invoice together?", sources: [{ kind: "invoice", date: "2026-09-20T12:00:00.000Z", refId: dealId, summary: "Invoice #7 is awaiting payment" }] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(draft));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmFollowUpDraft(customerId, dealId)).resolves.toEqual(draft);
    expect(fetchMock).toHaveBeenCalledWith("/api/crm/follow-up-draft", expect.objectContaining({ method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": dealId } }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ customerId });
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/crm")).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ draft: "Only a draft" })));
    await expect(fetchCrmFollowUpDraft(customerId, dealId)).rejects.toMatchObject({ name: "CrmApiError" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...draft, unexpected: true })));
    await expect(fetchCrmFollowUpDraft(customerId, dealId)).rejects.toMatchObject({ name: "CrmApiError" });
  });

  it("routes profile updates through Go and strictly validates previous snapshots", async () => {
    const previous = { customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false };
    const current = { ...previous, name: "Northwind Ltd", tags: ["priority"], notes: "Updated note", preferredContactMethod: "whatsapp", doNotContact: true };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { updatedCount: 1, previous: [previous], current: [current] } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { action: "updateProfile" as const, customerIds: [customerId], name: "Northwind Ltd", phone: null, notes: "Updated note", ownerUserId: null, addTags: ["priority"], removeTags: ["renewal"], doNotContact: true, preferredContactMethod: "whatsapp" as const };

    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, { actorId: customerId, organizationId: dealId })).resolves.toEqual({ kind: "completed", data: { updatedCount: 1, previous: [previous], current: [current] } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.updateCustomerProfiles", input: { customerIds: [customerId], name: "Northwind Ltd" }, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { updatedCount: 1, previous: [{}] } })));
    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, { actorId: customerId, organizationId: dealId })).rejects.toMatchObject({ requestMayHaveReachedServer: true });
  });

  it("matches UUID casing when Go returns profile snapshot identifiers", async () => {
    const upperCustomerId = customerId.toUpperCase();
    const snapshot = { customerId, name: "Northwind", ownerUserId: null, tags: [], notes: null, phone: null, preferredContactMethod: "email", doNotContact: false };
    const current = { ...snapshot, name: "Northwind Ltd" };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { updatedCount: 1, previous: [snapshot], current: [current] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmCustomerProfileUpdate({ action: "updateProfile", customerIds: [upperCustomerId], name: "Northwind Ltd" }, undefined, true, crmRetryScope))
      .resolves.toMatchObject({ kind: "completed", data: { updatedCount: 1, previous: [{ customerId }], current: [{ customerId }] } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "crm.updateCustomerProfiles",
      input: { customerIds: [upperCustomerId] },
      intentId: expect.any(String),
    });
  });

  it("persists an exact Go profile undo and retries its original intent after pending approval", async () => {
    const previous = { customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email" as const, doNotContact: false };
    const updated = { ...previous, name: "Northwind Ltd" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { updatedCount: 1, previous: [previous], current: [updated] } }))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { updatedCount: 1, previous: [updated], current: [previous] } }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: customerId, organizationId: dealId };
    await submitCrmCustomerProfileUpdate({ action: "updateProfile", customerIds: [customerId], name: "Northwind Ltd" }, undefined, true, scope);
    const undoState = { profiles: [previous], expectedCurrent: [updated] };
    await expect(readCrmCustomerProfileUndo(scope)).resolves.toEqual(undoState);
    await expect(submitCrmCustomerProfileUndo(undoState, undefined, scope)).resolves.toMatchObject({ kind: "pending" });
    await expect(readPendingCrmCustomerProfileRestore(scope)).resolves.toEqual(undoState);
    await expect(submitCrmCustomerProfileUndo(undoState, undefined, scope)).resolves.toEqual({ kind: "completed", data: { updatedCount: 1, previous: [updated], current: [previous] } });
    await expect(readPendingCrmCustomerProfileRestore(scope)).resolves.toBeNull();
    await expect(readCrmCustomerProfileUndo(scope)).resolves.toBeNull();
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.capabilityId)).toEqual(["crm.updateCustomerProfiles", "crm.restoreCustomerProfiles", "crm.restoreCustomerProfiles"]);
    expect(bodies[1]?.intentId).toBe(bodies[2]?.intentId);
    expect(bodies[1]).toMatchObject({ input: { profiles: [previous], expectedCurrent: [updated] }, intentId: expect.any(String) });
  });

  it("keeps the profile undo intent when Go reports a stale expected snapshot", async () => {
    const previous = { customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Old", phone: null, preferredContactMethod: "email" as const, doNotContact: false };
    const expectedCurrent = { ...previous, name: "Updated" };
    const staleCurrent = { ...expectedCurrent, notes: "Changed in another client" };
    const undoState = { profiles: [previous], expectedCurrent: [expectedCurrent] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { updatedCount: 1, previous: [staleCurrent], current: [previous] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmCustomerProfileUndo(undoState, undefined, crmRetryScope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    await expect(readPendingCrmCustomerProfileRestore(crmRetryScope)).resolves.toEqual(undoState);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "crm.restoreCustomerProfiles",
      input: { profiles: [previous], expectedCurrent: [expectedCurrent] },
      intentId: expect.any(String),
    });
  });

  it("keeps profile writes on Go when the retired selector is disabled", async () => {
    const snapshot = { customerId, name: "Northwind", ownerUserId: null, tags: [], notes: null, phone: null, preferredContactMethod: "email", doNotContact: false };
    const current = { ...snapshot, notes: "Legacy route" };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { updatedCount: 1, previous: [snapshot], current: [current] } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { action: "updateProfile" as const, customerIds: [customerId], notes: "Legacy route" };

    await expect(submitCrmCustomerProfileUpdate(input, undefined, false, crmRetryScope)).resolves.toMatchObject({ kind: "completed", data: { updatedCount: 1, previous: [{ customerId }], current: [{ customerId }] } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.updateCustomerProfiles", input: { customerIds: [customerId] }, intentId: expect.any(String) });
  });

  it("keeps the exact profile action and scoped intent after a Go 404 without falling back to the legacy writer", async () => {
    const previous = { customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Approval required" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(Response.json({ error: "Route not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { updatedCount: 1, previous: [previous], current: [{ ...previous, name: "Northwind Ltd" }] } }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: customerId, organizationId: dealId };
    const input = { action: "updateProfile" as const, customerIds: [customerId], name: "Northwind Ltd" };

    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, scope)).resolves.toMatchObject({ kind: "pending" });
    await expect(readPendingCrmCustomerProfileUpdate(scope)).resolves.toEqual(input);
    await expect(submitCrmCustomerProfileUpdate({ ...input, name: "Changed payload" }, undefined, true, scope)).rejects.toMatchObject({ status: 0 });
    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, scope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingCrmCustomerProfileUpdate(scope)).resolves.toEqual(input);
    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, scope)).resolves.toMatchObject({ kind: "completed" });

    const goCalls = fetchMock.mock.calls;
    expect(goCalls.map(([path]) => path)).toEqual([
      "/api/capabilities/execute",
      "/api/capabilities/execute",
      "/api/capabilities/execute",
      "/api/capabilities/execute",
    ]);
    const intents = goCalls.map(([, init]) => JSON.parse(String(init?.body)).intentId);
    expect(new Set(intents).size).toBe(1);
    expect(await readPendingCrmCustomerProfileUpdate(scope)).toBeNull();
  });

  it("fails closed when Go profile updates have no actor and organization scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmCustomerProfileUpdate({ action: "updateProfile", customerIds: [customerId], notes: "Updated" }, undefined, true)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes saved views through Go even when the retired selector is false", async () => {
    vi.stubGlobal("__GO_CRM_VIEW_WRITES__", false);
    const viewId = dealId;
    const prior = { id: viewId, name: "Prior", filters: savedViewFilters, isShared: false, isPinned: true, createdByUserId: customerId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { viewId, previous: prior } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { id: viewId, name: "Active customers", filters: savedViewFilters, isShared: true, isPinned: false };

    await expect(submitCrmSavedViewWrite(input, undefined, crmRetryScope)).resolves.toEqual({ kind: "completed", data: { viewId, previous: prior } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "crm.saveCustomerView",
      input,
      intentId: expect.any(String),
    });
    await expect(readPendingCrmSavedViewWrite(crmRetryScope)).resolves.toBeNull();
  });

  it("retries an uncertain saved-view write with its exact intent and never uses legacy", async () => {
    vi.stubGlobal("__GO_CRM_VIEW_WRITES__", false);
    let attemptCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attemptCount += 1;
      if (attemptCount === 1) throw new TypeError("connection reset");
      if (attemptCount === 2) return Response.json({ pendingApproval: true, error: "Owner approval required" }, { status: 202 });
      return Response.json({ ok: true, data: { viewId: dealId, previous: null } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { name: "Active customers", filters: savedViewFilters, isShared: true, isPinned: false };

    await expect(submitCrmSavedViewWrite(input, undefined, crmRetryScope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    await expect(readPendingCrmSavedViewWrite(crmRetryScope)).resolves.toMatchObject({ action: "saveCustomerView", ...input });
    await expect(submitCrmSavedViewWrite(input, undefined, crmRetryScope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitCrmSavedViewWrite(input, undefined, crmRetryScope)).resolves.toMatchObject({ kind: "completed" });

    const goCalls = fetchMock.mock.calls;
    expect(goCalls).toHaveLength(3);
    expect(goCalls.every(([path]) => path === "/api/capabilities/execute")).toBe(true);
    expect(new Set(goCalls.map(([, init]) => JSON.parse(String(init?.body)).intentId)).size).toBe(1);
    await expect(readPendingCrmSavedViewWrite(crmRetryScope)).resolves.toBeNull();
  });

  it("does not fall back to the legacy saved-view route when Go returns 404", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmSavedViewWrite({ name: "Active", filters: savedViewFilters, isShared: true, isPinned: false }, undefined, crmRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute"]);
    await expect(readPendingCrmSavedViewWrite(crmRetryScope)).resolves.toMatchObject({ name: "Active" });
  });

  it("serializes concurrent saved-view reservations by retry key", async () => {
    let releaseFirst!: () => void;
    let firstRequested!: () => void;
    let secondRequested!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstRequest = new Promise<void>((resolve) => { firstRequested = resolve; });
    const secondRequest = new Promise<void>((resolve) => { secondRequested = resolve; });
    const tails = new Map<string, Promise<void>>();
    const lockNames: string[] = [];
    let requests = 0;
    const locks = {
      request: async <T,>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
        lockNames.push(name);
        const requestIndex = requests++;
        if (requestIndex === 0) firstRequested();
        if (requestIndex === 1) secondRequested();
        const previous = tails.get(name) ?? Promise.resolve();
        let release = (): void => {};
        const current = new Promise<void>((resolve) => { release = resolve; });
        tails.set(name, current);
        await previous;
        try {
          if (requestIndex === 0) await gate;
          return await callback();
        } finally {
          release();
          if (tails.get(name) === current) tails.delete(name);
        }
      },
    };
    const testNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(testNavigator, "locks", { configurable: true, value: locks });
    vi.stubGlobal("navigator", testNavigator);
    const fetchMock = vi.fn(async () => Response.json({ pendingApproval: true, error: "Owner approval required" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const firstAction = { name: "Active customers", filters: savedViewFilters, isShared: true, isPinned: false };
    const secondAction = { ...firstAction, name: "Inactive customers" };

    const first = submitCrmSavedViewWrite(firstAction, undefined, crmRetryScope);
    await firstRequest;
    const second = submitCrmSavedViewWrite(secondAction, undefined, crmRetryScope);
    await secondRequest;
    expect(fetchMock).not.toHaveBeenCalled();
    releaseFirst();

    await expect(first).resolves.toMatchObject({ kind: "pending" });
    await expect(second).rejects.toThrow(/previous CRM result is unresolved/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lockNames).toHaveLength(2);
    expect(lockNames[0]).toBe(lockNames[1]);
    await expect(readPendingCrmSavedViewWrite(crmRetryScope)).resolves.toMatchObject(firstAction);
  });

  it("does not let a delayed saved-view response clear a newer intent marker", async () => {
    let resolveFirst!: (response: Response) => void;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const fetchMock = vi.fn(() => {
      requestStarted();
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { name: "Active customers", filters: savedViewFilters, isShared: true, isPinned: false };
    const delayed = submitCrmSavedViewWrite(action, undefined, crmRetryScope);
    await started;
    const storageKey = window.localStorage.key(0);
    expect(storageKey).not.toBeNull();
    const original = JSON.parse(window.localStorage.getItem(storageKey!) ?? "null") as { intentId: string; fingerprint: string; action: unknown };
    const newerIntentId = crypto.randomUUID();
    window.localStorage.setItem(storageKey!, JSON.stringify({ ...original, intentId: newerIntentId }));

    resolveFirst(Response.json({ ok: true, data: { viewId: dealId, previous: null } }));
    await expect(delayed).resolves.toMatchObject({ kind: "completed" });
    const remaining = JSON.parse(window.localStorage.getItem(storageKey!) ?? "null") as { intentId: string; fingerprint: string; action: unknown };
    expect(remaining).toEqual({ ...original, intentId: newerIntentId });
    await expect(readPendingCrmSavedViewWrite(crmRetryScope)).resolves.toMatchObject(action);
  });

  it("compares saved-view retry fingerprints before clearing a marker", async () => {
    let resolveFirst!: (response: Response) => void;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const fetchMock = vi.fn(() => {
      requestStarted();
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { name: "Active customers", filters: savedViewFilters, isShared: true, isPinned: false };
    const delayed = submitCrmSavedViewWrite(action, undefined, crmRetryScope);
    await started;
    const storageKey = window.localStorage.key(0);
    expect(storageKey).not.toBeNull();
    const original = JSON.parse(window.localStorage.getItem(storageKey!) ?? "null") as { intentId: string; fingerprint: string; action: unknown };
    const newerFingerprint = "f".repeat(64);
    window.localStorage.setItem(storageKey!, JSON.stringify({ ...original, fingerprint: newerFingerprint }));

    resolveFirst(Response.json({ ok: true, data: { viewId: dealId, previous: null } }));
    await expect(delayed).resolves.toMatchObject({ kind: "completed" });
    const remaining = JSON.parse(window.localStorage.getItem(storageKey!) ?? "null") as { intentId: string; fingerprint: string; action: unknown };
    expect(remaining).toEqual({ ...original, fingerprint: newerFingerprint });
  });

  it("fails closed when browser-wide CRM attempt locks are unavailable", async () => {
    vi.stubGlobal("navigator", {} as Navigator);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmSavedViewWrite({ name: "Active", filters: savedViewFilters, isShared: true, isPinned: false }, undefined, crmRetryScope))
      .rejects.toThrow(/cannot safely coordinate CRM changes across tabs/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});
