import type { AccountType } from "./posting";

export type { AccountType };

export interface AccountBalance {
  code: string;
  name: string;
  type: AccountType;
  debitMinor: number;
  creditMinor: number;
}

export interface IncomeStatement {
  revenueMinor: number;
  expenseMinor: number;
  netIncomeMinor: number;
  lines: { code: string; name: string; amountMinor: number }[];
}

/** Natural balance side per account type. */
function signedBalance(a: AccountBalance): number {
  const net = a.debitMinor - a.creditMinor;
  switch (a.type) {
    case "asset":
    case "expense":
      return net;
    case "liability":
    case "equity":
    case "income":
      return -net;
  }
}

/** P&L over income and expense accounts. Pure. */
export function computeIncomeStatement(balances: AccountBalance[]): IncomeStatement {
  let revenue = 0;
  let expense = 0;
  const lines: IncomeStatement["lines"] = [];
  for (const a of balances) {
    if (a.type === "income") {
      const amt = signedBalance(a);
      revenue += amt;
      lines.push({ code: a.code, name: a.name, amountMinor: amt });
    } else if (a.type === "expense") {
      const amt = signedBalance(a);
      expense += amt;
      lines.push({ code: a.code, name: a.name, amountMinor: amt });
    }
  }
  return { revenueMinor: revenue, expenseMinor: expense, netIncomeMinor: revenue - expense, lines };
}

export interface BalanceSheet {
  assetsMinor: number;
  liabilitiesMinor: number;
  equityMinor: number;
  /** Net income rolls into equity until formally closed to retained earnings. */
  retainedResultMinor: number;
  balanced: boolean;
  sections: Record<"asset" | "liability" | "equity", { code: string; name: string; amountMinor: number }[]>;
}

/**
 * Balance sheet with the accounting equation enforced as output:
 * assets = liabilities + equity + current result.
 * `balanced: false` means the underlying ledger is corrupt, never ignore it.
 */
export function computeBalanceSheet(balances: AccountBalance[]): BalanceSheet {
  const sections: BalanceSheet["sections"] = { asset: [], liability: [], equity: [] };
  let assets = 0;
  let liabilities = 0;
  let equity = 0;

  for (const a of balances) {
    const amt = signedBalance(a);
    if (a.type === "asset") {
      assets += amt;
      if (amt !== 0) sections.asset.push({ code: a.code, name: a.name, amountMinor: amt });
    } else if (a.type === "liability") {
      liabilities += amt;
      if (amt !== 0) sections.liability.push({ code: a.code, name: a.name, amountMinor: amt });
    } else if (a.type === "equity") {
      equity += amt;
      if (amt !== 0) sections.equity.push({ code: a.code, name: a.name, amountMinor: amt });
    }
  }

  const pnl = computeIncomeStatement(balances);
  const retainedResult = pnl.netIncomeMinor;
  const right = liabilities + equity + retainedResult;

  return {
    assetsMinor: assets,
    liabilitiesMinor: liabilities,
    equityMinor: equity,
    retainedResultMinor: retainedResult,
    balanced: Math.abs(assets - right) < 1,
    sections,
  };
}
