import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DocumentsApiError, fetchDocumentDetail, fetchDocuments, fetchDocumentsEnabled, type DocumentDetail, type DocumentRow } from "../api/documents";
import { authClient } from "../api/auth";
import { fetchOrganizations } from "../api/organizations";
import { createAuthoredDocumentDraft, DocumentsEditorApiError } from "../api/documents-editor";
import { createIngestedDocument, DocumentsIngestApiError } from "../api/documents-ingest";
import {
  createDocumentFolder,
  deleteDocumentFolder,
  fetchAuthoredDocuments,
  fetchDocumentFolders,
  renameDocumentFolder,
  deleteIngestedDocument,
  hasPendingIngestedDocumentDeletionMarker,
  pendingIngestedDocumentDeletion,
  type AuthoredDocumentRow,
  type DocumentFolder,
  type DocumentsLibraryScope,
  type PendingIngestedDocumentDeletion,
} from "../api/documents-library";
import { navigate } from "../navigation";
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

type AuthoredListState =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "ready"; documents: AuthoredDocumentRow[] };

type RequestedDocumentSelection =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "requested"; id: string };

function requestedDocumentSelection(search: string): RequestedDocumentSelection {
  const values = new URLSearchParams(search).getAll("documentId");
  if (values.length === 0) return { kind: "none" };
  const id = values[0] ?? "";
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { kind: "invalid" };
  return { kind: "requested", id };
}

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

function DocumentDetails({
  state,
  selected,
  deleteConfirm,
  deleteBlocked,
  deleting,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  state: DetailState;
  selected: DocumentRow;
  deleteConfirm: boolean;
  deleteBlocked: boolean;
  deleting: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  if (state.status === "loading" || state.status === "idle") {
    return <p className="documents-detail-message" role="status">Loading document details…</p>;
  }
  if (state.status === "failed") {
    return (
      <section className="documents-detail-error" role="alert">
        <h2>{state.error.status === 404 ? "Document not found" : "Could not load this document"}</h2>
        <p>{state.error.message}</p>
        {state.error.status === 404 && <a href="/documents">Back to document library</a>}
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
      <div className="documents-ingest-actions">
        {deleteConfirm ? (
          <>
            <span>This permanently deletes the uploaded record and its extracted content.</span>
            <button type="button" className="documents-secondary-action" disabled={deleting} onClick={onCancelDelete}>Cancel</button>
            <button type="button" className="documents-primary-link" disabled={deleting} onClick={onConfirmDelete}>{deleting ? "Deleting…" : "Confirm delete"}</button>
          </>
        ) : (
          <button type="button" className="documents-secondary-action" disabled={deleting || deleteBlocked} onClick={onRequestDelete}>Delete record</button>
        )}
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
        <a className="documents-file-link" href={`/api/go/documents/${encodeURIComponent(document.id)}/content`} target="_blank" rel="noreferrer">
          Open uploaded file <span aria-hidden="true">↗</span>
        </a>
      )}

      <section className="documents-extracted" aria-labelledby="documents-extracted-title">
        <h3 id="documents-extracted-title">Extracted text</h3>
        {document.parsedMarkdown
          ? <pre>{document.parsedMarkdown}</pre>
          : <p className="documents-muted">{document.status === "queued" || document.status === "processing" ? "Text extraction is in progress." : "No extracted text is available for this document yet."}</p>}
      </section>
      <section className="documents-extracted" aria-labelledby="documents-coding-title">
        <h3 id="documents-coding-title">Coding suggestions</h3>
        {document.suggestions.length > 0
          ? <ul className="documents-coding-suggestions">
              {document.suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <strong>{suggestion.description}</strong>
                  <span>Account {suggestion.suggestedAccountCode}</span>
                  <span>{suggestion.quantityThousandths / 1000} × {suggestion.unitPriceMinor} minor units</span>
                  <span>Status: {suggestion.status}</span>
                </li>
              ))}
            </ul>
          : <p className="documents-muted">No coding suggestions are available for this document.</p>}
      </section>
      <p className="documents-detail-id">Record {document.id || selected.id}</p>
    </article>
  );
}

export function DocumentsPage() {
  const [requestedSelection] = useState(() => requestedDocumentSelection(window.location.search));
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requestedSelectionError, setRequestedSelectionError] = useState<"invalid" | "not-found" | null>(null);
  const [query, setQuery] = useState("");
  const [authoredQuery, setAuthoredQuery] = useState("");
  const [authoredState, setAuthoredState] = useState<AuthoredListState>({ status: "loading" });
  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [folderLoadError, setFolderLoadError] = useState<string | null>(null);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const [folderPathInput, setFolderPathInput] = useState("");
  const [folderEditPath, setFolderEditPath] = useState<string | null>(null);
  const [folderNewPath, setFolderNewPath] = useState("");
  const [folderDeleteConfirm, setFolderDeleteConfirm] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [documentDeleteConfirmId, setDocumentDeleteConfirmId] = useState<string | null>(null);
  const [documentDeleting, setDocumentDeleting] = useState(false);
  const [documentDeleteNotice, setDocumentDeleteNotice] = useState<string | null>(null);
  const [pendingDocumentDelete, setPendingDocumentDelete] = useState<PendingIngestedDocumentDeletion | null>(null);
  const [retry, setRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [ingestMode, setIngestMode] = useState<"text" | "file" | null>(null);
  const [ingestTitle, setIngestTitle] = useState("");
  const [ingestFolder, setIngestFolder] = useState("");
  const [ingestText, setIngestText] = useState("");
  const [ingestFile, setIngestFile] = useState<File | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestSuccess, setIngestSuccess] = useState(false);
  const detailRequestId = useRef(0);
  const requestedSelectionHandled = useRef(false);

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
      if (!requestedSelectionHandled.current && requestedSelection.kind !== "none") {
        requestedSelectionHandled.current = true;
        if (requestedSelection.kind === "invalid") {
          setRequestedSelectionError("invalid");
          setSelectedId(null);
          return;
        }
        if (!documents.some((document) => document.id === requestedSelection.id)) {
          setRequestedSelectionError("not-found");
          setSelectedId(null);
          return;
        }
        setRequestedSelectionError(null);
        setSelectedId(requestedSelection.id);
        return;
      }
      setRequestedSelectionError(null);
      setSelectedId((current) => documents.some((document) => document.id === current) ? current : documents[0]?.id ?? null);
    } catch (error) {
      if (signal?.aborted) return;
      setState({ status: "failed", error: readableError(error) });
    }
  }, []);

  const libraryScope = useCallback(async (): Promise<DocumentsLibraryScope> => {
    const session = await authClient.getSession();
    const actorId = session.data?.user.id;
    if (session.error || !actorId) throw new Error("Sign in again before changing documents.");
    const organizations = await fetchOrganizations();
    if (!organizations.activeOrgId || !organizations.orgs.some((organization) => organization.id === organizations.activeOrgId)) {
      throw new Error("Choose an active workspace before changing documents.");
    }
    return { actorId, organizationId: organizations.activeOrgId };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, retry]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const controller = new AbortController();
    void fetchAuthoredDocuments(controller.signal).then((documents) => {
      if (!controller.signal.aborted) setAuthoredState({ status: "ready", documents });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setAuthoredState({ status: "failed", error: error instanceof Error ? error.message : "Could not load written documents." });
    });
    return () => controller.abort();
  }, [state.status, retry]);

  useEffect(() => {
    if (state.status !== "ready") return;
    if (!hasPendingIngestedDocumentDeletionMarker()) {
      setPendingDocumentDelete(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const pendingId = await pendingIngestedDocumentDeletion(await libraryScope());
        if (!controller.signal.aborted) setPendingDocumentDelete(pendingId);
      } catch (error) {
        if (!controller.signal.aborted) setDocumentDeleteNotice(error instanceof Error ? error.message : "Could not check for a pending document deletion.");
      }
    })();
    return () => controller.abort();
  }, [state.status, retry, libraryScope]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const controller = new AbortController();
    void fetchDocumentFolders(controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setFolders(result);
        setFolderLoadError(null);
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFolderLoadError(error instanceof Error ? error.message : "Could not load folders.");
    });
    return () => controller.abort();
  }, [state.status, retry]);

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
  const authoredDocuments = authoredState.status === "ready" ? authoredState.documents : [];
  const filteredAuthored = useMemo(() => {
    const needle = authoredQuery.trim().toLocaleLowerCase();
    if (!needle) return authoredDocuments;
    return authoredDocuments.filter((document) => [document.title, document.status, document.folder ?? "", document.documentType ?? "", document.linkedRecordLabel ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [authoredDocuments, authoredQuery]);

  async function reloadFolders() {
    const result = await fetchDocumentFolders();
    setFolders(result);
    setFolderLoadError(null);
  }

  async function submitFolderCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (folderBusy) return;
    setFolderBusy(true);
    setFolderNotice(null);
    try {
      const outcome = await createDocumentFolder(folderPathInput, await libraryScope());
      if (outcome.kind === "pending") {
        setFolderNotice(outcome.hint);
      } else {
        setFolderPathInput("");
        setFolderNotice(`Created ${outcome.data.path}.`);
        await reloadFolders();
      }
    } catch (error) {
      setFolderNotice(error instanceof Error ? error.message : "Could not create the folder.");
    } finally {
      setFolderBusy(false);
    }
  }

  async function submitFolderRename(path: string) {
    if (folderBusy) return;
    setFolderBusy(true);
    setFolderNotice(null);
    try {
      const outcome = await renameDocumentFolder(path, folderNewPath, await libraryScope());
      if (outcome.kind === "pending") {
        setFolderNotice(outcome.hint);
      } else {
        setFolderEditPath(null);
        setFolderNewPath("");
        setFolderNotice(`Moved ${outcome.data.path} to ${outcome.data.movedTo}.`);
        await Promise.all([reloadFolders(), load()]);
      }
    } catch (error) {
      setFolderNotice(error instanceof Error ? error.message : "Could not rename the folder.");
    } finally {
      setFolderBusy(false);
    }
  }

  async function submitFolderDelete(path: string) {
    if (folderBusy) return;
    setFolderBusy(true);
    setFolderNotice(null);
    try {
      const outcome = await deleteDocumentFolder(path, await libraryScope());
      if (outcome.kind === "pending") {
        setFolderNotice(outcome.hint);
      } else {
        setFolderDeleteConfirm(null);
        setFolderNotice(outcome.data.deleted ? `Deleted ${outcome.data.path}.` : `${outcome.data.path} was already removed.`);
        await reloadFolders();
      }
    } catch (error) {
      setFolderNotice(error instanceof Error ? error.message : "Could not delete the folder.");
    } finally {
      setFolderBusy(false);
    }
  }

  async function submitDocumentDelete(documentId: string, recovery = false, originalScope?: PendingIngestedDocumentDeletion) {
    if (documentDeleting || (pendingDocumentDelete && pendingDocumentDelete.documentId !== documentId)) return;
    if (!recovery && (selected?.id !== documentId || documentDeleteConfirmId !== documentId)) return;
    setDocumentDeleting(true);
    setDocumentDeleteNotice(null);
    let scope: DocumentsLibraryScope | null = null;
    try {
      scope = await libraryScope();
      if (recovery && originalScope && (scope.actorId !== originalScope.actorId || scope.organizationId !== originalScope.organizationId)) {
        setDocumentDeleteNotice("This deletion belongs to a different account or workspace. Switch back to the original scope before retrying it.");
        return;
      }
      const outcome = await deleteIngestedDocument(documentId, scope);
      if (outcome.kind === "pending") {
        setDocumentDeleteNotice(outcome.hint);
        setPendingDocumentDelete({ documentId, actorId: scope.actorId, organizationId: scope.organizationId });
        return;
      }
      setDocumentDeleteConfirmId(null);
      setPendingDocumentDelete(null);
      setDocumentDeleteNotice(outcome.data.deleted ? "Document deleted." : "This document was already deleted.");
      if (selected?.id === documentId) setSelectedId(null);
      await load();
    } catch (error) {
      setDocumentDeleteNotice(error instanceof Error ? error.message : "Could not delete the document.");
      try {
        scope ??= await libraryScope();
        setPendingDocumentDelete(await pendingIngestedDocumentDeletion(scope));
      } catch {
        if (scope) setPendingDocumentDelete({ documentId, actorId: scope.actorId, organizationId: scope.organizationId });
      }
    } finally {
      setDocumentDeleting(false);
    }
  }

  async function retryPendingDocumentDelete() {
    if (pendingDocumentDelete) await submitDocumentDelete(pendingDocumentDelete.documentId, true, pendingDocumentDelete);
  }

  const createDraft = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const session = await authClient.getSession();
      const actorId = session.data?.user.id;
      if (session.error || !actorId) throw new DocumentsEditorApiError(401, "Sign in again before creating a document.");
      const organizations = await fetchOrganizations();
      if (!organizations.activeOrgId || !organizations.orgs.some((organization) => organization.id === organizations.activeOrgId)) {
        throw new DocumentsEditorApiError(0, "Choose an active workspace before creating a document.");
      }
      const outcome = await createAuthoredDocumentDraft({ actorId, organizationId: organizations.activeOrgId });
      if (outcome.kind === "pending") {
        setCreateError(outcome.hint);
        return;
      }
      navigate(`/documents/editor/${encodeURIComponent(outcome.data.documentId)}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create the document. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const submitIngest = async () => {
    if (ingesting || !ingestMode) return;
    setIngesting(true);
    setIngestError(null);
    setIngestSuccess(false);
    try {
      const session = await authClient.getSession();
      const actorId = session.data?.user.id;
      if (session.error || !actorId) throw new DocumentsIngestApiError(401, "Sign in again before adding a document.");
      const organizations = await fetchOrganizations();
      if (!organizations.activeOrgId || !organizations.orgs.some((organization) => organization.id === organizations.activeOrgId)) {
        throw new DocumentsIngestApiError(0, "Choose an active workspace before adding a document.");
      }
      const input = ingestMode === "file"
        ? ingestFile ? { title: ingestTitle, folder: ingestFolder, file: ingestFile } : null
        : { title: ingestTitle, folder: ingestFolder, text: ingestText };
      if (!input) throw new DocumentsIngestApiError(400, "Choose a PDF or image file before uploading.");
      const outcome = await createIngestedDocument(input, { actorId, organizationId: organizations.activeOrgId });
      if (outcome.kind === "pending") {
        setIngestError(outcome.hint);
        return;
      }
      setIngestMode(null);
      setIngestTitle("");
      setIngestFolder("");
      setIngestText("");
      setIngestFile(null);
      setRetry((current) => current + 1);
      setSelectedId(outcome.documentId);
      setIngestSuccess(true);
    } catch (error) {
      setIngestError(error instanceof Error ? error.message : "The document could not be added. Try again.");
    } finally {
      setIngesting(false);
    }
  };

  return (
    <main className="documents-page">
      <header className="documents-page-header">
        <div>
          <p className="documents-eyebrow">Knowledge and records</p>
          <h1>Documents</h1>
          <p>Browse uploaded records and review extracted text and processing status.</p>
        </div>
        <div className="documents-header-actions">
          <button className="documents-secondary-action" type="button" onClick={() => { setIngestMode((current) => current ? null : "text"); setIngestError(null); setIngestSuccess(false); }}>
            {ingestMode ? "Close form" : "Add a document"}
          </button>
          <button className="documents-full-workspace" type="button" onClick={() => void createDraft()} disabled={creating}>
            {creating ? "Creating draft…" : "New draft"}
          </button>
        </div>
      </header>

      {createError && <p className="documents-error" role="alert">{createError}</p>}
      {ingestSuccess && <p className="documents-ingest-success" role="status">Document added to the records library.</p>}
      {documentDeleteNotice && <p className="documents-folder-notice" role="status">{documentDeleteNotice}</p>}
      {pendingDocumentDelete && (
        <section className="documents-detail-error" role="alert">
          <h2>Previous deletion needs confirmation</h2>
          <p>The result for document {pendingDocumentDelete.documentId} was not confirmed. Retry the same deletion to confirm whether it was removed.</p>
          <button type="button" disabled={documentDeleting} onClick={() => void retryPendingDocumentDelete()}>
            {documentDeleting ? "Retrying…" : "Retry previous deletion"}
          </button>
        </section>
      )}

      {ingestMode && (
        <section className="documents-ingest-form" aria-labelledby="documents-ingest-title">
          <div className="documents-ingest-heading">
            <div><p className="documents-eyebrow">Add to records</p><h2 id="documents-ingest-title">Add a document</h2></div>
            <div className="documents-ingest-modes" role="group" aria-label="Document source">
              <button type="button" aria-pressed={ingestMode === "text"} onClick={() => { setIngestMode("text"); setIngestError(null); setIngestSuccess(false); }}>Paste text</button>
              <button type="button" aria-pressed={ingestMode === "file"} onClick={() => { setIngestMode("file"); setIngestError(null); setIngestSuccess(false); }}>Upload PDF or image</button>
            </div>
          </div>
          <div className="documents-ingest-fields">
            <label>Title<input value={ingestTitle} maxLength={200} onChange={(event) => setIngestTitle(event.currentTarget.value)} placeholder="Supplier invoice #42" /></label>
            <label>Folder (optional)<input value={ingestFolder} maxLength={300} onChange={(event) => setIngestFolder(event.currentTarget.value)} placeholder="Finance / Payables" /></label>
            {ingestMode === "text" ? (
              <label className="documents-ingest-wide">Text<textarea value={ingestText} maxLength={100_000} rows={6} onChange={(event) => setIngestText(event.currentTarget.value)} placeholder="Paste document text here" /></label>
            ) : (
              <label className="documents-ingest-wide">PDF or image, up to 5 MB
                <input aria-label="Upload document file" type="file" accept="image/*,.pdf" onChange={(event) => setIngestFile(event.currentTarget.files?.[0] ?? null)} />
                {ingestFile && <span>{ingestFile.name} ({formatSize(ingestFile.size)})</span>}
              </label>
            )}
          </div>
          {ingestError && <p className="documents-ingest-error" role="alert">{ingestError}</p>}
          <div className="documents-ingest-actions">
            <span>Text is limited to 100,000 characters. Uploads are limited to 5 MB.</span>
            <button type="button" className="documents-primary-link" onClick={() => void submitIngest()} disabled={ingesting}>
              {ingesting ? "Adding…" : ingestMode === "file" ? "Upload document" : "Add text"}
            </button>
          </div>
        </section>
      )}

      {state.status === "ready" && (
        <section className="documents-folder-manager" aria-labelledby="documents-folders-title">
          <div className="documents-library-heading">
            <div><h2 id="documents-folders-title">Folders</h2><span>{folders.length} {folders.length === 1 ? "folder" : "folders"}</span></div>
          </div>
          <form className="documents-folder-create" onSubmit={(event) => void submitFolderCreate(event)}>
            <label htmlFor="documents-folder-path">Create folder</label>
            <input id="documents-folder-path" value={folderPathInput} maxLength={300} onChange={(event) => setFolderPathInput(event.currentTarget.value)} placeholder="Finance / Payables" />
            <button className="documents-primary-link" type="submit" disabled={folderBusy || !folderPathInput.trim()}>{folderBusy ? "Saving…" : "Create"}</button>
          </form>
          {folderNotice && <p className="documents-folder-notice" role="status">{folderNotice}</p>}
          {folderLoadError && <p className="documents-ingest-error" role="alert">{folderLoadError}</p>}
          {folders.length > 0 ? (
            <ul className="documents-folder-list">
              {folders.map((folder) => (
                <li key={folder.id}>
                  {folderEditPath === folder.path ? (
                    <form className="documents-folder-rename" onSubmit={(event) => { event.preventDefault(); void submitFolderRename(folder.path); }}>
                      <label className="sr-only" htmlFor={`folder-rename-${folder.id}`}>New path for {folder.path}</label>
                      <input id={`folder-rename-${folder.id}`} value={folderNewPath} maxLength={300} onChange={(event) => setFolderNewPath(event.currentTarget.value)} />
                      <button type="submit" disabled={folderBusy || !folderNewPath.trim()}>Save</button>
                      <button type="button" onClick={() => { setFolderEditPath(null); setFolderNewPath(""); }}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <span>{folder.path}</span>
                      {folderDeleteConfirm === folder.path ? (
                        <span className="documents-folder-actions">
                          <span>Delete this empty folder?</span>
                          <button type="button" disabled={folderBusy} onClick={() => void submitFolderDelete(folder.path)}>Confirm</button>
                          <button type="button" onClick={() => setFolderDeleteConfirm(null)}>Cancel</button>
                        </span>
                      ) : (
                        <span className="documents-folder-actions">
                          <button type="button" disabled={folderBusy} onClick={() => { setFolderEditPath(folder.path); setFolderNewPath(folder.path); }}>Rename</button>
                          <button type="button" disabled={folderBusy} onClick={() => setFolderDeleteConfirm(folder.path)}>Delete</button>
                        </span>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="documents-muted">Create folders to organize written documents.</p>}
        </section>
      )}

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
        <section className="documents-empty" role={requestedSelectionError ? "alert" : undefined} aria-live={requestedSelectionError ? undefined : "polite"}>
          <span aria-hidden="true">▤</span>
          {requestedSelectionError
            ? <><h2>{requestedSelectionError === "invalid" ? "Invalid document link" : "Document not found"}</h2><p>{requestedSelectionError === "invalid" ? "The document ID in this link is invalid." : "This document is not in the current workspace or may have been deleted."}</p><a href="/documents">Back to document library</a></>
            : <><h2>No documents yet</h2><p>Upload a PDF or image, paste text into the records library, or start an editable draft.</p></>}
          <button className="documents-primary-link" type="button" onClick={() => { setIngestMode("text"); setIngestError(null); setIngestSuccess(false); }}>
            Add text to records
          </button>
          <button className="documents-secondary-action" type="button" onClick={() => { setIngestMode("file"); setIngestError(null); setIngestSuccess(false); }}>
            Upload a PDF or image
          </button>
          <button className="documents-secondary-action" type="button" onClick={() => void createDraft()} disabled={creating}>
            {creating ? "Creating draft…" : "Create editable draft"}
          </button>
        </section>
      )}

      {state.status === "ready" && documents.length > 0 && requestedSelectionError && (
        <section className="documents-detail-error" role="alert">
          <h2>{requestedSelectionError === "invalid" ? "Invalid document link" : "Document not found"}</h2>
          <p>{requestedSelectionError === "invalid" ? "The document ID in this link is invalid." : "This document is not in the current workspace or may have been deleted."}</p>
          <a href="/documents">Back to document library</a>
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
                      onClick={() => { setRequestedSelectionError(null); setDocumentDeleteConfirmId(null); setSelectedId(document.id); }}
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
            {selected ? <DocumentDetails
              state={detailState}
              selected={selected}
              deleteConfirm={documentDeleteConfirmId === selected.id}
              deleteBlocked={pendingDocumentDelete !== null}
              deleting={documentDeleting}
              onRequestDelete={() => { setDocumentDeleteConfirmId(selected.id); setDocumentDeleteNotice(null); }}
              onCancelDelete={() => setDocumentDeleteConfirmId(null)}
              onConfirmDelete={() => void submitDocumentDelete(selected.id)}
            /> : requestedSelectionError ? null : <p className="documents-detail-message">Select a document to review its details.</p>}
          </section>
        </section>
      )}

      {state.status === "ready" && (
        <section className="documents-authored" aria-labelledby="documents-authored-title">
          <div className="documents-authored-heading">
            <div>
              <p className="documents-eyebrow">Written documents</p>
              <h2 id="documents-authored-title">Drafts and published documents</h2>
            </div>
            <span>{authoredState.status === "ready" ? authoredDocuments.length : ""}</span>
          </div>
          <label className="documents-search">
            <span className="sr-only">Search written documents</span>
            <input type="search" value={authoredQuery} onChange={(event) => setAuthoredQuery(event.currentTarget.value)} placeholder="Search title, folder, or linked record" />
          </label>
          {authoredState.status === "loading" ? <p className="documents-loading" role="status">Loading written documents…</p> : null}
          {authoredState.status === "failed" ? (
            <div className="documents-error" role="alert"><p>{authoredState.error}</p><button type="button" onClick={() => setRetry((current) => current + 1)}>Try again</button></div>
          ) : null}
          {authoredState.status === "ready" && authoredDocuments.length === 0 ? (
            <div className="documents-filter-empty"><h3>No written documents yet</h3><p>Create a draft to start a document in the editor.</p></div>
          ) : null}
          {authoredState.status === "ready" && authoredDocuments.length > 0 && filteredAuthored.length === 0 ? (
            <div className="documents-filter-empty"><h3>No matching written documents</h3><p>Try another title, status, folder, or linked record.</p></div>
          ) : null}
          {authoredState.status === "ready" && filteredAuthored.length > 0 ? (
            <ul className="documents-authored-list">
              {filteredAuthored.map((document) => (
                <li key={document.id}>
                  <div>
                    <strong>{document.title}</strong>
                    <span>{document.folder || "Unfiled"} · {document.documentType || "Document"}{document.linkedRecordLabel ? ` · ${document.linkedRecordLabel}` : ""}</span>
                    <span>{document.versions} {document.versions === 1 ? "version" : "versions"} · Updated {formatDate(document.updatedAt)}</span>
                  </div>
                  <span className={`documents-status ${statusClass(document.status)}`}>{document.status}</span>
                  <button className="documents-secondary-action" type="button" onClick={() => navigate(`/documents/editor/${encodeURIComponent(document.id)}`)}>Open editor</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </main>
  );
}
