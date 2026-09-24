"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Dialog } from "@/components/ui";
import { IconArrowRight, IconEye, IconFileText } from "@/components/icons";
import { DOCUMENT_TEMPLATE_CATALOG, DOCUMENT_TEMPLATE_GROUP_LABELS, DOCUMENT_TEMPLATE_GROUPS, DOCUMENT_TEMPLATE_TYPES, templateDemoValues, type DocumentTemplateGroup, type DocumentTemplateType } from "@/lib/document-templates";
import { TemplatePreviewPage } from "@/components/template-preview";

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  placeholders: string[];
  isSystem: string | null;
  content?: Record<string, unknown> | null;
}

type CategoryId = "all" | DocumentTemplateType | "custom";

const GROUPED_TYPES: { group: DocumentTemplateGroup; types: DocumentTemplateType[] }[] = DOCUMENT_TEMPLATE_GROUP_LABELS.filter((group): group is { id: DocumentTemplateGroup; label: string } => group.id !== "general").map((group) => ({
  group: group.id,
  types: DOCUMENT_TEMPLATE_TYPES.filter((type) => DOCUMENT_TEMPLATE_GROUPS[type.id] === group.id).map((type) => type.id),
}));

const BLANK_DOC = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Custom template" }] }, { type: "paragraph" }] } as const;

function definitionFor(template: TemplateRow) {
  return DOCUMENT_TEMPLATE_CATALOG.find((item) => item.name === template.name) ?? null;
}

function typeLabel(template: TemplateRow): string {
  const definition = definitionFor(template);
  if (definition) return DOCUMENT_TEMPLATE_TYPES.find((type) => type.id === definition.type)?.label ?? "Template";
  return "Other";
}

export function DocumentTemplateGallery({ templates, onSelect }: { templates: TemplateRow[]; onSelect: (template: TemplateRow) => void }) {
  const [filter, setFilter] = useState<CategoryId>("all");
  const [previewTemplate, setPreviewTemplate] = useState<TemplateRow | null>(null);

  const counts = useMemo(() => {
    const byType = new Map<CategoryId, number>([["all", templates.length], ["custom", 0]]);
    for (const template of templates) {
      const definition = definitionFor(template);
      const key: CategoryId = definition?.type ?? "custom";
      byType.set(key, (byType.get(key) ?? 0) + 1);
    }
    return byType;
  }, [templates]);

  const visible = useMemo(
    () => templates.filter((template) => {
      if (filter === "all") return true;
      const definition = definitionFor(template);
      return filter === "custom" ? !definition : definition?.type === filter;
    }),
    [filter, templates],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="figure-label">Template studio</p>
          <p className="mt-1 text-sm text-stone-500">Pick a starting point from real paper, then finish it in the studio form.</p>
        </div>
        <p className="text-xs text-stone-500" role="status">{visible.length} of {templates.length} template{templates.length === 1 ? "" : "s"}</p>
      </div>

      <div className="tpl-chips" role="group" aria-label="Template categories">
        <button type="button" className="tpl-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All<span className="tpl-chip__count">{counts.get("all") ?? 0}</span>
        </button>
        {GROUPED_TYPES.map((entry) => (
          <span key={entry.group} className="tpl-chips__cluster">
            <span className="tpl-chips__label">{DOCUMENT_TEMPLATE_GROUP_LABELS.find((group) => group.id === entry.group)?.label}</span>
            {entry.types.map((id) => (
              <button key={id} type="button" className="tpl-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {DOCUMENT_TEMPLATE_TYPES.find((type) => type.id === id)?.label}
                <span className="tpl-chip__count">{counts.get(id) ?? 0}</span>
              </button>
            ))}
          </span>
        ))}
        {(counts.get("custom") ?? 0) > 0 && (
          <span className="tpl-chips__cluster">
            <span className="tpl-chips__label">General</span>
            <button type="button" className="tpl-chip" aria-pressed={filter === "custom"} onClick={() => setFilter("custom")}>
              Other<span className="tpl-chip__count">{counts.get("custom") ?? 0}</span>
            </button>
          </span>
        )}
      </div>

      <div className="tpl-grid">
        {visible.map((template) => {
          const definition = definitionFor(template);
          const content = definition?.contentJson ?? template.content ?? BLANK_DOC;
          const values = templateDemoValues(template.placeholders);
          const variant = definition ? DOCUMENT_TEMPLATE_GROUPS[definition.type] : "people";
          return (
            <article key={template.id} className="tpl-card">
              <button
                type="button"
                className="tpl-card__thumb"
                onClick={() => setPreviewTemplate(template)}
                aria-label={`Preview ${template.name}`}
              >
                <span className="tpl-card__paper" aria-hidden="true">
                  <TemplatePreviewPage content={content as Record<string, unknown>} values={values} variant={variant} />
                </span>
              </button>
              <div className="tpl-card__body">
                <p className="tpl-card__name">{template.name}</p>
                <p className="tpl-card__meta">
                  <span className="tpl-card__tag">{typeLabel(template)}</span>
                  <span className="tpl-card__fields"><IconFileText className="size-3" /> {template.placeholders.length} field{template.placeholders.length === 1 ? "" : "s"}</span>
                  {definition ? null : <Badge tone="neutral">{template.isSystem ? "built-in" : "custom"}</Badge>}
                </p>
                <div className="tpl-card__actions">
                  <Button size="sm" onClick={() => onSelect(template)}><IconArrowRight className="size-3.5" /> Use template</Button>
                  <Button tone="ghost" size="sm" onClick={() => setPreviewTemplate(template)}><IconEye className="size-3.5" /> Preview</Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {templates.length === 0 ? (
        <div className="tpl-grid" aria-label="Loading templates">{[1, 2, 3].map((item) => <div key={item} className="h-72 animate-pulse rounded-xl border border-stone-200 bg-stone-100" />)}</div>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">No templates in this category yet.</p>
      ) : null}

      <Dialog open={previewTemplate !== null} onClose={() => setPreviewTemplate(null)} title={previewTemplate?.name ?? "Template preview"} description={previewTemplate ? (definitionFor(previewTemplate)?.description ?? previewTemplate.description ?? undefined) : undefined} width="max-w-4xl">
        {previewTemplate && (() => {
          const definition = definitionFor(previewTemplate);
          const content = definition?.contentJson ?? previewTemplate.content ?? BLANK_DOC;
          const sampleValues = templateDemoValues(previewTemplate.placeholders);
          return <>
            <div className="template-view-dialog__stage"><TemplatePreviewPage content={content as Record<string, unknown>} values={sampleValues} variant={definition ? DOCUMENT_TEMPLATE_GROUPS[definition.type] : "people"} /></div>
            <div className="mt-4 flex items-center justify-between gap-3"><p className="text-xs text-stone-500">{previewTemplate.placeholders.length} fields can be populated and switched off before creation.</p><Button onClick={() => { onSelect(previewTemplate); setPreviewTemplate(null); }}>Use this template</Button></div>
          </>;
        })()}
      </Dialog>
    </div>
  );
}
