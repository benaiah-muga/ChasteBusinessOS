/* global console */
import assert from "node:assert/strict";
import { DOCUMENT_TEMPLATE_CATALOG, DOCUMENT_TEMPLATE_TYPES, templateDemoValues } from "../apps/web/src/lib/document-templates.ts";

// Serialized Tiptap nodes of one template, for structural assertions.
const nodes = (template) => (template.contentJson.content ?? []);
const cellType = (node) => (node.type === "tableHeader" || node.type === "tableCell" ? node.type : null);
const firstTable = (template) => nodes(template).find((node) => node.type === "table");
const hasDataTables = (template) =>
  nodes(template).some((node) => node.type === "table" && (node.content?.[0]?.content ?? []).some((cell) => cellType(cell) === "tableHeader"));
const textOf = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (typeof value === "object") return Object.values(value).map(textOf).join(" ");
  return "";
};

assert.equal(DOCUMENT_TEMPLATE_CATALOG.length, 24, "the catalog must contain exactly 24 business templates");
assert.equal(DOCUMENT_TEMPLATE_TYPES.length, 8, "the catalog must expose all eight document types");

for (const type of DOCUMENT_TEMPLATE_TYPES) {
  const templates = DOCUMENT_TEMPLATE_CATALOG.filter((template) => template.type === type.id);
  assert.equal(templates.length, 3, `${type.label} must have exactly three templates`);
  assert.equal(new Set(templates.map((template) => JSON.stringify(template.contentJson))).size, 3, `${type.label} layouts must be structurally distinct`);
  for (const template of templates) {
    const serialized = JSON.stringify(template.contentJson);
    const placeholders = new Set([...serialized.matchAll(/\{\{([a-zA-Z][\w.]+)\}\}/g)].map((match) => match[1]));
    const head = firstTable(template);
    assert.ok(head, `${template.name} must open with a letterhead table`);
    assert.equal(
      (head.content?.[0]?.content ?? []).some((cell) => cellType(cell) === "tableHeader"),
      false,
      `${template.name} must open with a borderless letterhead, not a data table`,
    );
    assert.ok(serialized.includes('"heading"'), `${template.name} needs a useful heading hierarchy`);
    assert.match(serialized, /"horizontalRule"/, `${template.name} needs the ledger rule under its letterhead`);
    assert.ok(placeholders.size >= 4, `${template.name} needs useful fill-in fields`);
    assert.ok(template.preview.meta.length >= 8, `${template.name} needs a spec chip for its gallery card`);
    assert.ok(template.description.length >= 30, `${template.name} needs a meaningful description`);
    const demoValues = templateDemoValues([...placeholders]);
    for (const [token, value] of Object.entries(demoValues)) {
      assert.ok(value.length > 0 && !value.includes("{{"), `${template.name} demo value for ${token} must be presentable`);
      assert.ok(!/^Sample entry$/.test(value) || !token.split(".").at(-1).match(/name|total|number|date/), `${template.name} demo for ${token} needs a real-looking value`);
    }
    if (["quotation", "sales_invoice", "purchase_order", "voucher", "receipt"].includes(type.id)) {
      assert.ok(hasDataTables(template), `${template.name} must carry at least one ruled data table`);
      assert.match(textOf(template.contentJson), /\b(TOTAL|DUE|PAID|BALANCE)\b/i, `${template.name} needs a clear total moment`);
    } else {
      // Delivery and employment paper close with signature lines, not money.
      const signatureLine = nodes(template).some((node) =>
        node.type === "table" && JSON.stringify(node).includes('"horizontalRule"'),
      );
      assert.ok(signatureLine, `${template.name} must close with a signature block`);
    }
  }
}

assert.equal(new Set(DOCUMENT_TEMPLATE_CATALOG.map((template) => template.name)).size, 24, "template names must be unique");
console.log("DOCUMENT TEMPLATE CATALOG OK: 8 types, 24 distinct professional templates");
