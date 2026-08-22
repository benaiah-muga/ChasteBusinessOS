"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ base64: string; mimeType: string } | null>(null);

  const load = useCallback(async () => {
    const d = await fetch("/api/documents").then((r) => r.json());
    setDocs(d.documents ?? []);
  }, []);

  const openDetail = useCallback(async (id: string) => {
    const d = await fetch(`/api/documents?id=${id}`).then((r) => r.json());
    setDetail(d.document ? d : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (res.status === 202) setMessage(`${label}: needs human approval (check Approvals).`);
      else if (json.ok) setMessage(`${label}: done.`);
      else setMessage(`${label} failed: ${json.error ?? "unknown error"}`);
      await load();
      if (payload.documentId) await openDetail(String(payload.documentId));
      return json.ok === true || res.status === 202;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!title.trim()) return setMessage("Give the document a title first.");
    const ok = file
      ? await action({ action: "create", title, fileBase64: file.base64, mimeType: file.mimeType }, "Upload")
      : await action({ action: "create", title, text }, "Ingest text");
    if (ok) {
      setTitle("");
      setText("");
      setFile(null);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return setFile(null);
    const reader = new FileReader();
    reader.onload = () =>
      setFile({ base64: String(reader.result).split(",")[1] ?? "", mimeType: f.type || "application/octet-stream" });
    reader.readAsDataURL(f);
  }

  const statusBadge = (s: string) => (
    <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${
      s === "parsed" ? "bg-emerald-100 text-emerald-800"
      : s === "failed" ? "bg-red-100 text-red-800"
      : "bg-neutral-100 text-neutral-700"
    }`}>
      {s}
    </span>
  );

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Documents</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Upload a bill or receipt and the agent reads it. Parsed text lands in org memory; expense
        coding is suggested against your chart of accounts — nothing posts until you act on it.
      </p>

      {message && (
        <p className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
          message.includes("failed") ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>{message}</p>
      )}

      <div className="mb-8 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">New document</h2>
        <div className="grid gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title, e.g. “Acme stationery invoice #42”"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="…or paste the document text here (works without an NVIDIA key)"
            className="rounded-lg border border-neutral-300 px-3 py-2 font-mono text-xs focus:border-emerald-600 focus:outline-none"
            disabled={Boolean(file)}
          />
          <div className="flex items-center justify-between gap-4">
            <label className="text-xs text-neutral-500">
              Upload image/PDF (≤5MB):{" "}
              <input type="file" accept="image/*,.pdf" onChange={onFile} className="ml-1 text-xs" />
              {file && <span className="ml-2 font-mono text-[10px] text-emerald-700">{file.mimeType} loaded</span>}
            </label>
            <button
              onClick={submit}
              disabled={busy}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? "Working…" : "Ingest"}
            </button>
          </div>
        </div>
      </div>

      {docs === null && <p className="text-sm text-neutral-400">Loading…</p>}
      {docs?.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center text-sm text-neutral-400">
          No documents yet.
        </p>
      )}

      {docs && docs.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 font-mono text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className={`border-b border-neutral-100 last:border-0 ${detail?.document.id === d.id ? "bg-emerald-50/40" : "hover:bg-neutral-50"}`}>
                  <td className="px-4 py-2.5 font-medium">{d.title}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{d.sourceType}</td>
                  <td className="px-4 py-2.5">{statusBadge(d.status)}</td>
                  <td className="px-4 py-2.5 text-xs text-neutral-500">{new Date(d.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => openDetail(d.id)} className="mr-3 text-xs text-emerald-700 underline underline-offset-2">
                      open
                    </button>
                    <button
                      onClick={() => action({ action: "delete", documentId: d.id }, "Delete")}
                      disabled={busy}
                      className="text-xs text-red-700 underline underline-offset-2 disabled:opacity-40"
                    >
                      delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{detail.document.title}</h2>
            <div className="flex items-center gap-2">
              {statusBadge(detail.document.status)}
              <button
                onClick={() => action({ action: "parse", documentId: detail.document.id }, "Parse")}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs hover:border-emerald-600 disabled:opacity-40"
              >
                Parse{detail.document.sourceType === "upload" ? " (OCR)" : ""}
              </button>
              <button
                onClick={() => action({ action: "suggest", documentId: detail.document.id }, "Suggest coding")}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs hover:border-emerald-600 disabled:opacity-40"
              >
                Suggest coding
              </button>
            </div>
          </div>

          {detail.document.parseError && (
            <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 font-mono text-xs text-red-800">
              {detail.document.parseError}
            </p>
          )}

          {detail.suggestions.length > 0 && (
            <div className="mb-4 overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-neutral-200 bg-neutral-50 font-mono text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="px-3 py-2">Line</th>
                    <th className="px-3 py-2">Qty (k)</th>
                    <th className="px-3 py-2">Unit price</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.suggestions.map((s) => (
                    <tr key={s.id} className="border-b border-neutral-100 last:border-0">
                      <td className="px-3 py-2">{s.description}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.quantityThousandths}</td>
                      <td className="px-3 py-2 font-mono text-xs">{(s.unitPriceMinor / 100).toFixed(2)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.suggestedAccountCode}</td>
                      <td className="px-3 py-2">
                        <span className={`font-mono text-xs ${s.matchScore > 0 ? "text-emerald-700" : "text-neutral-400"}`}>
                          {s.matchScore > 0 ? `matched ×${s.matchScore}` : "fallback"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {detail.document.parsedMarkdown && (
            <details>
              <summary className="cursor-pointer text-xs uppercase tracking-wide text-neutral-500">Parsed text</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 font-mono text-xs text-neutral-700">
                {detail.document.parsedMarkdown}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
