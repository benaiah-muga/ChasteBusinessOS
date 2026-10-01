import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

const rows = [
  { id: "doc-1", title: "Supplier invoice", status: "parsed", sourceType: "upload", createdAt: "2026-09-28T10:00:00.000Z", folder: "Finance" },
  { id: "doc-2", title: "Warehouse notes", status: "queued", sourceType: "text", createdAt: "2026-09-27T08:00:00.000Z", folder: null },
];

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
    expect(screen.getByRole("link", { name: "Open uploaded file" }).getAttribute("href")).toBe("/api/documents/doc-1/content");
    expect(fetchMock).toHaveBeenCalledWith("/api/documents?id=doc-1&preview=1", expect.any(Object));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "warehouse" } });
    expect(screen.getByRole("button", { name: /Warehouse notes/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Supplier invoice/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Warehouse notes/ }));
    expect(await screen.findByText("Text extraction is in progress.")).not.toBeNull();
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
