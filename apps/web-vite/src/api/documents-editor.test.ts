import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PAGE_SETTINGS,
  DocumentsEditorApiError,
  buildDocxBytes,
  createDocumentTemplate,
  documentHtmlToJson,
  documentJsonToHtml,
  documentsEditorIdFromPath,
  fetchArchivedVersion,
  fetchEditorDocument,
  postEditorWorkspace,
  publishDocumentVersion,
  refineDocumentHtml,
  releaseEditorWorkspace,
  requestAssist,
  restoreDocumentVersion,
  sanitizeDocumentHtml,
  updateDocumentMetadata,
} from "./documents-editor";

const authoredDocument = {
  id: "doc-1",
  title: "Service quote",
  status: "published",
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
  html: "<p>Hello</p>",
  templateId: null,
  folder: "Sales",
  documentType: "quote",
  linkedRecordType: "deal",
  linkedRecordId: "1f0b0a52-6b0a-4f3d-9a1a-2f6f0a2f1c33",
  linkedRecordLabel: "Deal: Ada",
  pageSettings: { size: "A4", orientation: "portrait", margin: "normal" },
  versions: 2,
  updatedAt: "2026-09-28T10:00:00.000Z",
};

const versionRows = [
  { version: 1, note: "First draft", createdBy: "ada", createdAt: "2026-09-20T08:00:00.000Z" },
  { version: 2, note: null, createdBy: "workmate", createdAt: "2026-09-28T09:30:00.000Z" },
];

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recorder(responses: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return responses(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body ?? "{}")) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("editor route matching", () => {
  it("reads the document id out of the dynamic path and refuses everything else", () => {
    expect(documentsEditorIdFromPath("/documents/editor/6f1b2c3d-0000-4000-8000-000000000001")).toBe("6f1b2c3d-0000-4000-8000-000000000001");
    expect(documentsEditorIdFromPath("/documents/editor/6f1b%2F2c3d/")).toBe("6f1b/2c3d");
    expect(documentsEditorIdFromPath("/documents/editor")).toBeNull();
    expect(documentsEditorIdFromPath("/documents")).toBeNull();
    expect(documentsEditorIdFromPath("/documents/editor/one/two")).toBeNull();
    expect(documentsEditorIdFromPath("/documents/editor/%E0%A4%A")).toBeNull();
  });
});

describe("authored document reads", () => {
  it("loads the document and its version history with the signed-in same-origin session", async () => {
    const { calls } = recorder(() => Response.json({ document: authoredDocument, versions: versionRows }));

    await expect(fetchEditorDocument("doc-1")).resolves.toEqual({ document: authoredDocument, versions: versionRows });
    expect(calls[0]?.url).toBe("/api/docs/doc-1");
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps permission and shape failures understandable", async () => {
    recorder(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(fetchEditorDocument("doc-1")).rejects.toEqual(new DocumentsEditorApiError(401, "Sign in again to edit this document."));

    recorder(() => Response.json({ error: "document not found" }, { status: 404 }));
    await expect(fetchEditorDocument("doc-1")).rejects.toThrow("That document no longer exists.");

    recorder(() => Response.json({ document: { ...authoredDocument, status: 7 }, versions: [] }));
    await expect(fetchEditorDocument("doc-1")).rejects.toThrow("The document service returned data in an unexpected format.");

    recorder(() => Response.json("nope", { status: 500 }));
    await expect(fetchEditorDocument("doc-1")).rejects.toThrow("The document service is unavailable. Try again in a moment.");
  });

  it("reads one archived version for the compare panes", async () => {
    const { calls } = recorder(() => Response.json({ version: 2, html: "<p>Newer</p>", note: null, createdAt: "2026-09-28T09:30:00.000Z" }));

    await expect(fetchArchivedVersion("doc-1", 2)).resolves.toEqual({ version: 2, html: "<p>Newer</p>", note: null, createdAt: "2026-09-28T09:30:00.000Z" });
    expect(calls[0]?.url).toBe("/api/docs/doc-1?version=2");
  });

  it("defaults absent page settings instead of failing the whole document", async () => {
    const { pageSettings: _omitted, ...withoutSettings } = authoredDocument;
    recorder(() => Response.json({ document: withoutSettings, versions: [] }));

    const payload = await fetchEditorDocument("doc-1");
    expect(payload.document?.pageSettings).toEqual(DEFAULT_PAGE_SETTINGS);
  });
});

describe("draft workspace ticks", () => {
  it("stamps an intent id and sends the draft with its known revision", async () => {
    const { calls } = recorder(() => Response.json({ lock: { heldBy: "Ada", mine: true }, savedRev: 4, draft: null, others: [] }));

    const tick = await postEditorWorkspace("doc-1", {
      content: { type: "doc", content: [] },
      pageSettings: DEFAULT_PAGE_SETTINGS,
      rev: 3,
    });

    expect(tick).toEqual({ conflict: false, savedRev: 4, lock: { heldBy: "Ada", mine: true }, others: [], draft: null });
    expect(calls[0]?.url).toBe("/api/docs/doc-1/workspace");
    expect(calls[0]?.init.method).toBe("POST");
    const sent = bodyOf(calls[0]!);
    expect(typeof sent.intentId).toBe("string");
    expect((sent.intentId as string).length).toBeGreaterThan(0);
    expect(sent.rev).toBe(3);
    expect(sent.pageSettings).toEqual(DEFAULT_PAGE_SETTINGS);
  });

  it("keeps a caller supplied intent id so a retried save reconciles", async () => {
    const { calls } = recorder(() => Response.json({ lock: { heldBy: "Ada", mine: true }, others: [] }));
    await postEditorWorkspace("doc-1", { content: { type: "doc", content: [] }, intentId: undefined } as never);
    expect(typeof bodyOf(calls[0]!).intentId).toBe("string");

    const again = recorder(() => Response.json({ lock: { heldBy: "Ada", mine: true }, others: [] }));
    await postEditorWorkspace("doc-1", { content: { type: "doc", content: [] }, rev: 2 });
    expect(bodyOf(again.calls[0]!).rev).toBe(2);
  });

  it("reports a 409 as a conflict state rather than a failed request", async () => {
    recorder(() => Response.json({
      conflict: true,
      draft: { content: { type: "doc", content: [] }, rev: 9, pageSettings: DEFAULT_PAGE_SETTINGS },
      lock: { heldBy: "Ada", mine: true },
      others: [{ userId: "u-2", name: "Grace" }],
    }, { status: 409 }));

    const tick = await postEditorWorkspace("doc-1", { content: { type: "doc", content: [] }, rev: 4 });
    expect(tick.conflict).toBe(true);
    expect(tick.draft?.rev).toBe(9);
    expect(tick.others).toEqual([{ userId: "u-2", name: "Grace" }]);
  });

  it("surfaces a real failure as an error", async () => {
    recorder(() => Response.json({ error: "invalid body" }, { status: 400 }));
    await expect(postEditorWorkspace("doc-1", {})).rejects.toThrow("Some details were missing or malformed.");
  });

  it("releases presence and the lock without waiting for an answer", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    releaseEditorWorkspace("doc-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/docs/doc-1/workspace", expect.objectContaining({ method: "DELETE", keepalive: true }));
  });
});

describe("governed writes", () => {
  it("publishes a version and reads the history back", async () => {
    const { calls } = recorder((call) => (call.url === "/api/docs/doc-1"
      ? Response.json({ version: 3 })
      : Response.json({ document: authoredDocument, versions: [...versionRows, { version: 3, note: "Terms", createdBy: "ada", createdAt: "2026-09-29T08:00:00.000Z" }] })));

    const outcome = await publishDocumentVersion("doc-1", {
      title: "Service quote",
      content: authoredDocument.content,
      html: "<p>Hello</p>",
      pageSettings: DEFAULT_PAGE_SETTINGS,
      note: "Terms",
    });

    expect(outcome).toEqual({ kind: "completed", data: { version: 3 } });
    const sent = bodyOf(calls[0]!);
    expect(sent).toMatchObject({ action: "publish", title: "Service quote", html: "<p>Hello</p>", note: "Terms" });
    expect(typeof sent.intentId).toBe("string");
  });

  it("preserves the approval-pending envelope instead of calling it success or failure", async () => {
    const { calls } = recorder(() => Response.json({ pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." }, { status: 202 }));

    const published = await publishDocumentVersion("doc-1", {
      title: "Service quote",
      content: authoredDocument.content,
      html: "<p>Hello</p>",
      pageSettings: DEFAULT_PAGE_SETTINGS,
    });
    expect(published).toEqual({ kind: "pending", hint: "This change waits for approval in the Approvals inbox." });

    const restored = await restoreDocumentVersion("doc-1", 1);
    expect(restored.kind).toBe("pending");
    const renamed = await updateDocumentMetadata("doc-1", { title: "Renamed" });
    expect(renamed.kind).toBe("pending");
    const templated = await createDocumentTemplate("Quote", authoredDocument.content);
    expect(templated.kind).toBe("pending");

    expect(calls.map((call) => bodyOf(call).action)).toEqual(["publish", "restore", "updateMetadata", "createTemplate"]);
  });

  it("restores, renames and stores templates with their own intent identities", async () => {
    const { calls } = recorder((_call) => {
      const action = bodyOf(calls[calls.length - 1]!).action;
      if (action === "restore") return Response.json({ version: 4 });
      if (action === "createTemplate") return Response.json({ templateId: "tpl-1", placeholders: ["customer.name"] });
      return Response.json({ documentId: "doc-1", previous: { title: "Old", folder: null, linkedRecordType: null, linkedRecordId: null, linkedRecordLabel: null } });
    });

    await expect(restoreDocumentVersion("doc-1", 2)).resolves.toEqual({ kind: "completed", data: { version: 4 } });
    await expect(createDocumentTemplate("Quote", authoredDocument.content)).resolves.toEqual({
      kind: "completed",
      data: { templateId: "tpl-1", placeholders: ["customer.name"] },
    });
    await expect(updateDocumentMetadata("doc-1", { title: "Renamed" })).resolves.toMatchObject({ kind: "completed", data: { documentId: "doc-1", previous: { title: "Old" } } });

    expect(calls[0]?.url).toBe("/api/docs/doc-1");
    expect(calls[1]?.url).toBe("/api/docs");
    expect(bodyOf(calls[1]!)).toMatchObject({ action: "createTemplate", name: "Quote" });
    expect(bodyOf(calls[2]!)).toMatchObject({ action: "updateMetadata", title: "Renamed" });
    const identities = calls.map((call) => bodyOf(call).intentId);
    expect(new Set(identities).size).toBe(3);
  });

  it("turns a refused governed write into a readable error", async () => {
    recorder(() => Response.json({ error: "document not found" }, { status: 422 }));
    await expect(restoreDocumentVersion("doc-1", 2)).rejects.toEqual(expect.objectContaining({ name: "DocumentsEditorApiError", status: 422 }));
  });
});

describe("writing assist", () => {
  it("returns the model text for a selection rewrite", async () => {
    const { calls } = recorder(() => Response.json({ ok: true, text: "Tighter copy." }));
    await expect(requestAssist({ kind: "selection", action: "shorten", text: "Long copy", language: "English" })).resolves.toEqual({ ok: true, text: "Tighter copy." });
    expect(calls[0]?.url).toBe("/api/docs/assist");
    expect(bodyOf(calls[0]!)).toMatchObject({ kind: "selection", action: "shorten" });
  });

  it("rejects an empty or unreadable assist answer", async () => {
    recorder(() => Response.json({ ok: true, text: "  " }));
    await expect(requestAssist({ kind: "chat", documentId: "doc-1", question: "Why?" })).rejects.toThrow("The writing assistant could not help with that, try again.");

    recorder(() => Response.json({ error: "the model returned nothing, try again" }, { status: 502 }));
    await expect(requestAssist({ kind: "chat", documentId: "doc-1", question: "Why?" })).rejects.toThrow("the model returned nothing, try again");
  });
});

describe("document html safety", () => {
  it("drops active content, inline styles and remote media from stored or pasted markup", () => {
    const cleaned = sanitizeDocumentHtml(
      '<p onclick="steal()">Terms</p><script>alert(1)</script><iframe src="https://evil.test"></iframe>'
      + '<style>body{display:none}</style><img src="https://tracker.test/pixel.gif"><a href="javascript:alert(1)">go</a>'
      + '<unknown-tag data-x="1"><b>kept</b></unknown-tag><a href="https://ok.test" style="color:red">link</a>',
    );

    expect(cleaned).not.toContain("script");
    expect(cleaned).not.toContain("onclick");
    expect(cleaned).not.toContain("iframe");
    expect(cleaned).not.toContain("style=");
    expect(cleaned).not.toContain("tracker.test");
    expect(cleaned).not.toContain("javascript:");
    expect(cleaned).toContain("<b>kept</b>");
    expect(cleaned).toContain('href="https://ok.test"');
  });

  it("keeps an image only when it is an inline picture, never an uploaded document", () => {
    const inline = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeDocumentHtml(`<img alt="Logo" src="${inline}">`)).toBe(`<img alt="Logo" src="${inline}">`);
    expect(sanitizeDocumentHtml('<img alt="Logo" src="/api/documents/doc-9/content">')).toBe("");
    expect(sanitizeDocumentHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')).toBe("");
  });

  it("serializes the editor tree to allowlisted html and back again", () => {
    const tree = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Terms" }] },
        { type: "paragraph", content: [
          { type: "text", text: "Pay in " },
          { type: "text", text: "30 days", marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "text", text: "Thank you", marks: [{ type: "italic" }, { type: "link", attrs: { href: "https://example.test/terms" } }] },
        ] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] },
        { type: "table", content: [{ type: "tableRow", content: [
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }] },
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Amount" }] }] },
        ] }, { type: "tableRow", content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Design" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1,200" }] }] },
        ] }] },
        { type: "horizontalRule" },
      ],
    };

    const html = documentJsonToHtml(tree);
    expect(html).toBe(
      "<h2>Terms</h2><p>Pay in <strong>30 days</strong><br><a href=\"https://example.test/terms\" target=\"_blank\" rel=\"noopener noreferrer\"><em>Thank you</em></a></p>"
      + "<ul><li><p>One</p></li></ul>"
      + "<table><thead><tr><th>Item</th><th>Amount</th></tr></thead>"
      + "<tbody><tr><td>Design</td><td>1,200</td></tr></tbody></table><hr>",
    );

    const back = documentHtmlToJson(html);
    expect(back.type).toBe("doc");
    const blocks = back.content as Array<{ type: string; content?: Array<{ type: string }> }>;
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "bulletList", "table", "horizontalRule"]);
    const cells = (blocks[3]!.content as Array<{ type: string; content?: Array<{ type: string }> }>)[0]!.content!;
    expect(cells.map((cell) => cell.type)).toEqual(["tableHeader", "tableHeader"]);
    const paragraph = blocks[1]!.content!;
    expect(paragraph.map((node) => node.type)).toEqual(["text", "text", "hardBreak", "text"]);
    expect((paragraph[1] as { content?: unknown }).content).toBeUndefined();
    const link = paragraph[3] as { marks?: Array<{ type: string }> };
    expect(link.marks?.map((mark) => mark.type)).toEqual(["link", "italic"]);
    expect(documentJsonToHtml(back)).toBe(html);
  });

  it("escapes text and drops unsafe links and remote images when serializing", () => {
    const html = documentJsonToHtml({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script> & co" }] },
        { type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
        { type: "image", attrs: { src: "https://tracker.test/pixel.gif" } },
      ],
    });

    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; co</p><p>click</p>");
  });

  it("refines the preview paper: header rows, numeric columns and layout tables", () => {
    const refined = refineDocumentHtml(
      '<table><tbody><tr><th>Item</th><th>Amount</th></tr><tr><td>Design</td><td>1,200</td></tr></tbody></table>'
      + '<table><tbody><tr><td>Acme Ltd</td></tr><tr><td>Balance</td><td>0</td></tr></tbody></table>'
      + '<p>INVOICE</p>',
    );

    expect(refined).toContain("<table class=\"doc-table\"><thead><tr>");
    expect(refined).toContain("<th class=\"num\">Amount</th>");
    expect(refined).toContain("<td class=\"num\">1,200</td>");
    expect(refined).toContain("doc-grid doc-totals");
    expect(refined).not.toContain("doc-letterhead");
    expect(refined).toContain('class="doc-eyebrow">INVOICE<');
  });

  it("reads a leading headerless table as the letterhead", () => {
    const refined = refineDocumentHtml('<table><tbody><tr><td>Acme Ltd</td><td>Invoice 42</td></tr></tbody></table>');
    expect(refined).toContain("doc-grid doc-letterhead");
    expect(refined).not.toContain("doc-totals");
  });
});

describe("docx export", () => {
  function readEntries(bytes: Uint8Array): Array<{ name: string; method: number; crc: number; size: number; data: string }> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    const endSignature = view.getUint32(bytes.length - 22, true);
    expect(endSignature).toBe(0x06054b50);
    const entries = view.getUint16(bytes.length - 22 + 10, true);
    let cursor = view.getUint32(bytes.length - 22 + 16, true);
    const found: Array<{ name: string; method: number; crc: number; size: number; data: string }> = [];
    for (let index = 0; index < entries; index += 1) {
      expect(view.getUint32(cursor, true)).toBe(0x02014b50);
      const method = view.getUint16(cursor + 10, true);
      const crc = view.getUint32(cursor + 16, true);
      const size = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      const offset = view.getUint32(cursor + 42, true);
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      const localNameLength = view.getUint16(offset + 26, true);
      const dataStart = offset + 30 + localNameLength + view.getUint16(offset + 28, true);
      expect(decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength))).toBe(name);
      found.push({ name, method, crc, size, data: decoder.decode(bytes.subarray(dataStart, dataStart + size)) });
      cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    }
    return found;
  }

  it("builds a stored zip whose parts are the Word document the editor describes", () => {
    const bytes = buildDocxBytes("Quote & Co", {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Summary" }] },
        { type: "paragraph", content: [{ type: "text", text: "Payable", marks: [{ type: "bold" }] }] },
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] }] },
      ],
    });

    expect(decoder(bytes.subarray(0, 2))).toBe("PK");
    const entries = readEntries(bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/numbering.xml",
      "word/document.xml",
    ]);
    expect(new Set(entries.map((entry) => entry.method))).toEqual(new Set([0]));
    expect(new Set(entries.map((entry) => entry.crc > 0))).toEqual(new Set([true]));

    const document = entries.find((entry) => entry.name === "word/document.xml")!.data;
    expect(document).toContain("<w:t xml:space=\"preserve\">Quote &amp; Co</w:t>");
    expect(document).toContain("<w:pStyle w:val=\"Heading1\"/>");
    expect(document).toContain("<w:b/>");
    expect(document).toContain('<w:numId w:val="2"/>');
    expect(document).toContain("<w:sectPr>");
  });

  it("escapes a title that would otherwise break the document part", () => {
    const bytes = buildDocxBytes("<script>alert(1)</script>", { type: "doc", content: [] });
    const document = readEntries(bytes).find((entry) => entry.name === "word/document.xml")!.data;
    expect(document).not.toContain("<script>");
    expect(document).toContain("&lt;script&gt;");
  });
});

function decoder(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}