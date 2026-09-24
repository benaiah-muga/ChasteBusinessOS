"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionNotice, Badge, Button, ConfirmDialog, Dialog, EmptyState, LoadingPage, Select, type ActionNoticeState } from "@/components/ui";
import { IconArrowsHorizontal, IconBookOpen, IconFileText, IconListTree, IconSearch, IconTrash, IconUpload } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { statusTone, timeAgo } from "@/lib/format";
import { DocumentTemplateGallery } from "@/components/document-template-gallery";
import { FolderTree } from "@/components/folder-tree";
import { DOCUMENT_TEMPLATE_CATALOG } from "@/lib/document-templates";
import { TemplateStudio, type TemplateCreationInput, type TemplateCreationResult, type TemplateStudioRow } from "@/components/template-studio";

function isTemplateNode(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function replaceLineToken(value: unknown, prefix: string, row: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(new RegExp(`\\{\\{${prefix}\\.line1\\.([a-zA-Z][\\w]*)\\}\\}`, "g"), (_match, key: string) => row[key] ?? "");
  if (Array.isArray(value)) return value.map((item) => replaceLineToken(item, prefix, row));
  if (!isTemplateNode(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceLineToken(child, prefix, row)]));
}

function expandLineItems(value: unknown, lineItems: TemplateCreationInput["lineItems"]): unknown {
  if (Array.isArray(value)) return value.flatMap((item) => expandLineItems(item, lineItems));
  if (!isTemplateNode(value)) return value;
  if (value.type === "table" && Array.isArray(value.content)) {
    const rows = value.content.filter(isTemplateNode);
    const head = rows[0];
    const body = rows.slice(1);
    const expanded = body.flatMap((row) => {
      const match = JSON.stringify(row).match(/\{\{([a-zA-Z][\w]*)\.line1\./);
      const prefix = match?.[1];
      const rowsForPrefix = prefix ? lineItems[prefix] ?? [] : [];
      if (!prefix || rowsForPrefix.length === 0) return [expandLineItems(row, lineItems)];
      return rowsForPrefix.map((line) => replaceLineToken(expandLineItems(row, lineItems), prefix, line));
    });
    return { ...value, content: [head, ...expanded] };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandLineItems(child, lineItems)]));
}

function fillTemplateTokens(content: unknown, values: Record<string, string>, enabled: Record<string, boolean>): unknown {
  if (typeof content === "string") return content.replace(/\{\{([^}]+)\}\}/g, (_match, token: string) => enabled[token] === false ? "" : values[token]?.trim() || "Not provided");
  if (Array.isArray(content)) return content.map((item) => fillTemplateTokens(item, values, enabled));
  if (!isTemplateNode(content)) return content;
  return Object.fromEntries(Object.entries(content).map(([key, child]) => [key, fillTemplateTokens(child, values, enabled)]));
}

interface AuthoredDocRow {
  id: string;
  title: string;
  status: string;
  versions: number;
  updatedAt: string;
  folder: string | null;
  documentType: string | null;
  linkedRecordType: string | null;
  linkedRecordId: string | null;
  linkedRecordLabel: string | null;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  placeholders: string[];
  isSystem: string | null;
  content?: Record<string, unknown> | null;
}

const fallbackError = { title: "The document could not be saved", hint: "Check your connection and try again. Your entries are still in this form." };

export function WriteTab() {
  const router = useRouter();
  const templateAnchor = useRef<HTMLDivElement>(null);
  const [docs, setDocs] = useState<AuthoredDocRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tpl, setTpl] = useState<TemplateRow | null>(null);
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<AuthoredDocRow | null>(null);
  const [deleteDoc, setDeleteDoc] = useState<AuthoredDocRow | null>(null);
  const [folderCreateSignal, setFolderCreateSignal] = useState(0);
  const [draggingDocId, setDraggingDocId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [docRes, folderRes] = await Promise.all([
      callApi<{ documents: AuthoredDocRow[]; templates: TemplateRow[] }>("/api/docs"),
      callApi<{ folders: Array<{ path: string }> }>("/api/docs/folders"),
    ]);
    if (docRes.ok && docRes.data) {
      setDocs(docRes.data.documents ?? []);
      setTemplates(docRes.data.templates ?? []);
    } else {
      setNotice({ tone: "error", error: docRes.error ?? fallbackError });
      setDocs([]);
      setTemplates([]);
    }
    if (folderRes.ok) setFolders(folderRes.data?.folders.map((item) => item.path) ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const folderPaths = useMemo(() => [...folders, ...(docs ?? []).flatMap((item) => item.folder ? [item.folder] : [])], [docs, folders]);
  const folderCounts = useMemo(() => Object.fromEntries(folderPaths.map((path) => [path, (docs ?? []).filter((item) => item.folder === path || item.folder?.startsWith(`${path}/`)).length])), [docs, folderPaths]);
  const visibleDocs = useMemo(() => (docs ?? []).filter((item) => {
    const inFolder = !activeFolder || item.folder === activeFolder || item.folder?.startsWith(`${activeFolder}/`);
    const term = query.trim().toLowerCase();
    return inFolder && (!term || [item.title, item.folder, item.documentType, item.linkedRecordLabel].some((value) => value?.toLowerCase().includes(term)));
  }), [activeFolder, docs, query]);

  async function folderAction(body: Record<string, unknown>): Promise<boolean> {
    const result = await postApi("/api/docs/folders", body);
    if (!result.ok) {
      setNotice({ tone: "error", error: result.error ?? { title: "The folder was not changed", hint: "Move any documents or nested folders, then try again." } });
      return false;
    }
    await load();
    return true;
  }

  function openTemplate(template: TemplateRow) {
    setTpl(template);
  }

  /**
   * Commits the filled template as a document and stays here: the studio form
   * is the template's editor, so the word editor is never opened as a side
   * effect. The library list refreshes so the new file is immediately visible.
   */
  async function createFromTemplate(input: TemplateCreationInput): Promise<TemplateCreationResult | null> {
    const definition = DOCUMENT_TEMPLATE_CATALOG.find((item) => item.name === input.template.name);
    setBusy(true);
    try {
      const full = await callApi<{ template: { content: unknown } | null }>(`/api/docs?template=${input.template.id}`);
      const contentJson = full.ok && full.data?.template?.content ? full.data.template.content : definition?.contentJson;
      if (!contentJson) {
        setNotice({ tone: "error", error: { title: "The template content could not be loaded", hint: "Reopen the template and try again." } });
        return null;
      }
      const expandedContent = expandLineItems(contentJson, input.lineItems);
      const filledContent = fillTemplateTokens(expandedContent, input.values, input.fieldEnabled);
      const serialized = JSON.stringify(filledContent);
      const savedTitle = input.title || input.selectedRecord?.label || input.template.name.replace(" - ", ": ");
      const result = await postApi<{ documentId: string }>("/api/docs", {
        action: "create",
        title: savedTitle,
        content: JSON.parse(serialized) as Record<string, unknown>,
        html: "",
        templateId: input.template.id,
        folder: input.folder || undefined,
        documentType: definition?.type,
        linkedRecordType: input.selectedRecord && definition ? definition.recordType : undefined,
        linkedRecordId: input.selectedRecord?.id,
        linkedRecordLabel: input.selectedRecord?.label,
      });
      if (result.ok && result.data?.documentId) {
        await load();
        setNotice({ tone: "success", text: `Saved \u201C${savedTitle}\u201D to Documents.` });
        return { id: result.data.documentId, title: savedTitle };
      }
      setNotice({ tone: "error", error: result.error ?? fallbackError });
      return null;
    } finally { setBusy(false); }
  }

  async function createBlank() {
    if (!title.trim()) {
      setNotice({ tone: "error", error: { title: "The document needs a title", hint: "Add a short title so you can find it later." } });
      return;
    }
    setBusy(true);
    const content = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title.trim() }] }, { type: "paragraph" }] };
    const result = await postApi<{ documentId: string }>("/api/docs", { action: "create", title: title.trim(), content, html: "", folder: folder.trim() || undefined });
    setBusy(false);
    if (result.ok && result.data?.documentId) router.push(`/documents/editor/${result.data.documentId}`);
    else setNotice({ tone: "error", error: result.error ?? fallbackError });
  }

  async function saveMetadata() {
    if (!editDoc || !title.trim()) return;
    setBusy(true);
    const result = await postApi(`/api/docs/${editDoc.id}`, { action: "updateMetadata", title: title.trim(), folder: folder.trim() || null });
    setBusy(false);
    if (!result.ok) setNotice({ tone: "error", error: result.error ?? fallbackError });
    else { setEditDoc(null); await load(); }
  }

  async function moveDocumentToFolder(path: string | null, documentId: string): Promise<boolean> {
    const document = docs?.find((item) => item.id === documentId);
    if (!document || (document.folder ?? null) === path) return false;
    setBusy(true);
    try {
      const result = await postApi(`/api/docs/${documentId}`, { action: "updateMetadata", folder: path });
      if (!result.ok) {
        setNotice({ tone: "error", error: result.error ?? { title: "The document was not moved", hint: "Try again, or use Organize to choose a folder." } });
        return false;
      }
      setNotice({ tone: "success", text: `${document.title} moved to ${path ?? "Unfiled"}.` });
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function removeDocument() {
    if (!deleteDoc) return;
    setBusy(true);
    const result = await postApi("/api/docs", { action: "delete", documentId: deleteDoc.id });
    setBusy(false);
    if (!result.ok) setNotice({ tone: "error", error: result.error ?? fallbackError });
    else { setDeleteDoc(null); await load(); }
  }

  return (
    <div className="doc-desk">
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      <div className="doc-quickbar" role="group" aria-label="Document quick actions">
        <Button onClick={() => { setTitle(""); setFolder(activeFolder ?? ""); setNewDocOpen(true); }}><IconFileText className="size-4" /> Create document</Button>
        <Button tone="secondary" onClick={() => templateAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" })}><IconBookOpen className="size-4" /> Use template</Button>
        <Button tone="secondary" onClick={() => setFolderCreateSignal((value) => value + 1)}><IconListTree className="size-4" /> Create folder</Button>
        <Link href="/documents?tab=ingest" className="btn btn-secondary btn-md"><IconUpload className="size-4" /> Upload file</Link>
      </div>

      <div className="doc-desk__workspace">
        <FolderTree
          paths={folderPaths}
          counts={folderCounts}
          active={activeFolder}
          createSignal={folderCreateSignal}
          onSelect={setActiveFolder}
          onCreate={(path) => folderAction({ action: "create", path })}
          onRename={async (path, newPath) => {
            const ok = await folderAction({ action: "rename", path, newPath });
            if (ok && activeFolder === path) setActiveFolder(newPath);
            return ok;
          }}
          onDelete={(path) => folderAction({ action: "delete", path })}
          onDropDocument={moveDocumentToFolder}
        />

        <section className="doc-desk__list" aria-labelledby="document-list-title">
          <div className="doc-desk__listhead">
            <div><h2 id="document-list-title">{activeFolder ?? "All documents"}</h2><p>{visibleDocs.length} document{visibleDocs.length === 1 ? "" : "s"}</p></div>
            <label className="doc-search"><IconSearch className="size-4" /><span className="sr-only">Search documents</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, folder, type, or record" /></label>
          </div>
          {docs === null ? <LoadingPage /> : visibleDocs.length === 0 ? (
            <EmptyState icon={<IconFileText />} title={query ? "No documents match this search" : "This folder is empty"} hint={query ? "Try a different title, type, or linked record." : "Create a document here or move an existing document into this folder."} action={!query ? <Button onClick={() => setNewDocOpen(true)}>Create document</Button> : undefined} />
          ) : (
            <div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Document</th><th>Record</th><th>Status</th><th>Updated</th><th aria-label="Actions" /></tr></thead><tbody>
              {visibleDocs.map((item) => <tr
                key={item.id}
                draggable={!busy}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", `document:${item.id}`);
                  setDraggingDocId(item.id);
                }}
                onDragEnd={() => setDraggingDocId(null)}
                className={draggingDocId === item.id ? "opacity-45" : undefined}
              >
                <td><button type="button" className="text-left" onClick={() => router.push(`/documents/editor/${item.id}`)}><span className="block font-medium text-stone-900 hover:text-gold-700">{item.title}</span><span className="block text-xs text-stone-500">{item.documentType?.replaceAll("_", " ") ?? "Document"}{item.folder ? ` | ${item.folder}` : " | Unfiled"}</span></button></td>
                <td className="text-xs text-stone-600">{item.linkedRecordLabel ?? "No source record"}</td>
                <td><Badge tone={statusTone(item.status === "published" ? "parsed" : "received")}>{item.status}</Badge><span className="ml-2 text-xs text-stone-400">v{item.versions}</span></td>
                <td className="whitespace-nowrap text-xs text-stone-500">{timeAgo(item.updatedAt)}</td>
                <td className="whitespace-nowrap text-right"><button type="button" draggable={!busy} aria-label={`Drag ${item.title} to a folder`} title="Drag to a folder" className="btn btn-ghost btn-sm cursor-grab active:cursor-grabbing"><IconArrowsHorizontal className="size-3.5" /></button><Button tone="ghost" size="sm" onClick={() => router.push(`/documents/editor/${item.id}`)}>Open</Button><Button tone="ghost" size="sm" onClick={() => { setEditDoc(item); setTitle(item.title); setFolder(item.folder ?? ""); }}>Organize</Button><Button tone="ghost" size="sm" className="hover:text-red-700" aria-label={`Delete ${item.title}`} onClick={() => setDeleteDoc(item)}><IconTrash className="size-3.5" /></Button></td>
              </tr>)}
            </tbody></table></div>
          )}
        </section>
      </div>

      <div ref={templateAnchor} className="doc-template-section">
        <DocumentTemplateGallery templates={templates ?? []} onSelect={openTemplate} />
      </div>

      <TemplateStudio open={tpl !== null} templates={(templates ?? []) as TemplateStudioRow[]} initialTemplate={tpl as TemplateStudioRow | null} initialFolder={activeFolder ?? ""} busy={busy} onClose={() => setTpl(null)} onCreate={createFromTemplate} />

      <Dialog open={newDocOpen} onClose={() => setNewDocOpen(false)} title="Create a blank document">
        <label htmlFor="new-doc-title" className="label">Title</label><input id="new-doc-title" value={title} onChange={(event) => setTitle(event.target.value)} className="input" placeholder="Board resolution - September" />
        <label htmlFor="new-doc-folder" className="label mt-3">Folder</label><input id="new-doc-folder" value={folder} onChange={(event) => setFolder(event.target.value)} className="input" list="document-folders" placeholder="Unfiled" />
        <div className="mt-5 flex justify-end gap-2"><Button tone="secondary" onClick={() => setNewDocOpen(false)}>Cancel</Button><Button loading={busy} onClick={createBlank}>Create document</Button></div>
      </Dialog>

      <Dialog open={editDoc !== null} onClose={() => setEditDoc(null)} title="Organize document">
        <label htmlFor="edit-doc-title" className="label">Title</label><input id="edit-doc-title" value={title} onChange={(event) => setTitle(event.target.value)} className="input" />
        <label htmlFor="edit-doc-folder" className="label mt-3">Move to folder</label><Select id="edit-doc-folder" value={folder} onChange={(event) => setFolder(event.target.value)}><option value="">Unfiled</option>{folderPaths.map((path) => <option key={path} value={path}>{path}</option>)}</Select>
        {editDoc?.linkedRecordLabel && <p className="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600"><strong>Source record:</strong> {editDoc.linkedRecordLabel}</p>}
        <div className="mt-5 flex justify-end gap-2"><Button tone="secondary" onClick={() => setEditDoc(null)}>Cancel</Button><Button loading={busy} onClick={saveMetadata}>Save changes</Button></div>
      </Dialog>

      <ConfirmDialog open={deleteDoc !== null} onClose={() => setDeleteDoc(null)} onConfirm={removeDocument} title="Delete document" body={<>Delete “{deleteDoc?.title}” and its version history? This cannot be undone.</>} confirmLabel="Delete document" busy={busy} />
    </div>
  );
}
