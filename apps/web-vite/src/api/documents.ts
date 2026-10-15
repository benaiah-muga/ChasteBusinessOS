import { z } from "zod";

const SafeIntegerSchema = z.number().int().refine(Number.isSafeInteger);

const DocumentRowSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.string().min(1),
  sourceType: z.string().min(1),
  createdAt: z.string().datetime(),
  folder: z.string().nullable(),
});

const CapabilitySuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const DocumentCodingSuggestionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  documentId: z.string().uuid(),
  description: z.string(),
  quantityThousandths: SafeIntegerSchema.nonnegative(),
  unitPriceMinor: SafeIntegerSchema.nonnegative(),
  suggestedAccountCode: z.string().min(1),
  matchScore: SafeIntegerSchema,
  matchedOn: z.array(z.string()),
  status: z.string().min(1),
  createdAt: z.string().datetime(),
}).strict();
const GoDocumentListOutputSchema = z.object({
  documents: z.array(DocumentRowSchema.extend({ id: z.string().uuid() }).strict()).default([]),
  vendors: z.array(z.object({ id: z.string(), name: z.string() }).strict()).default([]),
}).strict();
const GoDocumentDetailOutputSchema = z.object({
  document: z.object({
    id: z.string().uuid(),
    title: z.string(),
    status: z.string().min(1),
    sourceType: z.string().min(1),
    mimeType: z.string().nullable(),
    sizeBytes: SafeIntegerSchema.nonnegative().nullable(),
    parseError: z.string().nullable(),
    parsedMarkdown: z.string().nullable(),
    createdAt: z.string().datetime(),
    folder: z.string().nullable(),
    suggestions: z.array(DocumentCodingSuggestionSchema).default([]),
  }).strict(),
}).strict();
const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string(),
    href: z.string().nullable(),
    protected: z.boolean().optional(),
  }).strict()),
  enabledModules: z.array(z.string().min(1)),
  usingDefaults: z.boolean(),
}).strict();

const ErrorResponseSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type DocumentRow = z.infer<typeof DocumentRowSchema>;
export type DocumentDetail = z.infer<typeof GoDocumentDetailOutputSchema>["document"];

export class DocumentsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DocumentsApiError";
  }
}

export async function fetchDocumentsEnabled(signal?: AbortSignal): Promise<boolean> {
  const body = await getJson("/api/modules", signal);
  const parsed = ModuleSwitchboardSchema.safeParse(body);
  if (!parsed.success) throw new DocumentsApiError(200, "The module switchboard returned an unexpected response.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("documents") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new DocumentsApiError(200, "The module switchboard returned an invalid Documents configuration.");
  }
  return parsed.data.enabledModules.includes("documents");
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch {
    if (signal?.aborted) throw new DocumentsApiError(0, "The document request was cancelled.");
    throw new DocumentsApiError(0, "Could not reach the documents service. Check your connection and try again.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DocumentsApiError(response.status, "The documents service returned an unreadable response.");
  }

  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(body);
    const message = response.status === 401
      ? "Sign in again to view your documents."
      : response.status === 403
        ? "You do not have permission to view these documents."
        : parsed.success
          ? parsed.data.error ?? parsed.data.message ?? "The documents request failed."
          : "The documents request failed.";
    throw new DocumentsApiError(response.status, message);
  }
  return body;
}

async function executeGoDocumentRead(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId: "documents.listIngestedDocuments",
        input,
        intentId: crypto.randomUUID(),
      }),
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch {
    if (signal?.aborted) throw new DocumentsApiError(0, "The document request was cancelled.");
    throw new DocumentsApiError(0, "Could not reach the Go documents service. Check your connection and try again.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DocumentsApiError(response.status, "The Go documents service returned an unreadable response.");
  }

  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(body);
    const message = response.status === 401
      ? "Sign in again to view your documents."
      : response.status === 403
        ? "You do not have permission to view these documents."
        : parsed.success
          ? parsed.data.error ?? parsed.data.message ?? "The Go documents request failed."
          : "The Go documents request failed.";
    throw new DocumentsApiError(response.status, message);
  }
  if (response.status !== 200) {
    throw new DocumentsApiError(response.status, "The Go documents service returned an unexpected response.");
  }
  const parsed = CapabilitySuccessSchema.safeParse(body);
  if (!parsed.success) {
    throw new DocumentsApiError(response.status, "The Go documents service returned an unexpected response.");
  }
  return parsed.data.data;
}

export async function fetchDocuments(signal?: AbortSignal): Promise<DocumentRow[]> {
  const body = await executeGoDocumentRead({}, signal);
  const parsed = GoDocumentListOutputSchema.safeParse(body);
  if (!parsed.success) {
    throw new DocumentsApiError(200, "The Go documents service returned data in an unexpected format.");
  }
  return parsed.data.documents;
}

export async function fetchDocumentDetail(id: string, signal?: AbortSignal): Promise<DocumentDetail> {
  if (!z.string().uuid().safeParse(id).success) {
    throw new DocumentsApiError(400, "The selected document has an invalid ID.");
  }
  const body = await executeGoDocumentRead({ id }, signal);
  const parsed = GoDocumentDetailOutputSchema.safeParse(body);
  if (!parsed.success) {
    throw new DocumentsApiError(200, "The Go documents service returned data in an unexpected format.");
  }
  return parsed.data.document;
}
