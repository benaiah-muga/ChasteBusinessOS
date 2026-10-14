import { z } from "zod";

/**
 * Client for the authored-document editor surface: the one document read,
 * the draft workspace (autosave, presence, soft lock), Go capability writes
 * (publish, restore, rename, save as template), and read-shaped AI assist
 * calls. Editor detail and authored-version reads use Go capabilities;
 * workspace presence and writing assist use Go session-authenticated routes.
 *
 * Document content crosses this boundary in two forms: the ProseMirror JSON
 * tree the editor works in, and the HTML that tree renders to. Every HTML
 * string is produced by an allowlist serializer and passed through
 * `sanitizeDocumentHtml` before it reaches the DOM, so a stored document can
 * never contribute a script, a frame, an event handler or a remote image to
 * this page.
 */

const PageSettingsSchema = z.object({
  size: z.enum(["A4", "Letter"]),
  orientation: z.enum(["portrait", "landscape"]),
  margin: z.enum(["compact", "normal", "wide"]),
}).strict();
export type PageSettings = z.infer<typeof PageSettingsSchema>;

export const DEFAULT_PAGE_SETTINGS: PageSettings = { size: "A4", orientation: "portrait", margin: "normal" };

export const VersionRowSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();
export type VersionRow = z.infer<typeof VersionRowSchema>;

export const AuthoredDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.string().min(1),
  content: z.record(z.string(), z.unknown()),
  html: z.string(),
  templateId: z.string().nullable().optional(),
  folder: z.string().nullable().optional(),
  documentType: z.string().nullable().optional(),
  linkedRecordType: z.string().nullable().optional(),
  linkedRecordId: z.string().nullable().optional(),
  linkedRecordLabel: z.string().nullable().optional(),
  pageSettings: PageSettingsSchema.default(DEFAULT_PAGE_SETTINGS),
  versions: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
}).strict();
export type AuthoredDocument = z.infer<typeof AuthoredDocumentSchema>;

const DocumentPayloadSchema = z.object({
  document: AuthoredDocumentSchema.nullable(),
  versions: z.array(VersionRowSchema),
}).strict();
export type DocumentPayload = z.infer<typeof DocumentPayloadSchema>;
const GoAuthoredDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string().min(1),
  content: z.record(z.string(), z.unknown()),
  html: z.string(),
  templateId: z.string().nullable(),
  folder: z.string().nullable(),
  documentType: z.string().nullable(),
  linkedRecordType: z.string().nullable(),
  linkedRecordId: z.string().nullable(),
  linkedRecordLabel: z.string().nullable(),
  pageSettings: PageSettingsSchema,
  versions: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
}).strict();
const GoAuthoredDocumentOutputSchema = z.object({ document: GoAuthoredDocumentSchema }).strict();

const ArchivedVersionSchema = z.object({
  version: z.number().int().positive(),
  html: z.string(),
  note: z.string().nullable().optional(),
  createdAt: z.string().datetime().optional(),
}).strict();
export type ArchivedVersion = z.infer<typeof ArchivedVersionSchema>;

const CapabilitySuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const GoDocumentVersionsSchema = z.object({ versions: z.array(VersionRowSchema) }).strict();
const GoArchivedDocumentVersionSchema = z.object({
  version: z.number().int().positive(),
  content: z.record(z.string(), z.unknown()),
  html: z.string(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();
const documentUUID = z.string().uuid();

const PresenceUserSchema = z.object({ userId: z.string().min(1), name: z.string() }).strict();
export type PresenceUser = z.infer<typeof PresenceUserSchema>;

const WorkspaceLockSchema = z.object({ heldBy: z.string(), mine: z.boolean() }).strict();
const WorkspaceDraftSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  pageSettings: PageSettingsSchema.optional(),
  rev: z.number().int().positive(),
  updatedAt: z.string().datetime().optional(),
}).strict();
export type WorkspaceDraft = z.infer<typeof WorkspaceDraftSchema>;

/** One workspace tick: my heartbeat, an optional autosave, and who holds the pen. */
const WorkspaceResponseSchema = z.object({
  lock: WorkspaceLockSchema.optional(),
  savedRev: z.number().int().positive().optional(),
  draft: WorkspaceDraftSchema.nullable().optional(),
  others: z.array(PresenceUserSchema).optional(),
  conflict: z.boolean().optional(),
}).strict();
export type WorkspaceTick = {
  conflict: boolean;
  savedRev: number | null;
  lock: z.infer<typeof WorkspaceLockSchema> | null;
  others: PresenceUser[];
  draft: WorkspaceDraft | null;
};

const PublishedVersionSchema = z.object({ version: z.number().int().positive() }).strict();
const DocumentNumberSchema = z.object({ number: z.string().min(1) }).strict();
const TemplateCreatedSchema = z.object({
  templateId: z.string().uuid(),
  placeholders: z.array(z.string()),
}).strict();
export type TemplateCreated = z.infer<typeof TemplateCreatedSchema>;
const AuthoredDocumentCreatedSchema = z.object({ documentId: z.string().uuid() }).strict();
const TemplateRetryMarkerSchema = z.object({
  version: z.literal(1),
  intentId: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const DocumentWriteRetryMarkerSchema = TemplateRetryMarkerSchema;
const MetadataPreviousSchema = z.object({
  title: z.string(),
  folder: z.string().nullable(),
  linkedRecordType: z.string().nullable(),
  linkedRecordId: z.string().nullable(),
  linkedRecordLabel: z.string().nullable(),
}).strict();
const MetadataUpdatedSchema = z.object({
  documentId: z.string().min(1),
  previous: MetadataPreviousSchema.optional(),
}).strict();
const LegacyPendingApprovalSchema = z.object({
  pendingApproval: z.literal(true),
  hint: z.string().optional(),
}).strict();
const GoPendingApprovalSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().min(1),
  approvalId: z.string().uuid().optional(),
}).strict();
const PendingApprovalSchema = z.union([LegacyPendingApprovalSchema, GoPendingApprovalSchema]);
const AssistTextSchema = z.object({ ok: z.literal(true).optional(), text: z.string() }).strict();
const AssistPrefillSchema = z.object({ ok: z.literal(true), values: z.record(z.string(), z.string()) }).strict();
export type AssistText = z.infer<typeof AssistTextSchema>;
export type AssistPrefill = z.infer<typeof AssistPrefillSchema>;
export type DocumentsAssistTextRequest =
  | { kind: "selection"; action: "improve" | "grammar" | "tone" | "shorten" | "expand" | "translate"; text: string; language?: string }
  | { kind: "continue"; before: string; after?: string }
  | { kind: "chat"; documentId: string; question: string };
export type DocumentsAssistPrefillRequest = { kind: "prefill"; templateId: string };
export type DocumentsAssistRequest = DocumentsAssistTextRequest | DocumentsAssistPrefillRequest;
export type DocumentsAssistResult = AssistText | AssistPrefill;

export type GovernedOutcome<T> = { kind: "completed"; data: T } | { kind: "pending"; hint: string };

export type DocumentsEditorRetryScope = { actorId: string | null; organizationId: string | null };
export type AuthoredDocumentNumberKind = "invoice" | "quote" | "receipt" | "delivery_note" | "purchase_order" | "voucher" | "employment_contract" | "employment_agreement";

export class DocumentsEditorApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DocumentsEditorApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface WireResponse {
  status: number;
  body: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DocumentsEditorApiError(response.status, "The document service returned an unreadable response.");
  }
}

const MISSING_DOCUMENT = "That document no longer exists. It may have been deleted or moved to another workspace.";

function messageFor(status: number, body: unknown): string {
  const server = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
  const text = typeof server === "string" ? server.trim() : "";
  if (status === 401) return "Sign in again to edit this document.";
  if (status === 403) return "You do not have permission to edit this document.";
  if (/^document not found$/i.test(text)) return MISSING_DOCUMENT;
  if (/^invalid body$/i.test(text)) return "Some details were missing or malformed. Reopen the document and try again.";
  if (text && text.length <= 160 && !/[{}<>]/.test(text)) return text;
  if (status === 404) return MISSING_DOCUMENT;
  if (status === 409) return "This document is being edited somewhere else. Reload to pick up the latest draft.";
  if (status === 422) return "The document service refused that change. Check the document and try again.";
  if (status === 428) return "Finish setting up your workspace before editing documents.";
  if (status >= 500) return "The document service is unavailable. Try again in a moment.";
  return "The document request failed.";
}

async function request(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs?: number): Promise<WireResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      signal: requestSignal(signal, timeoutMs ?? (init.method === "POST" ? 20_000 : 15_000)),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new DocumentsEditorApiError(0, "The document service took too long to respond. Check the document before trying again.");
    }
    throw new DocumentsEditorApiError(0, "Could not reach the document service. Check your connection and try again.");
  }
  return { status: response.status, body: await readJson(response) };
}

/**
 * Client action identity (B02): a governed write carries an intentId so a
 * retried intent reconciles to the same server-side receipt instead of
 * executing twice. Only a real string identity wins.
 */
function withIntentId(body: Record<string, unknown>): Record<string, unknown> {
  const existing = body.intentId;
  if (typeof existing === "string" && existing.length > 0) return body;
  return { ...body, intentId: crypto.randomUUID() };
}

async function post(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<WireResponse> {
  const { status, body: raw } = await request(url, { method: "POST", body: JSON.stringify(withIntentId(body)) }, signal);
  if (status === 202) {
    const parsed = PendingApprovalSchema.safeParse(raw);
    if (!parsed.success) throw new DocumentsEditorApiError(202, "The document service returned an unexpected approval response.");
    return { status, body: parsed.data };
  }
  return { status, body: raw };
}

function pendingApprovalHint(pending: z.infer<typeof PendingApprovalSchema>): string {
  return ("reason" in pending ? pending.reason : pending.hint) ?? "This change waits for approval in the Approvals inbox.";
}

const documentPath = (id: string): string => `/api/docs/${encodeURIComponent(id)}`;

function validateDocumentVersionInput(id: string, version?: number): void {
  if (!documentUUID.safeParse(id).success || (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) {
    throw new DocumentsEditorApiError(400, "The document version request is invalid. Reopen the document and try again.");
  }
}

async function postDocumentVersionCapability<T>(capabilityId: string, input: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const { status, body } = await request("/api/capabilities/execute", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
  }, signal);
  if (status < 200 || status >= 300) throw new DocumentsEditorApiError(status, messageFor(status, body));
  const envelope = CapabilitySuccessSchema.safeParse(body);
  if (!envelope.success) throw new DocumentsEditorApiError(status, "The document service returned an unexpected capability response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new DocumentsEditorApiError(status, "The document service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchDocumentVersionHistoryFromGo(id: string, signal?: AbortSignal): Promise<VersionRow[]> {
  validateDocumentVersionInput(id);
  const output = await postDocumentVersionCapability("documents.listDocVersions", { documentId: id }, GoDocumentVersionsSchema, signal);
  return output.versions;
}

export async function fetchEditorDocument(id: string, signal?: AbortSignal): Promise<DocumentPayload> {
  if (!documentUUID.safeParse(id).success) {
    throw new DocumentsEditorApiError(400, "The document request is invalid. Reopen the document and try again.");
  }
  const output = await postDocumentVersionCapability("documents.getDoc", { documentId: id }, GoAuthoredDocumentOutputSchema, signal);
  if (output.document.id.toLowerCase() !== id.toLowerCase()) {
    throw new DocumentsEditorApiError(200, "The document service returned data in an unexpected format.");
  }
  const versions = await fetchDocumentVersionHistoryFromGo(id, signal);
  const payload = DocumentPayloadSchema.safeParse({ document: output.document, versions });
  if (!payload.success) throw new DocumentsEditorApiError(200, "The document service returned data in an unexpected format.");
  return payload.data;
}

export async function fetchArchivedVersion(id: string, version: number, signal?: AbortSignal): Promise<ArchivedVersion> {
  validateDocumentVersionInput(id, version);
  const output = await postDocumentVersionCapability("documents.getDocVersion", { documentId: id, version }, GoArchivedDocumentVersionSchema, signal);
  if (output.version !== version) throw new DocumentsEditorApiError(200, "The document service returned data in an unexpected format.");
  const projected = { version: output.version, html: output.html, note: output.note, createdAt: output.createdAt };
  const parsed = ArchivedVersionSchema.safeParse(projected);
  if (!parsed.success) throw new DocumentsEditorApiError(200, "The document service returned data in an unexpected format.");
  return parsed.data;
}

/**
 * One POST is the editor's whole tick: heartbeat me, optionally autosave my
 * draft, then tell me who else is here and whose pen it is. A 409 means
 * another writer advanced the draft, which is a state the editor shows
 * rather than an error.
 */
export async function postEditorWorkspace(
  id: string,
  payload: { content?: Record<string, unknown>; pageSettings?: PageSettings; rev?: number },
  signal?: AbortSignal,
): Promise<WorkspaceTick> {
  validateDocumentVersionInput(id);
  const { status, body } = await post(`${documentPath(id)}/workspace`, { ...payload }, signal);
  if (status !== 409 && (status < 200 || status >= 300)) throw new DocumentsEditorApiError(status, messageFor(status, body));
  const parsed = WorkspaceResponseSchema.safeParse(body);
  if (!parsed.success) throw new DocumentsEditorApiError(status, "The document workspace returned an unexpected response.");
  return {
    conflict: status === 409 || parsed.data.conflict === true,
    savedRev: parsed.data.savedRev ?? null,
    lock: parsed.data.lock ?? null,
    others: parsed.data.others ?? [],
    draft: parsed.data.draft ?? null,
  };
}

/** Release presence and the soft lock on exit. Never fails hard. */
export function releaseEditorWorkspace(id: string): void {
  if (!documentUUID.safeParse(id).success) return;
  void fetch(`${documentPath(id)}/workspace`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => undefined);
}

export function publishDocumentVersion(
  id: string,
  body: { title: string; content: Record<string, unknown>; html: string; pageSettings: PageSettings; note?: string },
  scope: DocumentsEditorRetryScope,
  signal?: AbortSignal,
): Promise<GovernedOutcome<z.infer<typeof PublishedVersionSchema>>> {
  validateDocumentVersionInput(id);
  return governedDocumentWrite("documents.saveDocVersion", { documentId: id, ...body }, PublishedVersionSchema, scope, signal);
}

export function restoreDocumentVersion(
  id: string,
  sourceVersion: number,
  scope: DocumentsEditorRetryScope,
  signal?: AbortSignal,
): Promise<GovernedOutcome<z.infer<typeof PublishedVersionSchema>>> {
  validateDocumentVersionInput(id, sourceVersion);
  return governedDocumentWrite("documents.restoreDocVersion", { documentId: id, sourceVersion }, PublishedVersionSchema, scope, signal);
}

export function updateDocumentMetadata(
  id: string,
  body: {
    title?: string;
    folder?: string | null;
    linkedRecordType?: string | null;
    linkedRecordId?: string | null;
    linkedRecordLabel?: string | null;
  },
  scope: DocumentsEditorRetryScope,
  signal?: AbortSignal,
): Promise<GovernedOutcome<z.infer<typeof MetadataUpdatedSchema>>> {
  validateDocumentVersionInput(id);
  return governedDocumentWrite("documents.updateDocMetadata", { documentId: id, ...body }, MetadataUpdatedSchema, scope, signal);
}

export function createDocumentTemplate(
  name: string,
  content: Record<string, unknown>,
  scope: DocumentsEditorRetryScope,
  signal?: AbortSignal,
): Promise<GovernedOutcome<TemplateCreated>> {
  return createDocumentTemplateInGo(name, content, scope, signal);
}

export function createAuthoredDocumentDraft(
  scope: DocumentsEditorRetryScope,
): Promise<GovernedOutcome<z.infer<typeof AuthoredDocumentCreatedSchema>>> {
  return createAuthoredDocumentDraftInGo(scope);
}

export function allocateAuthoredDocumentNumber(
  kind: AuthoredDocumentNumberKind,
  scope: DocumentsEditorRetryScope,
): Promise<GovernedOutcome<z.infer<typeof DocumentNumberSchema>>> {
  return governedDocumentWrite("documents.allocateNumber", { kind }, DocumentNumberSchema, scope);
}

const templateRetryPrefix = "chaste:documents-template:v1:";
const authoredDocumentRetryPrefix = "chaste:authored-document-create:v1:";
const documentWriteRetryPrefix = "chaste:documents-editor-write:v1:";

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function governedDocumentWrite<T>(
  capabilityId: string,
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
  retryScope: DocumentsEditorRetryScope,
  signal?: AbortSignal,
): Promise<GovernedOutcome<T>> {
  const { actorId, organizationId } = templateRetryScope(retryScope);
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) throw new DocumentsEditorApiError(0, "Document edit retry protection is unavailable in this browser.");
  const scopeHash = await digest(`${actorId}:${organizationId}`);
  const storageKey = `${documentWriteRetryPrefix}${scopeHash}:${capabilityId}:${String(input.documentId)}`;
  try {
    return await locks.request(storageKey, { mode: "exclusive" }, async () => {
      const fingerprint = await digest(JSON.stringify({ capabilityId, input }));
      let marker: z.infer<typeof DocumentWriteRetryMarkerSchema> | null;
      try { marker = parseDocumentWriteRetryMarker(window.localStorage.getItem(storageKey)); }
      catch (error) {
        if (error instanceof DocumentsEditorApiError) throw error;
        throw new DocumentsEditorApiError(0, "Document edit retry protection could not be read. Enable browser storage before continuing.");
      }
      if (marker && marker.fingerprint !== fingerprint) {
        throw new DocumentsEditorApiError(0, "A previous document edit is unresolved. Retry those exact details before changing the document again.");
      }
      marker ??= { version: 1, intentId: crypto.randomUUID(), fingerprint };
      const serialized = JSON.stringify(marker);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("document edit retry marker did not persist");
      } catch {
        throw new DocumentsEditorApiError(0, "Document edit retry protection could not be saved. Enable browser storage before continuing.");
      }

      const clearIfCurrent = (): void => {
        try {
          const current = parseDocumentWriteRetryMarker(window.localStorage.getItem(storageKey));
          if (current?.intentId === marker.intentId && current.fingerprint === marker.fingerprint) window.localStorage.removeItem(storageKey);
        } catch {
          throw new DocumentsEditorApiError(0, "The document service confirmed the result, but retry protection could not be cleared. Retry the exact action to confirm it safely.");
        }
      };

      const { status, body } = await request("/api/capabilities/execute", {
        method: "POST",
        cache: "no-store",
        headers: { "X-Organization-ID": organizationId },
        body: JSON.stringify({ capabilityId, input, intentId: marker.intentId }),
      }, signal);
      if (status === 202) {
        const pending = GoPendingApprovalSchema.safeParse(body);
        if (!pending.success) throw new DocumentsEditorApiError(status, "The Go documents service returned an unexpected approval response.");
        return { kind: "pending", hint: pendingApprovalHint(pending.data) };
      }
      if (status < 200 || status >= 300) {
        if (status >= 400 && status < 500 && ![404, 408, 425, 429].includes(status)) clearIfCurrent();
        throw new DocumentsEditorApiError(status, messageFor(status, body));
      }
      const envelope = CapabilitySuccessSchema.safeParse(body);
      const parsed = envelope.success ? schema.safeParse(envelope.data.data) : null;
      if (!parsed?.success) throw new DocumentsEditorApiError(status, "The Go documents service returned an unexpected action response.");
      clearIfCurrent();
      return { kind: "completed", data: parsed.data };
    });
  } catch (error) {
    if (error instanceof DocumentsEditorApiError) throw error;
    throw new DocumentsEditorApiError(0, "The browser could not safely coordinate this document edit across tabs. Retry the exact action after closing other Documents tabs.");
  }
}

function parseDocumentWriteRetryMarker(raw: string | null): z.infer<typeof DocumentWriteRetryMarkerSchema> | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new DocumentsEditorApiError(0, "A saved document edit retry marker is invalid. Verify the document before trying again."); }
  const parsed = DocumentWriteRetryMarkerSchema.safeParse(value);
  if (!parsed.success) throw new DocumentsEditorApiError(0, "A saved document edit retry marker is invalid. Verify the document before trying again.");
  return parsed.data;
}

function templateRetryScope(scope: DocumentsEditorRetryScope): { actorId: string; organizationId: string } {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!actorId || actorId.length > 255 || !z.string().uuid().safeParse(organizationId).success) {
    throw new DocumentsEditorApiError(0, "Wait for your account and organization to finish loading before creating or saving documents.");
  }
  return { actorId, organizationId };
}

function parseTemplateRetryMarker(raw: string | null): z.infer<typeof TemplateRetryMarkerSchema> | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new DocumentsEditorApiError(0, "A saved template retry marker is invalid. Verify the template before trying again."); }
  const parsed = TemplateRetryMarkerSchema.safeParse(value);
  if (!parsed.success) throw new DocumentsEditorApiError(0, "A saved template retry marker is invalid. Verify the template before trying again.");
  return parsed.data;
}

async function createDocumentTemplateInGo(
  name: string,
  content: Record<string, unknown>,
  scope: DocumentsEditorRetryScope,
  signal?: AbortSignal,
): Promise<GovernedOutcome<TemplateCreated>> {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 120 || !content || typeof content !== "object" || Array.isArray(content)) {
    throw new DocumentsEditorApiError(400, "Enter a valid template name and document content.");
  }
  const { actorId, organizationId } = templateRetryScope(scope);
  const locks = navigator.locks;
  if (!locks) throw new DocumentsEditorApiError(0, "Template retry protection is unavailable in this browser.");

  return locks.request(`chaste:documents-template:${actorId}:${organizationId}`, { mode: "exclusive" }, async () => {
    const fingerprint = await digest(JSON.stringify({ capabilityId: "documents.createTemplate", name: normalizedName, content }));
    const scopeHash = await digest(`${actorId}:${organizationId}`);
    const storageKey = `${templateRetryPrefix}${scopeHash}`;
    let marker: z.infer<typeof TemplateRetryMarkerSchema> | null;
    try { marker = parseTemplateRetryMarker(window.localStorage.getItem(storageKey)); }
    catch (error) { if (error instanceof DocumentsEditorApiError) throw error; throw new DocumentsEditorApiError(0, "Template retry protection could not be read. Enable browser storage before saving."); }
    if (marker && marker.fingerprint !== fingerprint) {
      throw new DocumentsEditorApiError(0, "A previous template save is unresolved. Retry its exact saved details before changing anything else.");
    }
    marker ??= { version: 1, intentId: crypto.randomUUID(), fingerprint };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(marker));
      if (parseTemplateRetryMarker(window.localStorage.getItem(storageKey))?.intentId !== marker.intentId) throw new Error("marker did not persist");
    } catch {
      throw new DocumentsEditorApiError(0, "Template retry protection could not be saved. Enable browser storage before continuing.");
    }

    const { status, body } = await request("/api/capabilities/execute", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Organization-ID": organizationId },
      body: JSON.stringify({ capabilityId: "documents.createTemplate", input: { name: normalizedName, content }, intentId: marker.intentId }),
    }, signal);
    if (status === 202) {
      const pending = GoPendingApprovalSchema.safeParse(body);
      if (!pending.success) throw new DocumentsEditorApiError(status, "The document service returned an unexpected approval response.");
      return { kind: "pending", hint: pending.data.reason };
    }
    if (status < 200 || status >= 300) {
      if (status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429) {
        try { window.localStorage.removeItem(storageKey); }
        catch { throw new DocumentsEditorApiError(0, "The template was refused, but its retry marker could not be cleared. Retry the same action after checking the template list."); }
      }
      throw new DocumentsEditorApiError(status, messageFor(status, body));
    }
    const envelope = CapabilitySuccessSchema.safeParse(body);
    const parsed = envelope.success ? TemplateCreatedSchema.safeParse(envelope.data.data) : null;
    if (!parsed?.success) throw new DocumentsEditorApiError(status, "The document service returned data in an unexpected format.");
    try { window.localStorage.removeItem(storageKey); }
    catch { throw new DocumentsEditorApiError(0, "The template was saved, but retry protection could not be cleared. Retry the same details to confirm it safely."); }
    return { kind: "completed", data: parsed.data };
  });
}

async function createAuthoredDocumentDraftInGo(
  scope: DocumentsEditorRetryScope,
): Promise<GovernedOutcome<z.infer<typeof AuthoredDocumentCreatedSchema>>> {
  const { actorId, organizationId } = templateRetryScope(scope);
  const locks = navigator.locks;
  if (!locks) throw new DocumentsEditorApiError(0, "Document creation retry protection is unavailable in this browser.");

  const input = {
    title: "Untitled document",
    content: { type: "doc", content: [{ type: "paragraph" }] },
    html: "<p></p>",
    pageSettings: DEFAULT_PAGE_SETTINGS,
  };
  return locks.request(`chaste:authored-document-create:${actorId}:${organizationId}`, { mode: "exclusive" }, async () => {
    const fingerprint = await digest(JSON.stringify({ capabilityId: "documents.createDoc", input }));
    const scopeHash = await digest(`${actorId}:${organizationId}`);
    const storageKey = `${authoredDocumentRetryPrefix}${scopeHash}`;
    let marker: z.infer<typeof TemplateRetryMarkerSchema> | null;
    try { marker = parseTemplateRetryMarker(window.localStorage.getItem(storageKey)); }
    catch (error) { if (error instanceof DocumentsEditorApiError) throw error; throw new DocumentsEditorApiError(0, "Document creation retry protection could not be read. Enable browser storage before continuing."); }
    if (marker && marker.fingerprint !== fingerprint) {
      throw new DocumentsEditorApiError(0, "A previous document creation is unresolved. Retry it or check the document list before creating another.");
    }
    marker ??= { version: 1, intentId: crypto.randomUUID(), fingerprint };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(marker));
      if (parseTemplateRetryMarker(window.localStorage.getItem(storageKey))?.intentId !== marker.intentId) throw new Error("marker did not persist");
    } catch {
      throw new DocumentsEditorApiError(0, "Document creation retry protection could not be saved. Enable browser storage before continuing.");
    }

    const { status, body } = await request("/api/capabilities/execute", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Organization-ID": organizationId },
      body: JSON.stringify({ capabilityId: "documents.createDoc", input, intentId: marker.intentId }),
    });
    if (status === 202) {
      const pending = GoPendingApprovalSchema.safeParse(body);
      if (!pending.success) throw new DocumentsEditorApiError(status, "The document service returned an unexpected approval response.");
      return { kind: "pending", hint: pending.data.reason };
    }
    if (status < 200 || status >= 300) {
      if (status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429) {
        try { window.localStorage.removeItem(storageKey); }
        catch { throw new DocumentsEditorApiError(0, "Document creation was refused, but its retry marker could not be cleared. Check the document list before retrying."); }
      }
      throw new DocumentsEditorApiError(status, messageFor(status, body));
    }
    const envelope = CapabilitySuccessSchema.safeParse(body);
    const parsed = envelope.success ? AuthoredDocumentCreatedSchema.safeParse(envelope.data.data) : null;
    if (!parsed?.success) throw new DocumentsEditorApiError(status, "The document service returned data in an unexpected format.");
    try { window.localStorage.removeItem(storageKey); }
    catch { throw new DocumentsEditorApiError(0, "The document was created, but retry protection could not be cleared. Retry the same action to confirm it safely."); }
    return { kind: "completed", data: parsed.data };
  });
}

export function requestAssist(body: DocumentsAssistTextRequest, signal?: AbortSignal): Promise<AssistText>;
export function requestAssist(body: DocumentsAssistPrefillRequest, signal?: AbortSignal): Promise<AssistPrefill>;
export async function requestAssist(body: DocumentsAssistRequest, signal?: AbortSignal): Promise<DocumentsAssistResult> {
  const { status, body: raw } = await request("/api/docs/assist", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(body),
  }, signal, 65_000);
  if (status < 200 || status >= 300) throw new DocumentsEditorApiError(status, messageFor(status, raw));
  const prefill = AssistPrefillSchema.safeParse(raw);
  if (prefill.success) return prefill.data;
  const parsed = AssistTextSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.text.trim()) throw new DocumentsEditorApiError(status, "The writing assistant could not help with that, try again.");
  return parsed.data;
}

/** Route match for the dynamic editor path: `/documents/editor/<id>`. */
export function documentsEditorIdFromPath(pathname: string): string | null {
  const prefix = "/documents/editor/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/\/+$/, "");
  if (!rest || rest.includes("/")) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

// ── document content ──────────────────────────────────────────────────────

interface ContentNode {
  type: string;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
  content?: ContentNode[];
}

function asNode(value: unknown): ContentNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as ContentNode;
  return typeof candidate.type === "string" ? candidate : null;
}

function childrenOf(node: ContentNode): ContentNode[] {
  return (Array.isArray(node.content) ? node.content : []).map(asNode).filter((child): child is ContentNode => child !== null);
}

const SAFE_LINK = /^(https?:\/\/|mailto:|tel:|\/|#)/i;
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

// A fixed nesting order keeps the html stable across a round trip through the
// editor, whichever order the marks arrived in.
const MARK_ORDER = ["code", "bold", "italic", "underline", "strike", "link"] as const;

function orderedMarks(marks: ContentNode["marks"]): NonNullable<ContentNode["marks"]> {
  const list = Array.isArray(marks) ? [...marks] : [];
  return list.sort((a, b) => MARK_ORDER.indexOf(a.type as typeof MARK_ORDER[number]) - MARK_ORDER.indexOf(b.type as typeof MARK_ORDER[number]));
}

function linkOf(mark: ContentNode): string | null {
  const href = mark.attrs?.href;
  return typeof href === "string" && SAFE_LINK.test(href.trim()) ? href.trim() : null;
}

function imageOf(node: ContentNode): string | null {
  const src = node.attrs?.src;
  return typeof src === "string" && SAFE_IMAGE.test(src) ? src : null;
}

function renderInline(node: ContentNode): string {
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "image") {
    const src = imageOf(node);
    if (!src) return "";
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    return `<img alt="${escapeAttribute(alt)}" src="${escapeAttribute(src)}">`;
  }
  if (node.type !== "text") return childrenOf(node).map(renderInline).join("");
  let html = escapeText(node.text ?? "");
  for (const mark of orderedMarks(node.marks)) {
    if (mark.type === "bold") html = `<strong>${html}</strong>`;
    else if (mark.type === "italic") html = `<em>${html}</em>`;
    else if (mark.type === "underline") html = `<u>${html}</u>`;
    else if (mark.type === "strike") html = `<s>${html}</s>`;
    else if (mark.type === "code") html = `<code>${html}</code>`;
    else if (mark.type === "link") {
      const href = linkOf(mark);
      if (href) html = `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
    }
  }
  return html;
}

function plainTextOf(node: ContentNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return childrenOf(node).map(plainTextOf).join(node.type === "paragraph" || node.type === "heading" ? "" : "");
}

function renderTableCell(cell: ContentNode): string {
  const tag = cell.type === "tableHeader" ? "th" : "td";
  const content = childrenOf(cell)
    .map((child) => (child.type === "paragraph" || child.type === "heading" ? renderInline(child) : renderBlock(child)))
    .join("");
  return `<${tag}>${content || "<br>"}</${tag}>`;
}

function renderBlock(node: ContentNode): string {
  switch (node.type) {
    case "paragraph": {
      const content = childrenOf(node).map(renderInline).join("");
      return `<p>${content || "<br>"}</p>`;
    }
    case "heading": {
      const raw = Number(node.attrs?.level ?? 2);
      const level = Number.isFinite(raw) ? Math.min(3, Math.max(1, Math.round(raw))) : 2;
      return `<h${level}>${childrenOf(node).map(renderInline).join("")}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${childrenOf(node).map(renderBlock).join("")}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${escapeText(plainTextOf(node))}</code></pre>`;
    case "bulletList":
    case "orderedList": {
      const tag = node.type === "orderedList" ? "ol" : "ul";
      return `<${tag}>${childrenOf(node).map(renderBlock).join("")}</${tag}>`;
    }
    case "listItem":
      return `<li>${childrenOf(node).map(renderBlock).join("")}</li>`;
    case "horizontalRule":
      return "<hr>";
    case "table": {
      const rows = childrenOf(node);
      // A first row of header cells becomes a real thead, which is what makes
      // the header row survive an edit round trip.
      const first = rows[0];
      const headerRow = first && first.type === "tableRow" && childrenOf(first).length > 0
        && childrenOf(first).every((cell) => cell.type === "tableHeader");
      const body = rows.slice(headerRow ? 1 : 0).map(renderBlock).join("");
      const head = headerRow ? `<thead>${renderBlock(first!)}</thead>` : "";
      return `<table>${head}<tbody>${body}</tbody></table>`;
    }
    case "tableRow": {
      const cells = childrenOf(node).map(renderBlock).join("");
      return `<tr>${cells}</tr>`;
    }
    case "tableCell":
    case "tableHeader":
      return renderTableCell(node);
    case "text":
    case "hardBreak":
    case "image":
      return renderInline(node);
    default:
      return childrenOf(node).map(renderBlock).join("");
  }
}

/** Serializes the editor's JSON tree to allowlisted HTML. Unknown nodes keep their children. */
export function documentJsonToHtml(content: unknown): string {
  const doc = asNode(content);
  if (!doc) return "";
  if (doc.type === "doc") return childrenOf(doc).map(renderBlock).join("");
  return renderBlock(doc);
}

const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "img", "li", "mark", "ol", "p", "pre", "s", "small", "span", "strike", "strong", "sub",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);
const DROPPED_TAGS = new Set([
  "applet", "audio", "base", "button", "canvas", "embed", "form", "frame", "frameset", "iframe", "input", "link",
  "math", "meta", "noscript", "object", "option", "portal", "script", "select", "slot", "source", "style", "svg",
  "template", "textarea", "track", "video",
]);
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["alt", "src", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};
const BLOCK_TAGS = new Set(["address", "article", "aside", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "header", "main", "nav", "section"]);

function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function scrub(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue;
    if (child.nodeType !== 1) {
      node.removeChild(child);
      continue;
    }
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROPPED_TAGS.has(tag)) {
      node.removeChild(element);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      unwrap(element);
      continue;
    }
    const allowed = ALLOWED_ATTRIBUTES[tag];
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const safeUrl = name === "href" ? SAFE_LINK.test(value) : name === "src" ? SAFE_IMAGE.test(value) : true;
      if (!allowed?.has(name) || !safeUrl) element.removeAttribute(attribute.name);
    }
    if (tag === "img" && !element.getAttribute("src")) {
      node.removeChild(element);
      continue;
    }
    scrub(element);
  }
}

/**
 * Allowlist pass over stored or pasted HTML: keeps the document vocabulary,
 * drops active content entirely, unwraps unknown elements and strips every
 * attribute outside the allowlist (which removes inline styles and all event
 * handlers). DOMParser documents have no browsing context, so nothing loads
 * while this runs.
 */
export function sanitizeDocumentHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  scrub(parsed.body);
  return parsed.body.innerHTML;
}

const INLINE_TAGS = new Set(["a", "b", "br", "code", "del", "em", "i", "img", "s", "span", "strike", "strong", "sub", "sup", "u"]);

function marksFor(element: Element, marks: ContentNode["marks"]): ContentNode["marks"] {
  const tag = element.tagName.toLowerCase();
  let next = marks;
  if (tag === "strong" || tag === "b") next = [...(marks ?? []), { type: "bold" }];
  else if (tag === "em" || tag === "i") next = [...(marks ?? []), { type: "italic" }];
  else if (tag === "u") next = [...(marks ?? []), { type: "underline" }];
  else if (tag === "s" || tag === "strike" || tag === "del") next = [...(marks ?? []), { type: "strike" }];
  else if (tag === "code") next = [...(marks ?? []), { type: "code" }];
  else if (tag === "a") {
    const href = (element.getAttribute("href") ?? "").trim();
    if (SAFE_LINK.test(href)) next = [...(marks ?? []), { type: "link", attrs: { href } }];
  }
  return next;
}

function inlineFrom(nodes: Iterable<Node>, marks: ContentNode["marks"] = []): ContentNode[] {
  const out: ContentNode[] = [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      if (text) out.push(marks && marks.length > 0 ? { type: "text", text, marks: [...marks] } : { type: "text", text });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      out.push({ type: "hardBreak" });
      continue;
    }
    if (tag === "img") {
      const src = (element.getAttribute("src") ?? "").trim();
      if (SAFE_IMAGE.test(src)) {
        out.push({ type: "image", attrs: { src, alt: element.getAttribute("alt") ?? null, title: element.getAttribute("title") ?? null } });
      }
      continue;
    }
    out.push(...inlineFrom(Array.from(element.childNodes), marksFor(element, marks)));
  }
  return out;
}

function paragraphOf(content: ContentNode[]): ContentNode | null {
  if (content.length === 0) return null;
  return { type: "paragraph", content };
}

function tableFrom(element: Element): ContentNode {
  const rows = Array.from(element.querySelectorAll("tr"))
    .map((row) => ({
      type: "tableRow",
      content: Array.from(row.children)
        .filter((cell) => ["td", "th"].includes(cell.tagName.toLowerCase()))
        .map((cell) => ({
          type: cell.tagName.toLowerCase() === "th" ? "tableHeader" : "tableCell",
          content: blocksFrom(cell).map((block) => (block.type === "paragraph" ? block : { type: "paragraph", content: block.content ? [block] : [] })),
        })),
    }))
    .filter((row) => row.content.length > 0);
  return { type: "table", content: rows };
}

function blocksFrom(parent: Element): ContentNode[] {
  const blocks: ContentNode[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    const paragraph = paragraphOf(inlineFrom(run));
    if (paragraph) blocks.push(paragraph);
    run = [];
  };
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3) {
      if ((child.nodeValue ?? "").trim()) run.push(child);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      run.push(element);
      continue;
    }
    if (tag === "img") {
      run.push(element);
      continue;
    }
    if (INLINE_TAGS.has(tag)) {
      run.push(element);
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(tag)) blocks.push({ type: "heading", attrs: { level: Number(tag.slice(1)) }, content: inlineFrom(element.childNodes) });
    else if (tag === "p") blocks.push({ type: "paragraph", content: inlineFrom(element.childNodes) });
    else if (tag === "blockquote") blocks.push({ type: "blockquote", content: blocksFrom(element) });
    else if (tag === "pre") blocks.push({ type: "codeBlock", content: [{ type: "text", text: element.textContent ?? "" }] });
    else if (tag === "ul" || tag === "ol") {
      const items = Array.from(element.children)
        .filter((item) => item.tagName.toLowerCase() === "li")
        .map((item) => ({ type: "listItem", content: blocksFrom(item) }));
      if (items.length > 0) blocks.push({ type: tag === "ol" ? "orderedList" : "bulletList", content: items });
    } else if (tag === "hr") blocks.push({ type: "horizontalRule" });
    else if (tag === "table") blocks.push(tableFrom(element));
    else if (tag === "li") blocks.push({ type: "listItem", content: blocksFrom(element) });
    else if (BLOCK_TAGS.has(tag)) {
      const nested = blocksFrom(element);
      if (nested.length > 0) blocks.push(...nested);
    } else {
      const inline = paragraphOf(inlineFrom(element.childNodes));
      if (inline) blocks.push(inline);
    }
  }
  flush();
  return blocks;
}

/** Parses allowlisted HTML back into the editor's JSON tree. */
export function documentHtmlToJson(html: string): Record<string, unknown> {
  if (!html || typeof DOMParser === "undefined") return { type: "doc", content: [] };
  const parsed = new DOMParser().parseFromString(sanitizeDocumentHtml(html), "text/html");
  return { type: "doc", content: blocksFrom(parsed.body) };
}

/** Plain text of the editor tree, for the assist prompt and the print copy. */
export function documentPlainText(content: unknown): string {
  const doc = asNode(content);
  if (!doc) return "";
  return childrenOf(doc).map(plainTextOf).join("\n").trim();
}

const NUMERIC_HEADER = /\b(qty|quantity|no\.?|rate|price|amount|line total|total|fee|debit|credit|net|tax|gross|ordered|delivered|outstanding|completion|claim|balance|value|applied|due)\b/i;
const TOTALS_TEXT = /\b(sub\s?total|total|balance|amount due|amount to pay|amount payable|amount received)\b/i;

function numericAligns(headers: string[]): boolean[] {
  return headers.map((header) => NUMERIC_HEADER.test(header.trim()));
}

/**
 * Preview and print share one refinement pass: the first table row becomes a
 * header row, numeric columns align right, and a headerless table is read as
 * layout (letterhead, parties, totals) rather than data.
 */
export function refineDocumentHtml(html: string): string {
  const safe = sanitizeDocumentHtml(html);
  if (!safe || typeof DOMParser === "undefined") return safe;
  const parsed = new DOMParser().parseFromString(safe, "text/html");
  const tables = Array.from(parsed.body.querySelectorAll("table"));
  tables.forEach((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll("tr"));
    const firstRow = rows[0];
    if (!firstRow) return;
    const headerCells = Array.from(firstRow.querySelectorAll("th"));
    if (headerCells.length > 0) {
      table.classList.add("doc-table");
      if (!table.querySelector("thead")) {
        const head = parsed.createElement("thead");
        head.append(firstRow);
        table.insertBefore(head, table.firstChild);
      }
      const aligns = numericAligns(headerCells.map((cell) => cell.textContent ?? ""));
      headerCells.forEach((cell, index) => {
        if (aligns[index]) cell.classList.add("num");
      });
      rows.slice(1).forEach((row) => {
        Array.from(row.querySelectorAll("td")).forEach((cell, index) => {
          if (aligns[index]) cell.classList.add("num");
        });
      });
    } else {
      table.classList.add("doc-grid");
      const gridText = Array.from(table.querySelectorAll("td,th")).map((cell) => cell.textContent ?? "").join(" ");
      if (TOTALS_TEXT.test(gridText)) table.classList.add("doc-totals");
      if (tableIndex === 0) table.classList.add("doc-letterhead");
    }
  });
  parsed.body.querySelectorAll("p").forEach((paragraph) => {
    const text = (paragraph.textContent ?? "").trim();
    if (text.length >= 2 && text.length <= 48 && /[A-Z]/.test(text) && text === text.toUpperCase()) paragraph.classList.add("doc-eyebrow");
  });
  return parsed.body.innerHTML;
}

// ── .docx export ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Stored (uncompressed) zip, which is what a .docx needs and no more. */
function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, file.data);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(8, 0x0800, true);
    entryView.setUint16(10, 0, true);
    entryView.setUint16(12, 0, true);
    entryView.setUint16(14, 0x0021, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, file.data.length, true);
    entryView.setUint32(24, file.data.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint16(30, 0, true);
    entryView.setUint16(32, 0, true);
    entryView.setUint16(34, 0, true);
    entryView.setUint16(36, 0, true);
    entryView.setUint32(38, 0, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);
    directory.push(entry);
    offset += local.length + file.data.length;
  }
  const centralSize = directory.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  parts.push(...directory, end);

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function docxRuns(node: ContentNode): string {
  const out: string[] = [];
  for (const child of childrenOf(node)) {
    if (child.type === "hardBreak") {
      out.push("<w:r><w:br/></w:r>");
      continue;
    }
    if (child.type !== "text") {
      out.push(docxRuns(child));
      continue;
    }
    const marks = new Set((child.marks ?? []).map((mark) => mark.type));
    const properties = [
      marks.has("bold") ? "<w:b/>" : "",
      marks.has("italic") ? "<w:i/>" : "",
      marks.has("strike") ? "<w:strike/>" : "",
      marks.has("underline") ? '<w:u w:val="single"/>' : "",
      marks.has("code") ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : "",
    ].join("");
    const propertiesXml = properties ? `<w:rPr>${properties}</w:rPr>` : "";
    const text = child.text ?? "";
    out.push(`<w:r>${propertiesXml}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`);
  }
  return out.join("");
}

function docxParagraph(node: ContentNode, style: string | null, extraProperties = ""): string {
  const properties = [style ? `<w:pStyle w:val="${style}"/>` : "", extraProperties].filter(Boolean).join("");
  const propertiesXml = properties ? `<w:pPr>${properties}</w:pPr>` : "";
  return `<w:p>${propertiesXml}${docxRuns(node)}</w:p>`;
}

function docxListItem(node: ContentNode, numId: number): string {
  const blocks = childrenOf(node);
  const first = blocks[0];
  if (!first) return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr></w:p>`;
  return docxParagraph(first, null, `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);
}

function docxTable(node: ContentNode): string {
  const cells = (row: ContentNode): string => {
    const parts = childrenOf(row).map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2500" w:type="pct"/></w:tcPr>${childrenOf(cell).map((block) => docxParagraph(block, null)).join("") || "<w:p/>"}</w:tc>`);
    return `<w:tr>${parts.join("")}</w:tr>`;
  };
  const rows = childrenOf(node).map(cells).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${rows}</w:tbl>`;
}

function docxBlocks(node: ContentNode): string {
  const out: string[] = [];
  for (const child of childrenOf(node)) {
    if (child.type === "paragraph") out.push(docxParagraph(child, null));
    else if (child.type === "heading") {
      const raw = Number(child.attrs?.level ?? 1);
      const level = Number.isFinite(raw) ? Math.min(3, Math.max(1, Math.round(raw))) : 1;
      out.push(docxParagraph(child, `Heading${level}`));
    } else if (child.type === "blockquote") {
      out.push(docxParagraph(child, null, '<w:ind w:left="720"/><w:spacing w:before="120" w:after="120"/>'));
    } else if (child.type === "codeBlock") {
      out.push(docxParagraph(child, null, '<w:shd w:val="clear" w:fill="F5F5F4"/>'));
    } else if (child.type === "bulletList" || child.type === "orderedList") {
      const numId = child.type === "orderedList" ? 2 : 1;
      for (const item of childrenOf(child)) out.push(docxListItem(item, numId));
    } else if (child.type === "horizontalRule") {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D6D3D1"/></w:pBdr><w:spacing w:after="200"/></w:pPr></w:p>');
    } else if (child.type === "table") out.push(docxTable(child));
    else out.push(docxBlocks(child));
  }
  return out.join("");
}

const DOCX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
  + "</Types>";

const DOCX_ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + "</Relationships>";

const DOCX_DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
  + "</Relationships>";

function docxStyles(): string {
  const heading = (id: string, size: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>'
    + heading("Heading1", 34)
    + heading("Heading2", 28)
    + heading("Heading3", 24)
    + "</w:styles>";
}

function docxNumbering(): string {
  const level = (format: string, text: string, font: string): string =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr></w:lvl>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:abstractNum w:abstractNumId="0">${level("bullet", "•", "Symbol")}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1">${level("decimal", "%1.", "Calibri")}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
    + "</w:numbering>";
}

/**
 * Builds the .docx bytes for the editor tree: headings, paragraphs with the
 * bold/italic/underline/strike/code runs, bullet and numbered lists, quotes,
 * code blocks, horizontal rules and tables. Images are omitted, as in the
 * legacy exporter.
 */
export function buildDocxBytes(title: string, content: unknown): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const heading = `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p>`;
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + heading
    + docxBlocks(asNode(content) ?? { type: "doc", content: [] })
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';
  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(DOCX_CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(DOCX_ROOT_RELS) },
    { name: "word/_rels/document.xml.rels", data: encoder.encode(DOCX_DOCUMENT_RELS) },
    { name: "word/styles.xml", data: encoder.encode(docxStyles()) },
    { name: "word/numbering.xml", data: encoder.encode(docxNumbering()) },
    { name: "word/document.xml", data: encoder.encode(documentXml) },
  ]);
}

export function docxFileName(title: string): string {
  return `${title.replace(/[^\w\s-]/g, "").trim() || "document"}.docx`;
}

export function downloadDocx(title: string, content: unknown): void {
  const blob = new Blob([buildDocxBytes(title, content)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = docxFileName(title);
  anchor.click();
  URL.revokeObjectURL(href);
}
