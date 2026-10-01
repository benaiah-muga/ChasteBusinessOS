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

describe("documents API client", () => {
  it("checks the Documents module before loading protected records", async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalog: [{ id: "documents" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDocumentsEnabled()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("loads the existing document library contract with the signed-in same-origin session", async () => {
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
