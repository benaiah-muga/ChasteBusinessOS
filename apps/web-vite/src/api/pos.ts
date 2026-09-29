import { z } from "zod";

const PosSessionSchema = z.object({
  id: z.string().uuid(),
  register: z.string().min(1).optional(),
  number: z.number().int().positive().optional(),
  status: z.string().min(1),
  openedAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).nullable(),
}).passthrough().refine((session) => Boolean(session.register || session.number !== undefined), "A register name or session number is required");

const PosSessionsSchema = z.object({ sessions: z.array(PosSessionSchema) });
const MethodTotalSchema = z.object({ method: z.string().min(1), amountMinor: z.number().int().safe() });
const ShiftSummarySchema = z.object({
  register: z.string(),
  status: z.string(),
  salesCount: z.number().int().nonnegative().safe(),
  takingsMinor: z.number().int().safe(),
  tenderTotals: z.array(MethodTotalSchema),
  refundTotals: z.array(MethodTotalSchema),
  expectedCashMinor: z.number().int().safe(),
  countedCashMinor: z.number().int().safe().nullable(),
  varianceMinor: z.number().int().safe().nullable(),
});
const ShiftSummaryResponseSchema = z.object({ ok: z.literal(true), data: ShiftSummarySchema });
const ErrorSchema = z.object({ error: z.string().max(500) });

export type PosSession = z.infer<typeof PosSessionSchema>;
export type PosShiftSummary = z.infer<typeof ShiftSummarySchema>;

export class PosApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PosApiError";
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

async function readError(response: Response, fallback: string): Promise<PosApiError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ErrorSchema.safeParse(body);
  if (response.status === 401) return new PosApiError(401, "Your session has ended. Sign in again to continue.");
  if (response.status === 403 || response.status === 422) {
    return new PosApiError(response.status, parsed.success ? parsed.data.error : "You do not have permission to view POS sessions.");
  }
  return new PosApiError(response.status, response.status >= 500
    ? "The POS service is unavailable. Try again."
    : parsed.success ? parsed.data.error : fallback);
}

export async function fetchPosSessions(signal?: AbortSignal): Promise<PosSession[]> {
  let response: Response;
  try {
    response = await fetch("/api/pos", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new PosApiError(0, timedOut
      ? "The POS service took too long to load. Try again."
      : "Could not reach the POS service. Check your connection and try again.");
  }

  if (!response.ok) throw await readError(response, "Could not load POS sessions. Try again.");
  const body: unknown = await response.json().catch(() => null);
  const parsed = PosSessionsSchema.safeParse(body);
  if (!parsed.success) throw new PosApiError(response.status, "The POS service returned sessions in an unexpected format.");
  return parsed.data.sessions;
}

export async function fetchPosShiftSummary(sessionId: string, signal?: AbortSignal): Promise<PosShiftSummary> {
  if (!z.string().uuid().safeParse(sessionId).success) {
    throw new PosApiError(0, "Choose a valid register session.");
  }

  let response: Response;
  try {
    response = await fetch("/api/pos", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
      body: JSON.stringify({ action: "shiftSummary", sessionId, intentId: crypto.randomUUID() }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new PosApiError(0, timedOut
      ? "The POS service took too long to load this shift. Try again."
      : "Could not reach the POS service. Check your connection and try again.");
  }

  if (!response.ok) throw await readError(response, "Could not load this shift summary. Try again.");
  const body: unknown = await response.json().catch(() => null);
  const parsed = ShiftSummaryResponseSchema.safeParse(body);
  if (!parsed.success) throw new PosApiError(response.status, "The POS service returned a shift summary in an unexpected format.");
  return parsed.data.data;
}
