import { z } from "zod";
import { fetchPurchasingEnabled, PurchasingPaymentRunsApiError } from "./purchasing-payment-runs";

const SafeMinorSchema = z.number().int().safe().nonnegative();
const AgingBucketsSchema = z.object({
  current: SafeMinorSchema,
  d30: SafeMinorSchema,
  d60: SafeMinorSchema,
  d90plus: SafeMinorSchema,
  totalOutstanding: SafeMinorSchema,
}).strict();
const AgingResponseSchema = z.object({
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  apAging: z.object({
    buckets: AgingBucketsSchema,
  }).strict(),
});
const CapabilitySuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).passthrough();
const GoAgingOutputSchema = z.object({ buckets: AgingBucketsSchema }).strict();

export type PurchasingAging = z.infer<typeof AgingResponseSchema>["apAging"]["buckets"];

function purchasingAgingGoSelected(): boolean {
  return typeof __GO_PURCHASING_AP_AGING_READS__ !== "undefined" && __GO_PURCHASING_AP_AGING_READS__;
}

async function fetchPurchasingAgingFromGo(signal?: AbortSignal): Promise<{ baseCurrency: null; buckets: PurchasingAging }> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ capabilityId: "purchasing.apAging", input: {}, intentId: crypto.randomUUID() }),
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PurchasingPaymentRunsApiError(0, "Could not reach the Go Purchasing service. Check your connection and try again.");
  }
  if (response.status !== 200) {
    const message = response.status === 401
      ? "Sign in again to review payables."
      : response.status === 403
        ? "You do not have permission to view accounts payable."
        : "The Go Purchasing service could not load accounts payable aging.";
    throw new PurchasingPaymentRunsApiError(response.status, message);
  }
  const body: unknown = await response.json().catch(() => null);
  const envelope = CapabilitySuccessSchema.safeParse(body);
  if (!envelope.success) {
    throw new PurchasingPaymentRunsApiError(response.status, "The Go Purchasing service returned an unexpected aging report.");
  }
  const parsed = GoAgingOutputSchema.safeParse(envelope.data.data);
  if (!parsed.success) {
    throw new PurchasingPaymentRunsApiError(response.status, "The Go Purchasing service returned an unexpected aging report.");
  }
  return { baseCurrency: null, buckets: parsed.data.buckets };
}

export async function fetchPurchasingAging(signal?: AbortSignal): Promise<{ baseCurrency: string | null; buckets: PurchasingAging }> {
  if (purchasingAgingGoSelected()) return fetchPurchasingAgingFromGo(signal);

  let response: Response;
  try {
    response = await fetch("/api/purchasing", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PurchasingPaymentRunsApiError(0, "Could not reach the Purchasing service. Check your connection and try again.");
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : response.status === 401
        ? "Sign in again to review payables."
        : response.status === 403
          ? "You do not have permission to view accounts payable."
          : "Could not load accounts payable aging. Try again.";
    throw new PurchasingPaymentRunsApiError(response.status, message);
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = AgingResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new PurchasingPaymentRunsApiError(response.status, "The Purchasing service returned an unexpected aging report.");
  }
  return { baseCurrency: parsed.data.baseCurrency, buckets: parsed.data.apAging.buckets };
}

export async function loadPurchasingAging(signal?: AbortSignal) {
  const enabled = await fetchPurchasingEnabled(signal);
  if (!enabled) return null;
  return fetchPurchasingAging(signal);
}
