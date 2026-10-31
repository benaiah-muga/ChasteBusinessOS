import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsApiError, fetchDocumentDetail, fetchDocuments, fetchDocumentsEnabled } from "./documents";

afterEach(() => vi.unstubAllGlobals());

const row = {
  id: "doc-1",
  title: "Supplier invoice",
  status: "parsed",
  sourceType: "upload",
  createdAt: "2026-09-28T10:00:00.000Z",
  folder: "Finance",
};
const goDocumentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const goRow = { ...row, id: goDocumentId };
const goEarlierRow = { ...row, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Earlier receipt", createdAt: "2026-09-27T08:00:00.000Z" };
const goDetail = {
  ...goRow,
  mimeType: "application/pdf",
  sizeBytes: 240,
  parseError: null,
  parsedMarkdown: "Invoice number: 42",
  refType: null,
  refId: null,
  linkedBillNumber: null,
  suggestions: [],
};
const goSuggestion = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  orgId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  documentId: goDocumentId,
  description: "Printer paper",
  quantityThousandths: 2000,
  unitPriceMinor: 1500,
  suggestedAccountCode: "6000",
  matchScore: 2,
  matchedOn: ["office"],
  status: "open",
  createdAt: "2026-09-28T10:00:00.000Z",
};
const moduleCatalogRow = { id: "documents", label: "Documents", description: "Ingestion and authored documents", href: "/documents" };

describe("documents API client", () => {
  it("checks the Documents module before loading protected records", async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalog: [moduleCatalogRow], enabledModules: [], usingDefaults: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentsEnabled()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ method: "GET", credentials: "same-origin" }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: [{ ...moduleCatalogRow, unexpected: true }], enabledModules: [], usingDefaults: false })));
    await expect(fetchDocumentsEnabled()).rejects.toEqual(new DocumentsApiError(200, "The module switchboard returned an unexpected response."));
  });

  it("loads the document library through Go when no route selector is present", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { documents: [goRow], vendors: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocuments()).resolves.toEqual([goRow]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }));
  });

  it("keeps document reads on Go even when the former selector is false", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { documents: [goRow] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocuments()).resolves.toEqual([goRow]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("rejects a non-UUID detail id before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail("doc / 1")).rejects.toMatchObject({ name: "DocumentsApiError", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the list through the Go capability with exact input and validates its envelope", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { documents: [goRow, goEarlierRow], vendors: [{ id: "vendor-1", name: "Vendor" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocuments()).resolves.toEqual([goRow, goEarlierRow]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }));
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ capabilityId: "documents.listIngestedDocuments", input: {}, intentId: expect.any(String) });
  });

  it("treats omitted Go list arrays as empty in an empty workspace", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocuments()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("loads detail and coding suggestions through Go without requesting file content", async () => {
    const detailWithSuggestions = { ...goDetail, suggestions: [goSuggestion] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { document: detailWithSuggestions } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail(goDocumentId)).resolves.toEqual(detailWithSuggestions);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ capabilityId: "documents.listIngestedDocuments", input: { id: goDocumentId }, intentId: expect.any(String) });
    expect(JSON.stringify(request)).not.toContain("base64");
  });

  it("treats an omitted Go suggestions field as an empty collection", async () => {
    const detailWithoutSuggestions = { ...goDetail } as Record<string, unknown>;
    delete detailWithoutSuggestions.suggestions;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { document: detailWithoutSuggestions } })));

    await expect(fetchDocumentDetail(goDocumentId)).resolves.toMatchObject({ suggestions: [] });
  });

  it("uses Go exclusively and rejects errors or malformed output", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "capability is disabled on this Go route" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { documents: [goRow], vendors: [] }, extra: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { documents: [goRow], vendors: [], unexpected: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocuments()).rejects.toMatchObject({ name: "DocumentsApiError", status: 503 });
    await expect(fetchDocuments()).rejects.toMatchObject({ name: "DocumentsApiError", status: 200, message: expect.stringContaining("unexpected response") });
    await expect(fetchDocuments()).rejects.toMatchObject({ name: "DocumentsApiError", status: 200, message: expect.stringContaining("unexpected format") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });

  it("rejects malformed Go coding suggestions and extra fields", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { document: { ...goDetail, suggestions: [{ ...goSuggestion, suggestedAccountCode: 6000 }] } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail(goDocumentId)).rejects.toMatchObject({
      name: "DocumentsApiError",
      status: 200,
      message: expect.stringContaining("unexpected format"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects Go minor-unit values that JavaScript cannot represent exactly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      data: { document: { ...goDetail, suggestions: [{ ...goSuggestion, unitPriceMinor: Number.MAX_SAFE_INTEGER + 1 }] } },
    })));

    await expect(fetchDocumentDetail(goDocumentId)).rejects.toMatchObject({
      name: "DocumentsApiError",
      status: 200,
      message: expect.stringContaining("unexpected format"),
    });
  });

  it("rejects malformed matched-on metadata from Go", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { document: { ...goDetail, suggestions: [{ ...goSuggestion, matchedOn: { unexpected: "object" } }] } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail(goDocumentId)).rejects.toMatchObject({
      name: "DocumentsApiError",
      status: 200,
      message: expect.stringContaining("unexpected format"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps Go detail failures on the capability route without fallback", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail(goDocumentId)).rejects.toMatchObject({ name: "DocumentsApiError", status: 404 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("rejects malformed payloads and keeps permission errors understandable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { documents: [{ id: "doc-1" }] } })));
    await expect(fetchDocuments()).rejects.toEqual(expect.objectContaining({
      name: "DocumentsApiError",
      message: "The Go documents service returned data in an unexpected format.",
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })));
    await expect(fetchDocuments()).rejects.toEqual(new DocumentsApiError(403, "You do not have permission to view these documents."));
  });
});
