import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentFolder,
  deleteIngestedDocument,
  deleteDocumentFolder,
  DocumentsLibraryApiError,
  fetchAuthoredDocuments,
  fetchDocumentFolders,
  fetchDocumentTemplates,
  pendingIngestedDocumentDeletion,
  renameDocumentFolder,
  searchDocumentRecords,
} from "./documents-library";

const actorId = "Ruy2DBncwmLOJWfeGyXMnhp5vOyqsz9U";
const organizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const authored = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  title: "Consulting proposal",
  status: "draft",
  versions: 1,
  templateId: null,
  folder: "Sales",
  documentType: "proposal",
  linkedRecordType: null,
  linkedRecordId: null,
  linkedRecordLabel: null,
  updatedAt: "2026-10-01T10:00:00.000Z",
};

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function organizationHeaderOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("X-Organization-ID");
}

function stubWebLocks() {
  vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
}

describe("Go document library capability client", () => {
  it("loads the authored document list from its strict Go capability contract", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { documents: [authored] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAuthoredDocuments()).resolves.toEqual([authored]);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ capabilityId: "documents.listDocs", input: {}, intentId: expect.any(String) });
  });

  it("rejects extra authored-list fields instead of accepting a mismatched Go response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { documents: [{ ...authored, html: "<p>unexpected</p>" }] } })));
    await expect(fetchAuthoredDocuments()).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected format") });
  });

  it("lists folders and searches records through their scoped Go capabilities", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      const request = bodyOf(init);
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [{ id: authored.id, path: "Sales" }] } });
      return Response.json({ ok: true, data: { records: [{ id: authored.id, label: "Ada Lovelace", detail: "ada@example.test", values: { "customer.name": "Ada Lovelace" } }] } });
    }));

    await expect(fetchDocumentFolders()).resolves.toEqual([{ id: authored.id, path: "Sales" }]);
    await expect(searchDocumentRecords("customer", " Ada ")).resolves.toEqual([{ id: authored.id, label: "Ada Lovelace", detail: "ada@example.test", values: { "customer.name": "Ada Lovelace" } }]);
    expect(calls.map((init) => bodyOf(init))).toMatchObject([
      { capabilityId: "documents.listFolders", input: {} },
      { capabilityId: "documents.searchRecords", input: { type: "customer", query: "Ada" } },
    ]);
  });

  it("loads strict template rows from Go and accepts empty lists", async () => {
    const template = { id: authored.id, name: "Quote", description: "Sales quote", placeholders: ["customer.name"], isSystem: null, content: { type: "doc", content: [{ type: "paragraph" }] } };
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({ ok: true, data: { templates: [template] } });
    }));

    await expect(fetchDocumentTemplates()).resolves.toEqual([template]);
    expect(bodyOf(calls[0])).toMatchObject({ capabilityId: "documents.listTemplates", input: {} });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { templates: [] } })));
    await expect(fetchDocumentTemplates()).resolves.toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { templates: [{ ...template, unexpected: true }] } })));
    await expect(fetchDocumentTemplates()).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected format") });
  });

  it("preserves the same intent when a folder create response is lost", async () => {
    stubWebLocks();
    const requests: Array<{ body: Record<string, unknown>; init?: RequestInit }> = [];
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: bodyOf(init), init });
      attempt += 1;
      if (attempt === 1) throw new TypeError("connection reset");
      return Response.json({ ok: true, data: { folderId: authored.id, path: "Sales/Quotes" } });
    }));
    const scope = { actorId, organizationId };

    await expect(createDocumentFolder("Sales/Quotes", scope)).rejects.toBeInstanceOf(DocumentsLibraryApiError);
    await expect(createDocumentFolder("Sales/Quotes", scope)).resolves.toMatchObject({ kind: "completed", data: { path: "Sales/Quotes" } });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.intentId).toBe(requests[1]?.body.intentId);
    expect(requests.every((request) => organizationHeaderOf(request.init) === organizationId)).toBe(true);
  });

  it("routes folder rename and delete through governed Go writes with strict result shapes", async () => {
    stubWebLocks();
    const requests: Array<{ body: Record<string, unknown>; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = bodyOf(init);
      requests.push({ body: request, init });
      if (request.capabilityId === "documents.renameFolder") return Response.json({ ok: true, data: { path: "Sales", movedTo: "Commercial" } });
      return Response.json({ ok: true, data: { deleted: true, path: "Commercial" } });
    }));

    await expect(renameDocumentFolder("Sales", "Commercial", { actorId, organizationId })).resolves.toMatchObject({ kind: "completed" });
    await expect(deleteDocumentFolder("Commercial", { actorId, organizationId })).resolves.toMatchObject({ kind: "completed" });
    expect(requests.map((request) => request.body.capabilityId)).toEqual(["documents.renameFolder", "documents.deleteFolder"]);
    expect(requests.every((request) => typeof request.body.intentId === "string")).toBe(true);
    expect(requests.every((request) => organizationHeaderOf(request.init) === organizationId)).toBe(true);
  });

  it("deletes an ingested record through Go with the same intent after a lost response", async () => {
    stubWebLocks();
    const requests: Array<{ body: Record<string, unknown>; init?: RequestInit }> = [];
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: bodyOf(init), init });
      attempt += 1;
      if (attempt === 1) throw new TypeError("connection reset");
      return Response.json({ ok: true, data: { deleted: true } });
    }));

    await expect(deleteIngestedDocument(authored.id, { actorId, organizationId })).rejects.toBeInstanceOf(DocumentsLibraryApiError);
    await expect(pendingIngestedDocumentDeletion({ actorId, organizationId })).resolves.toEqual({ documentId: authored.id, actorId, organizationId });
    await expect(deleteIngestedDocument(authored.id, { actorId, organizationId })).resolves.toMatchObject({ kind: "completed", data: { deleted: true } });
    await expect(pendingIngestedDocumentDeletion({ actorId, organizationId })).resolves.toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests.map(({ body }) => body)).toMatchObject([
      { capabilityId: "documents.deleteDocument", input: { documentId: authored.id }, intentId: expect.any(String) },
      { capabilityId: "documents.deleteDocument", input: { documentId: authored.id }, intentId: expect.any(String) },
    ]);
    expect(requests[0]?.body.intentId).toBe(requests[1]?.body.intentId);
    expect(requests.every(({ init }) => organizationHeaderOf(init) === organizationId)).toBe(true);
  });

  it("rejects invalid ingested document IDs before sending a delete", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => deleteIngestedDocument("bad-id", { actorId, organizationId })).toThrow(/invalid ID/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
