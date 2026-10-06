import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmApiError, fetchCrmDeals, fetchCrmFollowUpDraft, fetchCrmTimeline, importCrmCustomers, readPendingCrmCustomerCreate, readPendingCrmCustomerProfileUpdate, readPendingCrmDealCreate, readPendingCrmTaskCreate, readPendingCrmTaskDetails, readPendingCrmTaskDetailsForScope, submitCrmAction, submitCrmCustomerCreate, submitCrmCustomerProfileUpdate, submitCrmDealCreate, submitCrmDealStageMove, submitCrmTaskMutation, undoCrmImport } from "./crm";

const dealId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const customerId = "2beae091-6921-4e49-97b1-5049196e0ac5";

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("CRM API client", () => {
  it("validates the legacy deals list and carries the same-origin session", async () => {
    const deal = { id: dealId, title: "Renewal", stage: "proposal", valueMinor: 250000, note: null, customerId, customerName: "Northwind", updatedAt: "2026-09-29T12:00:00.000Z" };
    const fetchMock = vi.fn(async () => Response.json({ deals: [deal] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmDeals()).resolves.toEqual([deal]);
    expect(fetchMock).toHaveBeenCalledWith("/api/deals", expect.objectContaining({ credentials: "same-origin", headers: { accept: "application/json" }, signal: expect.any(AbortSignal) }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ deals: [{ id: dealId }] })));
    await expect(fetchCrmDeals()).rejects.toBeInstanceOf(CrmApiError);
  });

  it("encodes the customer timeline identifier and validates the timeline result", async () => {
    const fetchMock = vi.fn(async () => Response.json({ entries: [{ kind: "invoice", date: "2026-09-29T12:00:00.000Z", refId: dealId, summary: "Invoice #1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCrmTimeline(customerId)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/crm?timeline=${customerId}`, expect.objectContaining({ credentials: "same-origin" }));
    await expect(fetchCrmTimeline("bad-id")).rejects.toMatchObject({ name: "CrmApiError" });
  });

  it("surfaces pending approvals without treating them as completed writes", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmAction("/api/deals", { action: "move", dealId, stage: "won" })).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ action: "move", dealId, stage: "won", intentId: expect.any(String) });
  });

  it("routes only a Go-enabled stage move through crm.moveDealStage", async () => {
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

    const legacyFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { moved: true, stage: "qualified" } }));
    vi.stubGlobal("fetch", legacyFetch);
    await submitCrmDealStageMove({ dealId, stage: "qualified" }, undefined, false);
    expect(legacyFetch.mock.calls[0]?.[0]).toBe("/api/deals");
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

  it("reuses an intent when a missing Go route falls back to legacy", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { moved: true, stage: "proposal" } }));
    vi.stubGlobal("fetch", fetchMock);

    await submitCrmDealStageMove({ dealId, stage: "proposal" }, undefined, true, { actorId: customerId, organizationId: dealId });
    const goBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const legacyBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/deals"]);
    expect(legacyBody).toMatchObject({ action: "move", dealId, stage: "proposal", intentId: goBody.intentId });
  });

  it("routes deal creation through Go and strictly validates the deal ID", async () => {
    const input = { title: "Renewal", valueMinor: 25_500, customerId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmDealCreate(input, undefined, true, { actorId: customerId, organizationId: dealId })).resolves.toEqual({ kind: "completed", data: { dealId } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createDeal", input, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId, extra: true } })));
    await expect(submitCrmDealCreate(input, undefined, true, { actorId: customerId, organizationId: dealId })).rejects.toMatchObject({ name: "CrmApiError", message: "The CRM service returned an unexpected deal result." });
  });

  it("restores exact deal drafts and reuses intent through pending, uncertainty, and same-intent 404 fallback", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const input = { title: "Renewal", valueMinor: 25_500, customerId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmDealCreate(input, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmDealCreate(scope)).resolves.toEqual(input);
    const intentId = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    await expect(submitCrmDealCreate(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });

    const legacyFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }))
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { dealId } }));
    vi.stubGlobal("fetch", legacyFetch);
    await expect(submitCrmDealCreate(input, undefined, true, scope)).resolves.toEqual({ kind: "completed", data: { dealId } });
    const goBody = JSON.parse(String(legacyFetch.mock.calls[0]?.[1]?.body));
    const legacyBody = JSON.parse(String(legacyFetch.mock.calls[1]?.[1]?.body));
    expect(legacyFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/deals"]);
    expect(goBody.intentId).toBe(intentId);
    expect(legacyBody).toMatchObject({ action: "create", ...input, intentId });
    await expect(readPendingCrmDealCreate(scope)).resolves.toBeNull();
  });

  it("fails closed for deal creation without scope and blocks changed drafts after an uncertain result", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const input = { title: "Renewal", valueMinor: 25_500 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } })).mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmDealCreate(input, undefined, true)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(submitCrmDealCreate(input, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    await expect(submitCrmDealCreate({ ...input, title: "Changed" }, undefined, true, scope)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy deal creation on /api/deals when Go is disabled", async () => {
    const input = { title: "Renewal", valueMinor: 25_500, customerId };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { dealId } }));
    vi.stubGlobal("fetch", fetchMock);
    await submitCrmDealCreate(input, undefined, false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/deals");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: "create", ...input, intentId: expect.any(String) });
  });

  it("routes task creation and completion through strict Go capability outputs", async () => {
    const taskId = "77e93149-61d7-48ed-929d-754ddfa263b1";
    const scope = { actorId: customerId, organizationId: dealId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { completed: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer", note: "Discuss renewal", refType: "customer", refId: customerId }, undefined, true, scope)).resolves.toEqual({ kind: "completed", data: { taskId } });
    await expect(submitCrmTaskMutation({ action: "completeTask", taskId }, undefined, true, scope)).resolves.toEqual({ kind: "completed", data: { completed: true } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createTask", input: { title: "Call customer", note: "Discuss renewal", refType: "customer", refId: customerId }, intentId: expect.any(String) });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ capabilityId: "crm.completeTask", input: { taskId }, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { taskId, extra: true } })));
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, true, scope)).rejects.toMatchObject({ name: "CrmApiError", message: "The CRM service returned an unexpected task result." });
  });

  it("routes task detail updates through Go and keeps the exact pending payload when the Go route is missing", async () => {
    const taskId = "77e93149-61d7-48ed-929d-754ddfa263b1";
    const assigneeUserId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const scope = { actorId: customerId, organizationId: dealId };
    const action = { action: "updateTaskDetails" as const, taskId, dueAt: null, assigneeUserId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId, previous: { dueAt: "2026-10-15T12:00:00.000Z", assigneeUserId: null } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation(action, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmTaskDetails(scope, taskId)).resolves.toEqual(action);
    await expect(readPendingCrmTaskDetailsForScope(scope)).resolves.toEqual([action]);
    await expect(submitCrmTaskMutation(action, undefined, true, scope)).rejects.toMatchObject({
      status: 404,
      requestMayHaveReachedServer: true,
      message: "The Go CRM task route is unavailable. Ask an administrator to check the Go task route configuration.",
    });

    const goBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(goBody).toMatchObject({ capabilityId: "crm.updateTaskDetails", input: { taskId, dueAt: null, assigneeUserId }, intentId: expect.any(String) });
    expect(retryBody.intentId).toBe(goBody.intentId);
    await expect(readPendingCrmTaskDetails(scope, taskId)).resolves.toEqual(action);
    await expect(readPendingCrmTaskDetailsForScope(scope)).resolves.toEqual([action]);

    await submitCrmTaskMutation(action, undefined, true, scope);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).intentId).toBe(goBody.intentId);
    await expect(readPendingCrmTaskDetails(scope, taskId)).resolves.toBeNull();
    await expect(readPendingCrmTaskDetailsForScope(scope)).resolves.toEqual([]);

    const otherTaskId = "4d906ed9-70da-4e66-a8e7-a192cfaf42db";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { taskId: otherTaskId, previous: { dueAt: null, assigneeUserId: null } } })));
    await expect(submitCrmTaskMutation(action, undefined, true, scope)).rejects.toMatchObject({ message: "The CRM service returned an unexpected task result." });
    await expect(readPendingCrmTaskDetails(scope, taskId)).resolves.toEqual(action);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { taskId, previous: { dueAt: null, assigneeUserId: null }, extra: true } })));
    await expect(submitCrmTaskMutation(action, undefined, true, scope)).rejects.toMatchObject({ message: "The CRM service returned an unexpected task result." });
  });

  it("retains the exact create-task draft and intent while pending and fails closed on a missing Go route", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const action = { action: "createTask" as const, title: "Prepare renewal notes", dueAt: "2026-10-15T12:00:00.000Z", note: "Include updated terms", refType: "customer", refId: customerId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation(action, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmTaskCreate(scope)).resolves.toEqual(action);
    const pendingIntentId = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    const goFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", goFetch);
    await expect(submitCrmTaskMutation(action, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    const goBody = JSON.parse(String(goFetch.mock.calls[0]?.[1]?.body));
    expect(goFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
    expect(goBody.intentId).toBe(pendingIntentId);
    await expect(readPendingCrmTaskCreate(scope)).resolves.toEqual(action);

    await submitCrmTaskMutation(action, undefined, true, scope);
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

    await expect(submitCrmTaskMutation({ action: "completeTask", taskId }, undefined, true, scope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute"]);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    await submitCrmTaskMutation({ action: "completeTask", taskId }, undefined, true, scope);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId).toBe(first.intentId);
  });

  it("fails closed on missing scope and does not rotate task intents after uncertainty or for changed drafts", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, true)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, true, scope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    await expect(submitCrmTaskMutation({ action: "createTask", title: "Different title" }, undefined, true, scope)).rejects.toMatchObject({ status: 0 });
    await submitCrmTaskMutation({ action: "createTask", title: "Call customer" }, undefined, true, scope);
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

  it("restores customer drafts and keeps the same intent through pending, uncertain response, and 404 fallback", async () => {
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

    const legacyFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { customerId, duplicateWarning: null } }));
    vi.stubGlobal("fetch", legacyFetch);
    await expect(submitCrmCustomerCreate(input, undefined, true, scope)).resolves.toMatchObject({ kind: "completed", data: { customerId, duplicateWarning: null } });
    const goBody = JSON.parse(String(legacyFetch.mock.calls[0]?.[1]?.body));
    const legacyBody = JSON.parse(String(legacyFetch.mock.calls[1]?.[1]?.body));
    expect(legacyFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/customers"]);
    expect(goBody.intentId).toBe(pendingIntentId);
    expect(legacyBody).toMatchObject({ action: "create", ...input, intentId: pendingIntentId });
    await expect(readPendingCrmCustomerCreate(scope)).resolves.toBeNull();
  });

  it("fails closed for customer creation without actor and organization scope", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { customerId, duplicateWarning: null } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmCustomerCreate({ name: "Northwind", preferredContactMethod: "email", doNotContact: false }, undefined, true)).rejects.toMatchObject({ name: "CrmApiError", status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only the established envelope for saved-view writes", async () => {
    const viewId = "8ea6ef66-d321-4be4-a4ee-32fa0b13e5f9";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { viewId, previous: null } })));
    await expect(submitCrmAction("/api/crm/views", { name: "Active accounts" })).resolves.toEqual({
      kind: "completed",
      data: { viewId, previous: null },
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ viewId, previous: null })));
    await expect(submitCrmAction("/api/crm/views", { name: "Active accounts" })).rejects.toMatchObject({
      name: "CrmApiError",
      message: "The CRM service returned an unexpected action response.",
    });
  });

  it("imports and undoes customer batches using the existing import contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ inserted: 1, skippedDuplicates: 2, createdIds: [customerId], errors: [] }))
      .mockResolvedValueOnce(Response.json({ undone: 1, remaining: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(importCrmCustomers([{ rowNumber: 2, name: "Northwind", allowDuplicate: false }])).resolves.toEqual({ kind: "completed", data: { inserted: 1, skippedDuplicates: 2, createdIds: [customerId], errors: [] } });
    await expect(undoCrmImport([customerId])).resolves.toEqual({ kind: "completed", data: { undone: 1, remaining: 0 } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/import", "/api/import"]);
  });

  it("validates approval responses for customer import and undo", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Import needs approval" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ error: "Undo needs approval" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Undo needs approval" }, { status: 202 })));

    await expect(importCrmCustomers([{ rowNumber: 2, name: "Northwind", allowDuplicate: false }])).resolves.toEqual({
      kind: "pending",
      reason: "Import needs approval",
    });
    await expect(importCrmCustomers([{ rowNumber: 2, name: "Northwind", allowDuplicate: false }])).rejects.toMatchObject({
      name: "CrmApiError",
      message: "The import service returned an unexpected approval response.",
    });
    await expect(undoCrmImport([customerId])).rejects.toMatchObject({
      name: "CrmApiError",
      message: "The import service returned an unexpected undo approval response.",
    });
    await expect(undoCrmImport([customerId])).resolves.toEqual({
      kind: "pending",
      reason: "Undo needs approval",
    });
  });

  it("requests the existing AI follow-up draft action and validates its grounded sources", async () => {
    const draft = { draft: "Hello Northwind, should we review the invoice together?", sources: [{ kind: "invoice", date: "2026-09-20T12:00:00.000Z", refId: dealId, summary: "Invoice #7 is awaiting payment" }] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(draft));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCrmFollowUpDraft(customerId)).resolves.toEqual(draft);
    expect(fetchMock).toHaveBeenCalledWith("/api/crm", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ action: "draftFollowUp", customerId });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ draft: "Only a draft" })));
    await expect(fetchCrmFollowUpDraft(customerId)).rejects.toMatchObject({ name: "CrmApiError" });
  });

  it("routes profile updates through Go and strictly validates previous snapshots", async () => {
    const previous = { customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { updatedCount: 1, previous: [previous] } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { action: "updateProfile" as const, customerIds: [customerId], name: "Northwind Ltd", phone: null, notes: "Updated note", ownerUserId: null, addTags: ["priority"], removeTags: ["renewal"], doNotContact: true, preferredContactMethod: "whatsapp" as const };

    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, { actorId: customerId, organizationId: dealId })).resolves.toEqual({ kind: "completed", data: { updatedCount: 1, previous: [previous] } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.updateCustomerProfiles", input: { customerIds: [customerId], name: "Northwind Ltd" }, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { updatedCount: 1, previous: [{}] } })));
    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, { actorId: customerId, organizationId: dealId })).rejects.toMatchObject({ requestMayHaveReachedServer: true });
  });

  it("keeps an exact profile action through pending and uncertainty and uses the same intent on 404 fallback", async () => {
    const previous = { customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Approval required" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(Response.json({ error: "Route not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { updatedCount: 1, previous: [previous] } }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: customerId, organizationId: dealId };
    const input = { action: "updateProfile" as const, customerIds: [customerId], name: "Northwind Ltd" };

    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, scope)).resolves.toMatchObject({ kind: "pending" });
    await expect(readPendingCrmCustomerProfileUpdate(scope)).resolves.toEqual(input);
    await expect(submitCrmCustomerProfileUpdate({ ...input, name: "Changed payload" }, undefined, true, scope)).rejects.toMatchObject({ status: 0 });
    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, scope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    await expect(submitCrmCustomerProfileUpdate(input, undefined, true, scope)).resolves.toMatchObject({ kind: "completed" });

    const goCall = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const fallbackCall = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as { intentId: string; action: string };
    expect(fallbackCall).toMatchObject({ action: "updateProfile", intentId: goCall.intentId });
    expect(await readPendingCrmCustomerProfileUpdate(scope)).toBeNull();
  });

  it("fails closed when Go profile updates have no actor and organization scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitCrmCustomerProfileUpdate({ action: "updateProfile", customerIds: [customerId], notes: "Updated" }, undefined, true)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
