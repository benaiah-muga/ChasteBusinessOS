/**
 * Credit-limit evaluation for sales-order confirmation (M9, ADR 0036).
 *
 * Pure business rule: given the customer's currently open receivables and
 * the candidate order total, decide whether confirming keeps them inside
 * their configured ceiling. A null limit means "no credit control" — the
 * honest default for walk-in customers.
 *
 * All amounts are integer minor units. This function performs no IO and
 * never throws on in-range inputs; callers refuse with the returned
 * decision rendered into an actionable message.
 */
export interface CreditEvaluation {
  /** "no-limit" = no ceiling configured; "within" = confirm; "over" = refuse. */
  decision: "no-limit" | "within" | "over";
  /**
   * Room left under the limit after this order (null when no limit).
   * Negative when over — the exact overshoot, so messages can say how
   * much payment or headroom is needed.
   */
  headroomMinor: number | null;
  /** The limit that was evaluated against (null when no limit). */
  creditLimitMinor: number | null;
}

export function evaluateCredit(
  openArMinor: number,
  orderTotalMinor: number,
  creditLimitMinor: number | null,
): CreditEvaluation {
  if (creditLimitMinor === null) return { decision: "no-limit", headroomMinor: null, creditLimitMinor: null };
  const headroomMinor = creditLimitMinor - openArMinor - orderTotalMinor;
  return {
    decision: headroomMinor >= 0 ? "within" : "over",
    headroomMinor,
    creditLimitMinor,
  };
}
