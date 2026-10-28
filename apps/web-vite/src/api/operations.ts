import { z } from "zod";

const RecordSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["objective", "exception", "decision"]),
  stableKey: z.string().min(1),
  status: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  details: z.unknown(),
  revision: z.number().int().positive(),
  authorityRef: z.string().nullable(),
  approvalId: z.string().uuid().nullable(),
  ownerUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
}).strict();

const ListOutputSchema = z.object({ records: z.array(RecordSchema) }).strict();
const EnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const ErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });
const PendingSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string().optional() }).strict();

export type OperationalRecord = z.infer<typeof RecordSchema>;
export type ExceptionDetails = Record<string, unknown>;
export type ExceptionWrite = {
  stableKey: string;
  status: "open" | "acknowledged" | "resolved";
  title: string;
  summary: string;
  details: ExceptionDetails;
  ownerUserId?: string;
};
export type OperationsScope = { actorId: string | null; organizationId: string | null };
export type ExceptionWriteOutcome = { kind: "completed"; record: OperationalRecord } | { kind: "pending"; reason: string };

export class OperationsApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "OperationsApiError";
  }
}

const MARKER_PREFIX = "chaste:operations-exception-attempt:v1:";

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function scopeFingerprint(scope: OperationsScope): string {
  const actor = scope.actorId?.trim() ?? "";
  const org = scope.organizationId?.trim() ?? "";
  if (!actor || !org) throw new OperationsApiError(0, "Sign in to the active workspace before changing an exception.");
  return JSON.stringify([actor, org]);
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function markerKey(scope: OperationsScope, stableKey: string, status: string): string {
  return `${MARKER_PREFIX}${encodeURIComponent(scopeFingerprint(scope))}:${encodeURIComponent(stableKey)}:${status}`;
}

type Marker = { intentId: string; fingerprint: string };

function readMarker(key: string): Marker | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = z.object({ intentId: z.string().uuid(), fingerprint: z.string().length(64) }).strict().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeMarker(key: string, marker: Marker): void {
  try { localStorage.setItem(key, JSON.stringify(marker)); } catch { /* A blocked store only weakens retry reuse; the stable key keeps the record unique. */ }
}

function clearMarker(key: string): void {
  try { localStorage.removeItem(key); } catch { /* Nothing to clear. */ }
}

async function execute(capabilityId: string, input: unknown, signal?: AbortSignal, intentId?: string): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(intentId ? { capabilityId, input, intentId } : { capabilityId, input }),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new OperationsApiError(0, "Could not reach the operations service. Check your connection and try again.", true);
  }
  return { status: response.status, body: await response.json().catch(() => null) };
}

function errorMessage(status: number, body: unknown): string {
  const parsed = ErrorSchema.safeParse(body);
  const message = parsed.success ? parsed.data.message ?? parsed.data.error : undefined;
  if (message?.trim()) return message;
  if (status === 401) return "Your session has expired. Sign in again to update this exception.";
  if (status === 403) return "Your account cannot change this exception.";
  return "The exception could not be saved. Try again.";
}

export async function fetchExceptions(signal?: AbortSignal): Promise<OperationalRecord[]> {
  const { status, body } = await execute("operations.listRecords", { kind: "exception", limit: 100 }, signal);
  if (status !== 200) throw new OperationsApiError(status, errorMessage(status, body));
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new OperationsApiError(status, "The operations service returned an unexpected response.");
  const parsed = ListOutputSchema.safeParse(envelope.data.data);
  if (!parsed.success) throw new OperationsApiError(status, "The operations service returned an unexpected exception list.");
  return parsed.data.records;
}

export async function saveException(write: ExceptionWrite, scope: OperationsScope, signal?: AbortSignal): Promise<ExceptionWriteOutcome> {
  const key = markerKey(scope, write.stableKey, write.status);
  const fingerprint = await digest(JSON.stringify(write));
  const stored = readMarker(key);
  const intentId = stored?.fingerprint === fingerprint ? stored.intentId : crypto.randomUUID();
  if (!stored || stored.fingerprint !== fingerprint) writeMarker(key, { intentId, fingerprint });
  const capabilityInput = {
    kind: "exception",
    stableKey: write.stableKey,
    status: write.status,
    title: write.title,
    summary: write.summary,
    details: write.details,
    ...(write.ownerUserId ? { ownerUserId: write.ownerUserId } : {}),
  };
  let outcome: { status: number; body: unknown };
  try {
    outcome = await execute("operations.upsertRecord", capabilityInput, signal, intentId);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw error;
  }
  if (outcome.status === 202) {
    const pending = PendingSchema.safeParse(outcome.body);
    if (!pending.success) throw new OperationsApiError(202, "The operations service returned an unexpected pending response.", true);
    return { kind: "pending", reason: pending.data.reason ?? "This exception update is waiting for approval." };
  }
  if (outcome.status !== 200) {
    const mayHaveReachedServer = outcome.status === 408 || outcome.status === 429 || outcome.status >= 500;
    if (!mayHaveReachedServer) clearMarker(key);
    throw new OperationsApiError(outcome.status, errorMessage(outcome.status, outcome.body), mayHaveReachedServer);
  }
  const envelope = EnvelopeSchema.safeParse(outcome.body);
  if (!envelope.success) throw new OperationsApiError(outcome.status, "The operations service returned an unexpected response.", true);
  const parsed = RecordSchema.safeParse(envelope.data.data);
  if (!parsed.success) throw new OperationsApiError(outcome.status, "The operations service returned an unexpected exception record.", true);
  clearMarker(key);
  return { kind: "completed", record: parsed.data };
}
