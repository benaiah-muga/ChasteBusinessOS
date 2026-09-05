/**
 * Expense intelligence primitives (M11, ADR 0038).
 *
 * Deterministic, advisory: category suggestions come from a fixed keyword
 * table (rules-first — the human always overrides); duplicate-claim
 * detection is pairwise with stable ordering, like payment duplicates.
 */

export type ExpenseCategory = "travel" | "meals" | "supplies" | "software" | "other";

const CATEGORY_KEYWORDS: Array<[ExpenseCategory, string[]]> = [
  ["travel", ["taxi", "flight", "airline", "hotel", "train", "mileage", "uber", "parking"]],
  ["meals", ["restaurant", "lunch", "dinner", "breakfast", "coffee", "catering"]],
  ["software", ["saas", "subscription", "license", "licence", "hosting", "domain"]],
  ["supplies", ["office", "stationery", "printer", "paper", "ink", "furniture"]],
];

/** Rules-first categorization from the memo. Deterministic; human overrides. */
export function suggestExpenseCategory(memo: string): ExpenseCategory {
  const text = memo.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => text.includes(k))) return category;
  }
  return "other";
}

export interface ExpenseClaimRecord {
  id: string;
  claimantUserId: string;
  amountMinor: number;
  submittedAt: Date;
}

export interface DuplicateClaimPair {
  claimIdA: string;
  claimIdB: string;
  claimantUserId: string;
  amountMinor: number;
  daysApart: number;
}

/** Same claimant, same amount, inside the window — the classic double submit. */
export function findDuplicateExpenseClaims(claims: ExpenseClaimRecord[], windowDays = 3): DuplicateClaimPair[] {
  const out: DuplicateClaimPair[] = [];
  const sorted = [...claims].sort(
    (a, b) => a.claimantUserId.localeCompare(b.claimantUserId) || a.id.localeCompare(b.id),
  );
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.claimantUserId !== b.claimantUserId) break;
      if (a.amountMinor !== b.amountMinor) continue;
      const daysApart = Math.abs(a.submittedAt.getTime() - b.submittedAt.getTime()) / 86_400_000;
      if (daysApart > windowDays) continue;
      const [claimIdA, claimIdB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      out.push({ claimIdA, claimIdB, claimantUserId: a.claimantUserId, amountMinor: a.amountMinor, daysApart: Math.round(daysApart) });
    }
  }
  return out.sort(
    (x, y) =>
      x.claimantUserId.localeCompare(y.claimantUserId) ||
      x.claimIdA.localeCompare(y.claimIdA) ||
      x.claimIdB.localeCompare(y.claimIdB),
  );
}

/** Per-category spend ceilings; null when the category has no policy. */
export function evaluateExpensePolicy(
  category: string,
  amountMinor: number,
  policies: Array<{ category: string; limitMinor: number }>,
): { overLimit: boolean; limitMinor: number | null } {
  const hit = policies.find((p) => p.category === category);
  if (!hit) return { overLimit: false, limitMinor: null };
  return { overLimit: amountMinor > hit.limitMinor, limitMinor: hit.limitMinor };
}
