import { z } from "zod";

export const LedgerEventSchema = z.object({
  seq: z.number().int(),
  kind: z.string(),
  capabilityId: z.string().nullable(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  sessionId: z.string().nullable(),
  payload: z.unknown(),
  hash: z.string(),
  prevHash: z.string().nullable(),
  occurredAt: z.string().datetime(),
});

const LedgerResponseSchema = z.object({ events: z.array(LedgerEventSchema) });
const ErrorResponseSchema = z.object({ error: z.string().optional() });

export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export class LedgerApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LedgerApiError";
  }
}

async function responseError(response: Response): Promise<string> {
  const body = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
  if (response.status === 401) return "Your session has ended. Sign in again to continue.";
  if (response.status === 403) return "You do not have permission to view the event ledger.";
  if (response.status >= 500) return "The ledger service is unavailable. Try again.";
  const message = body.success ? body.data.error : undefined;
  return message && message.length <= 240 && !/[{}<>]/.test(message)
    ? message
    : "The ledger request could not be completed. Try again.";
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new LedgerApiError(response.status, "The ledger service returned an unreadable response.");
  }
}

export async function fetchLedgerEvents(signal?: AbortSignal): Promise<LedgerEvent[]> {
  let response: Response;
  try {
    response = await fetch("/api/ledger?limit=100", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new LedgerApiError(0, "The ledger service took too long to load. Try again.");
    }
    throw new LedgerApiError(0, "Could not reach the ledger service. Check your connection and try again.");
  }

  if (!response.ok) throw new LedgerApiError(response.status, await responseError(response));
  const parsed = LedgerResponseSchema.safeParse(await parseJson(response));
  if (!parsed.success) {
    throw new LedgerApiError(response.status, "The ledger service returned data in an unexpected format.");
  }
  return parsed.data.events;
}
