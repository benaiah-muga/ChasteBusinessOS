import { z } from "zod";

const CapabilitySuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const PendingApprovalSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().min(1),
  approvalId: z.string().uuid().optional(),
}).strict();
const ErrorResponseSchema = z.object({ error: z.string().optional(), message: z.string().optional() });
const AuthoredDocumentRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string().min(1),
  versions: z.number().int().nonnegative(),
  templateId: z.string().uuid().nullable(),
  folder: z.string().nullable(),
  documentType: z.string().nullable(),
  linkedRecordType: z.string().nullable(),
  linkedRecordId: z.string().uuid().nullable(),
  linkedRecordLabel: z.string().nullable(),
  updatedAt: z.string().datetime(),
}).strict();
const AuthoredDocumentsOutputSchema = z.object({ documents: z.array(AuthoredDocumentRowSchema) }).strict();
const DocumentFolderSchema = z.object({ id: z.string().uuid(), path: z.string().min(1).max(300) }).strict();
const DocumentFoldersOutputSchema = z.object({ folders: z.array(DocumentFolderSchema) }).strict();
const FolderCreatedSchema = z.object({ folderId: z.string().uuid(), path: z.string().min(1).max(300) }).strict();
const FolderRenamedSchema = z.object({ path: z.string().min(1).max(300), movedTo: z.string().min(1).max(300) }).strict();
const FolderDeletedSchema = z.object({ deleted: z.boolean(), path: z.string().min(1).max(300) }).strict();
const IngestedDocumentDeletedSchema = z.object({ deleted: z.boolean() }).strict();
const DocumentRecordSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  detail: z.string(),
  values: z.record(z.string(), z.string()),
}).strict();
const SearchRecordsOutputSchema = z.object({ records: z.array(DocumentRecordSchema) }).strict();
const RetryMarkerSchema = z.object({
  version: z.literal(1),
  intentId: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  documentId: z.string().uuid().optional(),
  actorId: z.string().min(1).max(255).optional(),
  organizationId: z.string().uuid().optional(),
}).strict();

export type AuthoredDocumentRow = z.infer<typeof AuthoredDocumentRowSchema>;
export type DocumentFolder = z.infer<typeof DocumentFolderSchema>;
export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;
export type DocumentRecordType = "customer" | "supplier" | "employee" | "invoice" | "quote" | "purchase_order" | "sales_order";
export type DocumentsLibraryScope = { actorId: string; organizationId: string };
export type PendingIngestedDocumentDeletion = { documentId: string; actorId: string; organizationId: string };
export type DocumentsLibraryOutcome<T> = { kind: "completed"; data: T } | { kind: "pending"; hint: string };

const recordTypes = new Set<DocumentRecordType>(["customer", "supplier", "employee", "invoice", "quote", "purchase_order", "sales_order"]);
const retryPrefix = "chaste:documents-library-write:v1:";

export class DocumentsLibraryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DocumentsLibraryApiError";
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DocumentsLibraryApiError(response.status, "The Go documents service returned an unreadable response.");
  }
}

function errorMessage(status: number, body: unknown): string {
  if (status === 401) return "Sign in again to access documents.";
  if (status === 403) return "You do not have permission to access these documents.";
  const parsed = ErrorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error ?? parsed.data.message ?? "The Go documents request failed." : "The Go documents request failed.";
}

async function executeRead<T>(capabilityId: string, input: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
      signal: requestSignal(signal),
    });
  } catch {
    if (signal?.aborted) throw new DocumentsLibraryApiError(0, "The document request was cancelled.");
    throw new DocumentsLibraryApiError(0, "Could not reach the Go documents service. Check your connection and try again.");
  }
  const body = await readBody(response);
  if (!response.ok) throw new DocumentsLibraryApiError(response.status, errorMessage(response.status, body));
  if (response.status !== 200) throw new DocumentsLibraryApiError(response.status, "The Go documents service returned an unexpected response.");
  const envelope = CapabilitySuccessSchema.safeParse(body);
  if (!envelope.success) throw new DocumentsLibraryApiError(response.status, "The Go documents service returned an unexpected response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new DocumentsLibraryApiError(response.status, "The Go documents service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchAuthoredDocuments(signal?: AbortSignal): Promise<AuthoredDocumentRow[]> {
  const result = await executeRead("documents.listDocs", {}, AuthoredDocumentsOutputSchema, signal);
  return result.documents;
}

export async function fetchDocumentFolders(signal?: AbortSignal): Promise<DocumentFolder[]> {
  const result = await executeRead("documents.listFolders", {}, DocumentFoldersOutputSchema, signal);
  return result.folders;
}

export async function searchDocumentRecords(type: DocumentRecordType, query: string, signal?: AbortSignal): Promise<DocumentRecord[]> {
  const normalizedQuery = query.trim();
  if (!recordTypes.has(type) || normalizedQuery.length > 120) {
    throw new DocumentsLibraryApiError(400, "Enter a valid record type and a search under 120 characters.");
  }
  const result = await executeRead("documents.searchRecords", { type, query: normalizedQuery }, SearchRecordsOutputSchema, signal);
  return result.records;
}

export function createDocumentFolder(path: string, scope: DocumentsLibraryScope): Promise<DocumentsLibraryOutcome<z.infer<typeof FolderCreatedSchema>>> {
  return executeFolderWrite("documents.createFolder", { path }, FolderCreatedSchema, scope);
}

export function renameDocumentFolder(path: string, newPath: string, scope: DocumentsLibraryScope): Promise<DocumentsLibraryOutcome<z.infer<typeof FolderRenamedSchema>>> {
  return executeFolderWrite("documents.renameFolder", { path, newPath }, FolderRenamedSchema, scope);
}

export function deleteDocumentFolder(path: string, scope: DocumentsLibraryScope): Promise<DocumentsLibraryOutcome<z.infer<typeof FolderDeletedSchema>>> {
  return executeFolderWrite("documents.deleteFolder", { path }, FolderDeletedSchema, scope);
}

export function deleteIngestedDocument(documentId: string, scope: DocumentsLibraryScope): Promise<DocumentsLibraryOutcome<z.infer<typeof IngestedDocumentDeletedSchema>>> {
  if (!z.string().uuid().safeParse(documentId).success) {
    throw new DocumentsLibraryApiError(400, "The selected document has an invalid ID.");
  }
  return executeLibraryWrite("documents.deleteDocument", { documentId }, IngestedDocumentDeletedSchema, scope, "document");
}

export async function pendingIngestedDocumentDeletion(scope: DocumentsLibraryScope): Promise<PendingIngestedDocumentDeletion | null> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  // eslint-disable-next-line no-control-regex -- Control characters cannot be included in retry scope keys.
  const safeActorId = actorId.length > 0 && actorId.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(actorId);
  if (!safeActorId || !z.string().uuid().safeParse(organizationId).success) {
    throw new DocumentsLibraryApiError(0, "Wait for your account and organization to finish loading before checking pending document actions.");
  }
  const scopeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${actorId}:${organizationId}`));
  const scopeHash = [...new Uint8Array(scopeBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const storageKey = `${retryPrefix}${scopeHash}:documents.deleteDocument`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new DocumentsLibraryApiError(0, "The saved document deletion could not be read. Enable browser storage before continuing."); }
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new DocumentsLibraryApiError(0, "A saved document deletion marker is invalid. Verify the document library before continuing."); }
  const parsed = RetryMarkerSchema.safeParse(value);
  if (!parsed.success) throw new DocumentsLibraryApiError(0, "A saved document deletion marker is invalid. Verify the document library before continuing.");
  if (!parsed.data.documentId) {
    throw new DocumentsLibraryApiError(0, "A previous document deletion needs confirmation, but its target cannot be recovered. Verify the library before deleting another record.");
  }
  if (!parsed.data.actorId || !parsed.data.organizationId) {
    throw new DocumentsLibraryApiError(0, "A previous document deletion is missing its original account or workspace. Switch to the original workspace before continuing.");
  }
  if (parsed.data.actorId !== actorId || parsed.data.organizationId !== organizationId) {
    throw new DocumentsLibraryApiError(0, "The saved document deletion belongs to a different account or workspace. Switch back before retrying it.");
  }
  return {
    documentId: parsed.data.documentId,
    actorId: parsed.data.actorId,
    organizationId: parsed.data.organizationId,
  };
}

export function hasPendingIngestedDocumentDeletionMarker(): boolean {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(retryPrefix) && key.endsWith(":documents.deleteDocument")) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function executeFolderWrite<T>(
  capabilityId: "documents.createFolder" | "documents.renameFolder" | "documents.deleteFolder",
  input: Record<string, string>,
  schema: z.ZodType<T>,
  scope: DocumentsLibraryScope,
): Promise<DocumentsLibraryOutcome<T>> {
  return executeLibraryWrite(capabilityId, input, schema, scope, "folder");
}

async function executeLibraryWrite<T>(
  capabilityId: "documents.createFolder" | "documents.renameFolder" | "documents.deleteFolder" | "documents.deleteDocument",
  input: Record<string, string>,
  schema: z.ZodType<T>,
  scope: DocumentsLibraryScope,
  actionLabel: "folder" | "document",
): Promise<DocumentsLibraryOutcome<T>> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  // Better Auth IDs are opaque strings, while organization IDs use UUIDs.
  // eslint-disable-next-line no-control-regex -- Control characters cannot be included in retry scope keys.
  const safeActorId = actorId.length > 0 && actorId.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(actorId);
  if (!safeActorId || !z.string().uuid().safeParse(organizationId).success) {
    throw new DocumentsLibraryApiError(0, `Wait for your account and organization to finish loading before changing this ${actionLabel}.`);
  }
  if (actionLabel === "folder") {
    for (const value of Object.values(input)) {
      if (!value.trim() || value.length > 300) throw new DocumentsLibraryApiError(400, "Enter a valid folder path.");
    }
  }
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) throw new DocumentsLibraryApiError(0, `Retry protection for this ${actionLabel} action is unavailable in this browser.`);
  const scopeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${actorId}:${organizationId}`));
  const scopeHash = [...new Uint8Array(scopeBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const storageKey = `${retryPrefix}${scopeHash}:${capabilityId}`;
  try {
    return await locks.request(storageKey, { mode: "exclusive" }, async () => {
      const requestInput = JSON.stringify({ capabilityId, input });
      const fingerprintBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestInput));
      const fingerprint = [...new Uint8Array(fingerprintBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      let marker: z.infer<typeof RetryMarkerSchema> | null;
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw === null) marker = null;
        else {
          const parsed = RetryMarkerSchema.safeParse(JSON.parse(raw) as unknown);
          if (!parsed.success) throw new DocumentsLibraryApiError(0, `A saved ${actionLabel} retry marker is invalid. Verify the ${actionLabel} before trying again.`);
          marker = parsed.data;
        }
      } catch (error) {
        if (error instanceof DocumentsLibraryApiError) throw error;
        throw new DocumentsLibraryApiError(0, `Retry protection for this ${actionLabel} action could not be read. Enable browser storage before continuing.`);
      }
      if (marker && marker.fingerprint !== fingerprint) {
        throw new DocumentsLibraryApiError(0, `A previous ${actionLabel} action is unresolved. Retry that exact action before making another change.`);
      }
      if (actionLabel === "document" && marker && (marker.documentId !== input.documentId || marker.actorId !== actorId || marker.organizationId !== organizationId)) {
        throw new DocumentsLibraryApiError(0, "The saved document deletion belongs to a different account or workspace. Switch back before retrying it.");
      }
      marker ??= {
        version: 1,
        intentId: crypto.randomUUID(),
        fingerprint,
        ...(actionLabel === "document" ? { documentId: input.documentId, actorId, organizationId } : {}),
      };
      const serialized = JSON.stringify(marker);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("retry marker did not persist");
      } catch {
        throw new DocumentsLibraryApiError(0, `Retry protection for this ${actionLabel} action could not be saved. Enable browser storage before continuing.`);
      }
      const clearIfCurrent = (): void => {
        try {
          const raw = window.localStorage.getItem(storageKey);
          if (raw === serialized) window.localStorage.removeItem(storageKey);
        } catch {
          throw new DocumentsLibraryApiError(0, `The ${actionLabel} action was confirmed, but retry protection could not be cleared. Retry the exact action to confirm it safely.`);
        }
      };
      let response: Response;
      let body: unknown;
      try {
        response = await fetch("/api/capabilities/execute", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": organizationId },
          cache: "no-store",
          body: JSON.stringify({ capabilityId, input, intentId: marker.intentId }),
          signal: requestSignal(),
        });
        body = await response.json();
      } catch {
        throw new DocumentsLibraryApiError(0, `The ${actionLabel} result was not confirmed. Retry the same action to avoid applying it twice.`);
      }
      if (response.status === 202) {
        const pending = PendingApprovalSchema.safeParse(body);
        if (!pending.success) throw new DocumentsLibraryApiError(202, "The Go documents service returned an unexpected approval response.");
        return { kind: "pending", hint: pending.data.reason };
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) clearIfCurrent();
        throw new DocumentsLibraryApiError(response.status, errorMessage(response.status, body));
      }
      if (response.status !== 200) throw new DocumentsLibraryApiError(response.status, "The Go documents service returned an unexpected response.");
      const envelope = CapabilitySuccessSchema.safeParse(body);
      const parsed = envelope.success ? schema.safeParse(envelope.data.data) : null;
      if (!parsed?.success) throw new DocumentsLibraryApiError(response.status, "The Go documents service returned data in an unexpected format.");
      clearIfCurrent();
      return { kind: "completed", data: parsed.data };
    });
  } catch (error) {
    if (error instanceof DocumentsLibraryApiError) throw error;
    throw new DocumentsLibraryApiError(0, `The browser could not safely coordinate this ${actionLabel} action across tabs. Retry after closing other Documents tabs.`);
  }
}
