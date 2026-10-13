import { z } from "zod";
import { fetchPurchasingEnabled, PurchasingApiError } from "./purchasing";
import { PurchasingPaymentRunsApiError } from "./purchasing-payment-runs";

const SafeMinorSchema = z.number().int().safe().nonnegative();
const AgingBucketsSchema = z.object({
  current: SafeMinorSchema,
  d30: SafeMinorSchema,
  d60: SafeMinorSchema,
  d90plus: SafeMinorSchema,
  totalOutstanding: SafeMinorSchema,
}).strict();
const CapabilitySuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).passthrough();
const GoAgingOutputSchema = z.object({ buckets: AgingBucketsSchema }).strict();

export type PurchasingAging = z.infer<typeof AgingBucketsSchema>;

async function fetchPurchasingAgingFromGo(organizationId: string | null | undefined, signal?: AbortSignal): Promise<{ baseCurrency: null; buckets: PurchasingAging }> {
  const normalizedOrganizationId = organizationId?.trim();
  if (!normalizedOrganizationId) {
    throw new PurchasingPaymentRunsApiError(0, "Wait for the active organization to finish loading before reviewing payables.");
  }
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": normalizedOrganizationId },
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

export async function fetchPurchasingAging(organizationId: string | null | undefined, signal?: AbortSignal): Promise<{ baseCurrency: string | null; buckets: PurchasingAging }> {
  return fetchPurchasingAgingFromGo(organizationId, signal);
}

export async function loadPurchasingAging(organizationId: string | null | undefined, signal?: AbortSignal) {
  let enabled: boolean;
  try {
    enabled = await fetchPurchasingEnabled(organizationId, signal);
  } catch (error) {
    if (error instanceof PurchasingApiError) throw new PurchasingPaymentRunsApiError(error.status, error.message);
    throw error;
  }
  if (!enabled) return null;
  return fetchPurchasingAging(organizationId, signal);
}
