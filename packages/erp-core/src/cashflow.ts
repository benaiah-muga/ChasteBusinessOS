import type { AccountType } from "./posting";

/**
 * Direct-method cash flow statement (M10, ADR 0037).
 *
 * Derived, never stored: a pure function over ledger lines. An entry moves
 * cash when it touches a cash account; its category comes from the
 * counter-accounts — operating for the trading cycle (AR, inventory, AP,
 * tax, revenue, expense), financing for equity, investing for other assets.
 * Books are balanced, so an entry's cash delta is exactly minus the sum of
 * its counter deltas — the property tests hold both directions.
 */

export interface CashFlowLine {
  accountCode: string;
  accountType: AccountType;
  debitMinor: number;
  creditMinor: number;
}

export interface CashFlowEntry {
  occurredAt: Date;
  lines: CashFlowLine[];
}

export type CashFlowCategory = "operating" | "investing" | "financing";

/** Trading-cycle codes that mark an entry as operating (default COA). */
const OPERATING_CODES = new Set(["1100", "1200", "2000", "2100"]);

export function isCashLine(line: CashFlowLine, cashCodes: string[]): boolean {
  return cashCodes.includes(line.accountCode);
}

function signed(line: CashFlowLine): number {
  return line.debitMinor - line.creditMinor;
}

/**
 * Classify one entry. Returns null when the entry never touches cash (a
 * non-cash event like depreciation or an AR sale) — it has no place in a
 * direct-method statement.
 */
export function classifyCashEntry(
  lines: CashFlowLine[],
  cashCodes: string[],
): { cashDeltaMinor: number; category: CashFlowCategory } | null {
  const cashLines = lines.filter((l) => isCashLine(l, cashCodes));
  if (cashLines.length === 0) return null;
  const cashDeltaMinor = cashLines.reduce((sum, l) => sum + signed(l), 0);
  const counters = lines.filter((l) => !isCashLine(l, cashCodes));

  let category: CashFlowCategory = "operating";
  if (counters.length > 0) {
    if (counters.some((c) => c.accountType === "equity")) {
      category = "financing";
    } else if (
      counters.every((c) => c.accountType === "asset") &&
      !counters.some((c) => OPERATING_CODES.has(c.accountCode))
    ) {
      category = "investing";
    }
  }
  return { cashDeltaMinor, category };
}

export interface CashFlowCategoryTotal {
  inflowMinor: number;
  outflowMinor: number;
  netMinor: number;
  entries: number;
}

export interface CashFlowStatement {
  openingMinor: number;
  operating: CashFlowCategoryTotal;
  investing: CashFlowCategoryTotal;
  financing: CashFlowCategoryTotal;
  netMinor: number;
  closingMinor: number;
  /** Independent recomputation of the cash balance from the same lines. */
  cashBalanceMinor: number;
  /** True when the derived closing equals the independent cash balance. */
  ties: boolean;
}

/** Independent cash balance over the given entries — the statement must tie to this. */
export function cashBalanceFromEntries(entries: CashFlowEntry[], cashCodes: string[]): number {
  let balance = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      if (isCashLine(l, cashCodes)) balance += signed(l);
    }
  }
  return balance;
}

export function buildCashFlowStatement(
  entries: CashFlowEntry[],
  opts: { cashCodes: string[]; openingMinor: number },
): CashFlowStatement {
  const totals: Record<CashFlowCategory, CashFlowCategoryTotal> = {
    operating: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
    investing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
    financing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
  };
  for (const entry of entries) {
    const classified = classifyCashEntry(entry.lines, opts.cashCodes);
    if (!classified) continue;
    const t = totals[classified.category];
    if (classified.cashDeltaMinor >= 0) t.inflowMinor += classified.cashDeltaMinor;
    else t.outflowMinor += -classified.cashDeltaMinor;
    t.netMinor += classified.cashDeltaMinor;
    t.entries += 1;
  }
  const netMinor = totals.operating.netMinor + totals.investing.netMinor + totals.financing.netMinor;
  const closingMinor = opts.openingMinor + netMinor;
  // Independent recomputation: every cash movement must have landed in
  // exactly one category — no drops, no double-counts.
  const cashBalanceMinor = cashBalanceFromEntries(entries, opts.cashCodes);
  return {
    openingMinor: opts.openingMinor,
    operating: totals.operating,
    investing: totals.investing,
    financing: totals.financing,
    netMinor,
    closingMinor,
    cashBalanceMinor,
    ties: netMinor === cashBalanceMinor && closingMinor === opts.openingMinor + cashBalanceMinor,
  };
}
