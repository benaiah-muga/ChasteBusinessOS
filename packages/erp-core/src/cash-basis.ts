/**
 * Cash-basis view over an accrual ledger. The ledger stays accrual
 * double-entry; cash basis is a *derived* report, never a second set of
 * books. Identity enforced by construction:
 *
 *   netCashMinor === cashInMinor - cashOutMinor === Δcash for the window
 *
 * An entry contributes to the period only if it touches a cash account;
 * its income/expense lines are attributed by how the cash moved. Entries
 * without a cash leg (credit sales, accruals) are invisible here, that is
 * precisely the difference from the accrual P&L.
 */

export interface CashBasisEntry {
  /** Posting date; filtered against [from, to). */
  occurredAt: Date;
  lines: {
    accountCode: string;
    accountType: "asset" | "liability" | "equity" | "income" | "expense";
    debitMinor: number;
    creditMinor: number;
  }[];
}

export interface CashBasisSummary {
  /** Cash received in-window (debits to cash accounts, minus refunds out). */
  cashInMinor: number;
  /** Cash paid out in-window (credits to cash accounts, minus refunds in). */
  cashOutMinor: number;
  /** Net operating cash movement; equals cashIn − cashOut. */
  netCashMinor: number;
  /** Accrual-basis revenue/expense booked in-window, for comparison. */
  accrualRevenueMinor: number;
  accrualExpenseMinor: number;
  /**
   * Booked-but-uncollected gap: accrual revenue not yet matched by cash in.
   * Positive means work done but money not in the door yet.
   */
  uncollectedMinor: number;
}

function signedCashDelta(l: CashBasisEntry["lines"][number]): number {
  return l.debitMinor - l.creditMinor;
}

/** Pure. Window is half-open [from, to); undefined bounds are open. */
export function computeCashBasis(
  entries: CashBasisEntry[],
  cashAccountCodes: ReadonlySet<string>,
  window: { from?: Date | undefined; to?: Date | undefined } = {},
): CashBasisSummary {
  let cashIn = 0;
  let cashOut = 0;
  let accrualRevenue = 0;
  let accrualExpense = 0;

  for (const e of entries) {
    if (window.from && e.occurredAt < window.from) continue;
    if (window.to && e.occurredAt >= window.to) continue;

    const cashLines = e.lines.filter((l) => cashAccountCodes.has(l.accountCode));
    const hasCashLeg = cashLines.some((l) => signedCashDelta(l) !== 0);

    for (const l of e.lines) {
      if (l.accountType === "income") accrualRevenue += l.creditMinor - l.debitMinor;
      if (l.accountType === "expense") accrualExpense += l.debitMinor - l.creditMinor;
    }

    if (!hasCashLeg) continue;
    for (const l of cashLines) {
      const d = signedCashDelta(l);
      // Refunds net against their side rather than double-counting gross flows.
      if (d > 0) cashIn += d;
      else cashOut += -d;
    }
  }

  return {
    cashInMinor: cashIn,
    cashOutMinor: cashOut,
    netCashMinor: cashIn - cashOut,
    accrualRevenueMinor: accrualRevenue,
    accrualExpenseMinor: accrualExpense,
    uncollectedMinor: Math.max(0, accrualRevenue - cashIn),
  };
}
