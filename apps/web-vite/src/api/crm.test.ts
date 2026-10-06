import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmApiError, fetchCrmDeals, fetchCrmFollowUpDraft, fetchCrmTimeline, importCrmCustomers, readPendingCrmTaskCreate, submitCrmAction, submitCrmDealStageMove, submitCrmTaskMutation, undoCrmImport } from "./crm";

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

  it("retains the exact create-task draft and intent while pending, after reload, and on 404 fallback", async () => {
    const scope = { actorId: customerId, organizationId: dealId };
    const action = { action: "createTask" as const, title: "Prepare renewal notes", dueAt: "2026-10-15T12:00:00.000Z", note: "Include updated terms", refType: "customer", refId: customerId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitCrmTaskMutation(action, undefined, true, scope)).resolves.toEqual({ kind: "pending", reason: "Manager approval required" });
    await expect(readPendingCrmTaskCreate(scope)).resolves.toEqual(action);
    const pendingIntentId = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId;
    const legacyFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { taskId: "77e93149-61d7-48ed-929d-754ddfa263b1" } }));
    vi.stubGlobal("fetch", legacyFetch);
    await submitCrmTaskMutation(action, undefined, true, scope);
    const goBody = JSON.parse(String(legacyFetch.mock.calls[0]?.[1]?.body));
    const legacyBody = JSON.parse(String(legacyFetch.mock.calls[1]?.[1]?.body));
    expect(legacyFetch.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities/execute", "/api/crm"]);
    expect(goBody.intentId).toBe(pendingIntentId);
    expect(legacyBody).toMatchObject({ ...action, intentId: goBody.intentId });
    await expect(readPendingCrmTaskCreate(scope)).resolves.toBeNull();
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
});
