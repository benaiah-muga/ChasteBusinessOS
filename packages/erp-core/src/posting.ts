export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface JournalLineInput {
  accountCode: string;
  debitMinor: number;
  creditMinor: number;
}

export interface JournalEntryInput {
  memo: string;
  lines: JournalLineInput[];
}

export class UnbalancedEntryError extends Error {}

/**
 * The invariant that makes the books trustworthy: debits equal credits.
 * Throws rather than returning — an unbalanced entry must never exist.
 */
export function assertBalanced(entry: JournalEntryInput): void {
  if (entry.lines.length < 2) throw new UnbalancedEntryError("entry needs at least two lines");
  let debits = 0;
  let credits = 0;
  for (const line of entry.lines) {
    if (line.debitMinor < 0 || line.creditMinor < 0) {
      throw new UnbalancedEntryError("negative amounts are not allowed; swap debit/credit");
    }
    if (line.debitMinor > 0 && line.creditMinor > 0) {
      throw new UnbalancedEntryError("a line cannot be both debit and credit");
    }
    if (line.debitMinor === 0 && line.creditMinor === 0) {
      throw new UnbalancedEntryError("empty line");
    }
    debits += line.debitMinor;
    credits += line.creditMinor;
  }
  if (debits !== credits) {
    throw new UnbalancedEntryError(`unbalanced entry: debits ${debits} != credits ${credits}`);
  }
}

/** Standard chart of accounts seeded for new orgs. */
export const DEFAULT_CHART_OF_ACCOUNTS: { code: string; name: string; type: AccountType }[] = [
  { code: "1000", name: "Cash", type: "asset" },
  { code: "1100", name: "Accounts Receivable", type: "asset" },
  { code: "1200", name: "Inventory", type: "asset" },
  { code: "2000", name: "Accounts Payable", type: "liability" },
  { code: "2100", name: "Sales Tax Payable", type: "liability" },
  { code: "2200", name: "Payroll Liabilities", type: "liability" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity" },
  { code: "4000", name: "Sales Revenue", type: "income" },
  { code: "5000", name: "Cost of Goods Sold", type: "expense" },
  { code: "6000", name: "Operating Expenses", type: "expense" },
];
