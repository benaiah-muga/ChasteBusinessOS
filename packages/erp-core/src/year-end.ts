/**
 * Year-end close: the formal retained-earnings roll. All income and expense
 * accounts are zeroed into Retained Earnings via one closing journal entry.
 * Pure math here; the caller posts the entry immutably and records the close.
 */

import type { AccountBalance } from "./reports";

export interface ClosingLine {
  accountCode: string;
  debitMinor: number;
  creditMinor: number;
}

export interface YearEndClose {
  /** Zeroing lines for each income/expense account with a balance. */
  closingLines: ClosingLine[];
  /** The single retained-earnings line; equals net income (credit-positive). */
  retainedEarningsLine: ClosingLine;
  netIncomeMinor: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
}

/**
 * Builds the closing entry for a fiscal year. Income accounts (credit-natural)
 * are debited their balance; expense accounts (debit-natural) are credited
 * theirs. The difference lands on Retained Earnings, so the entry balances by
 * construction, that identity is property-tested, not hoped for.
 */
export function computeYearEndClose(
  balances: AccountBalance[],
  retainedEarningsCode: string,
): YearEndClose {
  const closingLines: ClosingLine[] = [];
  let net = 0;

  for (const a of balances) {
    const natural =
      a.type === "asset" || a.type === "expense"
        ? a.debitMinor - a.creditMinor
        : a.creditMinor - a.debitMinor;
    if (a.type !== "income" && a.type !== "expense") continue;
    if (natural === 0) continue;
    net += a.type === "income" ? natural : -natural;
    closingLines.push(
      a.type === "income"
        ? { accountCode: a.code, debitMinor: natural, creditMinor: 0 }
        : { accountCode: a.code, debitMinor: 0, creditMinor: natural },
    );
  }

  const retainedEarningsLine =
    net >= 0
      ? { accountCode: retainedEarningsCode, debitMinor: 0, creditMinor: net }
      : { accountCode: retainedEarningsCode, debitMinor: -net, creditMinor: 0 };

  const totalDebitMinor =
    closingLines.reduce((s, l) => s + l.debitMinor, 0) + retainedEarningsLine.debitMinor;
  const totalCreditMinor =
    closingLines.reduce((s, l) => s + l.creditMinor, 0) + retainedEarningsLine.creditMinor;

  return { closingLines, retainedEarningsLine, netIncomeMinor: net, totalDebitMinor, totalCreditMinor };
}
