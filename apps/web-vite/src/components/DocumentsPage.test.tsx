import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

const rows = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Supplier invoice", status: "parsed", sourceType: "upload", createdAt: "2026-09-28T10:00:00.000Z", folder: "Finance" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Warehouse notes", status: "queued", sourceType: "text", createdAt: "2026-09-27T08:00:00.000Z", folder: null },
];
const goDocumentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function emptyLibraryCapability(capabilityId: string): Response | undefined {
  if (capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
  if (capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
  return undefined;
}

function detail(id: string, title: string, status: string, parsedMarkdown: string | null) {
  return {
    document: {
      ...rows.find((row) => row.id === id)!,
      title,
      status,
      mimeType: id === rows[0]!.id ? "application/pdf" : null,
      sizeBytes: id === rows[0]!.id ? 1024 : null,
      parseError: null,
      parsedMarkdown,
      suggestions: id === goDocumentId ? [{
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        orgId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        documentId: id,
        description: "Printer paper",
        quantityThousandths: 2000,
        unitPriceMinor: 1500,
        suggestedAccountCode: "6000",
        matchScore: 2,
        matchedOn: ["office"],
        status: "open",
        createdAt: "2026-09-28T10:00:00.000Z",
      }] : [],
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body ?? "{}")) as { capabilityId: string; input?: { id?: string } };
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
      return request.input?.id === undefined
        ? Response.json({ ok: true, data: { documents: rows, vendors: [] } })
        : Response.json({ ok: true, data: { document: detail(request.input.id, request.input.id === rows[1]!.id ? "Warehouse notes" : "Supplier invoice", request.input.id === rows[1]!.id ? "queued" : "parsed", request.input.id === rows[1]!.id ? null : "Invoice number: 42").document } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Documents" })).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Supplier invoice" })).not.toBeNull();
    expect(screen.getByText("Invoice number: 42")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Coding suggestions" })).not.toBeNull();
    expect(screen.getByText("Printer paper")).not.toBeNull();
    expect(screen.getByText("Account 6000")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open uploaded file" }).getAttribute("href")).toBe(`/api/go/documents/${rows[0]!.id}/content`);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities/execute")).toHaveLength(4);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "warehouse" } });
    expect(screen.getByRole("button", { name: /Warehouse notes/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Supplier invoice/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Warehouse notes/ }));
    expect(await screen.findByText("Text extraction is in progress.")).not.toBeNull();
  });

  it("loads authored documents from Go and filters by title, folder, and linked record", async () => {
    const authoredDocuments = [
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Supplier agreement", status: "draft", versions: 2, templateId: null, folder: "Legal", documentType: "agreement", linkedRecordType: "supplier", linkedRecordId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", linkedRecordLabel: "Northwind", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", title: "Hiring plan", status: "draft", versions: 1, templateId: null, folder: "People", documentType: "plan", linkedRecordType: null, linkedRecordId: null, linkedRecordLabel: null, updatedAt: "2026-10-02T00:00:00.000Z" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: { id?: string } };
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: authoredDocuments } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
      if (request.capabilityId === "documents.listIngestedDocuments") return Response.json({ ok: true, data: { documents: [], vendors: [] } });
      throw new Error(`Unexpected capability ${request.capabilityId}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    expect(await screen.findByText("Supplier agreement")).not.toBeNull();
    expect(screen.getByText("Hiring plan")).not.toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search written documents" }), { target: { value: "northwind" } });
    expect(screen.getByText("Supplier agreement")).not.toBeNull();
    expect(screen.queryByText("Hiring plan")).toBeNull();
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}"))).some((request) => request.capabilityId === "documents.listDocs")).toBe(true);
  });

  it("creates, renames, and deletes folders through Go capabilities", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const actorId = "11111111-aaaa-4aaa-8aaa-111111111111";
    const organizationId = "22222222-bbbb-4bbb-8bbb-222222222222";
    let folder: { id: string; path: string } | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: actorId, name: "Ada", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: actorId, expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: organizationId, orgs: [{ id: organizationId, name: "Workspace" }] });
      const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, string>; intentId?: string };
      if (request.capabilityId === "documents.listIngestedDocuments") return Response.json({ ok: true, data: { documents: [], vendors: [] } });
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: folder ? [folder] : [] } });
      expect(request.intentId).toMatch(/^[0-9a-f-]{36}$/u);
      if (request.capabilityId === "documents.createFolder") {
        folder = { id: "33333333-cccc-4ccc-8ccc-333333333333", path: request.input.path! };
        return Response.json({ ok: true, data: { folderId: folder.id, path: folder.path } });
      }
      if (request.capabilityId === "documents.renameFolder") {
        const previous = request.input.path!;
        folder = { id: folder!.id, path: request.input.newPath! };
        return Response.json({ ok: true, data: { path: previous, movedTo: folder.path } });
      }
      if (request.capabilityId === "documents.deleteFolder") {
        const previous = folder!.path;
        folder = null;
        return Response.json({ ok: true, data: { deleted: true, path: previous } });
      }
      throw new Error(`Unexpected capability ${request.capabilityId}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    await screen.findByRole("heading", { name: "No documents yet" });
    fireEvent.change(screen.getByLabelText("Create folder"), { target: { value: "Finance" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Created Finance.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New path for Finance"), { target: { value: "Finance / Payables" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Moved Finance to Finance / Payables.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Deleted Finance / Payables.")).not.toBeNull();
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}"))).map((request) => request.capabilityId)).toEqual(expect.arrayContaining(["documents.createFolder", "documents.renameFolder", "documents.deleteFolder"]));
  });

  it("selects the document identified by the Vite documentId query", async () => {
    window.history.replaceState(null, "", `/documents?documentId=${rows[1]!.id}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: { id?: string } };
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
      return request.input.id === undefined
        ? Response.json({ ok: true, data: { documents: rows, vendors: [] } })
        : Response.json({ ok: true, data: { document: detail(rows[1]!.id, "Warehouse notes", "queued", null).document } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Warehouse notes" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Warehouse notes/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Supplier invoice/ }).getAttribute("aria-current")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities/execute")).toHaveLength(4);
  });

  it("validates documentId and shows a not-found state without selecting the first row", async () => {
    window.history.replaceState(null, "", "/documents?documentId=unsafe%2Fid");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
        if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
        expect(request.capabilityId).toBe("documents.listIngestedDocuments");
        return Response.json({ ok: true, data: { documents: rows, vendors: [] } });
      }
      return Response.json({ error: "unexpected detail request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Invalid document link" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Back to document library" }).getAttribute("href")).toBe("/documents");
    expect(screen.queryByRole("heading", { name: "Supplier invoice" })).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/capabilities/execute")).toHaveLength(3);

    cleanup();
    window.history.replaceState(null, "", `/documents?documentId=${goDocumentId}`);
    const notFoundFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: { id?: string } };
        if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
        if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
        expect(request.capabilityId).toBe("documents.listIngestedDocuments");
        return request.input.id === undefined
          ? Response.json({ ok: true, data: { documents: [{ ...rows[0]!, id: goDocumentId }], vendors: [] } })
          : Response.json({ error: "The document was not found." }, { status: 404 });
      }
      return Response.json({ error: "unexpected detail request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", notFoundFetch);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Document not found" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Supplier invoice" })).toBeNull();
    const detailRequests = notFoundFetch.mock.calls.filter(([url]) => String(url) === "/api/capabilities/execute");
    expect(detailRequests).toHaveLength(4);
    const detailRequest = detailRequests.map((call) => JSON.parse(String(call[1]?.body)) as { input: { id?: string; preview?: boolean } }).find((request) => request.input.id !== undefined);
    expect(detailRequest).toMatchObject({
      capabilityId: "documents.listIngestedDocuments",
      input: { id: goDocumentId },
    });
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
      suggestions: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
      const libraryResponse = emptyLibraryCapability(request.capabilityId);
      if (libraryResponse) return libraryResponse;
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
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities/execute")).toHaveLength(4);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/documents")).toBe(false);
  });

  it("requires confirmation before deleting an ingested document through Go", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const actorId = "11111111-aaaa-4aaa-8aaa-111111111111";
    const organizationId = "22222222-bbbb-4bbb-8bbb-222222222222";
    let remaining = [{ ...rows[0]!, id: goDocumentId }];
    const requests: Array<{ url: string; capabilityId?: string; input?: Record<string, unknown>; intentId?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: actorId, name: "Ada", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: actorId, expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: organizationId, orgs: [{ id: organizationId, name: "Workspace" }] });
      const request = JSON.parse(String(init?.body ?? "{}")) as { capabilityId: string; input?: Record<string, unknown>; intentId?: string };
      requests.push({ url, ...request });
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
      if (request.capabilityId === "documents.listIngestedDocuments") {
        if (request.input?.id) return Response.json({ ok: true, data: { document: detail(goDocumentId, "Supplier invoice", "parsed", "Invoice 42").document } });
        return Response.json({ ok: true, data: { documents: remaining, vendors: [] } });
      }
      if (request.capabilityId === "documents.deleteDocument") {
        expect(request.input).toEqual({ documentId: goDocumentId });
        expect(request.intentId).toMatch(/^[0-9a-f-]{36}$/u);
        remaining = [];
        return Response.json({ ok: true, data: { deleted: true } });
      }
      throw new Error(`Unexpected capability ${request.capabilityId}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/documents?documentId=${goDocumentId}`);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Supplier invoice" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete record" }));
    expect(screen.getByText(/permanently deletes the uploaded record/u)).not.toBeNull();
    expect(requests.some((request) => request.capabilityId === "documents.deleteDocument")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByRole("heading", { name: "No documents yet" })).not.toBeNull();
    expect(await screen.findByText("Document deleted.")).not.toBeNull();
    expect(requests.filter((request) => request.capabilityId === "documents.deleteDocument")).toHaveLength(1);
    expect(requests.some((request) => request.url === "/api/documents")).toBe(false);
  });

  it("keeps delete confirmation bound to the document that opened it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body ?? "{}")) as { capabilityId: string; input?: { id?: string } };
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
      if (request.capabilityId === "documents.listIngestedDocuments") {
        return request.input?.id
          ? Response.json({ ok: true, data: { document: detail(request.input.id, request.input.id === goDocumentId ? "Supplier invoice" : "Warehouse notes", "parsed", null).document } })
          : Response.json({ ok: true, data: { documents: rows, vendors: [] } });
      }
      throw new Error(`Unexpected capability ${request.capabilityId}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Supplier invoice" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete record" }));
    expect(screen.getByRole("button", { name: "Confirm delete" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Warehouse notes/ }));
    expect(await screen.findByRole("heading", { name: "Warehouse notes" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => JSON.parse(String(init?.body ?? "{}")).capabilityId === "documents.deleteDocument")).toBe(false);
  });

  it.each(["actor", "workspace"] as const)("offers exact retry after reload and refuses it after the %s changes", async (changedScope) => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const actorId = "11111111-aaaa-4aaa-8aaa-111111111111";
    const organizationId = "22222222-bbbb-4bbb-8bbb-222222222222";
    let activeActorId = actorId;
    let activeOrganizationId = organizationId;
    let documentExists = true;
    const deleteRequests: Array<{ intentId?: string; documentId?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: activeActorId, name: "Ada", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: activeActorId, expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: activeOrganizationId, orgs: [{ id: activeOrganizationId, name: "Workspace" }] });
      const request = JSON.parse(String(init?.body ?? "{}")) as { capabilityId: string; input?: { id?: string; documentId?: string }; intentId?: string };
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
      if (request.capabilityId === "documents.listIngestedDocuments") {
        if (request.input?.id) {
          if (!documentExists) return Response.json({ error: "The document was not found." }, { status: 404 });
          return Response.json({ ok: true, data: { document: detail(goDocumentId, "Supplier invoice", "parsed", null).document } });
        }
        return Response.json({ ok: true, data: { documents: documentExists ? [{ ...rows[0]!, id: goDocumentId }] : [], vendors: [] } });
      }
      if (request.capabilityId === "documents.deleteDocument") {
        deleteRequests.push({ intentId: request.intentId, documentId: request.input?.documentId });
        if (deleteRequests.length === 1) {
          documentExists = false;
          throw new TypeError("connection reset after server commit");
        }
        return Response.json({ ok: true, data: { deleted: false } });
      }
      throw new Error(`Unexpected capability ${request.capabilityId}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/documents?documentId=${goDocumentId}`);
    const firstRender = render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Supplier invoice" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete record" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(await screen.findByText(/The result for document/u)).not.toBeNull();
    expect(deleteRequests).toHaveLength(1);
    firstRender.unmount();
    window.history.replaceState(null, "", "/documents");
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Previous deletion needs confirmation" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "No documents yet" })).not.toBeNull();
    if (changedScope === "actor") activeActorId = "33333333-cccc-4ccc-8ccc-333333333333";
    else activeOrganizationId = "44444444-dddd-4ddd-8ddd-444444444444";
    fireEvent.click(screen.getByRole("button", { name: "Retry previous deletion" }));
    expect(await screen.findByText(/Switch back to the original scope/u)).not.toBeNull();
    expect(deleteRequests).toHaveLength(1);
    activeActorId = actorId;
    activeOrganizationId = organizationId;
    fireEvent.click(screen.getByRole("button", { name: "Retry previous deletion" }));
    expect(await screen.findByText("This document was already deleted.")).not.toBeNull();
    expect(deleteRequests).toHaveLength(2);
    expect(deleteRequests[0]?.intentId).toBe(deleteRequests[1]?.intentId);
    expect(deleteRequests.every((request) => request.documentId === goDocumentId)).toBe(true);
    expect(screen.queryByRole("heading", { name: "Previous deletion needs confirmation" })).toBeNull();
  });

  it("shows selected Go list errors without retrying the legacy document route", async () => {
    vi.stubGlobal("__GO_DOCUMENT_INGESTED_READS__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body)) as { capabilityId: string };
      return emptyLibraryCapability(request.capabilityId) ?? Response.json({ error: "Go route unavailable" }, { status: 404 });
    });
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
      const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
      const libraryResponse = emptyLibraryCapability(request.capabilityId);
      if (libraryResponse) return libraryResponse;
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
      "/api/capabilities/execute",
      "/api/capabilities/execute",
    ]);
  });

  it("announces loading and empty library states", async () => {
    const pending: Array<{ capabilityId: string; resolve: (response: Response) => void }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/modules"
      ? Promise.resolve(Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] }))
      : new Promise<Response>((resolve) => {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string };
        pending.push({ capabilityId: request.capabilityId, resolve });
      })));
    render(<DocumentsPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading documents");
    await waitFor(() => expect(pending.some(({ capabilityId }) => capabilityId === "documents.listIngestedDocuments")).toBe(true));
    pending.find(({ capabilityId }) => capabilityId === "documents.listIngestedDocuments")?.resolve(Response.json({ ok: true, data: { documents: [], vendors: [] } }));
    await waitFor(() => expect(pending).toHaveLength(3));
    pending.find(({ capabilityId }) => capabilityId === "documents.listDocs")?.resolve(Response.json({ ok: true, data: { documents: [] } }));
    pending.find(({ capabilityId }) => capabilityId === "documents.listFolders")?.resolve(Response.json({ ok: true, data: { folders: [] } }));
    expect(await screen.findByRole("heading", { name: "No documents yet" })).not.toBeNull();
  });

  it("creates an authored draft through Go and opens the Vite editor", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: "actor-1", name: "Ada Lovelace", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: "actor-1", expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: "11111111-1111-4111-8111-111111111111", orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Workspace" }] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        const libraryResponse = emptyLibraryCapability(request.capabilityId);
        if (libraryResponse) return libraryResponse;
        if (request.capabilityId === "documents.listIngestedDocuments") return Response.json({ ok: true, data: { documents: [], vendors: [] } });
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
      if (url === "/api/auth/get-session") return Response.json({ user: { id: "actor-1", name: "Ada Lovelace", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: "actor-1", expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: "11111111-1111-4111-8111-111111111111", orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Workspace" }] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        const libraryResponse = emptyLibraryCapability(request.capabilityId);
        if (libraryResponse) return libraryResponse;
        if (request.capabilityId === "documents.listIngestedDocuments") return Response.json({ ok: true, data: { documents: [], vendors: [] } });
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

    expect(await screen.findByText("Document added to the records library.")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(":3001"))).toBe(false);
  });

  it("uploads PDFs through Go and reports approval without claiming the upload completed", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      if (url === "/api/auth/get-session") return Response.json({ user: { id: "actor-1", name: "Ada Lovelace", email: "ada@example.test", emailVerified: true, image: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }, session: { id: "session-1", userId: "actor-1", expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } });
      if (url === "/api/org") return Response.json({ activeOrgId: "11111111-1111-4111-8111-111111111111", orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Workspace" }] });
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
        const libraryResponse = emptyLibraryCapability(request.capabilityId);
        if (libraryResponse) return libraryResponse;
        if (request.capabilityId === "documents.listIngestedDocuments") return Response.json({ ok: true, data: { documents: [], vendors: [] } });
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json({ catalog: [{ id: "documents" }], enabledModules: ["documents"] });
      const request = JSON.parse(String(init?.body)) as { capabilityId: string };
      if (request.capabilityId === "documents.listDocs") return Response.json({ ok: true, data: { documents: [] } });
      if (request.capabilityId === "documents.listFolders") return Response.json({ ok: true, data: { folders: [] } });
      listAttempt += 1;
      return listAttempt === 1
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : Response.json({ ok: true, data: { documents: [], vendors: [] } });
    }));
    render(<DocumentsPage />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No documents yet" })).not.toBeNull();
    expect(listAttempt).toBe(2);
  });
});
