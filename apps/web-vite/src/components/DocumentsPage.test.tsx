import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

const rows = [
  { id: "doc-1", title: "Supplier invoice", status: "parsed", sourceType: "upload", createdAt: "2026-09-28T10:00:00.000Z", folder: "Finance" },
  { id: "doc-2", title: "Warehouse notes", status: "queued", sourceType: "text", createdAt: "2026-09-27T08:00:00.000Z", folder: null },
];
const goDocumentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function detail(id: string, title: string, status: string, parsedMarkdown: string | null) {
  return {
    document: {
      ...rows.find((row) => row.id === id)!,
      title,
      status,
      mimeType: id === "doc-1" ? "application/pdf" : null,
      sizeBytes: id === "doc-1" ? 1024 : null,
      parseError: null,
      parsedMarkdown,
    },
    suggestions: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Vite documents page", () => {
  it("does not request document records when the module is disabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalog: [{ id: "documents" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Documents is turned off" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows the existing library, selected document details, extracted text, and file link", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", false);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/documents") return Response.json({ documents: rows, vendors: [] });
      if (url === "/api/documents?id=doc-2&preview=1") return Response.json(detail("doc-2", "Warehouse notes", "queued", null));
      return Response.json(detail("doc-1", "Supplier invoice", "parsed", "Invoice number: 42"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Documents" })).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Supplier invoice" })).not.toBeNull();
    expect(screen.getByText("Invoice number: 42")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open uploaded file" }).getAttribute("href")).toBe("/api/go/documents/doc-1/content");
    expect(fetchMock).toHaveBeenCalledWith("/api/documents?id=doc-1&preview=1", expect.any(Object));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "warehouse" } });
    expect(screen.getByRole("button", { name: /Warehouse notes/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Supplier invoice/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Warehouse notes/ }));
    expect(await screen.findByText("Text extraction is in progress.")).not.toBeNull();
  });

  it("selects the document identified by the Vite documentId query", async () => {
    window.history.replaceState(null, "", "/documents?documentId=doc-2");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/documents") return Response.json({ documents: rows, vendors: [] });
      if (url === "/api/documents?id=doc-2&preview=1") return Response.json(detail("doc-2", "Warehouse notes", "queued", null));
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Warehouse notes" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Warehouse notes/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Supplier invoice/ }).getAttribute("aria-current")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/documents?id=doc-2&preview=1", expect.any(Object));
  });

  it("validates documentId and shows a not-found state without selecting the first row", async () => {
    window.history.replaceState(null, "", "/documents?documentId=unsafe%2Fid");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/documents") return Response.json({ documents: rows, vendors: [] });
      return Response.json({ error: "unexpected detail request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Invalid document link" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Back to document library" }).getAttribute("href")).toBe("/documents");
    expect(screen.queryByRole("heading", { name: "Supplier invoice" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("preview=1"))).toBe(false);

    cleanup();
    window.history.replaceState(null, "", `/documents?documentId=${goDocumentId}`);
    const notFoundFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/documents") return Response.json({ documents: rows, vendors: [] });
      return Response.json({ error: "unexpected detail request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", notFoundFetch);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Document not found" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Supplier invoice" })).toBeNull();
    expect(notFoundFetch.mock.calls.some(([url]) => String(url).includes("preview=1"))).toBe(false);
  });

  it("shows the library and preview from Go with uploaded content links owned by the Go route", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
    const goRow = { ...rows[0]!, id: goDocumentId };
    const goDocument = {
      ...goRow,
      mimeType: "application/pdf",
      sizeBytes: 1024,
      parseError: null,
      parsedMarkdown: "Invoice number: 42",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
      expect(request.capabilityId).toBe("documents.listIngestedDocuments");
      return request.input.id === undefined
        ? Response.json({ ok: true, data: { documents: [goRow], vendors: [] } })
        : Response.json({ ok: true, data: { document: goDocument } });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/documents?documentId=${goDocumentId}`);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Supplier invoice" })).not.toBeNull();
    expect(screen.getByText("Invoice number: 42")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open uploaded file" }).getAttribute("href")).toBe(`/api/go/documents/${goDocumentId}/content`);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities/execute")).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/documents")).toBe(false);
  });

  it("shows selected Go list errors without retrying the legacy document route", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/modules"
      ? Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] })
      : Response.json({ error: "Go route unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Could not load documents" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
  });

  it("shows a selected Go preview error without retrying the legacy detail route", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
    const goRow = { ...rows[0]!, id: goDocumentId };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body)) as { input: Record<string, unknown> };
      if (request.input.id === undefined) return Response.json({ ok: true, data: { documents: [goRow], vendors: [] } });
      return Response.json({ error: "The document was not found." }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/documents?documentId=${goDocumentId}`);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Document not found" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Back to document library" }).getAttribute("href")).toBe("/documents");
    expect(screen.getByRole("button", { name: /Supplier invoice/ }).getAttribute("aria-current")).toBe("true");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/modules",
      "/api/capabilities/execute",
      "/api/capabilities/execute",
    ]);
  });

  it("announces loading and empty library states", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input) === "/api/modules"
      ? Promise.resolve(Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] }))
      : new Promise<Response>((resolve) => { resolveResponse = resolve; })));
    render(<DocumentsPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading documents");
    await waitFor(() => expect(resolveResponse).toBeDefined());
    resolveResponse?.(Response.json({ documents: [], vendors: [] }));
    expect(await screen.findByRole("heading", { name: "No documents yet" })).not.toBeNull();
  });

  it("creates an authored draft through Go and opens the Vite editor", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/documents") return Response.json({ documents: [], vendors: [] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: "actor-1", name: "Ada Lovelace", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: "actor-1", expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: "11111111-1111-4111-8111-111111111111", orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Workspace" }] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        expect(request.capabilityId).toBe("documents.createDoc");
        expect(request.input.title).toBe("Untitled document");
        expect(request.intentId).toBeTruthy();
        return Response.json({ ok: true, data: { documentId: goDocumentId } });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    const create = await screen.findByRole("button", { name: "Create editable draft" });
    fireEvent.click(create);
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/editor/${goDocumentId}`));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(":3001"))).toBe(false);
  });

  it("adds pasted text through documents.createDocument with the active account scope", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/documents") return Response.json({ documents: [], vendors: [] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: "actor-1", name: "Ada Lovelace", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: "actor-1", expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: "11111111-1111-4111-8111-111111111111", orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Workspace" }] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        expect(request.capabilityId).toBe("documents.createDocument");
        expect(request.input).toEqual({ title: "Supplier invoice #42", folder: "Finance", text: "Invoice due Friday" });
        expect(request.intentId).toBeTruthy();
        return Response.json({ ok: true, data: { documentId: goDocumentId } });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a document" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Supplier invoice #42" } });
    fireEvent.change(screen.getByLabelText("Folder (optional)"), { target: { value: "Finance" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Invoice due Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "Add text" }));

    expect(await screen.findByRole("status")).not.toBeNull();
    expect(screen.getByText("Document added to the records library.")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(":3001"))).toBe(false);
  });

  it("uploads PDFs through Go and reports approval without claiming the upload completed", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/documents") return Response.json({ documents: [], vendors: [] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: "actor-1", name: "Ada Lovelace", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: "actor-1", expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: "11111111-1111-4111-8111-111111111111", orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Workspace" }] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
        expect(request.capabilityId).toBe("documents.createDocument");
        expect(request.input).toMatchObject({ title: "April bill", mimeType: "application/pdf", fileBase64: btoa("%PDF-1.7 test") });
        return Response.json({ ok: false, pendingApproval: true, reason: "Upload needs approval", approvalId: goDocumentId }, { status: 202 });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a document" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF or image" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "April bill" } });
    const file = new File(["%PDF-1.7 test"], "bill.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Upload document file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    expect(await screen.findByText("Upload needs approval")).not.toBeNull();
    expect(screen.queryByText("Document added to the records library.")).toBeNull();
  });

  it("surfaces permission errors and allows retry", async () => {
    let listAttempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      listAttempt += 1;
      return listAttempt === 1
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : Response.json({ documents: [], vendors: [] });
    }));
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No documents yet" })).not.toBeNull();
    expect(listAttempt).toBe(2);
  });
});
