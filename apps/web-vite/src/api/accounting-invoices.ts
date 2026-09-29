import { z } from "zod";

const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

const InvoiceSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().safe(),
  customerId: z.string().min(1),
  customerName: z.string(),
  status: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalMinor: z.number().int().safe(),
  paidMinor: z.number().int().safe(),
  outstandingMinor: z.number().int().safe(),
  issuedAt: z.string().datetime({ offset: true }).nullable(),
});

const AccountingInvoicesSchema = z.object({ invoices: z.array(InvoiceSchema) });
const ErrorSchema = z.object({ error: z.string().max(500) });

export type AccountingInvoice = z.infer<typeof InvoiceSchema>;

export class AccountingInvoicesApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AccountingInvoicesApiError";
  }
}

export async function fetchAccountingEnabled(signal?: AbortSignal): Promise<boolean> {
  const { response, body } = await getJson("/api/modules", signal);
  if (!response.ok) {
    throw new AccountingInvoicesApiError(response.status, "Could not check whether Accounting is enabled.");
  }

  const parsed = SwitchboardSchema.safeParse(body);
  if (!parsed.success) {
    throw new AccountingInvoicesApiError(response.status, "The module switchboard returned data in an unexpected format.");
  }
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("accounting") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new AccountingInvoicesApiError(response.status, "The module switchboard returned an invalid Accounting configuration.");
  }
  return parsed.data.enabledModules.includes("accounting");
}

export async function fetchAccountingInvoices(signal?: AbortSignal): Promise<AccountingInvoice[]> {
  const { response, body } = await getJson("/api/accounting", signal);
  if (!response.ok) {
    const parsedError = ErrorSchema.safeParse(body);
    if (response.status === 401) {
      throw new AccountingInvoicesApiError(401, "Your session has ended. Sign in again to continue.");
    }
    if (response.status === 403 || response.status === 422) {
      throw new AccountingInvoicesApiError(response.status, parsedError.success ? parsedError.data.error : "You do not have permission to view invoices.");
    }
    throw new AccountingInvoicesApiError(response.status, response.status >= 500
      ? "The Accounting service is unavailable. Try again."
      : parsedError.success ? parsedError.data.error : "The Accounting request could not be completed. Try again.");
  }

  const parsed = AccountingInvoicesSchema.safeParse(body);
  if (!parsed.success) {
    throw new AccountingInvoicesApiError(response.status, "The Accounting service returned invoices in an unexpected format.");
  }
  return parsed.data.invoices;
}

async function getJson(path: string, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new AccountingInvoicesApiError(0, timedOut
      ? "The Accounting service took too long to respond. Try again."
      : "Could not reach the Accounting service. Check your connection and try again.");
  }
  return { response, body: await response.json().catch(() => null) };
}
