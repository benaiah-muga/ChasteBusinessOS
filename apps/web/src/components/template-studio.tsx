"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Dialog, Select } from "@/components/ui";
import { IconCheck, IconDownload, IconFileText, IconSearch } from "@/components/icons";
import { callApi } from "@/lib/api";
import { DOCUMENT_TEMPLATE_CATALOG, DOCUMENT_TEMPLATE_GROUPS, type DocumentTemplateDefinition } from "@/lib/document-templates";
import { TemplatePreviewPage, refineDocumentHtml, renderTemplateHtml, type TemplateLineItems } from "@/components/template-preview";

export interface TemplateStudioRow {
  id: string;
  name: string;
  description: string | null;
  placeholders: string[];
  isSystem: string | null;
  content?: Record<string, unknown> | null;
}

export interface TemplateStudioRecord {
  id: string;
  label: string;
  detail: string;
  values: Record<string, string>;
}

export interface TemplateCreationInput {
  template: TemplateStudioRow;
  values: Record<string, string>;
  fieldEnabled: Record<string, boolean>;
  title: string;
  folder: string;
  selectedRecord: TemplateStudioRecord | null;
  lineItems: TemplateLineItems;
}

export interface TemplateCreationResult {
  id: string;
  title: string;
}

interface TemplateStudioProps {
  open: boolean;
  templates: TemplateStudioRow[];
  initialTemplate: TemplateStudioRow | null;
  initialFolder?: string;
  busy?: boolean;
  onClose: () => void;
  /** Commits the filled paper and returns the saved document; null means it did not save. */
  onCreate: (input: TemplateCreationInput) => Promise<TemplateCreationResult | null>;
}

function fieldLabel(token: string): string {
  return token.split(".").map((part) => part.replace(/([a-z])([A-Z])/g, "$1 $2")).join(" / ").replace(/^./, (letter) => letter.toUpperCase());
}

function definitionFor(template: TemplateStudioRow | null): DocumentTemplateDefinition | null {
  return DOCUMENT_TEMPLATE_CATALOG.find((item) => item.name === template?.name) ?? null;
}

function lineToken(token: string): boolean {
  return /^[a-zA-Z][\w]*\.line\d+\.[a-zA-Z][\w]*$/.test(token);
}

function inputTypeFor(token: string): "text" | "date" | "datetime-local" {
  if (/date/i.test(token) && !/dateTime|datetime/i.test(token)) return "date";
  if (/dateTime|datetime|time/i.test(token)) return "datetime-local";
  return "text";
}

function numberingFor(definition: DocumentTemplateDefinition | null): { token: string; kind: string } | null {
  if (!definition) return null;
  const numbering: Record<DocumentTemplateDefinition["type"], { token: string; kind: string }> = {
    sales_invoice: { token: "invoice.number", kind: "invoice" },
    quotation: { token: "quotation.number", kind: "quote" },
    receipt: { token: "receipt.number", kind: "receipt" },
    delivery_note: { token: "delivery.number", kind: "delivery_note" },
    purchase_order: { token: "purchaseOrder.number", kind: "purchase_order" },
    voucher: { token: "voucher.number", kind: "voucher" },
    employment_contract: { token: "employment.reference", kind: "employment_contract" },
    employment_agreement: { token: "agreement.reference", kind: "employment_agreement" },
  };
  return numbering[definition.type];
}

function localDateValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initialLineItems(definition: DocumentTemplateDefinition | null): TemplateLineItems {
  if (!definition?.lineItemConfig) return {};
  const row = Object.fromEntries(definition.lineItemConfig.columns.map((column) => [column.key, column.computed === "amount" ? "0" : column.key === "quantity" ? "1" : ""]));
  return { [definition.lineItemConfig.prefix]: [row] };
}

function updateComputedRows(items: TemplateLineItems, definition: DocumentTemplateDefinition | null): TemplateLineItems {
  const config = definition?.lineItemConfig;
  if (!config) return items;
  return {
    ...items,
    [config.prefix]: (items[config.prefix] ?? []).map((row) => {
      const amountColumn = config.columns.find((column) => column.computed === "amount");
      if (!amountColumn) return row;
      const quantity = Number(row.quantity ?? 0);
      const rate = Number(row.rate ?? 0);
      const amount = Number.isFinite(quantity * rate) ? String(Math.round(quantity * rate * 100) / 100) : "0";
      return { ...row, [amountColumn.key]: amount };
    }),
  };
}

export function TemplateStudio({ open, templates, initialTemplate, initialFolder = "", busy = false, onClose, onCreate }: TemplateStudioProps) {
  const [activeTemplate, setActiveTemplate] = useState<TemplateStudioRow | null>(initialTemplate);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldEnabled, setFieldEnabled] = useState<Record<string, boolean>>({});
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState(initialFolder);
  const [recordQuery, setRecordQuery] = useState("");
  const [records, setRecords] = useState<TemplateStudioRecord[]>([]);
  const [recordsBusy, setRecordsBusy] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<TemplateStudioRecord | null>(null);
  const [lineItems, setLineItems] = useState<TemplateLineItems>({});
  // Small screens show fields or preview, never both stacked; the tab bar below switches panes.
  const [mobilePane, setMobilePane] = useState<"fields" | "preview">("fields");
  // Committing keeps the studio open: the form is the template's editor, so the
  // saved document stays here under its file name instead of moving elsewhere.
  const [saved, setSaved] = useState<TemplateCreationResult | null>(null);
  const [editsAfterSave, setEditsAfterSave] = useState(false);

  const definition = useMemo(() => definitionFor(activeTemplate), [activeTemplate]);

  useEffect(() => {
    if (!open) return;
    setActiveTemplate(initialTemplate);
    setValues({});
    setFieldEnabled(Object.fromEntries((initialTemplate?.placeholders ?? []).map((token) => [token, true])));
    setTitle("");
    setFolder(initialFolder);
    setRecordQuery("");
    setRecords([]);
    setSelectedRecord(null);
    setLineItems(initialLineItems(definitionFor(initialTemplate)));
    setMobilePane("fields");
    setSaved(null);
    setEditsAfterSave(false);
  }, [initialFolder, initialTemplate, open]);

  useEffect(() => {
    if (!activeTemplate) return;
    setFieldEnabled((current) => Object.fromEntries(activeTemplate.placeholders.map((token) => [token, current[token] ?? true])));
    setLineItems(initialLineItems(definitionFor(activeTemplate)));
  }, [activeTemplate]);

  useEffect(() => {
    if (!open || !definition) return;
    const numbering = numberingFor(definition);
    const dateToken = definition.type === "delivery_note" || definition.type === "receipt" || definition.type === "quotation" || definition.type === "sales_invoice" ? "document.date" : null;
    if (dateToken) setValues((current) => current[dateToken] ? current : { ...current, [dateToken]: localDateValue() });
    if (!numbering) return;
    void callApi<{ number: string }>(`/api/docs/next-number?kind=${numbering.kind}`).then((result) => {
      if (result.ok && result.data?.number) setValues((current) => current[numbering.token] ? current : { ...current, [numbering.token]: result.data!.number });
    });
  }, [definition, open]);

  useEffect(() => {
    if (!definition) return;
    const timer = setTimeout(async () => {
      setRecordsBusy(true);
      const result = await callApi<{ records: TemplateStudioRecord[] }>(`/api/docs/records?type=${definition.recordType}&q=${encodeURIComponent(recordQuery)}`);
      setRecords(result.ok ? result.data?.records ?? [] : []);
      setRecordsBusy(false);
    }, 220);
    return () => clearTimeout(timer);
  }, [definition, recordQuery]);

  function touch(): void {
    if (saved) setEditsAfterSave(true);
  }

  function switchTemplate(id: string): void {
    const next = templates.find((template) => template.id === id) ?? null;
    if (!next) return;
    setActiveTemplate(next);
    setRecordQuery("");
    setRecords([]);
    setSelectedRecord(null);
    setLineItems(initialLineItems(definitionFor(next)));
    setSaved(null);
    setEditsAfterSave(false);
  }

  function chooseRecord(record: TemplateStudioRecord): void {
    setSelectedRecord(record);
    setValues((current) => ({ ...record.values, ...current }));
    if (!title) setTitle(record.label);
    touch();
  }

  async function create(): Promise<void> {
    if (!activeTemplate) return;
    const result = await onCreate({ template: activeTemplate, values, fieldEnabled, lineItems: updateComputedRows(lineItems, definition), title: title.trim(), folder: folder.trim(), selectedRecord });
    if (result) {
      setSaved(result);
      setEditsAfterSave(false);
    }
  }

  /** Prints the live paper through the shared print surface; the browser's dialog saves it as PDF. */
  function downloadPdf(): void {
    const html = renderTemplateHtml(previewContent, values, fieldEnabled, lineItems);
    const surface = document.createElement("div");
    surface.className = "print-only";
    surface.dataset.margin = "normal";
    if (definition) surface.dataset.docType = definition.type;
    surface.innerHTML = refineDocumentHtml(html);
    const settings = document.createElement("style");
    settings.media = "print";
    settings.textContent = "@page { size: A4 portrait; margin: 0; }";
    const remove = () => {
      settings.remove();
      surface.remove();
      window.removeEventListener("afterprint", remove);
    };
    window.addEventListener("afterprint", remove);
    document.body.append(settings, surface);
    requestAnimationFrame(() => window.print());
    setTimeout(remove, 60_000);
  }

  const previewContent = definition?.contentJson ?? activeTemplate?.content ?? { type: "doc", content: [] };
  const regularPlaceholders = (activeTemplate?.placeholders ?? []).filter((token) => !lineToken(token));
  const lineItemConfig = definition?.lineItemConfig;
  const filledCount = regularPlaceholders.filter((token) => (values[token]?.trim() ?? "").length > 0).length;
  const variant = definition ? DOCUMENT_TEMPLATE_GROUPS[definition.type] : "people";

  const status = saved
    ? editsAfterSave
      ? `Saved as \u201C${saved.title}\u201D in Documents. Your edits are not saved yet: use Save a copy to keep them.`
      : `Saved as \u201C${saved.title}\u201D in Documents.`
    : "Preview updates as you type";

  return (
    <Dialog open={open} onClose={onClose} title="Build from a template" description="Fill in the document, check the final paper, and save it with a file name. This form is the editor: nothing opens elsewhere." width="max-w-6xl">
      <div className="template-studio" data-pane={mobilePane}>
        <div className="template-studio__tabs" role="tablist" aria-label="Studio panes">
          <button type="button" role="tab" aria-selected={mobilePane === "fields"} onClick={() => setMobilePane("fields")}>Fields{activeTemplate ? ` (${filledCount}/${activeTemplate.placeholders.length})` : ""}</button>
          <button type="button" role="tab" aria-selected={mobilePane === "preview"} onClick={() => setMobilePane("preview")}>Preview</button>
        </div>
        <section className="template-studio__form" role="tabpanel" aria-label="Template fields">
          <div className="template-studio__template-switch">
            <div>
              <p className="figure-label">Template</p>
              <p className="mt-1 text-xs text-stone-500">Switching keeps your working values where fields match.</p>
            </div>
            <Select aria-label="Selected template" value={activeTemplate?.id ?? ""} onChange={(event) => switchTemplate(event.target.value)}>
              {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </Select>
          </div>

          {definition && (
            <div className="template-studio__identity">
              <div className="flex min-w-0 items-center gap-2"><IconFileText className="size-4 text-gold-700" /><strong className="truncate">{activeTemplate?.name}</strong></div>
              <Badge tone="neutral">{definition.recordLabel}</Badge>
            </div>
          )}

          {definition && (
            <div className="record-picker template-studio__record-picker">
              <label htmlFor="template-record-search" className="label">Populate from {definition.recordLabel.toLowerCase()}</label>
              <div className="record-picker__search"><IconSearch className="size-4" /><input id="template-record-search" value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} placeholder={`Search ${definition.recordLabel.toLowerCase()}`} autoComplete="off" /></div>
              {selectedRecord ? (
                <div className="record-picker__selected"><span><strong>Selected record</strong><br />{selectedRecord.label}<small>{selectedRecord.detail}</small></span><Button tone="ghost" size="sm" onClick={() => setSelectedRecord(null)}>Change</Button></div>
              ) : (
                <div className="record-picker__results" role="listbox" aria-label={`${definition.recordLabel} results`}>
                  {recordsBusy ? <p>Searching records...</p> : records.length === 0 ? <p>No matching records. You can continue by hand.</p> : records.map((record) => <button key={record.id} type="button" role="option" aria-selected="false" onClick={() => chooseRecord(record)}><span>{record.label}</span><small>{record.detail}</small></button>)}
                </div>
              )}
            </div>
          )}

          <div className="template-studio__fields-head"><div><p className="figure-label">Fill-in fields</p><p className="mt-1 text-xs text-stone-500">Unfilled fields stay visible as a clear placeholder.</p></div><span className="text-xs text-stone-400">{regularPlaceholders.length} fields</span></div>
          <div className="template-studio__fields">
            {regularPlaceholders.map((token) => (
              <div key={token} className={`template-studio__field ${fieldEnabled[token] === false ? "is-disabled" : ""}`}>
                <label className="template-studio__field-label" htmlFor={`template-field-${token}`}>
                  <input type="checkbox" checked={fieldEnabled[token] !== false} onChange={(event) => { setFieldEnabled((current) => ({ ...current, [token]: event.target.checked })); touch(); }} />
                  <span>{fieldLabel(token)}</span>
                </label>
                <input id={`template-field-${token}`} type={inputTypeFor(token)} className="input" disabled={fieldEnabled[token] === false} value={values[token] ?? ""} onChange={(event) => { setValues((current) => ({ ...current, [token]: event.target.value })); touch(); }} placeholder={inputTypeFor(token) === "text" ? "Enter a value" : undefined} />
                {token === numberingFor(definition)?.token && fieldEnabled[token] !== false && <span className="mt-1 block text-xs text-stone-500">Suggested from your document sequence. You can edit this reference.</span>}
              </div>
            ))}
          </div>

          {lineItemConfig && (
            <div className="template-studio__line-items">
              <div className="template-studio__fields-head"><div><p className="figure-label">Line items</p><p className="mt-1 text-xs text-stone-500">Add as many rows as the document needs. Amounts calculate from quantity and unit price.</p></div><Button tone="secondary" size="sm" onClick={() => setLineItems((current) => ({ ...current, [lineItemConfig.prefix]: [...(current[lineItemConfig.prefix] ?? []), Object.fromEntries(lineItemConfig.columns.map((column) => [column.key, column.computed === "amount" ? "0" : column.key === "quantity" ? "1" : ""]))] }))}>Add line</Button></div>
              <div className="template-studio__line-list">
                {(lineItems[lineItemConfig.prefix] ?? []).map((row, rowIndex) => (
                  <div className="template-studio__line-row" key={`${lineItemConfig.prefix}-${rowIndex}`}>
                    <span className="template-studio__line-index">{rowIndex + 1}</span>
                    {lineItemConfig.columns.map((column) => {
                      const disabled = column.computed === "amount";
                      return <label className="template-studio__line-field" key={column.key}><span>{column.label}</span><input className="input" type={column.input} inputMode={column.input === "number" ? "decimal" : undefined} min={column.input === "number" ? "0" : undefined} step={column.input === "number" ? "0.01" : undefined} disabled={disabled} value={row[column.key] ?? ""} onChange={(event) => setLineItems((current) => updateComputedRows({ ...current, [lineItemConfig.prefix]: (current[lineItemConfig.prefix] ?? []).map((item, index) => index === rowIndex ? { ...item, [column.key]: event.target.value } : item) }, definition))} placeholder={disabled ? "Calculated" : "Enter value"} /></label>;
                    })}
                    <button type="button" className="template-studio__line-remove" onClick={() => setLineItems((current) => ({ ...current, [lineItemConfig.prefix]: (current[lineItemConfig.prefix] ?? []).filter((_item, index) => index !== rowIndex) }))} disabled={(lineItems[lineItemConfig.prefix] ?? []).length <= 1} aria-label={`Remove line ${rowIndex + 1}`}>Remove</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="template-studio__meta-fields">
            <div><label htmlFor="template-studio-title" className="label">File name</label><input id="template-studio-title" className="input" value={title} onChange={(event) => { setTitle(event.target.value); touch(); }} placeholder={activeTemplate?.name ?? "Document title"} /></div>
            <div><label htmlFor="template-studio-folder" className="label">Folder <span className="font-normal text-stone-400">(optional)</span></label><input id="template-studio-folder" className="input" value={folder} onChange={(event) => { setFolder(event.target.value); touch(); }} placeholder="Finance / 2026" /></div>
          </div>
        </section>

        <aside className="template-studio__preview" role="tabpanel" aria-label="Live template preview">
          <div className="template-studio__preview-bar">
            <span>Live paper preview</span>
            <span className="flex items-center gap-2">
              <button type="button" className="template-studio__download" onClick={downloadPdf}><IconDownload className="size-3.5" /> Download PDF</button>
              <span>{definition?.type.replaceAll("_", " ") ?? "Template"}</span>
            </span>
          </div>
          <div className="template-studio__preview-stage"><TemplatePreviewPage content={previewContent} values={values} enabled={fieldEnabled} lineItems={lineItems} variant={variant} /></div>
        </aside>
      </div>
      <div className="template-studio__footer">
        <span className={`flex items-center gap-1.5 text-xs ${saved ? (editsAfterSave ? "text-amber-700" : "text-emerald-700") : "text-stone-500"}`} role="status">
          <IconCheck className={`size-3.5 ${saved && editsAfterSave ? "text-amber-600" : "text-emerald-600"}`} /> {status}
        </span>
        <div className="flex gap-2">
          <Button tone="secondary" onClick={onClose}>{saved ? "Close" : "Cancel"}</Button>
          <Button tone="ghost" onClick={downloadPdf} disabled={!activeTemplate}><IconDownload className="size-3.5" /> Download PDF</Button>
          {!saved || editsAfterSave ? (
            <Button loading={busy} disabled={!activeTemplate} onClick={() => void create()}>{saved ? "Save a copy" : "Use this template"}</Button>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
