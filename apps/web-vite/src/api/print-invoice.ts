import { z } from "zod";

/**
 * Read-only projection for the Vite print view of a posted invoice. Money stays
 * in integer minor units; the print layout derives its totals the same way the
 * legacy server-rendered page did.
 */

const safeMinor = z.number().int().safe().nonnegative();
const PrintLineSchema = z.object({
  description: z.string(),
  quantity: z.number().int().safe().positive(),
  unitPriceMinor: safeMinor,
  taxMinor: safeMinor,
}).strict();

const PrintOrderSchema = z.object({
  number: z.number().int().safe().positive(),
  status: z.string().min(1),
  note: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  customerName: z.string(),
  customerEmail: z.string().nullable().optional(),
  paymentTermDays: z.number().int().safe().nonnegative().nullable().optional(),
  orgName: z.string(),
}).strict();

const PrintBrandingSchema = z.object({
  logoDataUrl: z.string().regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/).max(300_000).nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  invoiceFooter: z.string().max(300).nullable().optional(),
  layout: z.enum(["classic", "modern"]).nullable().optional(),
}).strict();

const PrintInvoiceSchema = z.object({
  order: PrintOrderSchema,
  lines: z.array(PrintLineSchema),
  branding: PrintBrandingSchema.nullable().optional(),
}).strict();

export type PrintLine = z.infer<typeof PrintLineSchema>;
export type PrintInvoice = z.infer<typeof PrintInvoiceSchema>;

export type PrintInvoiceResult =
  | { status: "ok"; invoice: PrintInvoice }
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "error"; message: string };

function invoiceAmountsAreSafe(lines: PrintLine[]): boolean {
  let subtotal = 0n;
  let tax = 0n;
  for (const line of lines) {
    const lineNumerator = BigInt(line.quantity) * BigInt(line.unitPriceMinor);
    subtotal += (lineNumerator + 500n) / 1000n;
    tax += BigInt(line.taxMinor);
  }
  const total = subtotal + tax;
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);
  return total > 0n && subtotal <= safeMaximum && tax <= safeMaximum && total <= safeMaximum;
}

/** The legacy route answers "Invoice not found." with a 200 and that message as
 * the body, so a bare error envelope means not-found rather than a failure. */
function isNotFoundEnvelope(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    (body as { error?: unknown }).error === "Invoice not found."
  );
}

/** Quantity is thousandths and unit prices are minor units, so a line amount
 * divides by 1000 to land back in minor units, exactly as the legacy page did. */
export function lineAmountMinor(line: PrintLine): number {
  const numerator = BigInt(line.quantity) * BigInt(line.unitPriceMinor);
  return Number((numerator + 500n) / 1000n);
}

export function subtotalMinor(lines: PrintLine[]): number {
  return Number(lines.reduce((sum, line) => {
    const numerator = BigInt(line.quantity) * BigInt(line.unitPriceMinor);
    return sum + (numerator + 500n) / 1000n;
  }, 0n));
}

export function taxMinor(lines: PrintLine[]): number {
  return Number(lines.reduce((sum, line) => sum + BigInt(line.taxMinor), 0n));
}

export function formatMoney(minor: number): string {
  if (!Number.isSafeInteger(minor)) return "0.00";
  return (minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Payment terms are counted in whole days from the issue date. */
export function dueDate(issuedAt: string, paymentTermDays: number | null | undefined): string {
  if (!paymentTermDays) return "On issue";
  const date = new Date(new Date(issuedAt).getTime() + paymentTermDays * 86_400_000);
  return Number.isNaN(date.getTime()) ? "On issue" : date.toISOString().slice(0, 10);
}

export function issueDate(issuedAt: string): string {
  return new Date(issuedAt).toISOString().slice(0, 10);
}

export async function fetchPrintInvoice(orderId: string): Promise<PrintInvoiceResult> {
  if (!orderId) return { status: "not-found" };

  let response: Response;
  try {
    response = await fetch(`/api/sales/${encodeURIComponent(orderId)}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: "error", message: "Couldn't load this invoice." };
  }

  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 404) return { status: "not-found" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", message: "Couldn't load this invoice." };
  }

  if (isNotFoundEnvelope(body)) return { status: "not-found" };
  if (!response.ok) return { status: "error", message: "Couldn't load this invoice." };

  const parsed = PrintInvoiceSchema.safeParse(body);
  if (!parsed.success || !invoiceAmountsAreSafe(parsed.data.lines)) {
    return { status: "error", message: "Couldn't load this invoice." };
  }
  return { status: "ok", invoice: parsed.data };
}
