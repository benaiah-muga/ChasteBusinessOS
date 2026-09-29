import { z } from "zod";
import { fetchPurchasingEnabled, PurchasingPaymentRunsApiError } from "./purchasing-payment-runs";

const SafeMinorSchema = z.number().int().safe().nonnegative();
const AgingResponseSchema = z.object({
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  apAging: z.object({
    buckets: z.object({
      current: SafeMinorSchema,
      d30: SafeMinorSchema,
      d60: SafeMinorSchema,
      d90plus: SafeMinorSchema,
      totalOutstanding: SafeMinorSchema,
    }).strict(),
  }).strict(),
});

export type PurchasingAging = z.infer<typeof AgingResponseSchema>["apAging"]["buckets"];

export async function fetchPurchasingAging(signal?: AbortSignal): Promise<{ baseCurrency: string; buckets: PurchasingAging }> {
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
