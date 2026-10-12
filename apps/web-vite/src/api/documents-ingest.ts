import { z } from "zod";

export type DocumentsIngestScope = { actorId: string | null; organizationId: string | null };
export type DocumentsIngestInput =
  | { title: string; folder?: string; text: string }
  | { title: string; folder?: string; file: File };

const MAX_TEXT_LENGTH = 100_000;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 255;
const CapabilitySuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const PendingApprovalSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().min(1),
  approvalId: z.string().uuid().optional(),
}).strict();
const IngestedDocumentCreatedSchema = z.object({ documentId: z.string().uuid() }).strict();
const RetryMarkerSchema = z.object({ version: z.literal(1), intentId: z.string().uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
const retryPrefix = "chaste:documents-ingest:v1:";

export type DocumentsIngestOutcome =
  | { kind: "completed"; documentId: string }
  | { kind: "pending"; hint: string };

export class DocumentsIngestApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DocumentsIngestApiError";
  }
}

function scopeValues(scope: DocumentsIngestScope): { actorId: string; organizationId: string } {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  // eslint-disable-next-line no-control-regex -- Control characters must not enter retry storage scope keys.
  if (!actorId || !organizationId || actorId.length > 255 || organizationId.length > 255 || /[\u0000-\u001f\u007f]/u.test(actorId + organizationId)) {
    throw new DocumentsIngestApiError(0, "Wait for your account and organization to finish loading before adding a document.");
  }
  return { actorId, organizationId };
}

function requestSignal(): AbortSignal {
  return AbortSignal.timeout(30_000);
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readMarker(raw: string | null): z.infer<typeof RetryMarkerSchema> | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new DocumentsIngestApiError(0, "A saved document retry marker is invalid. Verify the document list before trying again."); }
  const parsed = RetryMarkerSchema.safeParse(value);
  if (!parsed.success) throw new DocumentsIngestApiError(0, "A saved document retry marker is invalid. Verify the document list before trying again.");
  return parsed.data;
}

function base64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function payloadFor(input: DocumentsIngestInput): Promise<Record<string, string>> {
  const title = input.title.trim();
  if (!title || title.length > 200) throw new DocumentsIngestApiError(400, "Enter a document title between 1 and 200 characters.");
  const folder = input.folder?.trim();
  if (folder && folder.length > 300) throw new DocumentsIngestApiError(400, "Keep the folder name under 300 characters.");
  const payload: Record<string, string> = { title };
  if (folder) payload.folder = folder;

  if ("text" in input) {
    if (!input.text.trim()) throw new DocumentsIngestApiError(400, "Enter some text before adding the document.");
    if (input.text.length > MAX_TEXT_LENGTH) throw new DocumentsIngestApiError(400, "Keep document text under 100,000 characters.");
    payload.text = input.text;
    return payload;
  }

  const file = input.file;
  if (!(file instanceof File) || file.size < 1) throw new DocumentsIngestApiError(400, "Choose a non-empty PDF or image file.");
  if (file.size > MAX_UPLOAD_BYTES) throw new DocumentsIngestApiError(400, "That file is larger than 5 MB. Compress it and try again.");
  if (file.name.length > MAX_FILE_NAME_LENGTH) throw new DocumentsIngestApiError(400, "The file name is too long.");
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType !== "application/pdf" && !mimeType.startsWith("image/")) {
    throw new DocumentsIngestApiError(400, "Choose a PDF or image file.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new DocumentsIngestApiError(400, "The selected file could not be read safely. Choose it again and retry.");
  }
  payload.fileBase64 = base64(bytes);
  payload.mimeType = mimeType;
  return payload;
}

function messageFor(status: number, body: unknown): string {
  const text = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error.trim()
    : "";
  if (status === 401) return "Sign in again before adding a document.";
  if (status === 403) return "You do not have permission to add documents to this workspace.";
  if (status === 413 || /5 ?mb|file exceeds/i.test(text)) return "That file is larger than 5 MB. Compress it and try again.";
  if (text && text.length <= 160 && !/[{}<>]/u.test(text)) return text;
  if (status >= 500) return "The documents service is unavailable. Try again in a moment.";
  return "The document could not be added.";
}

export async function createIngestedDocument(input: DocumentsIngestInput, scope: DocumentsIngestScope): Promise<DocumentsIngestOutcome> {
  const { actorId, organizationId } = scopeValues(scope);
  const bodyInput = await payloadFor(input);
  const locks = navigator.locks;
  if (!locks) throw new DocumentsIngestApiError(0, "Document retry protection is unavailable in this browser.");

  return locks.request(`chaste:documents-ingest:${actorId}:${organizationId}`, { mode: "exclusive" }, async () => {
    const fingerprint = await digest(JSON.stringify({ capabilityId: "documents.createDocument", input: bodyInput }));
    const scopeHash = await digest(`${actorId}:${organizationId}`);
    const storageKey = `${retryPrefix}${scopeHash}`;
    let marker: z.infer<typeof RetryMarkerSchema> | null;
    try { marker = readMarker(window.localStorage.getItem(storageKey)); }
    catch (error) { if (error instanceof DocumentsIngestApiError) throw error; throw new DocumentsIngestApiError(0, "Document retry protection could not be read. Enable browser storage before continuing."); }
    if (marker && marker.fingerprint !== fingerprint) {
      throw new DocumentsIngestApiError(0, "A previous document addition is unresolved. Retry those exact details or check the document list before continuing.");
    }
    marker ??= { version: 1, intentId: crypto.randomUUID(), fingerprint };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(marker));
      if (readMarker(window.localStorage.getItem(storageKey))?.intentId !== marker.intentId) throw new Error("retry marker did not persist");
    } catch {
      throw new DocumentsIngestApiError(0, "Document retry protection could not be saved. Enable browser storage before continuing.");
    }

    let response: Response;
    let resultBody: unknown;
    try {
      response = await fetch("/api/capabilities/execute", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ capabilityId: "documents.createDocument", input: bodyInput, intentId: marker.intentId }),
        signal: requestSignal(),
      });
      resultBody = await response.json();
    } catch {
      throw new DocumentsIngestApiError(0, "The documents service did not confirm the result. Retry the same details to avoid a duplicate.");
    }
    if (response.status === 202) {
      const pending = PendingApprovalSchema.safeParse(resultBody);
      if (!pending.success) throw new DocumentsIngestApiError(202, "The documents service returned an unexpected approval response.");
      return { kind: "pending", hint: pending.data.reason };
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && ![404, 408, 425, 429].includes(response.status)) {
        try { window.localStorage.removeItem(storageKey); }
        catch { throw new DocumentsIngestApiError(0, "The document was refused, but retry protection could not be cleared. Check the list before retrying."); }
      }
      throw new DocumentsIngestApiError(response.status, messageFor(response.status, resultBody));
    }
    const envelope = CapabilitySuccessSchema.safeParse(resultBody);
    const created = envelope.success ? IngestedDocumentCreatedSchema.safeParse(envelope.data.data) : null;
    if (!created?.success) throw new DocumentsIngestApiError(response.status, "The documents service returned an unexpected result.");
    try { window.localStorage.removeItem(storageKey); }
    catch { throw new DocumentsIngestApiError(0, "The document was added, but retry protection could not be cleared. Retry the same details to confirm it safely."); }
    return { kind: "completed", documentId: created.data.documentId };
  });
}
