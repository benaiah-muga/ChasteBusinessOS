"use client";

import { useMemo } from "react";

type TemplateNode = Record<string, unknown>;

function isNode(value: unknown): value is TemplateNode {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function childrenOf(node: TemplateNode): TemplateNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function displayValue(token: string, value: string): string {
  if (/date/i.test(token) && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
  }
  return value;
}

export type TemplateLineItems = Record<string, Array<Record<string, string>>>;

function replaceFields(text: string, values: Record<string, string>, enabled: Record<string, boolean>, lineItems: TemplateLineItems, lineIndex?: number, linePrefix?: string): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, token: string) => {
    if (enabled[token] === false) return "";
    const line = token.match(/^([a-zA-Z][\w]*)\.line1\.([a-zA-Z][\w]*)$/);
    const prefix = line?.[1];
    const key = line?.[2];
    if (prefix && key && lineIndex !== undefined && linePrefix === prefix) {
      const row = lineItems[prefix]?.[lineIndex];
      const lineValue = row?.[key];
      return escapeHtml(displayValue(token, lineValue?.trim() || "Not provided"));
    }
    return escapeHtml(displayValue(token, values[token]?.trim() || "Not provided"));
  });
}

function markedText(node: TemplateNode, values: Record<string, string>, enabled: Record<string, boolean>, lineItems: TemplateLineItems, lineIndex?: number, linePrefix?: string): string {
  const text = replaceFields(typeof node.text === "string" ? node.text : "", values, enabled, lineItems, lineIndex, linePrefix);
  const marks = Array.isArray(node.marks) ? node.marks.filter(isNode) : [];
  return marks.reduce((output, mark) => {
    const type = typeof mark.type === "string" ? mark.type : "";
    if (type === "bold") return `<strong>${output}</strong>`;
    if (type === "italic") return `<em>${output}</em>`;
    if (type === "underline") return `<u>${output}</u>`;
    if (type === "strike") return `<s>${output}</s>`;
    if (type === "code") return `<code>${output}</code>`;
    return output;
  }, text);
}

/**
 * Column alignment for ruled data tables: money and count columns sit on the
 * right. Driven by header wording so it works for built-in templates and for
 * tables people draw themselves in the editor.
 */
const NUMERIC_HEADER = /\b(qty|quantity|no\.?|rate|price|amount|line total|total|fee|debit|credit|net|tax|gross|ordered|delivered|outstanding|completion|claim|balance|value|applied|due)\b/i;

export function numericAligns(headers: string[]): boolean[] {
  return headers.map((header) => NUMERIC_HEADER.test(header.trim()));
}

/** A headerless table is layout (letterhead, parties, totals); headered ones are data. */
const TOTALS_TEXT = /\b(sub\s?total|total|balance|amount due|amount to pay|amount payable|amount received)\b/i;

function rowHasHeader(row: TemplateNode): boolean {
  return childrenOf(row).some((cell) => cell.type === "tableHeader");
}

function plainText(node: TemplateNode): string {
  return childrenOf(node)
    .map((child) => {
      if (typeof child.text === "string") return child.text;
      return plainText(child);
    })
    .join(" ");
}

function renderCell(node: TemplateNode, alignRight: boolean, values: Record<string, string>, enabled: Record<string, boolean>, lineItems: TemplateLineItems, lineIndex?: number, linePrefix?: string): string {
  const tag = node.type === "tableHeader" ? "th" : "td";
  const cls = alignRight ? ` class="num"` : "";
  const content = childrenOf(node).map((child) => renderNode(child, values, enabled, lineItems, lineIndex, linePrefix)).join("");
  return `<${tag}${cls}>${content}</${tag}>`;
}

function renderRow(node: TemplateNode, aligns: boolean[] | null, values: Record<string, string>, enabled: Record<string, boolean>, lineItems: TemplateLineItems, lineIndex?: number, linePrefix?: string): string {
  const cells = childrenOf(node);
  const content = cells.map((cell, index) => renderCell(cell, aligns?.[index] === true, values, enabled, lineItems, lineIndex, linePrefix)).join("");
  return `<tr>${content}</tr>`;
}

function renderNode(node: TemplateNode, values: Record<string, string>, enabled: Record<string, boolean>, lineItems: TemplateLineItems = {}, lineIndex?: number, linePrefix?: string): string {
  const type = typeof node.type === "string" ? node.type : "paragraph";
  if (type === "text") return markedText(node, values, enabled, lineItems, lineIndex, linePrefix);
  if (type === "table") {
    const rows = childrenOf(node);
    if (rows.length > 0 && rowHasHeader(rows[0]!)) {
      const aligns = numericAligns(childrenOf(rows[0]!).map((cell) => plainText(cell)));
      const head = renderRow(rows[0]!, aligns, values, enabled, lineItems);
      const body = rows.slice(1).map((row) => {
        const match = JSON.stringify(row).match(/\{\{([a-zA-Z][\w]*)\.line1\./);
        const prefix = match?.[1];
        const count = prefix && lineItems[prefix]?.length ? lineItems[prefix].length : 1;
        return Array.from({ length: count }, (_unused, index) => renderRow(row, aligns, values, enabled, lineItems, index, prefix)).join("");
      }).join("");
      return `<table class="doc-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }
    const classes = TOTALS_TEXT.test(plainText(node)) ? "doc-grid doc-totals" : "doc-grid";
    const body = rows.map((row) => renderRow(row, null, values, enabled, lineItems, lineIndex, linePrefix)).join("");
    return `<table class="${classes}"><tbody>${body}</tbody></table>`;
  }
  const content = childrenOf(node).map((child) => renderNode(child, values, enabled, lineItems, lineIndex, linePrefix)).join("");
  if (type === "doc") return content;
  if (type === "heading") {
    const level = typeof node.attrs === "object" && node.attrs && "level" in node.attrs && typeof node.attrs.level === "number" ? Math.min(3, Math.max(1, node.attrs.level)) : 2;
    return `<h${level}>${content}</h${level}>`;
  }
  if (type === "paragraph") {
    const single = childrenOf(node);
    const text = single.length > 0 && single.every((child) => typeof child.text === "string") ? single.map((child) => String(child.text)).join("").trim() : "";
    const isEyebrow = text.length >= 2 && text.length <= 48 && /[A-Z]/.test(text) && text === text.toUpperCase();
    if (isEyebrow) return `<p class="doc-eyebrow">${content || "&nbsp;"}</p>`;
    return `<p>${content || "&nbsp;"}</p>`;
  }
  if (type === "bulletList") return `<ul>${content}</ul>`;
  if (type === "orderedList") return `<ol>${content}</ol>`;
  if (type === "listItem") return `<li>${content}</li>`;
  if (type === "blockquote") return `<blockquote>${content}</blockquote>`;
  if (type === "horizontalRule") return "<hr />";
  if (type === "tableRow") return `<tr>${content}</tr>`;
  if (type === "tableHeader") return `<th>${content}</th>`;
  if (type === "tableCell") return `<td>${content}</td>`;
  if (type === "hardBreak") return "<br />";
  if (type === "image") {
    const attrs = isNode(node.attrs) ? node.attrs : {};
    const src = typeof attrs.src === "string" && /^(data:image\/(?:png|jpe?g|gif|webp);base64,|https?:\/\/)/i.test(attrs.src) ? attrs.src : "";
    return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(typeof attrs.alt === "string" ? attrs.alt : "Document image")}" />` : "";
  }
  return content;
}

export function renderTemplateHtml(content: Record<string, unknown>, values: Record<string, string>, enabled: Record<string, boolean>, lineItems: TemplateLineItems = {}): string {
  const html = renderNode(content, values, enabled, lineItems);
  const firstChild = childrenOf(content as TemplateNode)[0];
  if (firstChild && firstChild.type === "table" && !rowHasHeader(childrenOf(firstChild)[0] ?? {})) {
    return html.replace('class="doc-grid"', 'class="doc-grid doc-letterhead"');
  }
  return html;
}

/**
 * Same classification for HTML that Tiptap produced (editor paper and print):
 * wraps header rows in a thead and applies the business paper classes that the
 * JSON renderer bakes in.
 */
export function refineDocumentHtml(html: string): string {
  if (typeof window === "undefined" || !html) return html;
  const host = document.createElement("div");
  host.innerHTML = html;
  const tables = Array.from(host.querySelectorAll("table"));
  tables.forEach((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr"));
    const firstRow = rows[0];
    if (!firstRow) return;
    const headerCells = Array.from(firstRow.querySelectorAll(":scope > th"));
    if (headerCells.length > 0) {
      table.classList.add("doc-table");
      if (!table.querySelector(":scope > thead")) {
        const head = document.createElement("thead");
        head.append(firstRow);
        table.insertBefore(head, table.firstChild);
      }
      const aligns = numericAligns(headerCells.map((cell) => cell.textContent ?? ""));
      headerCells.forEach((cell, index) => aligns[index] && cell.classList.add("num"));
      rows.slice(1).forEach((row) => {
        Array.from(row.querySelectorAll(":scope > td")).forEach((cell, index) => aligns[index] && cell.classList.add("num"));
      });
    } else {
      table.classList.add("doc-grid");
      // Cell texts must be joined with separators so word boundaries survive
      // ("Subtotal" + "UGX 0" would otherwise read as one token).
      const gridText = Array.from(table.querySelectorAll("td,th")).map((cell) => cell.textContent ?? "").join(" ");
      if (TOTALS_TEXT.test(gridText)) table.classList.add("doc-totals");
      if (tableIndex === 0) table.classList.add("doc-letterhead");
    }
  });
  host.querySelectorAll("p").forEach((paragraph) => {
    const text = (paragraph.textContent ?? "").trim();
    if (text.length >= 2 && text.length <= 48 && /[A-Z]/.test(text) && text === text.toUpperCase()) paragraph.classList.add("doc-eyebrow");
  });
  return host.innerHTML;
}

export function TemplatePreviewPage({ content, values = {}, enabled = {}, variant, lineItems = {}, className = "" }: { content: Record<string, unknown>; values?: Record<string, string>; enabled?: Record<string, boolean>; variant?: string; lineItems?: TemplateLineItems; className?: string }) {
  const html = useMemo(() => renderTemplateHtml(content, values, enabled, lineItems), [content, enabled, lineItems, values]);
  const classes = ["template-preview-paper", ...(variant ? [`pv-${variant}`] : []), className].filter(Boolean).join(" ");
  return <article className={classes} dangerouslySetInnerHTML={{ __html: html }} />;
}
