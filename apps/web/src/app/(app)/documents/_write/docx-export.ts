"use client";

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/**
 * Client-side .docx export for authored documents (Phase 4). Converts the
 * editor's Tiptap JSON into a Word document. Supported: headings, paragraphs
 * with bold/italic/strike/code marks, bullet and numbered lists, quotes,
 * code blocks, tables, horizontal rules. Images are omitted from the export
 * (they remain in the document itself).
 */

type Mark = { type: string };
type Node = { type: string; text?: string; marks?: Mark[]; content?: Node[]; attrs?: Record<string, unknown> };

function runs(nodes: Node[] | undefined): TextRun[] {
  return (nodes ?? []).map((n) => {
    const marks = new Set((n.marks ?? []).map((m) => m.type));
    return new TextRun({
      text: n.text ?? "",
      bold: marks.has("bold"),
      italics: marks.has("italic"),
      strike: marks.has("strike"),
      font: marks.has("code") ? "Courier New" : undefined,
    });
  });
}

const LIST_LEVEL = { level: 0 as const };

function block(node: Node): (Paragraph | Table)[] {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const heading =
        level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return [new Paragraph({ children: runs(node.content), heading })];
    }
    case "paragraph":
      return [new Paragraph({ children: runs(node.content) })];
    case "blockquote":
      return [
        new Paragraph({ children: runs(node.content), indent: { left: 720 }, spacing: { before: 120, after: 120 } }),
      ];
    case "codeBlock":
      return [new Paragraph({ children: runs(node.content), shading: { fill: "F5F5F4" } })];
    case "bulletList":
      return (node.content ?? []).flatMap((li) =>
        (li.content ?? []).map((child) => new Paragraph({ children: runs(child.content), bullet: LIST_LEVEL })),
      );
    case "orderedList":
      return (node.content ?? []).flatMap((li) =>
        (li.content ?? []).map((child) =>
          new Paragraph({ children: runs(child.content), numbering: { reference: "doc-num", level: 0 } }),
        ),
      );
    case "horizontalRule":
      return [new Paragraph({ border: { bottom: { style: "single", size: 6, color: "D6D3D1" } }, spacing: { after: 200 } })];
    case "table":
      return [table(node)];
    default:
      return node.content ? node.content.flatMap(block) : [];
  }
}

function table(node: Node): Table {
  const rows = (node.content ?? []).map(
    (rowNode) =>
      new TableRow({
        children: (rowNode.content ?? []).map(
          (cellNode) =>
            new TableCell({
              children: (cellNode.content ?? []).map((c) => new Paragraph({ children: runs(c.content) })),
              width: { size: 25, type: WidthType.PERCENTAGE },
            }),
        ),
      }),
  );
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/** Builds and downloads a .docx for the given Tiptap JSON. */
export async function exportDocx(title: string, content: unknown): Promise<void> {
  const doc = content as Node;
  const children = (doc.content ?? []).flatMap(block);
  const document = new Document({
    numbering: {
      config: [
        {
          reference: "doc-num",
          levels: [
            { level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children: [new Paragraph({ text: title, heading: HeadingLevel.TITLE }), ...children] }],
  });
  const blob = await Packer.toBlob(document);
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^\w\s-]/g, "").trim() || "document"}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}
