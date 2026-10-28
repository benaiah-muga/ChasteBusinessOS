import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchExceptions, OperationsApiError, saveException } from "./operations";

const scope = {
  actorId: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
};
const record = {
  id: "30000000-0000-4000-8000-000000000001",
  kind: "exception",
  stableKey: "signal:inventory.reorder:SKU-1",
  status: "open",
  title: "SKU-1 is below its reorder point",
  summary: "5.000 on hand against a reorder point of 5.000.",
  details: { severity: "orange", module: "inventory" },
  revision: 1,
  authorityRef: null,
  approvalId: null,
  ownerUserId: null,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  resolvedAt: null,
};
const write = {
  stableKey: record.stableKey,
  status: "acknowledged" as const,
  title: record.title,
  summary: record.summary,
  details: record.details,
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("operations exception client", () => {
  it("lists saved exceptions through the governed read capability", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { records: [record] } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchExceptions()).resolves.toEqual([record]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "operations.listRecords",
      input: { kind: "exception", limit: 100 },
    });
  });

  it("writes an exception with a stable intent and returns the stored record", async () => {
    const acknowledged = { ...record, status: "acknowledged", ownerUserId: scope.actorId, revision: 2 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: acknowledged }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveException({ ...write, ownerUserId: scope.actorId }, scope)).resolves.toEqual({ kind: "completed", record: acknowledged });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      capabilityId: "operations.upsertRecord",
      input: {
        kind: "exception",
        stableKey: record.stableKey,
        status: "acknowledged",
        ownerUserId: scope.actorId,
      },
    });
    expect(body.intentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the saved intent after an uncertain failure so a retry cannot duplicate the record", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { ...record, status: "acknowledged" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveException(write, scope)).rejects.toMatchObject({ name: "OperationsApiError", status: 503 });
    await expect(saveException(write, scope)).resolves.toMatchObject({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(second.intentId).toBe(first.intentId);
    expect(window.localStorage.length).toBe(0);
  });

  it("refuses to update an exception without an actor scope", async () => {
    await expect(saveException(write, { actorId: null, organizationId: scope.organizationId })).rejects.toBeInstanceOf(OperationsApiError);
  });
});
