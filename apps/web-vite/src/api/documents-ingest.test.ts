import { afterEach, describe, expect, it, vi } from "vitest";
import { createIngestedDocument, DocumentsIngestApiError } from "./documents-ingest";

const scope = { actorId: "actor-one", organizationId: "org-one" };
const documentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function stubLocks() {
  vi.stubGlobal("navigator", {
    ...navigator,
    locks: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() },
  });
}

function callsFrom(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    init: init as RequestInit,
    body: JSON.parse(String((init as RequestInit).body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string },
  }));
}

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("createIngestedDocument", () => {
  it("sends text through the Go documents capability and validates the UUID receipt", async () => {
    stubLocks();
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { documentId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createIngestedDocument({ title: "Supplier notes", folder: "Finance", text: "Invoice due Friday" }, scope))
      .resolves.toEqual({ kind: "completed", documentId });
    const [call] = callsFrom(fetchMock);
    expect(call?.url).toBe("/api/capabilities/execute");
    expect(call?.body).toMatchObject({
      capabilityId: "documents.createDocument",
      input: { title: "Supplier notes", folder: "Finance", text: "Invoice due Friday" },
      intentId: expect.any(String),
    });
    expect(call?.init.credentials).toBe("same-origin");
    expect(window.localStorage.length).toBe(0);
  });

  it("encodes an accepted PDF and sends its declared MIME type", async () => {
    stubLocks();
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { documentId } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["%PDF-1.7 test"], "bill.pdf", { type: "application/pdf" });

    await expect(createIngestedDocument({ title: "April bill", file }, scope)).resolves.toEqual({ kind: "completed", documentId });
    expect(callsFrom(fetchMock)[0]?.body.input).toMatchObject({
      title: "April bill",
      mimeType: "application/pdf",
      fileBase64: btoa("%PDF-1.7 test"),
    });
  });

  it("enforces size, type, title, and non-empty text before making a request", async () => {
    stubLocks();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createIngestedDocument({ title: "PDF", file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.pdf", { type: "application/pdf" }) }, scope))
      .rejects.toThrow("larger than 5 MB");
    await expect(createIngestedDocument({ title: "Executable", file: new File(["no"], "run.bin", { type: "application/octet-stream" }) }, scope))
      .rejects.toThrow("Choose a PDF or image");
    await expect(createIngestedDocument({ title: "   ", text: "body" }, scope)).rejects.toThrow("document title");
    await expect(createIngestedDocument({ title: "Empty", text: "  " }, scope)).rejects.toThrow("Enter some text");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses an exact scoped retry intent after uncertainty and keeps malformed receipts unresolved", async () => {
    stubLocks();
    const uncertain = vi.fn(async () => { throw new Error("connection lost"); });
    vi.stubGlobal("fetch", uncertain);
    const input = { title: "April bill", text: "Invoice number 42" };
    await expect(createIngestedDocument(input, scope)).rejects.toMatchObject({ status: 0 });
    const first = callsFrom(uncertain)[0]!.body;
    await expect(createIngestedDocument({ title: "Different", text: "New" }, scope))
      .rejects.toThrow("Retry those exact details");

    const malformed = vi.fn(async () => Response.json({ ok: true, data: { documentId: "bad-id" } }));
    vi.stubGlobal("fetch", malformed);
    await expect(createIngestedDocument(input, scope)).rejects.toBeInstanceOf(DocumentsIngestApiError);
    const retry = callsFrom(malformed)[0]!.body;
    expect(retry.intentId).toBe(first.intentId);
    expect(window.localStorage.length).toBe(1);
  });

  it("keeps an approval-pending attempt available for exact retry", async () => {
    stubLocks();
    const pending = vi.fn(async () => Response.json({ ok: false, pendingApproval: true, reason: "Approval required" }, { status: 202 }));
    vi.stubGlobal("fetch", pending);
    const input = { title: "April bill", text: "Invoice number 42" };
    await expect(createIngestedDocument(input, scope)).resolves.toEqual({ kind: "pending", hint: "Approval required" });
    const first = callsFrom(pending)[0]!.body;
    const complete = vi.fn(async () => Response.json({ ok: true, data: { documentId } }));
    vi.stubGlobal("fetch", complete);
    await expect(createIngestedDocument(input, scope)).resolves.toEqual({ kind: "completed", documentId });
    expect(callsFrom(complete)[0]!.body.intentId).toBe(first.intentId);
  });

  it("fails closed without authenticated scope or browser locks", async () => {
    await expect(createIngestedDocument({ title: "Invoice", text: "42" }, { actorId: null, organizationId: "org-one" }))
      .rejects.toMatchObject({ status: 0 });
    vi.stubGlobal("navigator", { ...navigator, locks: undefined });
    await expect(createIngestedDocument({ title: "Invoice", text: "42" }, scope)).rejects.toMatchObject({ status: 0 });
  });
});
