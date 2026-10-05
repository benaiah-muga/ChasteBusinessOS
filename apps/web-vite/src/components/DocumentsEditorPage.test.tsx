import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsEditorPage } from "./DocumentsEditorPage";

const authoredDocument = {
  id: "doc-1",
  title: "Service quote",
  status: "published",
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
  html: "<p>Hello</p>",
  templateId: null,
  folder: "Sales",
  documentType: "quote",
  linkedRecordType: null,
  linkedRecordId: null,
  linkedRecordLabel: "Deal: Ada",
  pageSettings: { size: "A4", orientation: "portrait", margin: "normal" },
  versions: 2,
  updatedAt: "2026-09-28T10:00:00.000Z",
};

const versionRows = [
  { version: 1, note: "First draft", createdBy: "8f0c1d22-0000-4000-8000-000000000001", createdAt: "2026-09-20T08:00:00.000Z" },
  { version: 2, note: null, createdBy: "workmate", createdAt: "2026-09-28T09:30:00.000Z" },
];

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function editorFetch(override?: (call: RecordedCall) => Response | null) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const call: RecordedCall = {
      url: String(input),
      method,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const overrideResponse = override?.(call);
    if (overrideResponse) return overrideResponse;
    if (method === "DELETE") return new Response(null, { status: 200 });
    if (call.url === "/api/docs/doc-1/workspace") return Response.json({ lock: { heldBy: "Ada", mine: true }, others: [] });
    if (call.url.startsWith("/api/docs/doc-1?version=")) {
      const version = Number(call.url.split("version=")[1]);
      return Response.json({ version, html: `<p>Body of version ${version}</p>`, note: null, createdAt: "2026-09-28T09:30:00.000Z" });
    }
    if (call.url === "/api/docs/doc-1" && method === "GET") return Response.json({ document: authoredDocument, versions: versionRows });
    if (call.body?.action === "updateMetadata") {
      return Response.json({ documentId: "doc-1", previous: { title: "Service quote", folder: "Sales", linkedRecordType: null, linkedRecordId: null, linkedRecordLabel: "Deal: Ada" } });
    }
    if (call.url === "/api/docs/doc-1") return Response.json({ version: 3 });
    if (call.url === "/api/docs/assist") return Response.json({ ok: true, text: "Tighter copy." });
    if (call.url === "/api/docs") return Response.json({ templateId: "tpl-1", placeholders: ["customer.name"] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function surface(): HTMLElement {
  return screen.getByRole("textbox", { name: "Document body" });
}

function typeIntoSurface(html: string): void {
  const region = surface();
  region.innerHTML = html;
  fireEvent.input(region);
}

function workspaceSaves(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url === "/api/docs/doc-1/workspace" && call.method === "POST" && call.body?.content !== undefined);
}

// The editor mounts a paper preview, a print surface and a content-editable
// region; booting it in jsdom costs more than the default 5s budget.
const TIMEOUT = 30_000;
// Booting the editor costs several round trips; the default 1s query budget is
// not a safe floor on a loaded machine.
const BOOT = { timeout: 15_000 };

beforeEach(() => {
  window.history.replaceState(null, "", "/documents/editor/doc-1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});


describe("authored document editor", () => {
  it("opens the document from the dynamic path, seeds the surface and previews the paper", async () => {
    const { calls } = editorFetch();
    render(<DocumentsEditorPage />);

    expect(await screen.findByDisplayValue("Service quote", undefined, BOOT)).not.toBeNull();
    await waitFor(() => expect(document.title).toBe("Service quote | Chaste Business OS"));
    expect(surface().innerHTML).toBe("<p>Hello</p>");
    expect(within(screen.getByLabelText("Live document preview")).getByText("Hello")).not.toBeNull();
    expect(screen.getByText("Sales")).not.toBeNull();
    expect(screen.getByText("Source: Deal: Ada")).not.toBeNull();
    expect(calls.map((call) => call.url)).toEqual(["/api/docs/doc-1", "/api/docs/doc-1/workspace"]);
    expect(calls[1]?.body).toMatchObject({});
    expect(calls[1]?.body?.intentId).toEqual(expect.any(String));
  }, TIMEOUT);

  it("never renders stored markup as active content in the surface or the preview", async () => {
    editorFetch((call) => {
      if (call.url === "/api/docs/doc-1" && call.method === "GET") {
        return Response.json({
          document: {
            ...authoredDocument,
            content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Terms" }] }] },
            html: '<p>Terms</p><script>window.__pwned = true</script><img src="/api/documents/doc-9/content">',
          },
          versions: [],
        });
      }
      return null;
    });
    render(<DocumentsEditorPage documentId="doc-1" />);

    await screen.findByDisplayValue("Service quote", undefined, BOOT);
    const preview = screen.getByLabelText("Live document preview");
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img")).toBeNull();
    expect(surface().querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  }, TIMEOUT);

  it("autosaves a keystroke burst once, then reports the saved revision", async () => {
    const { calls } = editorFetch((call) => {
      if (call.url === "/api/docs/doc-1/workspace" && call.body?.content !== undefined) {
        return Response.json({ lock: { heldBy: "Ada", mine: true }, savedRev: 7, others: [] });
      }
      return null;
    });
    render(<DocumentsEditorPage documentId="doc-1" />);

    // Opening the document parks the loaded content as a draft, as it always did.
    await screen.findByDisplayValue("Service quote", undefined, BOOT);
    await waitFor(() => expect(workspaceSaves(calls)).toHaveLength(1));

    vi.useFakeTimers();
    try {
      typeIntoSurface("<p>Hello again</p>");
      typeIntoSurface("<p>Hello again, with more</p>");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(799);
      });
      expect(workspaceSaves(calls)).toHaveLength(1);
      expect(screen.getByRole("status").textContent).toBe("Unsaved changes");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
      const saves = workspaceSaves(calls);
      expect(saves).toHaveLength(2);
      expect(saves[1]?.body).toMatchObject({
        pageSettings: { size: "A4", orientation: "portrait", margin: "normal" },
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello again, with more" }] }] },
      });
      expect(screen.getByRole("status").textContent).toBe("Saved");

      typeIntoSurface("<p>Hello again, with more and a bit</p>");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(workspaceSaves(calls)[2]?.body?.rev).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  }, TIMEOUT);

  it("keeps a stale draft visible as a conflict instead of overwriting it", async () => {
    editorFetch((call) => {
      if (call.url === "/api/docs/doc-1/workspace" && call.body?.content !== undefined) {
        return Response.json({
          conflict: true,
          draft: { content: authoredDocument.content, rev: 9 },
          lock: { heldBy: "Ada", mine: true },
          others: [],
        }, { status: 409 });
      }
      return null;
    });
    render(<DocumentsEditorPage documentId="doc-1" />);
    await screen.findByDisplayValue("Service quote", undefined, BOOT);

    typeIntoSurface("<p>Conflicting edit</p>");
    expect(await screen.findByText("Edited elsewhere: reload to pick up the latest draft", undefined, BOOT)).not.toBeNull();
  }, TIMEOUT);

  it("reports a soft lock held by someone else and stops the surface from editing", async () => {
    editorFetch((call) => {
      if (call.url === "/api/docs/doc-1/workspace") return Response.json({ lock: { heldBy: "Grace", mine: false }, others: [{ userId: "u-2", name: "Grace" }] });
      return null;
    });
    render(<DocumentsEditorPage documentId="doc-1" />);
    await screen.findByDisplayValue("Service quote", undefined, BOOT);

    expect(screen.getByRole("status").textContent).toContain("Grace is editing right now");
    expect(screen.getByText("Grace")).not.toBeNull();
    expect(surface().getAttribute("contenteditable")).toBe("false");
    expect((screen.getByLabelText("Bold") as HTMLButtonElement).disabled).toBe(true);
  }, TIMEOUT);

  it("publishes through the governed route, keeps a pending approval visible, and refreshes history", async () => {
    const { calls } = editorFetch((call) => {
      if (call.url === "/api/docs/doc-1" && call.method === "POST" && call.body?.action === "publish") {
        return Response.json({ pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." }, { status: 202 });
      }
      return null;
    });
    render(<DocumentsEditorPage documentId="doc-1" />);
    await screen.findByDisplayValue("Service quote", undefined, BOOT);

    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    const note = await screen.findByLabelText("Version note (optional)", undefined, BOOT);
    fireEvent.change(note, { target: { value: "Added payment terms" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("Publish proposed: the workmate's version waits for approval.", undefined, BOOT)).not.toBeNull();
    const publish = calls.find((call) => call.body?.action === "publish");
    expect(publish?.body).toMatchObject({
      action: "publish",
      title: "Service quote",
      html: "<p>Hello</p>",
      note: "Added payment terms",
      pageSettings: { size: "A4", orientation: "portrait", margin: "normal" },
      content: authoredDocument.content,
    });
    expect(publish?.body?.intentId).toEqual(expect.any(String));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save as template" }));
    fireEvent.change(await screen.findByLabelText("Template name", undefined, BOOT), { target: { value: "Quote" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save template" }));
    expect(await screen.findByText('Template "Quote" saved.', undefined, BOOT)).not.toBeNull();
    expect(calls.find((call) => call.body?.action === "createTemplate")?.body).toMatchObject({ name: "Quote" });
  }, TIMEOUT);

  it("renames through the governed metadata route and shows the new title", async () => {
    const { calls } = editorFetch();
    render(<DocumentsEditorPage documentId="doc-1" />);
    const input = await screen.findByDisplayValue("Service quote", undefined, BOOT);

    fireEvent.change(input, { target: { value: "Service quote 2026" } });
    fireEvent.blur(input);

    expect(await screen.findByText('Saved as "Service quote 2026".', undefined, BOOT)).not.toBeNull();
    expect(calls.find((call) => call.body?.action === "updateMetadata")?.body).toMatchObject({ title: "Service quote 2026" });
  }, TIMEOUT);

  it("lists versions, compares two of them side by side and restores one into the editor", async () => {
    let published = false;
    const { calls } = editorFetch((call) => {
      if (call.url === "/api/docs/doc-1" && call.method === "GET" && published) {
        return Response.json({
          document: { ...authoredDocument, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Restored body" }] }] } },
          versions: [...versionRows, { version: 3, note: "Restored", createdBy: null, createdAt: "2026-09-29T08:00:00.000Z" }],
        });
      }
      if (call.url === "/api/docs/doc-1" && call.method === "POST" && call.body?.action === "restore") {
        published = true;
        return Response.json({ version: 3 });
      }
      return null;
    });
    render(<DocumentsEditorPage documentId="doc-1" />);
    await screen.findByDisplayValue("Service quote", undefined, BOOT);

    fireEvent.click(screen.getByRole("button", { name: /Versions/ }));
    const dialog = await screen.findByRole("dialog", undefined, BOOT);
    expect(within(dialog).getByText("First draft")).not.toBeNull();
    expect(within(dialog).getAllByRole("button", { name: "Compare" })).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Compare" }));
    const compare = await screen.findByRole("dialog", { name: /Compare v1 vs v2/ }, BOOT);
    expect(within(compare).getByText("Body of version 1")).not.toBeNull();
    expect(within(compare).getByText("Body of version 2")).not.toBeNull();
    fireEvent.click(within(compare).getByRole("button", { name: "Close compare" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Compare v1 vs v2/ })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Versions/ }));
    const history = await screen.findByRole("dialog", undefined, BOOT);
    fireEvent.click(within(history).getAllByRole("button", { name: "Restore" })[1]!);

    expect(await screen.findByText("Restored from version 2 as version 3.", undefined, BOOT)).not.toBeNull();
    await waitFor(() => expect(surface().innerHTML).toBe("<p>Restored body</p>"));
    expect(calls.filter((call) => call.body?.action === "restore")).toHaveLength(1);
    expect(calls.filter((call) => call.body?.action === "restore")[0]?.body).toMatchObject({ sourceVersion: 2 });
  }, TIMEOUT);

  it("keeps the print surface on the chosen paper geometry", async () => {
    editorFetch();
    render(<DocumentsEditorPage documentId="doc-1" />);
    await screen.findByDisplayValue("Service quote", undefined, BOOT);

    fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "Letter" } });
    fireEvent.change(screen.getByLabelText("Page orientation"), { target: { value: "landscape" } });
    await waitFor(() => {
      const printSurface = document.body.querySelector(".de-print-only");
      expect(printSurface?.getAttribute("data-size")).toBe("Letter");
      expect(printSurface?.getAttribute("data-orientation")).toBe("landscape");
    });
    expect(within(screen.getByLabelText("Live document preview")).getByText("Letter | landscape")).not.toBeNull();
  }, TIMEOUT);

  it("exports the current tree as a .docx download", async () => {
    editorFetch();
    const createObjectURL = vi.fn(() => "blob:document");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<DocumentsEditorPage documentId="doc-1" />);
    await screen.findByDisplayValue("Service quote", undefined, BOOT);
    fireEvent.click(screen.getByRole("button", { name: ".docx" }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = (createObjectURL.mock.calls[0] as unknown as unknown[])[0] as unknown as Blob;
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(click.mock.contexts[0]).toMatchObject({ download: "Service quote.docx", href: "blob:document" });
  }, TIMEOUT);

  it("asks the writing assistant and only applies the suggestion on request", async () => {
    const { calls } = editorFetch();
    render(<DocumentsEditorPage documentId="doc-1" />);
    await screen.findByDisplayValue("Service quote", undefined, BOOT);

    fireEvent.click(screen.getByRole("button", { name: "Assist" }));
    expect(await screen.findByRole("button", { name: "Improve" }, BOOT)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Improve" }));
    expect(await screen.findByText("Select some text first, then pick an action.", undefined, BOOT)).not.toBeNull();
    expect(calls.filter((call) => call.url === "/api/docs/assist")).toHaveLength(0);

    const region = surface();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(region);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.click(screen.getByRole("button", { name: "Improve" }));
    expect(await screen.findByText("Rewrite (improve)", undefined, BOOT)).not.toBeNull();
    const assist = calls.find((call) => call.url === "/api/docs/assist");
    expect(assist?.body).toMatchObject({ kind: "selection", action: "improve", text: "Hello", language: "English" });
    expect(region.textContent).toBe("Hello");
  }, TIMEOUT);

  it("explains a document it cannot open and offers a retry", async () => {
    let attempts = 0;
    editorFetch((call) => {
      if (call.url === "/api/docs/doc-1" && call.method === "GET") {
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: "document not found" }, { status: 404 })
          : Response.json({ document: authoredDocument, versions: versionRows });
      }
      return null;
    });
    render(<DocumentsEditorPage documentId="doc-1" />);

    expect(await screen.findByRole("alert", undefined, BOOT)).not.toBeNull();
    expect(screen.getByText("Could not open this document")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByDisplayValue("Service quote", undefined, BOOT)).not.toBeNull();
    expect(attempts).toBe(2);
  }, TIMEOUT);

  it("asks for a document when the path does not name one", () => {
    window.history.replaceState(null, "", "/documents");
    editorFetch();
    render(<DocumentsEditorPage />);

    expect(screen.getByRole("heading", { name: "No document to edit" })).not.toBeNull();
  }, TIMEOUT);
});
