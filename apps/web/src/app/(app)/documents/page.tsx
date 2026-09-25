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
  Select,
  StatCard,
  type ActionNoticeState,
} from "@/components/ui";
import { IconFileText, IconInfo, IconSearch, IconTrash, IconUpload } from "@/components/icons";
import { cn, statusTone, timeAgo } from "@/lib/format";
import { useRouter } from "next/navigation";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";
import { WriteTab } from "./_write/write-tab";

type Tab = "overview" | "write" | "library" | "ingest";

interface DocRow {
  id: string;
  title: string;
  status: string;
  sourceType: string;
  refType?: string | null;
  refId?: string | null;
  createdAt: string;
}

interface Suggestion {
  id: string;
  description: string;
  quantityThousandths: number;
  unitPriceMinor: number;
  suggestedAccountCode: string;
  matchScore: number;
  matchedOn: string[];
  accountName: string | null;
  status: string;
}

interface LinkableCustomer {
  id: string;
  name: string;
}

interface DocDetail {
  document: {
    id: string;
    title: string;
    status: string;
    sourceType: string;
    parseError: string | null;
    parsedMarkdown: string | null;
    rawText: string | null;
    mimeType: string | null;
    hasSource: boolean;
    refType: string | null;
    refId: string | null;
    createdAt: string;
  };
  suggestions: Suggestion[];
}

export default function DocumentsPage() {
  const __enabled = useModuleEnabled("documents");
  const router = useRouter();
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [linkableCustomers, setLinkableCustomers] = useState<LinkableCustomer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionNoticeState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null);

  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ name: string; base64: string; mimeType: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileReading, setFileReading] = useState(false);
  const [linkedCustomerId, setLinkedCustomerId] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await callApi<{ documents?: DocRow[]; customers?: LinkableCustomer[] }>("/api/documents");
      if (!res.ok) {
        setLoadError(res.error?.title ?? "Couldn't load documents");
        return false;
      }
      setDocs(res.data?.documents ?? []);
      setLinkableCustomers(res.data?.customers ?? []);
      setLoadError(null);
      return true;
    } catch {
      setLoadError("Couldn't load documents");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setDetailRequestId(id);
    setDetailLoadingId(id);
    setDetailError(null);
    setDetail(null);
    try {
      const res = await callApi<DocDetail>(`/api/documents?id=${encodeURIComponent(id)}`);
      if (!res.ok || !res.data?.document) {
        setDetailError(res.error?.title ?? "Couldn't open this document");
        return;
      }
      setDetail(res.data);
    } catch {
      setDetailError("Couldn't open this document");
    } finally {
      setDetailLoadingId(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const documentId = new URLSearchParams(window.location.search).get("documentId");
    if (!documentId) return;
    setTab("library");
    void openDetail(documentId);
  }, [openDetail]);

  async function action(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi<{ ok?: boolean }>("/api/documents", payload);
      if (res.status === 202) setMessage({ tone: "pending", text: `${label}: needs human approval, check Approvals.` });
      else if (!res.ok) setMessage({ tone: "error", error: res.error! });
      else setMessage({ tone: "success", text: `${label} done.` });
      await load();
      if (payload.documentId && payload.action !== "delete") await openDetail(String(payload.documentId));
      return res.ok && res.status !== 202;
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function submit() {
    if (fileReading) return;
    if (!title.trim()) {
      setMessage({ tone: "error", error: { title: "Add a title first", hint: "A short title keeps the document findable later." } });
      return;
    }
    const ok = file
      ? await action({ action: "create", title, fileBase64: file.base64, mimeType: file.mimeType, ...(linkedCustomerId ? { refId: linkedCustomerId } : {}) }, "Upload")
      : await action({ action: "create", title, text, ...(linkedCustomerId ? { refId: linkedCustomerId } : {}) }, "Ingest text");
    if (ok) {
      setTitle("");
      setText("");
      setFile(null);
      setLinkedCustomerId("");
    }
  }

  function readFile(f: File) {
    if (busy || fileReading) return;
    const lowerName = f.name.toLowerCase();
    const isPdf = f.type === "application/pdf" || lowerName.endsWith(".pdf");
    const isImage = f.type.startsWith("image/");
    if (!isPdf && !isImage) {
      setMessage({ tone: "error", error: { title: "Choose an image or PDF", hint: "This document reader accepts common image files and PDFs." } });
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setMessage({ tone: "error", error: { title: "This file is over 5 MB", hint: "Choose a smaller image or PDF to keep upload time short." } });
      return;
    }
    setFileReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      setFile({
        name: f.name,
        base64: String(reader.result).split(",")[1] ?? "",
        mimeType: isPdf ? "application/pdf" : f.type,
      });
      setFileReading(false);
    };
    reader.onerror = () => {
      setFileReading(false);
      setMessage({ tone: "error", error: { title: "Couldn't read that file", hint: "Try choosing it again or paste the document text instead." } });
    };
    reader.readAsDataURL(f);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (busy || fileReading) return;
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const deleted = await action({ action: "delete", documentId: deleteTarget.id }, "Delete");
    if (deleted && detail?.document.id === deleteTarget.id) {
      setDetail(null);
      setDetailRequestId(null);
      setDetailError(null);
    }
    setDeleteTarget(null);
  }

  if (!__enabled) return <ModuleDisabled label="Documents" />;

  const parsedCount = (docs ?? []).filter((d) => statusTone(d.status) === "green").length;
  const pendingCount = (docs ?? []).filter((d) => statusTone(d.status) === "amber").length;
  const statusOptions = [...new Set((docs ?? []).map((document) => document.status))].sort();
  const query = search.trim().toLowerCase();
  const visibleDocs = (docs ?? []).filter((document) => {
    const matchesQuery = !query || `${document.title} ${document.sourceType} ${document.status}`.toLowerCase().includes(query);
    return matchesQuery && (statusFilter === "all" || document.status === statusFilter);
  });

  return (
    <AppFrame
      appId="documents"
      description="Upload a bill or receipt and the agent reads it. Parsed text lands in org memory; expense coding is suggested against your chart of accounts, nothing posts until you act on it."
      persistKey="documents"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "write", label: "Write" },
        { id: "library", label: "Library", count: docs?.length || undefined },
        { id: "ingest", label: "Ingest" },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {message && <ActionNotice state={message} onDismiss={() => setMessage(null)} />}
      {loadError && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          <span>{loadError}. Your documents are still stored; try refreshing the list.</span>
          <Button tone="secondary" size="sm" loading={loading} onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {tab === "overview" && (
        <div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Documents" value={docs === null ? "Loading…" : docs.length} />
            <StatCard label="Parsed" value={docs === null ? "Loading…" : parsedCount} tone="success" />
            <StatCard label="Awaiting parse" value={docs === null ? "Loading…" : pendingCount} tone={pendingCount > 0 ? "warn" : "default"} />
            <StatCard label="This week" value={docs === null ? "Loading…" : docs.filter((d) => new Date(d.createdAt).getTime() > Date.now() - 7 * 86400000).length} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
              <p className="figure-label mb-3">Recently ingested</p>
              {docs === null ? (
                loading ? <LoadingPage /> : <EmptyState icon={<IconFileText />} title="Documents couldn't load" hint="Retry the list above to check your document library." />
              ) : docs.length === 0 ? (
                <EmptyState
                  icon={<IconFileText />}
                  title="No documents yet"
                  hint="Ingest your first vendor bill - coding suggestions appear after parsing."
                />
              ) : (
                <ul className="divide-y text-sm">
                  {docs.slice(0, 5).map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0 truncate">{d.title}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                        <span className="text-xs whitespace-nowrap opacity-50">{timeAgo(d.createdAt)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
              <p className="figure-label mb-3">Feed the memory</p>
              <p className="text-sm leading-relaxed opacity-70">
                Drop in a vendor bill or receipt and the agent reads it, suggests expense coding against your chart of
                accounts, and keeps the text searchable. Nothing posts until you act on a suggestion.
              </p>
              <Button className="mt-4" onClick={() => setTab("ingest")}>
                Ingest a document
              </Button>
            </div>
          </div>
        </div>
      )}

      {tab === "write" && <WriteTab />}

      {tab === "ingest" && (
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
              dragOver ? "border-gold-500 bg-gold-50/60" : "border-stone-300 bg-stone-50/50",
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
                  disabled={busy || fileReading}
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
                <Button tone="secondary" size="sm" className="mt-3" disabled={fileReading || busy} onClick={() => fileInputRef.current?.click()}>
                  Browse files
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf"
                  aria-label="Upload document file"
                  disabled={busy || fileReading}
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
              disabled={busy || fileReading}
              className="input"
            />
            <label htmlFor="doc-customer" className="label mt-3">Link to customer <span className="font-normal text-stone-400">(optional)</span></label>
            <select id="doc-customer" className="select" value={linkedCustomerId} onChange={(event) => setLinkedCustomerId(event.target.value)} disabled={busy || fileReading}>
              <option value="">Keep in the general library</option>
              {linkableCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select>
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
              disabled={Boolean(file) || busy || fileReading}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end border-t border-stone-100 pt-4">
            <Button loading={busy || fileReading} onClick={submit}>
            {fileReading ? "Reading file…" : busy ? "Ingesting document…" : "Ingest document"}
            </Button>
        </div>
      </Card>
      )}

      {/* List */}
      {tab === "library" && (
        <section className="mb-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="relative block w-full sm:max-w-md">
              <IconSearch aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, source, or status"
                aria-label="Search documents"
                className="input pl-9"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Filter documents by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="w-full sm:w-auto">
                <option value="all">All statuses</option>
                {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
              </Select>
              {search || statusFilter !== "all" ? (
                <Button tone="ghost" size="sm" onClick={() => { setSearch(""); setStatusFilter("all"); }}>Clear filters</Button>
              ) : (
                <span className="px-1 text-xs text-stone-500" aria-live="polite">
                  {loading && docs === null ? "Loading documents…" : `${visibleDocs.length} of ${docs?.length ?? 0} documents`}
                </span>
              )}
            </div>
          </div>

          {docs === null ? (
            loading ? <LoadingPage /> : <EmptyState icon={<IconFileText />} title="Documents couldn't load" hint="Retry the list above to check your document library." action={<Button tone="secondary" onClick={() => void load()}>Retry</Button>} />
          ) : docs.length === 0 ? (
            <EmptyState
              icon={<IconFileText />}
              title="No documents yet"
              hint="Add a bill or receipt to build a searchable record and get coding suggestions."
              action={<Button onClick={() => setTab("ingest")}>Ingest a document</Button>}
            />
          ) : visibleDocs.length === 0 ? (
            <EmptyState
              icon={<IconInfo />}
              title="No documents match those filters"
              hint="Try another title, source, or status."
              action={<Button tone="secondary" size="sm" onClick={() => { setSearch(""); setStatusFilter("all"); }}>Clear filters</Button>}
            />
          ) : (
            <>
              <ul className="space-y-2 sm:hidden" aria-label="Documents">
                {visibleDocs.map((document) => (
                  <li key={document.id} className={cn("rounded-xl border bg-white p-3 shadow-xs", detailRequestId === document.id ? "border-gold-400" : "border-stone-200")}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-stone-900">{document.title}</p>
                        <p className="mt-0.5 text-xs text-stone-500">{document.sourceType} · {timeAgo(document.createdAt)}</p>
                      </div>
                      <Badge tone={statusTone(document.status)}>{document.status}</Badge>
                    </div>
                    <div className="mt-3 flex gap-2 border-t border-stone-100 pt-2">
                      <Button tone="secondary" size="sm" loading={detailLoadingId === document.id} disabled={detailLoadingId !== null && detailLoadingId !== document.id} onClick={() => void openDetail(document.id)}>Open</Button>
                      <Button tone="ghost" size="sm" className="hover:bg-red-50 hover:text-red-700" disabled={busy} onClick={() => setDeleteTarget(document)}>
                        <IconTrash className="size-3.5" /> Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="table-shell hidden sm:block">
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
                    {visibleDocs.map((document) => (
                      <tr key={document.id} className={cn(detailRequestId === document.id && "bg-gold-50/50")}>
                        <td className="font-medium text-stone-800">{document.title}</td>
                        <td className="font-mono text-xs text-stone-500">{document.sourceType}</td>
                        <td><Badge tone={statusTone(document.status)}>{document.status}</Badge></td>
                        <td className="text-xs whitespace-nowrap text-stone-500" title={new Date(document.createdAt).toLocaleString()}>{timeAgo(document.createdAt)}</td>
                        <td className="text-right whitespace-nowrap">
                          <Button tone="ghost" size="sm" loading={detailLoadingId === document.id} disabled={detailLoadingId !== null && detailLoadingId !== document.id} onClick={() => void openDetail(document.id)}>Open</Button>
                          <Button tone="ghost" size="sm" className="hover:bg-red-50 hover:text-red-700" disabled={busy} onClick={() => setDeleteTarget(document)}>
                            <IconTrash className="size-3.5" /><span className="sr-only">Delete {document.title}</span>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {/* Detail */}
      {detailLoadingId && !detail && (
        <Card>
          <p className="text-sm text-stone-500" role="status">Loading document details…</p>
        </Card>
      )}
      {detailError && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          <span>{detailError}. The library is unchanged.</span>
          {detailRequestId && <Button tone="secondary" size="sm" loading={detailLoadingId === detailRequestId} onClick={() => void openDetail(detailRequestId)}>Retry</Button>}
        </div>
      )}
      {detail && (
        <Card>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold text-stone-900">{detail.document.title}</h2>
            <Badge tone={statusTone(detail.document.status)}>{detail.document.status}</Badge>
            {detail.document.refType === "customer" && detail.document.refId && <Badge tone="blue">Linked to {linkableCustomers.find((customer) => customer.id === detail.document.refId)?.name ?? "customer"}</Badge>}
            <div className="ml-auto flex gap-2">
              <Button
                tone="secondary"
                size="sm"
                loading={busy}
                onClick={() => action({ action: "parse", documentId: detail.document.id }, "Parse")}
              >
                {detail.document.parseError ? "Retry parsing" : "Parse"}{detail.document.sourceType === "upload" ? " · OCR" : ""}
              </Button>
              <Button
                tone="secondary"
                size="sm"
                loading={busy}
                disabled={!detail.document.parsedMarkdown}
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

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="min-w-0 rounded-lg border border-stone-200 p-3">
              <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">Original source</h3><span className="text-[11px] text-stone-400">{detail.document.mimeType ?? detail.document.sourceType}</span></div>
              <div className="min-h-72 overflow-hidden rounded-md border border-stone-200 bg-stone-50">
                {detail.document.mimeType === "application/pdf" ? <iframe title={`Original document: ${detail.document.title}`} src={`/api/documents/${encodeURIComponent(detail.document.id)}/content`} className="h-[32rem] w-full bg-white" />
                  : detail.document.mimeType?.startsWith("image/") ? <img alt={`Original document: ${detail.document.title}`} src={`/api/documents/${encodeURIComponent(detail.document.id)}/content`} className="max-h-[32rem] w-full object-contain" />
                    : detail.document.rawText || detail.document.parsedMarkdown ? <pre className="max-h-[32rem] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-stone-700">{detail.document.rawText ?? detail.document.parsedMarkdown}</pre>
                      : <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center"><IconInfo className="size-5 text-stone-400" /><p className="mt-2 text-sm font-medium text-stone-700">Source file is unavailable</p><p className="mt-1 text-xs text-stone-500">The source may not have been retained for this document.</p></div>}
              </div>
            </section>

            <section className="min-w-0 rounded-lg border border-stone-200 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">Extracted lines &amp; coding suggestions</h3><span className="text-[11px] text-stone-400">Review against source</span></div>
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">The parser does not provide a calibrated extraction confidence score. Account matches below show the terms that matched, not a probability. Check amounts and account codes against the original before posting.</p>
              {detail.suggestions.length > 0 ? (
                <div className="table-shell shadow-none">
                  <table className="data-table min-w-[580px]">
                    <thead><tr><th>Extracted line</th><th>Qty</th><th className="text-right">Unit price</th><th>Suggested account</th><th>Matched terms</th></tr></thead>
                    <tbody>{detail.suggestions.map((suggestion) => (
                      <tr key={suggestion.id}>
                        <td className="font-medium">{suggestion.description}</td>
                        <td className="num">{(suggestion.quantityThousandths / 1000).toLocaleString()}</td>
                        <td className="num">{(suggestion.unitPriceMinor / 100).toFixed(2)}</td>
                        <td><Badge tone="gold">{suggestion.suggestedAccountCode}{suggestion.accountName ? ` · ${suggestion.accountName}` : ""}</Badge></td>
                        <td>{suggestion.matchedOn.length > 0 ? <div className="flex flex-wrap gap-1">{suggestion.matchedOn.map((term) => <Badge key={term} tone="green">{term}</Badge>)}</div> : <span className="inline-flex items-center gap-1 text-xs text-stone-400"><IconInfo className="size-3.5" /> fallback</span>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : !busy ? <p className="rounded-lg bg-stone-50 px-3.5 py-3 text-sm text-stone-500">{detail.document.parsedMarkdown ? "No coding suggestions yet. Run Suggest coding to compare extracted lines with your chart of accounts." : "Parse this document before requesting line extraction and coding suggestions."}</p> : <p className="py-5 text-center text-sm text-stone-500" role="status">Preparing suggestions…</p>}
            </section>
          </div>

          {detail.document.parsedMarkdown && <details className="mt-4 group"><summary className="cursor-pointer text-xs font-semibold tracking-wide text-stone-500 uppercase select-none hover:text-stone-700">Full extracted text</summary><pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-stone-50 p-3 font-mono text-xs whitespace-pre-wrap text-stone-700">{detail.document.parsedMarkdown}</pre></details>}
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
    </AppFrame>
  );
}
