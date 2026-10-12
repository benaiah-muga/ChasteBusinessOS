import { z } from "zod";

const uuid = z.string().uuid();
const integer = z.number().int().safe();
export const SALES_QUOTE_DATABASE_INTEGER_MAX = 2_147_483_647;
const databaseInteger = z.number().int().min(0).max(SALES_QUOTE_DATABASE_INTEGER_MAX);
const QuoteStatusSchema = z.enum(["draft", "sent", "accepted", "declined", "expired"]);
const QuoteSchema = z.object({
  id: uuid,
  number: integer.nonnegative(),
  status: QuoteStatusSchema,
  totalMinor: integer.nonnegative(),
  customerId: uuid,
  createdAt: z.string().datetime({ offset: true }).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  invoiceId: uuid.nullable().optional(),
}).strict();
const CustomerSchema = z.object({ id: uuid, name: z.string().min(1).max(500), email: z.string().max(500).nullable() }).strict();
const DealSchema = z.object({
  id: uuid,
  title: z.string().min(1).max(500),
  stage: z.enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"]),
  valueMinor: integer.nonnegative(),
  note: z.string().nullable(),
  customerId: uuid.nullable(),
  customerName: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
const EnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const ErrorSchema = z.object({ error: z.string().max(500) });
const PendingSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string().max(500) }).strict();
const QuoteLineSchema = z.object({
  description: z.string().trim().min(1).max(500).refine((value) => !value.includes("\u0000")),
  quantity: databaseInteger.positive(),
  unitPriceMinor: databaseInteger,
  taxMinor: databaseInteger.optional(),
}).strict();
const CreateQuoteInputSchema = z.object({
  customerId: uuid,
  memo: z.string().max(4000).refine((value) => !value.includes("\u0000")).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  lines: z.array(QuoteLineSchema).min(1).max(100),
}).strict().superRefine(({ lines }, context) => {
  let total = 0n;
  for (const line of lines) {
    total += (BigInt(line.quantity) * BigInt(line.unitPriceMinor) + 500n) / 1000n;
    total += BigInt(line.taxMinor ?? 0);
  }
  if (total <= 0n || total > BigInt(SALES_QUOTE_DATABASE_INTEGER_MAX)) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Quote total must fit the supported database amount range and be greater than zero." });
  }
});
const AcceptQuoteInputSchema = z.object({ quoteId: uuid }).strict();
const CreateQuoteOutputSchema = z.object({ quoteId: uuid, quoteNumber: integer.positive(), totalMinor: integer.nonnegative() }).strict();
const AcceptQuoteOutputSchema = z.object({ invoiceId: uuid, invoiceNumber: integer.positive(), totalMinor: integer.nonnegative() }).strict();

export type SalesQuote = z.infer<typeof QuoteSchema>;
export type SalesQuoteCustomer = z.infer<typeof CustomerSchema>;
export type SalesQuoteDeal = z.infer<typeof DealSchema>;
export type SalesQuoteInput = z.infer<typeof CreateQuoteInputSchema>;
export type SalesQuoteScope = { actorId: string | null; organizationId: string | null };
export type SalesQuoteActionOutcome<T> = { kind: "completed"; data: T } | { kind: "pending"; reason: string };

export class SalesQuoteApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "SalesQuoteApiError";
  }
}

type QuoteWrite = { action: "create"; input: SalesQuoteInput } | { action: "accept"; input: { quoteId: string } };
type QuoteWriteMarker = { intentId: string; fingerprint: string; scopeFingerprint: string; write: QuoteWrite };
const MARKER_PREFIX = "chaste:sales-quotes:go-attempt:v1:";
const validUUID = (value: string): boolean => uuid.safeParse(value).success;

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(20_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function scopedMarkerKey(scope: SalesQuoteScope, write: QuoteWrite): Promise<{ key: string; fingerprint: string; scopeFingerprint: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!actorId || !validUUID(organizationId)) throw new SalesQuoteApiError(0, "Sign in to the active workspace before changing a quote.");
  const scopeFingerprint = await digest(JSON.stringify([actorId, organizationId]));
  const fingerprint = await digest(JSON.stringify(write));
  return { key: `${MARKER_PREFIX}${scopeFingerprint}:${write.action}:${fingerprint}`, fingerprint, scopeFingerprint };
}

function parseMarker(value: string | null): QuoteWriteMarker | null {
  if (!value) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(value) as unknown; } catch { throw new SalesQuoteApiError(0, "The saved quote retry record is unreadable. Contact support before retrying."); }
  const parsed = z.object({ intentId: uuid, fingerprint: z.string().length(64), scopeFingerprint: z.string().length(64), write: z.union([
    z.object({ action: z.literal("create"), input: CreateQuoteInputSchema }).strict(),
    z.object({ action: z.literal("accept"), input: AcceptQuoteInputSchema }).strict(),
  ]) }).strict().safeParse(decoded);
  if (!parsed.success) throw new SalesQuoteApiError(0, "The saved quote retry record is invalid. Contact support before retrying.");
  return parsed.data;
}

async function withMarkerLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (typeof window === "undefined" || !window.navigator.locks) throw new SalesQuoteApiError(0, "This browser cannot safely coordinate quote retries. Use a current browser before changing quotes.");
  try {
    return await window.navigator.locks.request(key, { mode: "exclusive" }, work);
  } catch (error) {
    if (error instanceof SalesQuoteApiError) throw error;
    throw new SalesQuoteApiError(0, "The browser could not coordinate this quote action safely. Try again.");
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null) as Promise<unknown>;
}

async function executeRead<T>(capabilityId: string, input: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SalesQuoteApiError(0, "Could not reach Go while loading Sales. Check your connection and try again.");
  }
  const body = await readJson(response);
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new SalesQuoteApiError(response.status, error.success ? error.data.error : "The Go Sales request failed.");
  }
  if (response.status !== 200) throw new SalesQuoteApiError(response.status, "The Go Sales service returned an unexpected response.");
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new SalesQuoteApiError(response.status, "The Go Sales service returned an unexpected response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new SalesQuoteApiError(response.status, "The Go Sales service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchSalesQuotes(signal?: AbortSignal): Promise<SalesQuote[]> {
  const result = await executeRead("accounting.listQuotes", {}, z.object({ quotes: z.array(QuoteSchema).max(100) }).strict(), signal);
  return result.quotes;
}

export async function fetchSalesQuoteCustomers(signal?: AbortSignal): Promise<SalesQuoteCustomer[]> {
  const result = await executeRead("crm.listCustomers", {}, z.object({ customers: z.array(CustomerSchema).max(100) }).strict(), signal);
  return result.customers;
}

export async function fetchSalesQuoteDeals(signal?: AbortSignal): Promise<SalesQuoteDeal[]> {
  const result = await executeRead("crm.listDeals", {}, z.object({ deals: z.array(DealSchema).max(200) }).strict(), signal);
  return result.deals;
}

async function submitWrite<T>(write: QuoteWrite, scope: SalesQuoteScope, schema: z.ZodType<T>): Promise<SalesQuoteActionOutcome<T>> {
  const parsedWrite = write.action === "create"
    ? CreateQuoteInputSchema.safeParse(write.input)
    : AcceptQuoteInputSchema.safeParse(write.input);
  if (!parsedWrite.success) throw new SalesQuoteApiError(0, "Quote quantities, prices, taxes, and total must fit the supported database amount range.");
  const safeWrite: QuoteWrite = write.action === "create"
    ? { action: "create", input: parsedWrite.data as SalesQuoteInput }
    : { action: "accept", input: parsedWrite.data as { quoteId: string } };
  const markerKey = await scopedMarkerKey(scope, safeWrite);
  return withMarkerLock(markerKey.key, async () => {
    let marker: QuoteWriteMarker | null;
    try {
      marker = parseMarker(window.localStorage.getItem(markerKey.key));
    } catch (error) {
      if (error instanceof SalesQuoteApiError) throw error;
      throw new SalesQuoteApiError(0, "Browser storage could not read the quote retry record. Enable browser storage before changing quotes.");
    }
    if (marker && (marker.fingerprint !== markerKey.fingerprint || marker.scopeFingerprint !== markerKey.scopeFingerprint || JSON.stringify(marker.write) !== JSON.stringify(safeWrite))) {
      throw new SalesQuoteApiError(0, "The saved quote retry record does not match this workspace action. Contact support before retrying.");
    }
    if (!marker) {
      marker = { intentId: crypto.randomUUID(), fingerprint: markerKey.fingerprint, scopeFingerprint: markerKey.scopeFingerprint, write: safeWrite };
      try { window.localStorage.setItem(markerKey.key, JSON.stringify(marker)); }
      catch { throw new SalesQuoteApiError(0, "Browser storage could not save the quote retry record. Enable browser storage before changing quotes."); }
    }

    let response: Response;
    let body: unknown;
    const capabilityId = safeWrite.action === "create" ? "accounting.createQuote" : "accounting.acceptQuote";
    try {
      response = await fetch("/api/capabilities/execute", {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ capabilityId, input: safeWrite.input, intentId: marker.intentId }),
        cache: "no-store",
        signal: requestSignal(),
      });
      body = await readJson(response);
    } catch {
      throw new SalesQuoteApiError(0, "The quote result is unknown. Retry the exact same action to check its saved result.", true);
    }
    const pending = PendingSchema.safeParse(body);
    if (response.status === 202 && pending.success) return { kind: "pending", reason: pending.data.reason };
    if (!response.ok) {
      const error = ErrorSchema.safeParse(body);
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        try { window.localStorage.removeItem(markerKey.key); } catch { throw new SalesQuoteApiError(0, "The quote was rejected, but its retry record could not be cleared. Contact support before retrying."); }
      }
      throw new SalesQuoteApiError(response.status, error.success ? error.data.error : "The quote action could not be completed.");
    }
    const envelope = EnvelopeSchema.safeParse(body);
    const output = envelope.success ? schema.safeParse(envelope.data.data) : null;
    if (!output?.success) throw new SalesQuoteApiError(response.status, "Go returned an unexpected quote result. Retry the exact same action to recover it.", true);
    try { window.localStorage.removeItem(markerKey.key); }
    catch { throw new SalesQuoteApiError(0, "The quote completed, but its retry record could not be cleared. Reload and verify quote history before continuing."); }
    return { kind: "completed", data: output.data };
  });
}

export function createSalesQuote(input: SalesQuoteInput, scope: SalesQuoteScope): Promise<SalesQuoteActionOutcome<z.infer<typeof CreateQuoteOutputSchema>>> {
  return submitWrite({ action: "create", input }, scope, CreateQuoteOutputSchema);
}

export function acceptSalesQuote(quoteId: string, scope: SalesQuoteScope): Promise<SalesQuoteActionOutcome<z.infer<typeof AcceptQuoteOutputSchema>>> {
  return submitWrite({ action: "accept", input: { quoteId } }, scope, AcceptQuoteOutputSchema);
}
