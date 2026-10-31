import { z } from "zod";
import type { components, operations } from "../generated/business-v1";

export const SignalSchema: z.ZodType<components["schemas"]["Signal"]> = z.object({
  id: z.string().min(1),
  severity: z.enum(["red", "orange", "green"]),
  module: z.string().min(1),
  subject: z.string(),
  detail: z.string(),
  evidence: z.object({
    refType: z.string(),
    refId: z.string().nullable().optional(),
  }).strict().nullable().optional(),
  suggestedAction: z.object({
    capabilityId: z.string().min(1),
    inputDraft: z.record(z.string(), z.unknown()).optional(),
  }).strict().nullable().optional(),
}).strict();

const SignalResponseSchema: z.ZodType<components["schemas"]["SignalResponse"]> = z.object({
  signals: z.array(SignalSchema),
}).strict();
const SignalFiltersSchema = z.object({
  severity: z.enum(["red", "orange", "green"]).optional(),
  module: z.string().refine((value) => {
    const bytes = new TextEncoder().encode(value).length;
    return bytes >= 2 && bytes <= 40;
  }).optional(),
}).strict();

export type Signal = components["schemas"]["Signal"];

export type SignalFilters = NonNullable<operations["getSignals"]["parameters"]["query"]>;

export class SignalsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SignalsApiError";
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function queryString(filters: SignalFilters): string {
  const params = new URLSearchParams();
  if (filters.severity !== undefined) params.set("severity", filters.severity);
  if (filters.module !== undefined) params.set("module", filters.module);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function errorForStatus(status: number): SignalsApiError {
  if (status === 400) return new SignalsApiError(status, "Choose a valid signal filter and try again.");
  if (status === 401) return new SignalsApiError(status, "Your session has expired. Sign in again to view signals.");
  if (status === 403) return new SignalsApiError(status, "Your account does not have access to these signals.");
  return new SignalsApiError(status, "The signals service is unavailable. Try again.");
}

export async function fetchSignals(filters: SignalFilters = {}, signal?: AbortSignal): Promise<Signal[]> {
  const validatedFilters = SignalFiltersSchema.safeParse(filters);
  if (!validatedFilters.success) throw errorForStatus(400);
  const response = await fetch(`/api/signals${queryString(validatedFilters.data)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: requestSignal(signal),
  });
  if (!response.ok) throw errorForStatus(response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SignalsApiError(response.status, "The signals service returned an unreadable response.");
  }
  const parsed = SignalResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new SignalsApiError(response.status, "The signals service returned data in an unexpected format.");
  }
  return parsed.data.signals;
}
