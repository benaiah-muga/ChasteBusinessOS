"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  LoadingPage,
  ActionNotice,
  type ActionNoticeState,
  PageHeader,
} from "@/components/ui";
import { IconFileText, IconInfo, IconTrash, IconUpload } from "@/components/icons";
import { cn, statusTone, timeAgo } from "@/lib/format";
import { useRouter } from "next/navigation";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

interface DocRow {
  id: string;
  title: string;
  status: string;
  sourceType: string;
  createdAt: string;
}

interface Suggestion {
  id: string;
  description: string;
  quantityThousandths: number;
  unitPriceMinor: number;
  suggestedAccountCode: string;
  matchScore: number;
  status: string;
}

interface DocDetail {
  document: {
    id: string;
    title: string;
    status: string;
    sourceType: string;
    parseError: string | null;
    parsedMarkdown: string | null;
    createdAt: string;
  };
  suggestions: Suggestion[];
}

export default function DocumentsPage() {
  const __enabled = useModuleEnabled("documents");
  const router = useRouter();
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionNoticeState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null);

  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ name: string; base64: string; mimeType: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await callApi<{ documents?: DocRow[] }>("/api/documents");
    setDocs(res.data?.documents ?? []);
    if (!res.ok) setMessage({ tone: "error", error: res.error! });
  }, []);

  const openDetail = useCallback(async (id: string) => {
    const res = await callApi<DocDetail>(`/api/documents?id=${id}`);
    setDetail(res.data?.document ? res.data : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi<{ ok?: boolean }>("/api/documents", payload);
      if (res.status === 202) setMessage({ tone: "pending", text: `${label}: needs human approval, check Approvals.` });
      else if (!res.ok) setMessage({ tone: "error", error: res.error! });
      else setMessage({ tone: "success", text: `${label} done.` });
      await load();
      if (payload.documentId) await openDetail(String(payload.documentId));
      return res.ok;
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function submit() {
    if (!title.trim()) {
      setMessage({ tone: "error", error: { title: "Add a title first", hint: "A short title keeps the document findable later." } });
      return;
    }
    const ok = file
      ? await action({ action: "create", title, fileBase64: file.base64, mimeType: file.mimeType }, "Upload")
      : await action({ action: "create", title, text }, "Ingest text");
    if (ok) {
      setTitle("");
      setText("");
      setFile(null);
    }
  }

  function readFile(f: File) {
    const reader = new FileReader();
    reader.onload = () =>
      setFile({ name: f.name, base64: String(reader.result).split(",")[1] ?? "", mimeType: f.type || "application/octet-stream" });
    reader.readAsDataURL(f);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await action({ action: "delete", documentId: deleteTarget.id }, "Delete");
    if (detail?.document.id === deleteTarget.id) setDetail(null);
    setDeleteTarget(null);
  }

  if (!__enabled) return <ModuleDisabled label="Documents" />;

  return (
    <div>
      <PageHeader
        title="Documents"
        description="Upload a bill or receipt and the agent reads it. Parsed text lands in org memory; expense coding is suggested against your chart of accounts, nothing posts until you act on it."
      />

      {message && <ActionNotice state={message} onDismiss={() => setMessage(null)} />}

      {/* Ingest */}
      <Card className="mb-8">
        <CardTitle>New document</CardTitle>
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors duration-150",
              dragOver ? "border-maroon-500 bg-maroon-50/60" : "border-stone-300 bg-stone-50/50",
              file && "border-emerald-300 bg-emerald-50/40",
            )}
          >
            {file ? (
              <>
                <IconFileText className="mb-2 size-6 text-emerald-700" />
                <p className="text-sm font-medium text-emerald-900">{file.name}</p>
                <p className="mt-0.5 font-mono text-xs text-emerald-700">{file.mimeType} ready</p>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="mt-2 cursor-pointer text-xs text-stone-500 underline-offset-2 hover:text-red-700 hover:underline"
                >
                  Remove file
                </button>
              </>
            ) : (
              <>
                <IconUpload className="mb-2 size-6 text-stone-400" />
                <p className="text-sm font-medium text-stone-600">Drop a bill or receipt here</p>
                <p className="mt-0.5 text-xs text-stone-400">Image or PDF, up to 5MB, OCR reads it for you</p>
                <Button tone="secondary" size="sm" className="mt-3" onClick={() => fileInputRef.current?.click()}>
                  Browse files
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf"
                  aria-label="Upload document file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) readFile(f);
                    e.target.value = "";
                  }}
                  className="sr-only"
                />
              </>
            )}
          </div>

          <div className="flex flex-col">
            <label htmlFor="doc-title" className="label">
              Title
            </label>
            <input
              id="doc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Acme stationery invoice #42"
              className="input"
            />
            <label htmlFor="doc-text" className="label mt-3">
              …or paste the document text
            </label>
            <textarea
              id="doc-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="Works without an NVIDIA key, paste any invoice or receipt text."
              className="textarea flex-1 resize-none font-mono text-xs"
              disabled={Boolean(file)}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end border-t border-stone-100 pt-4">
          <Button loading={busy} onClick={submit}>
            Ingest document
          </Button>
        </div>
      </Card>

      {/* List */}
      {docs === null ? (
        <LoadingPage />
      ) : docs.length === 0 ? (
        <EmptyState
          icon={<IconFileText />}
          title="No documents yet"
          hint="Ingest your first vendor bill above. Coding suggestions appear after parsing."
        />
      ) : (
        <div className="table-shell mb-6">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Source</th>
                <th>Status</th>
                <th>When</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr
                  key={d.id}
                  className={cn(detail?.document.id === d.id && "bg-maroon-50/50")}
                >
                  <td className="font-medium text-stone-800">{d.title}</td>
                  <td className="font-mono text-xs text-stone-500">{d.sourceType}</td>
                  <td>
                    <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                  </td>
                  <td className="text-xs whitespace-nowrap text-stone-500" title={new Date(d.createdAt).toLocaleString()}>
                    {timeAgo(d.createdAt)}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <Button tone="ghost" size="sm" onClick={() => openDetail(d.id)}>
                      Open
                    </Button>
                    <Button tone="ghost" size="sm" className="hover:bg-red-50 hover:text-red-700" onClick={() => setDeleteTarget(d)}>
                      <IconTrash className="size-3.5" />
                      <span className="sr-only">Delete {d.title}</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail */}
      {detail && (
        <Card>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold text-stone-900">{detail.document.title}</h2>
            <Badge tone={statusTone(detail.document.status)}>{detail.document.status}</Badge>
            <div className="ml-auto flex gap-2">
              <Button
                tone="secondary"
                size="sm"
                loading={busy}
                onClick={() => action({ action: "parse", documentId: detail.document.id }, "Parse")}
              >
                Parse{detail.document.sourceType === "upload" ? " · OCR" : ""}
              </Button>
              <Button
                tone="secondary"
                size="sm"
                loading={busy}
                onClick={() => action({ action: "suggest", documentId: detail.document.id }, "Suggest coding")}
              >
                Suggest coding
              </Button>
            </div>
          </div>

          {detail.document.parseError && (
            <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 font-mono text-xs break-words text-red-900">
              {detail.document.parseError}
            </p>
          )}

          {detail.suggestions.length > 0 ? (
            <div className="table-shell mb-4 shadow-none">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Qty</th>
                    <th className="text-right">Unit price</th>
                    <th>Account</th>
                    <th>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.suggestions.map((s) => (
                    <tr key={s.id}>
                      <td className="font-medium">{s.description}</td>
                      <td className="num">{(s.quantityThousandths / 1000).toLocaleString()}</td>
                      <td className="num">{(s.unitPriceMinor / 100).toFixed(2)}</td>
                      <td>
                        <Badge tone="maroon">{s.suggestedAccountCode}</Badge>
                      </td>
                      <td>
                        {s.matchScore > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                            matched ×{s.matchScore}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-stone-400">
                            <IconInfo className="size-3.5" /> fallback
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !busy && (
              <p className="mb-4 flex items-center gap-2 rounded-lg bg-stone-50 px-3.5 py-2.5 text-sm text-stone-500">
                No coding suggestions yet, run “Suggest coding” to match lines against your chart of accounts.
              </p>
            )
          )}

          {detail.document.parsedMarkdown && (
            <details className="group">
              <summary className="cursor-pointer text-xs font-semibold tracking-wide text-stone-500 uppercase select-none hover:text-stone-700">
                Parsed text
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-stone-50 p-3 font-mono text-xs whitespace-pre-wrap text-stone-700">
                {detail.document.parsedMarkdown}
              </pre>
            </details>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete document"
        body={
          <>
            Delete “{deleteTarget?.title}”? Its chunks leave org memory; anything already posted from it stays in the
            ledger.
          </>
        }
        confirmLabel="Delete"
        busy={busy}
      />
    </div>
  );
}
