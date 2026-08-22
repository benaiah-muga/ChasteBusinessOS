import type { JournalLineInput } from "./posting";

export interface InvoiceLineInput {
  quantity: number; // integer units (e.g. thousandths for fractional qty)
  unitPriceMinor: number;
  taxMinor: number;
}

export interface InvoiceTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export function computeInvoiceTotals(lines: InvoiceLineInput[]): InvoiceTotals {
  let subtotal = 0;
  let tax = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw new Error("invalid quantity");
    if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) throw new Error("invalid unit price");
    if (!Number.isSafeInteger(line.taxMinor) || line.taxMinor < 0) throw new Error("invalid tax");
    subtotal += Math.round((line.quantity * line.unitPriceMinor) / 1000);
    tax += line.taxMinor;
  }
  const totals = { subtotalMinor: subtotal, taxMinor: tax, totalMinor: subtotal + tax };
  if (totals.totalMinor <= 0) throw new Error("invoice must have a non-zero total");
  return totals;
}

export interface PostedInvoiceForPosting {
  totals: InvoiceTotals;
}

export function buildInvoiceEntryLines(
  accounts: { ar: string; revenue: string; taxPayable: string },
  invoice: PostedInvoiceForPosting,
): JournalLineInput[] {
  const lines: JournalLineInput[] = [
    { accountCode: accounts.ar, debitMinor: invoice.totals.totalMinor, creditMinor: 0 },
    { accountCode: accounts.revenue, debitMinor: 0, creditMinor: invoice.totals.subtotalMinor },
    { accountCode: accounts.taxPayable, debitMinor: 0, creditMinor: invoice.totals.taxMinor },
  ];
  // Zero components (e.g. no tax, or pure-tax invoices) drop out cleanly.
  return lines.filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
}

/** Posting rule: a payment settles part of the receivable. DR Cash, CR AR. */
export function buildPaymentEntryLines(
  accounts: { cash: string; ar: string },
  amountMinor: number,
): JournalLineInput[] {
  return [
    { accountCode: accounts.cash, debitMinor: amountMinor, creditMinor: 0 },
    { accountCode: accounts.ar, debitMinor: 0, creditMinor: amountMinor },
  ];
}
