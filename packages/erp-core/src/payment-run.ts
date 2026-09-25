export interface PaymentRunSelection {
  billId: string;
  currency: string;
  outstandingMinor: number;
  payMinor: number;
}

export interface ValidatedPaymentRun {
  currency: string;
  totalMinor: number;
  billCount: number;
  lines: PaymentRunSelection[];
}

/** Fail closed on duplicate bills, mixed currencies, and overpayments. */
export function validatePaymentRun(lines: readonly PaymentRunSelection[]): ValidatedPaymentRun {
  if (lines.length === 0) throw new Error("select at least one bill");
  const currency = lines[0]!.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("payment run currency must be an ISO currency code");
  const seen = new Set<string>();
  let totalMinor = 0n;
  for (const line of lines) {
    if (!line.billId || seen.has(line.billId)) throw new Error("a bill can appear only once in a payment run");
    seen.add(line.billId);
    if (line.currency.toUpperCase() !== currency) throw new Error("all bills in a payment run must use the same currency");
    if (!Number.isSafeInteger(line.outstandingMinor) || line.outstandingMinor <= 0) throw new Error(`bill ${line.billId} has no payable balance`);
    if (!Number.isSafeInteger(line.payMinor) || line.payMinor <= 0) throw new Error(`payment for bill ${line.billId} must be positive`);
    if (line.payMinor > line.outstandingMinor) throw new Error(`payment for bill ${line.billId} exceeds its outstanding balance`);
    totalMinor += BigInt(line.payMinor);
  }
  if (totalMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("payment run total exceeds the supported amount range");
  return { currency, totalMinor: Number(totalMinor), billCount: lines.length, lines: lines.map((line) => ({ ...line, currency })) };
}
