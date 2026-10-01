import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocumentsApiError, fetchDocumentDetail, fetchDocuments, fetchDocumentsEnabled, type DocumentDetail, type DocumentRow } from "../api/documents";
import { legacyUrl } from "../legacy";
import "./documents-page.css";

type ListState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: DocumentsApiError }
  | { status: "ready"; documents: DocumentRow[] };

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; error: DocumentsApiError }
  | { status: "ready"; document: DocumentDetail };

function readableError(error: unknown): DocumentsApiError {
  return error instanceof DocumentsApiError
    ? error
    : new DocumentsApiError(0, "Could not reach the documents service. Check your connection and try again.");
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "Text document";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (["parsed", "complete", "completed"].includes(normalized)) return "documents-status-good";
  if (["failed", "error"].includes(normalized)) return "documents-status-error";
  if (["queued", "processing", "pending"].includes(normalized)) return "documents-status-pending";
  return "documents-status-neutral";
}

function DocumentDetails({ state, selected }: { state: DetailState; selected: DocumentRow }) {
  if (state.status === "loading" || state.status === "idle") {
    return <p className="documents-detail-message" role="status">Loading document details…</p>;
  }
  if (state.status === "failed") {
    return (
      <section className="documents-detail-error" role="alert">
        <h2>Could not load this document</h2>
        <p>{state.error.message}</p>
      </section>
    );
  }

  const document = state.document;
  return (
    <article className="documents-detail">
      <div className="documents-detail-title">
        <div>
          <p className="documents-eyebrow">Document record</p>
          <h2>{document.title}</h2>
        </div>
        <span className={`documents-status ${statusClass(document.status)}`}>{document.status}</span>
      </div>
      <dl className="documents-metadata">
        <div><dt>Added</dt><dd><time dateTime={document.createdAt}>{formatDate(document.createdAt)}</time></dd></div>
        <div><dt>Folder</dt><dd>{document.folder || "Unfiled"}</dd></div>
        <div><dt>Source</dt><dd>{document.sourceType}</dd></div>
        <div><dt>File</dt><dd>{formatSize(document.sizeBytes)}{document.mimeType ? ` · ${document.mimeType}` : ""}</dd></div>
      </dl>

      {document.parseError && (
        <section className="documents-parse-error" aria-label="Processing error">
          <h3>Document processing needs attention</h3>
          <p>{document.parseError}</p>
        </section>
      )}

      {document.mimeType && document.sizeBytes !== null && (
        <a className="documents-file-link" href={`/api/documents/${encodeURIComponent(document.id)}/content`} target="_blank" rel="noreferrer">
          Open uploaded file <span aria-hidden="true">↗</span>
        </a>
      )}

      <section className="documents-extracted" aria-labelledby="documents-extracted-title">
        <h3 id="documents-extracted-title">Extracted text</h3>
        {document.parsedMarkdown
          ? <pre>{document.parsedMarkdown}</pre>
          : <p className="documents-muted">{document.status === "queued" || document.status === "processing" ? "Text extraction is in progress." : "No extracted text is available for this document yet."}</p>}
      </section>
      <p className="documents-detail-id">Record {document.id || selected.id}</p>
    </article>
  );
}

export function DocumentsPage() {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const detailRequestId = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      if (!await fetchDocumentsEnabled(signal)) {
        if (!signal?.aborted) setState({ status: "disabled" });
        return;
      }
      const documents = await fetchDocuments(signal);
      if (signal?.aborted) return;
      setState({ status: "ready", documents });
      setSelectedId((current) => documents.some((document) => document.id === current) ? current : documents[0]?.id ?? null);
    } catch (error) {
      if (signal?.aborted) return;
      setState({ status: "failed", error: readableError(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, retry]);

  useEffect(() => {
    if (!selectedId) {
      setDetailState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    const requestId = ++detailRequestId.current;
    setDetailState({ status: "loading" });
    void fetchDocumentDetail(selectedId, controller.signal).then((document) => {
      if (!controller.signal.aborted && requestId === detailRequestId.current) setDetailState({ status: "ready", document });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && requestId === detailRequestId.current) setDetailState({ status: "failed", error: readableError(error) });
    });
    return () => controller.abort();
  }, [selectedId]);

  const documents = state.status === "ready" ? state.documents : [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return documents;
    return documents.filter((document) => [document.title, document.folder ?? "", document.status, document.sourceType]
      .some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [documents, query]);
  const selected = documents.find((document) => document.id === selectedId) ?? null;

  return (
    <main className="documents-page">
      <header className="documents-page-header">
        <div>
          <p className="documents-eyebrow">Knowledge and records</p>
          <h1>Documents</h1>
          <p>Browse uploaded records and review extracted text and processing status.</p>
        </div>
        <a className="documents-full-workspace" href={legacyUrl("/documents")}>Open full documents workspace</a>
      </header>

      {state.status === "loading" && <p className="documents-loading" role="status">Loading documents…</p>}
      {state.status === "disabled" && (
        <section className="documents-empty" role="status">
          <h2>Documents is turned off</h2>
          <p>Ask a workspace administrator to enable the Documents module before viewing records.</p>
        </section>
      )}
      {state.status === "failed" && (
        <section className="documents-error" role="alert" aria-labelledby="documents-error-title">
          <div>
            <p className="documents-eyebrow">Library unavailable</p>
            <h2 id="documents-error-title">{state.error.status === 401 ? "Sign in again" : state.error.status === 403 ? "Access denied" : "Could not load documents"}</h2>
            <p>{state.error.message}</p>
          </div>
          <button type="button" onClick={() => setRetry((current) => current + 1)}>Try again</button>
        </section>
      )}

      {state.status === "ready" && documents.length === 0 && (
        <section className="documents-empty" aria-live="polite">
          <span aria-hidden="true">▤</span>
          <h2>No documents yet</h2>
          <p>Upload a PDF or image, or add text in the full documents workspace.</p>
          <a className="documents-primary-link" href={legacyUrl("/documents?tab=write")}>Add a document</a>
        </section>
      )}

      {state.status === "ready" && documents.length > 0 && (
        <section className="documents-workspace" aria-label="Document library">
          <aside className="documents-library">
            <div className="documents-library-heading">
              <div><h2>Library</h2><span>{documents.length} {documents.length === 1 ? "record" : "records"}</span></div>
              <label className="documents-search">
                <span className="sr-only">Search documents</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search title or folder" />
              </label>
            </div>
            {filtered.length > 0 ? (
              <ul className="documents-list">
                {filtered.map((document) => (
                  <li key={document.id}>
                    <button
                      type="button"
                      className={`documents-list-button${selectedId === document.id ? " documents-list-button-current" : ""}`}
                      aria-current={selectedId === document.id ? "true" : undefined}
                      onClick={() => setSelectedId(document.id)}
                    >
                      <span className="documents-list-heading"><strong>{document.title}</strong><span className={`documents-status ${statusClass(document.status)}`}>{document.status}</span></span>
                      <span className="documents-list-meta">{document.folder || "Unfiled"}<span aria-hidden="true"> · </span>{formatDate(document.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="documents-filter-empty"><h3>No matching documents</h3><p>Try another title, folder, or status.</p></div>
            )}
          </aside>
          <section className="documents-detail-panel" aria-label="Selected document">
            {selected ? <DocumentDetails state={detailState} selected={selected} /> : <p className="documents-detail-message">Select a document to review its details.</p>}
          </section>
        </section>
      )}
    </main>
  );
}
