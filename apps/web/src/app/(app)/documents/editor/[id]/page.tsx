"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Editor } from "@tiptap/react";
import {
  Badge,
  Button,
  Dialog,
  LoadingPage,
  ActionNotice,
  type ActionNoticeState,
} from "@/components/ui";
import { callApi, postApi } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { timeAgo } from "@/lib/format";
import { TiptapEditor } from "../../_write/tiptap-editor";
import { AiAssistPanel } from "../../_write/ai-panel";
import { exportDocx } from "../../_write/docx-export";

/**
 * Authored-document editor (Phase 4): Tiptap writing surface with debounced
 * autosave to the draft workspace (outside the ledger, ADR 0056), live
 * presence, soft locks, append-only version publishing with compare and
 * restore, AI writing assist, .docx export and print-styled PDF.
 */

type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict";

interface VersionRow {
  version: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface DocPayload {
  document: {
    id: string;
    title: string;
    status: string;
    content: Record<string, unknown>;
    html: string;
    templateId: string | null;
    versions: number;
    updatedAt: string;
  } | null;
  versions: VersionRow[];
}

export default function DocumentEditorPage() {
  const params = useParams<{ id: string }>();
  const documentId = params.id;
  const [prefs] = usePrefs();

  const [boot, setBoot] = useState<DocPayload | null>(null);
  const [initialContent, setInitialContent] = useState<Record<string, unknown> | null>(null);
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [others, setOthers] = useState<Array<{ userId: string; name: string }>>([]);
  const [lockHolder, setLockHolder] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [publishBusy, setPublishBusy] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [compare, setCompare] = useState<{ a: string; b: string; aV: number; bV: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [printHtml, setPrintHtml] = useState("");

  const editorRef = useRef<Editor | null>(null);
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const revRef = useRef<number | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Boot: doc + versions, then one workspace tick to pick up any draft.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [docRes, wsRes] = await Promise.all([
        callApi<DocPayload>(`/api/docs/${documentId}`),
        postApi<{ draft?: { content: Record<string, unknown>; rev: number } | null; lock?: { heldBy: string; mine: boolean }; others?: Array<{ userId: string; name: string }> }>(
          `/api/docs/${documentId}/workspace`,
          {},
        ),
      ]);
      if (!alive) return;
      if (!docRes.ok || !docRes.data?.document) {
        setNotice({
          tone: "error",
          error: docRes.error ?? { title: "Document not found", hint: "It may have been deleted; head back to Documents." },
        });
        return;
      }
      const doc = docRes.data.document;
      setVersions(docRes.data.versions ?? []);
      setTitle(doc.title);
      const draft = wsRes.data?.draft;
      if (draft?.content && Object.keys(draft.content).length > 0) {
        revRef.current = draft.rev;
        setInitialContent(draft.content);
      } else {
        setInitialContent(doc.content);
      }
      setBoot(docRes.data);
      if (wsRes.data?.lock && !wsRes.data.lock.mine) setLockHolder(wsRes.data.lock.heldBy);
      if (wsRes.data?.others) setOthers(wsRes.data.others);
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  const saveDraft = useCallback(
    async (json: Record<string, unknown>) => {
      if (lockHolder) return;
      setSaveState("saving");
      const res = await postApi<{ savedRev?: number }>(`/api/docs/${documentId}/workspace`, {
        content: json,
        rev: revRef.current,
      });
      if (res.status === 409) {
        setSaveState("conflict");
        return;
      }
      if (res.ok && res.data?.savedRev) revRef.current = res.data.savedRev;
      setSaveState("saved");
    },
    [documentId, lockHolder],
  );

  const onDocChange = useCallback(
    (json: Record<string, unknown>, _html: string) => {
      pendingRef.current = json;
      setSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const p = pendingRef.current;
        if (p) void saveDraft(p);
      }, 800);
    },
    [saveDraft],
  );

  // Presence heartbeat + lock observation.
  useEffect(() => {
    if (!boot) return;
    const tick = setInterval(async () => {
      const res = await postApi<{ savedRev?: number; lock?: { heldBy: string; mine: boolean }; others?: Array<{ userId: string; name: string }> }>(
        `/api/docs/${documentId}/workspace`,
        pendingRef.current ? { content: pendingRef.current } : {},
      );
      if (!res.ok) return;
      if (pendingRef.current && res.data?.savedRev) {
        revRef.current = res.data.savedRev;
        pendingRef.current = null;
        setSaveState("saved");
      }
      if (res.data?.lock) setLockHolder(res.data.lock.mine ? null : res.data.lock.heldBy);
      if (res.data?.others) setOthers(res.data.others);
    }, 10_000);
    return () => clearInterval(tick);
  }, [boot, documentId]);

  // Release presence + lock on exit.
  useEffect(() => {
    const release = () => {
      void fetch(`/api/docs/${documentId}/workspace`, { method: "DELETE", keepalive: true });
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [documentId]);

  async function publish() {
    const editor = editorRef.current;
    if (!editor) return;
    setPublishBusy(true);
    try {
      const res = await postApi<{ version: number }>(`/api/docs/${documentId}`, {
        action: "publish",
        title,
        content: editor.getJSON(),
        html: editor.getHTML(),
        ...(publishNote.trim() ? { note: publishNote.trim() } : {}),
      });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: "Publish proposed: the workmate's version waits for approval." });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice({ tone: "success", text: `Version ${res.data?.version ?? ""} published.` });
        const fresh = await callApi<DocPayload>(`/api/docs/${documentId}`);
        if (fresh.ok) setVersions(fresh.data?.versions ?? []);
        revRef.current = undefined;
      }
      setPublishOpen(false);
      setPublishNote("");
    } finally {
      setPublishBusy(false);
    }
  }

  async function restore(v: number) {
    setBusy(true);
    try {
      const res = await postApi<{ version: number }>(`/api/docs/${documentId}`, {
        action: "restore",
        sourceVersion: v,
      });
      if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice({ tone: "success", text: `Restored from version ${v} as version ${res.data?.version}.` });
        const fresh = await callApi<DocPayload>(`/api/docs/${documentId}`);
        if (fresh.ok && fresh.data?.document) {
          setVersions(fresh.data.versions);
          setInitialContent(fresh.data.document.content);
          editorRef.current?.commands.setContent(fresh.data.document.content);
          revRef.current = undefined;
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function compareVersions(a: number, b: number) {
    const [ra, rb] = await Promise.all([
      callApi<{ html: string }>(`/api/docs/${documentId}?version=${a}`),
      callApi<{ html: string }>(`/api/docs/${documentId}?version=${b}`),
    ]);
    if (ra.ok && rb.ok) setCompare({ a: ra.data?.html ?? "", b: rb.data?.html ?? "", aV: a, bV: b });
  }

  async function saveAsTemplate() {
    const editor = editorRef.current;
    if (!editor || !tplName.trim()) return;
    setBusy(true);
    try {
      const res = await postApi<{ templateId: string }>(`/api/docs`, {
        action: "createTemplate",
        name: tplName.trim(),
        content: editor.getJSON(),
      });
      if (!res.ok) setNotice({ tone: "error", error: res.error! });
      else setNotice({ tone: "success", text: `Template "${tplName.trim()}" saved.` });
      setTplOpen(false);
      setTplName("");
    } finally {
      setBusy(false);
    }
  }

  function printNow() {
    const editor = editorRef.current;
    if (!editor) return;
    setPrintHtml(editor.getHTML());
    requestAnimationFrame(() => window.print());
  }

  const saveLabel: Record<SaveState, string> = {    idle: "",
    dirty: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    conflict: "Edited elsewhere: reload to pick up the latest draft",
  };

  if (!boot || !initialContent) {
    return (
      <div className="p-6">
        <LoadingPage />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      {/* Editor header */}
      <div className="sticky top-14 z-10 border-b border-stone-200 bg-stone-50/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5">
          <Link
            href="/documents"
            className="cursor-pointer text-sm text-stone-500 hover:text-stone-800"
          >
            ← Documents
          </Link>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Document title"
            className="min-w-48 flex-1 rounded border-none bg-transparent px-2 py-1 text-base font-semibold text-stone-900 outline-none hover:bg-stone-100 focus:bg-white"
          />
          {others.length > 0 && (
            <span className="flex items-center gap-1">
              {others.map((o) => (
                <Badge key={o.userId} tone="gold">
                  {o.name}
                </Badge>
              ))}
            </span>
          )}
          {saveState !== "idle" && (
            <span
              className={cnSave(saveState)}
              role="status"
            >
              {saveLabel[saveState]}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button tone="ghost" size="sm" onClick={() => setVersionsOpen(true)}>
              Versions {versions.length > 0 && `(${versions.length})`}
            </Button>
            <Button tone="ghost" size="sm" onClick={() => setTplOpen(true)}>
              Save as template
            </Button>
            <Button tone="ghost" size="sm" onClick={() => void exportDocx(title, editorRef.current?.getJSON())}>
              .docx
            </Button>
            <Button tone="ghost" size="sm" onClick={() => printNow()}>
              Print / PDF
            </Button>
            <Button tone="ghost" size="sm" onClick={() => setAiOpen((v) => !v)} aria-pressed={aiOpen}>
              Assist
            </Button>
            <Button size="sm" loading={publishBusy} onClick={() => setPublishOpen(true)}>
              Publish version
            </Button>
          </div>
        </div>
        {lockHolder && (
          <div className="mx-auto max-w-6xl px-4 pb-2">
            <p role="status" className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
              {lockHolder} is editing right now. You can read along; saving resumes when the pen is free.
            </p>
          </div>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-4 px-4 py-4">
        <div className="min-w-0 flex-1">
          {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
          <TiptapEditor
            initialContent={initialContent}
            harperEnabled={prefs.writingAids}
            onDocChange={onDocChange}
            onReady={(e) => {
              editorRef.current = e;
            }}
          />
          {/* Print surface: refreshed from the editor at print time. */}
          <div className="print-only" dangerouslySetInnerHTML={{ __html: printHtml }} />
        </div>

        {aiOpen && (
          <aside className="w-72 shrink-0 rounded-xl border border-stone-200 bg-white shadow-xs">
            <AiAssistPanel editor={editorRef.current} documentId={documentId} />
          </aside>
        )}
      </div>

      {/* Publish dialog */}
      <Dialog open={publishOpen} onClose={() => setPublishOpen(false)} title="Publish a version">
        <p className="mb-3 text-sm text-stone-600">
          Publishing snapshots the current content into append-only history. Earlier versions stay comparable and
          restorable forever.
        </p>
        <label htmlFor="publish-note" className="label">
          Version note (optional)
        </label>
        <input
          id="publish-note"
          value={publishNote}
          onChange={(e) => setPublishNote(e.target.value)}
          placeholder="Added payment terms section"
          className="input"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button tone="secondary" onClick={() => setPublishOpen(false)}>
            Cancel
          </Button>
          <Button loading={publishBusy} onClick={publish}>
            Publish
          </Button>
        </div>
      </Dialog>

      {/* Save as template */}
      <Dialog open={tplOpen} onClose={() => setTplOpen(false)} title="Save as template">
        <p className="mb-3 text-sm text-stone-600">
          Reuse this document as a starting point. Wrap any reusable value in double braces, like{" "}
          <code className="rounded bg-stone-100 px-1 font-mono text-xs">{"{{customer.name}}"}</code>, and it becomes a
          fill-in field.
        </p>
        <label htmlFor="tpl-name" className="label">
          Template name
        </label>
        <input id="tpl-name" value={tplName} onChange={(e) => setTplName(e.target.value)} className="input" placeholder="Service quote" />
        <div className="mt-4 flex justify-end gap-2">
          <Button tone="secondary" onClick={() => setTplOpen(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={saveAsTemplate}>
            Save template
          </Button>
        </div>
      </Dialog>

      {/* Versions drawer */}
      <Dialog open={versionsOpen} onClose={() => setVersionsOpen(false)} title="Version history">
        {versions.length === 0 ? (
          <p className="text-sm text-stone-500">No published versions yet. Publish to start the history.</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto text-sm">
            {versions.map((v, i) => (
              <li key={v.version} className="flex items-center gap-3 py-2.5">
                <span className="w-14 font-mono text-xs text-stone-500">v{v.version}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{v.note ?? "(no note)"}</span>
                  <span className="block text-xs text-stone-400">
                    {timeAgo(v.createdAt)}
                    {v.createdBy ? ` · ${v.createdBy.slice(0, 8)}` : ""}
                  </span>
                </span>
                {i > 0 && (
                  <Button tone="ghost" size="sm" onClick={() => compareVersions(versions[i - 1]!.version, v.version)}>
                    Compare
                  </Button>
                )}
                <Button tone="secondary" size="sm" loading={busy} onClick={() => restore(v.version)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-stone-400">
          Restoring never deletes: the current content is archived first, and the restored copy becomes a new version.
        </p>
      </Dialog>

      {/* Side-by-side compare */}
      <Dialog open={compare !== null} onClose={() => setCompare(null)} title={`Compare v${compare?.aV} vs v${compare?.bV}`}>
        <div className="grid max-h-[65vh] grid-cols-2 gap-3 overflow-y-auto">
          <div>
            <p className="figure-label mb-1">v{compare?.aV} (older)</p>
            <div className="rounded-lg border border-stone-200 p-3 text-sm [&_p]:my-1" dangerouslySetInnerHTML={{ __html: compare?.a ?? "" }} />
          </div>
          <div>
            <p className="figure-label mb-1">v{compare?.bV} (newer)</p>
            <div className="rounded-lg border border-stone-200 p-3 text-sm [&_p]:my-1" dangerouslySetInnerHTML={{ __html: compare?.b ?? "" }} />
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function cnSave(state: SaveState): string {
  switch (state) {
    case "saved":
      return "text-xs font-medium text-emerald-700";
    case "saving":
    case "dirty":
      return "text-xs text-stone-500";
    case "conflict":
      return "text-xs font-medium text-amber-700";
    default:
      return "";
  }
}
