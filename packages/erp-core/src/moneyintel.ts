/**
 * Money intelligence primitives (M10, ADR 0037).
 *
 * Deterministic and advisory: duplicate-payment detection compares signed
 * records pairwise with a stable id ordering so output never depends on
 * input order or locale. Signals name the evidence; humans decide.
 */

export interface PaymentRecord {
  id: string;
  invoiceId: string;
  amountMinor: number;
  receivedAt: Date;
}

export interface DuplicatePair {
  paymentIdA: string;
  paymentIdB: string;
  invoiceId: string;
  amountMinor: number;
  daysApart: number;
}

/** Same invoice, same amount, inside the window — the classic double click. */
export function findDuplicatePayments(payments: PaymentRecord[], windowDays = 7): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  const sorted = [...payments].sort(
    (a, b) => a.invoiceId.localeCompare(b.invoiceId) || a.id.localeCompare(b.id),
  );
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.invoiceId !== b.invoiceId) break; // sorted by invoice — no later match
      if (a.amountMinor !== b.amountMinor) continue;
      const daysApart = Math.abs(a.receivedAt.getTime() - b.receivedAt.getTime()) / 86_400_000;
      if (daysApart > windowDays) continue;
      const [paymentIdA, paymentIdB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      out.push({ paymentIdA, paymentIdB, invoiceId: a.invoiceId, amountMinor: a.amountMinor, daysApart: Math.round(daysApart) });
    }
  }
  return out.sort(
    (x, y) =>
      x.invoiceId.localeCompare(y.invoiceId) ||
      x.paymentIdA.localeCompare(y.paymentIdA) ||
      x.paymentIdB.localeCompare(y.paymentIdB),
  );
}
