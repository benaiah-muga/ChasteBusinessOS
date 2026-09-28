import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmApiError, fetchCrmDeals, fetchCrmFollowUpDraft, fetchCrmTimeline, importCrmCustomers, submitCrmAction, undoCrmImport } from "./crm";

const dealId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const customerId = "2beae091-6921-4e49-97b1-5049196e0ac5";

afterEach(() => vi.unstubAllGlobals());

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

  it("imports and undoes customer batches using the existing import contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ inserted: 1, skippedDuplicates: 2, createdIds: [customerId], errors: [] }))
      .mockResolvedValueOnce(Response.json({ undone: 1, remaining: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(importCrmCustomers([{ rowNumber: 2, name: "Northwind", allowDuplicate: false }])).resolves.toEqual({ kind: "completed", data: { inserted: 1, skippedDuplicates: 2, createdIds: [customerId], errors: [] } });
    await expect(undoCrmImport([customerId])).resolves.toEqual({ kind: "completed", data: { undone: 1, remaining: 0 } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/import", "/api/import"]);
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
