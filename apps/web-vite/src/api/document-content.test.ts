import { describe, expect, it } from "vitest";
import { isBoundedDocumentContent } from "./document-content";

function nestedDocument(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "paragraph" };
  for (let level = 0; level < depth; level += 1) node = { type: "blockquote", content: [node] };
  return { type: "doc", content: [node] };
}

describe("bounded authored document content", () => {
  it("accepts valid ProseMirror document trees", () => {
    expect(isBoundedDocumentContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello", marks: [{ type: "bold" }] }] }],
    })).toBe(true);
  });

  it.each([
    { type: "doc", content: "not an array" },
    { type: "doc", content: [{ type: "paragraph", content: [null] }] },
    { type: "doc", content: [{ type: "text", text: 7 }] },
    { type: "doc", content: [{ type: "text", marks: "bold" }] },
    { type: "paragraph", content: [] },
  ])("rejects malformed nested document shapes", (content) => {
    expect(isBoundedDocumentContent(content)).toBe(false);
  });

  it("rejects content deeper than the serializer budget", () => {
    expect(isBoundedDocumentContent(nestedDocument(40))).toBe(false);
  });

  it("rejects trees over the node budget", () => {
    const content = { type: "doc", content: Array.from({ length: 10_001 }, () => ({ type: "paragraph" })) };
    expect(isBoundedDocumentContent(content)).toBe(false);
  });

  it("applies the generic value budget to arbitrary nested attributes", () => {
    const atLimit = { type: "doc", attrs: { flags: Array.from({ length: 99_996 }, () => true) } };
    const overLimit = { type: "doc", attrs: { flags: Array.from({ length: 99_997 }, () => true) } };
    expect(isBoundedDocumentContent(atLimit)).toBe(true);
    expect(isBoundedDocumentContent(overLimit)).toBe(false);

    let nested: unknown = "end";
    for (let level = 0; level < 64; level += 1) nested = { value: nested };
    expect(isBoundedDocumentContent({ type: "doc", attrs: { nested } })).toBe(false);
  });

  it("rejects cycles and content over the UTF-8 JSON byte budget", () => {
    const cyclic: Record<string, unknown> = { type: "doc" };
    cyclic.content = [cyclic];
    expect(isBoundedDocumentContent(cyclic)).toBe(false);
    expect(isBoundedDocumentContent({ type: "doc", content: [{ type: "text", text: "é".repeat(500_001) }] })).toBe(false);
    expect(isBoundedDocumentContent({ type: "doc", content: [{ type: "text", text: "é".repeat(499_000) }] })).toBe(true);
    expect(isBoundedDocumentContent({ type: "doc", text: "\ud800".repeat(170_000) })).toBe(true);
    expect(isBoundedDocumentContent({ type: "doc", text: "\\ud800" })).toBe(true);
    expect(isBoundedDocumentContent({ type: "doc", text: "\\u2028" })).toBe(true);
  });
});
