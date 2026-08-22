import type { AccountType } from "./posting";

export interface CoderAccount {
  code: string;
  name: string;
  type: AccountType;
}

export interface CodingMatch {
  code: string;
  /** 0 = no signal (fallback), higher = stronger lexical evidence. */
  score: number;
  matchedOn: string[];
}

/**
 * Domain phrases that should steer a line toward the account whose name
 * contains the paired token, regardless of how the vendor words the line.
 */
const SYNONYMS: Record<string, string[]> = {
  rent: ["rent", "lease", "premises"],
  utilities: ["electricity", "water", "power", "utilities"],
  internet: ["internet", "broadband", "wifi"],
  telephone: ["phone", "telephone", "airtime", "data bundle"],
  insurance: ["insurance", "premium"],
  salaries: ["salary", "salaries", "wages", "payroll", "staff cost"],
  marketing: ["marketing", "advertis", "promo"],
  professional: ["legal", "audit", "consult", "professional fee", "accounting fee"],
  repair: ["repair", "maintenance", "servicing"],
  transport: ["transport", "freight", "delivery", "courier", "shipping"],
  fuel: ["fuel", "diesel", "petrol", "gasoline"],
  licenses: ["license", "licence", "permit", "subscription", "saas"],
  bank: ["bank charge", "transaction fee", "processing fee"],
  goods: ["cogs", "coffee", "beans", "merchandise", "resale", "stock purchase"],
  expenses: ["office", "supplies", "stationery", "consumables", "general"],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/** Expands description tokens with synonyms of the terms they contain. */
function expandTokens(tokens: string[]): string[] {
  const out = [...tokens];
  for (const [canonical, synonyms] of Object.entries(SYNONYMS)) {
    for (const syn of [canonical, ...synonyms]) {
      if (tokens.some((t) => t === syn || t.includes(syn))) out.push(canonical);
    }
  }
  return out;
}

export const FALLBACK_EXPENSE_CODE = "6000";

/**
 * Deterministic expense-account suggestion for one document line.
 * Scores each candidate by shared tokens between the line description and
 * the account name (synonym-expanded); ties break on ascending code so the
 * result is stable regardless of input order. Never throws.
 */
export function suggestExpenseAccount(description: string, accounts: CoderAccount[]): CodingMatch {
  const expenses = accounts.filter((a) => a.type === "expense");
  const fallback =
    expenses.find((a) => a.code === FALLBACK_EXPENSE_CODE) ?? expenses[0] ?? { code: FALLBACK_EXPENSE_CODE, name: "", type: "expense" as const };

  const descTokens = new Set(expandTokens(tokenize(description)));
  let best: CodingMatch = { code: fallback.code, score: 0, matchedOn: [] };

  for (const account of expenses) {
    const nameTokens = tokenize(account.name);
    const matchedOn: string[] = [];
    for (const t of descTokens) {
      if (nameTokens.some((n) => n === t || n.includes(t) || t.includes(n))) matchedOn.push(t);
    }
    const score = matchedOn.length;
    if (score > best.score || (score === best.score && score > 0 && account.code < best.code)) {
      best = { code: account.code, score, matchedOn };
    }
  }
  return best;
}
