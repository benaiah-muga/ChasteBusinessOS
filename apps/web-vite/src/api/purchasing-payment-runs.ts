import { z } from "zod";

const SafeMinorSchema = z.number().int().safe().nonnegative();
const TimestampSchema = z.string().datetime({ offset: true });

const PaymentRunLineSchema = z.object({
  billId: z.string().uuid(),
  billNumber: z.number().int().safe().positive(),
  vendorName: z.string().min(1),
  vendorRef: z.string().nullable(),
  amountMinor: SafeMinorSchema,
}).strict();

const PaymentRunSchema = z.object({
  id: z.string().uuid(),
  reference: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalMinor: SafeMinorSchema,
  status: z.enum(["draft", "instructed", "confirmed", "reversed", "cancelled"]),
  createdAt: TimestampSchema,
  instructedAt: TimestampSchema.nullable(),
  confirmedAt: TimestampSchema.nullable(),
  entryId: z.string().uuid().nullable(),
  lines: z.array(PaymentRunLineSchema),
}).strict();

const PaymentRunsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ runs: z.array(PaymentRunSchema) }).strict(),
}).strict();
const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

export type PurchasingPaymentRun = z.infer<typeof PaymentRunSchema>;

export class PurchasingPaymentRunsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PurchasingPaymentRunsApiError";
  }
}

export async function fetchPurchasingEnabled(signal?: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/modules", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PurchasingPaymentRunsApiError(0, "Could not check whether Purchasing is enabled.");
  }
  if (!response.ok) {
    throw new PurchasingPaymentRunsApiError(response.status, "Could not check whether Purchasing is enabled.");
  }
  const parsed = SwitchboardSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new PurchasingPaymentRunsApiError(response.status, "The module switchboard returned data in an unexpected format.");
  }
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("purchasing") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new PurchasingPaymentRunsApiError(response.status, "The module switchboard returned an invalid Purchasing configuration.");
  }
  return parsed.data.enabledModules.includes("purchasing");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.error === "string" && record.error.trim()) return record.error;
    if (record.error && typeof record.error === "object" && "message" in record.error && typeof record.error.message === "string") {
      return record.error.message;
    }
  }
  if (response.status === 401) return "Your session has expired. Sign in again to view payment runs.";
  if (response.status === 403) return "Your account does not have permission to view supplier payment runs.";
  return "Could not load supplier payment runs. Check the service and try again.";
}

export async function fetchPurchasingPaymentRuns(signal?: AbortSignal): Promise<PurchasingPaymentRun[]> {
  let response: Response;
  try {
    response = await fetch("/api/purchasing/payment-runs", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new PurchasingPaymentRunsApiError(0, timedOut
      ? "Loading supplier payment runs took too long. Try again."
      : "Could not reach the purchasing service. Check your connection and try again.");
  }

  if (!response.ok) throw new PurchasingPaymentRunsApiError(response.status, await errorMessage(response));
  const parsed = PaymentRunsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new PurchasingPaymentRunsApiError(response.status, "The purchasing service returned payment runs in an unexpected format.");
  }
  return parsed.data.data.runs;
}
