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
};

describe("documents API client", () => {
  it("checks the Documents module before loading protected records", async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalog: [{ id: "documents" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentsEnabled()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("loads the existing document library contract with the signed-in same-origin session", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", false);
    const fetchMock = vi.fn(async () => Response.json({ documents: [row], vendors: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocuments()).resolves.toEqual([row]);
    expect(fetchMock).toHaveBeenCalledWith("/api/documents", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }));
  });

  it("encodes the selected document id and validates the existing detail response", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", false);
    const document = {
      ...row,
      mimeType: "application/pdf",
      sizeBytes: 240,
      parseError: null,
      parsedMarkdown: "Invoice number: 42",
    };
    const fetchMock = vi.fn(async () => Response.json({ document }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail("doc / 1")).resolves.toEqual(document);
    expect(fetchMock).toHaveBeenCalledWith("/api/documents?id=doc%20%2F%201&preview=1", expect.any(Object));
  });

  it("loads the list through the Go capability with exact input and validates its envelope", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
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

  it("loads preview detail through Go without requesting suggestions or content", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { document: goDetail } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail(goDocumentId)).resolves.toEqual(goDetail);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ capabilityId: "documents.listIngestedDocuments", input: { id: goDocumentId, preview: true }, intentId: expect.any(String) });
    expect(JSON.stringify(request)).not.toContain("suggestions");
    expect(JSON.stringify(request)).not.toContain("base64");
  });

  it("does not fall back to the legacy documents route after a selected Go error or malformed output", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
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

  it("rejects Go preview details that expose suggestions or extra fields", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { document: { ...goDetail, suggestions: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail(goDocumentId)).rejects.toMatchObject({
      name: "DocumentsApiError",
      status: 200,
      message: expect.stringContaining("unexpected format"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps selected Go detail failures on the capability route without a legacy retry", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentDetail(goDocumentId)).rejects.toMatchObject({ name: "DocumentsApiError", status: 404 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("rejects malformed payloads and keeps permission errors understandable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ documents: [{ id: "doc-1" }] })));
    await expect(fetchDocuments()).rejects.toEqual(expect.objectContaining({
      name: "DocumentsApiError",
      message: "The documents service returned data in an unexpected format.",
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })));
    await expect(fetchDocuments()).rejects.toEqual(new DocumentsApiError(403, "You do not have permission to view these documents."));
  });
});
