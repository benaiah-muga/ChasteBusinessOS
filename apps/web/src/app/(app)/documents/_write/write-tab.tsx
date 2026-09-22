"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  LoadingPage,
  ActionNotice,
  type ActionNoticeState,
} from "@/components/ui";
import { IconFileText, IconTrash } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { statusTone, timeAgo } from "@/lib/format";

/**
 * The Write tab (Phase 4): authored documents and the template gallery.
 * Creating from a template resolves {{placeholders}} through a fill-in
 * form, optionally pre-filled from org memory by the assistant.
 */

interface AuthoredDocRow {
  id: string;
  title: string;
  status: string;
  versions: number;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  placeholders: string[];
  isSystem: string | null;
}

export function WriteTab() {
  const router = useRouter();
  const [docs, setDocs] = useState<AuthoredDocRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tpl, setTpl] = useState<TemplateRow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [newDocOpen, setNewDocOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await callApi<{ documents: AuthoredDocRow[]; templates: TemplateRow[] }>("/api/docs");
    if (res.ok && res.data) {
      setDocs(res.data.documents ?? []);
      setTemplates(res.data.templates ?? []);
    } else {
      setNotice({ tone: "error", error: res.error! });
      setDocs([]);
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteDoc(id: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/docs", { action: "delete", documentId: id } as Record<string, unknown>);
      if (!res.ok) setNotice({ tone: "error", error: res.error! });
      await load();
    } finally {
      setBusy(false);
    }
  }

  function openTemplate(t: TemplateRow) {
    setTpl(t);
    setValues({});
    setTitle("");
  }

  async function prefill() {
    if (!tpl) return;
    setBusy(true);
    try {
      const res = await postApi<{ values: Record<string, string> }>("/api/docs/assist", {
        kind: "prefill",
        templateId: tpl.id,
      });
      if (res.ok && res.data?.values) setValues((v) => ({ ...res.data!.values, ...v }));
      else setNotice({ tone: "error", error: res.error ?? { title: "The assistant has nothing on file for these fields.", hint: "Fill the fields by hand; you can retry once the workmate has learned more." } });
    } finally {
      setBusy(false);
    }
  }

  async function createFromTemplate() {
    if (!tpl) return;
    setBusy(true);
    try {
      const full = await callApi<{ template: { content: unknown } | null }>(`/api/docs?template=${tpl.id}`);
      const contentJson = full.ok && full.data?.template?.content ? full.data.template.content : { type: "doc", content: [] };
      let serialized = JSON.stringify(contentJson);
      for (const ph of tpl.placeholders) {
        const value = (values[ph] ?? "").replace(/"/g, '\\"');
        serialized = serialized.split(`{{${ph}}}`).join(value);
      }
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      const res = await postApi<{ documentId: string }>("/api/docs", {
        action: "create",
        title: title.trim() || tpl.name,
        content: parsed,
        html: "",
        templateId: tpl.id,
      });
      if (res.ok && res.data?.documentId) {
        router.push(`/documents/editor/${res.data.documentId}`);
      } else {
        setNotice({ tone: "error", error: res.error! });
      }
    } finally {
      setBusy(false);
    }
  }

  async function createBlank() {
    setBusy(true);
    try {
      const content = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title.trim() || "Untitled" }] }, { type: "paragraph" }] };
      const res = await postApi<{ documentId: string }>("/api/docs", {
        action: "create",
        title: title.trim() || "Untitled document",
        content,
        html: "",
      });
      if (res.ok && res.data?.documentId) router.push(`/documents/editor/${res.data.documentId}`);
      else setNotice({ tone: "error", error: res.error! });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {/* Templates */}
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <p className="figure-label">Start from a template</p>
          <Button tone="secondary" size="sm" onClick={() => setNewDocOpen(true)}>
            New blank document
          </Button>
        </div>
        {templates === null ? (
          <LoadingPage />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => openTemplate(t)}
                className="cursor-pointer rounded-xl border border-stone-200 bg-white p-4 text-left shadow-xs transition-shadow hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-stone-900">{t.name}</p>
                  {t.isSystem ? <Badge tone="neutral">built-in</Badge> : null}
                </div>
                <p className="mt-1 line-clamp-2 min-h-8 text-xs text-stone-500">{t.description ?? ""}</p>
                <p className="mt-2 text-xs text-gold-700">
                  {t.placeholders.length > 0 ? `${t.placeholders.length} fill-in field${t.placeholders.length === 1 ? "" : "s"}` : "No fields"}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Authored documents */}
      <div className="rounded-xl border border-stone-200 bg-white shadow-xs">
        <p className="figure-label border-b border-stone-100 px-5 py-3">Your documents</p>
        {docs === null ? (
          <LoadingPage />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={<IconFileText />}
            title="Nothing written yet"
            hint="Start from a template above, or create a blank document."
          />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Versions</th>
                <th>Updated</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="font-medium text-stone-800">
                    <a href={`/documents/editor/${d.id}`} className="cursor-pointer hover:text-gold-700 hover:underline">
                      {d.title}
                    </a>
                  </td>
                  <td>
                    <Badge tone={statusTone(d.status === "published" ? "parsed" : "received")}>{d.status}</Badge>
                  </td>
                  <td className="num">{d.versions}</td>
                  <td className="text-xs whitespace-nowrap text-stone-500">{timeAgo(d.updatedAt)}</td>
                  <td className="text-right whitespace-nowrap">
                    <Button tone="ghost" size="sm" onClick={() => router.push(`/documents/editor/${d.id}`)}>
                      Open
                    </Button>
                    <Button
                      tone="ghost"
                      size="sm"
                      className="hover:bg-red-50 hover:text-red-700"
                      disabled={busy}
                      onClick={() => void deleteDoc(d.id)}
                    >
                      <IconTrash className="size-3.5" />
                      <span className="sr-only">Delete {d.title}</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Template fill-in dialog */}
      <Dialog open={tpl !== null} onClose={() => setTpl(null)} title={tpl ? `New from: ${tpl.name}` : ""}>
        {tpl && (
          <>
            {tpl.placeholders.length > 0 && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <p className="label mb-0">Fill in the fields</p>
                  <Button tone="ghost" size="sm" loading={busy} onClick={prefill}>
                    Fill from org memory
                  </Button>
                </div>
                <div className="grid max-h-64 gap-3 overflow-y-auto sm:grid-cols-2">
                  {tpl.placeholders.map((ph) => (
                    <div key={ph}>
                      <label htmlFor={`ph-${ph}`} className="label">
                        {ph}
                      </label>
                      <input
                        id={`ph-${ph}`}
                        value={values[ph] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [ph]: e.target.value }))}
                        className="input"
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
            <label htmlFor="tpl-doc-title" className="label mt-3">
              Document title
            </label>
            <input
              id="tpl-doc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tpl.name}
              className="input"
            />
            <p className="mt-2 text-xs text-stone-400">Unfilled fields keep their {"{{token}}"} so you can spot them later.</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button tone="secondary" onClick={() => setTpl(null)}>
                Cancel
              </Button>
              <Button loading={busy} onClick={createFromTemplate}>
                Create document
              </Button>
            </div>
          </>
        )}
      </Dialog>

      {/* New blank document */}
      <Dialog open={newDocOpen} onClose={() => setNewDocOpen(false)} title="New blank document">
        <label htmlFor="new-doc-title" className="label">
          Title
        </label>
        <input
          id="new-doc-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Letter to the landlord"
          className="input"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button tone="secondary" onClick={() => setNewDocOpen(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={createBlank}>
            Create
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
