import { z } from "zod";

/**
 * Public read-only invoice view, reached only through a revocable share link.
 * The API behind it exposes nothing else about the organization, so this
 * client validates strictly and renders nothing it was not given.
 */

const PortalLineSchema = z.object({
  description: z.string(),
  quantity: z.number().int().safe(),
  unitPriceMinor: z.number().int().safe(),
  taxMinor: z.number().int().safe(),
}).strict();

const PortalInvoiceSchema = z.object({
  number: z.number().int().safe(),
  status: z.string().min(1),
  currency: z.string().min(1),
  totalMinor: z.number().int().safe(),
  // The legacy route sends this so the customer sees the credit-adjusted
  // remaining amount. Omitting it silently shows the wrong balance.
  creditedMinor: z.number().int().safe(),
  paidMinor: z.number().int().safe(),
  outstandingMinor: z.number().int().safe(),
  issuedAt: z.string().datetime().nullable(),
  customerName: z.string(),
  lines: z.array(PortalLineSchema),
}).strict();

const PortalResponseSchema = z.object({
  invoice: PortalInvoiceSchema.nullable().optional(),
}).strict();

export type PortalInvoice = z.infer<typeof PortalInvoiceSchema>;

export type PortalInvoiceResult =
  | { status: "ok"; invoice: PortalInvoice }
  | { status: "not-found" }
  | { status: "rate-limited" }
  | { status: "error"; message: string };

/**
 * The legacy route answers 429 for a throttled token and 404 for an unknown
 * one, and both must read as a plain refusal rather than a stack trace.
 */
export async function fetchPortalInvoice(token: string, signal?: AbortSignal): Promise<PortalInvoiceResult> {
  if (token.length < 20 || token.length > 64) return { status: "not-found" };

  let response: Response;
  try {
    response = await fetch(`/api/portal/invoice/${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal,
    });
  } catch {
    return { status: "error", message: "Couldn't load this invoice." };
  }

  if (response.status === 429) return { status: "rate-limited" };
  if (response.status === 404 || response.status === 410) return { status: "not-found" };
  if (!response.ok) {
    return response.status >= 500
      ? { status: "error", message: PORTAL_MESSAGES.failed }
      : { status: "not-found" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", message: "Couldn't load this invoice." };
  }

  const parsed = PortalResponseSchema.safeParse(body);
  if (!parsed.success) return { status: "error", message: "Couldn't load this invoice." };
  if (!parsed.data.invoice) return { status: "not-found" };
  return { status: "ok", invoice: parsed.data.invoice };
}

export const PORTAL_MESSAGES = {
  notFound: "This link is not valid.",
  rateLimited: "Too many requests - try again shortly.",
  failed: "Couldn't load this invoice.",
} as const;
