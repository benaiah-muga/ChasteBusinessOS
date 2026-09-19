/**
 * One document-balance contract (N11). Every consumer - payment gating,
 * aging, dashboards, support lookups - derives outstanding from this, so a
 * customer credit can never make one surface say 60 is due while another
 * accepts 100. All values are integer minor units; the contract throws on
 * anything else rather than laundering bad money math.
 */

/** Documents in these states must not receive money. */
export const MONEY_INELIGIBLE_STATUSES = new Set(["draft", "void"]);

export interface DocumentMoneyState {
  totalMinor: number;
  paidMinor: number;
  creditedMinor: number;
}

export interface DocumentBalance extends DocumentMoneyState {
  /** What can still be collected or paid: total − credited − paid, floored at zero. */
  outstandingMinor: number;
  /** How much the document is over-allocated (credits + payments beyond total). */
  overallocatedMinor: number;
  /** Credits plus payments cover the gross total. */
  fullySettled: boolean;
}

function assertMinor(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer minor amount, got ${value}`);
  }
}

export function documentBalance(state: DocumentMoneyState): DocumentBalance {
  assertMinor(state.totalMinor, "totalMinor");
  assertMinor(state.paidMinor, "paidMinor");
  assertMinor(state.creditedMinor, "creditedMinor");
  const allocated = state.paidMinor + state.creditedMinor;
  return {
    ...state,
    outstandingMinor: Math.max(0, state.totalMinor - allocated),
    overallocatedMinor: Math.max(0, allocated - state.totalMinor),
    fullySettled: allocated >= state.totalMinor,
  };
}

export type PaymentVerdict = { ok: true; balance: DocumentBalance } | { ok: false; reason: string };

/**
 * Whether `amountMinor` may be applied to the document right now. Credits
 * count against the collectible amount: a 100 invoice with a 40 credit can
 * accept at most 60, whatever any legacy surface displays.
 */
export function canAcceptPayment(state: DocumentMoneyState, status: string, amountMinor: number): PaymentVerdict {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, reason: `payment amount must be a positive integer minor amount, got ${amountMinor}` };
  }
  if (MONEY_INELIGIBLE_STATUSES.has(status)) {
    return { ok: false, reason: `document is ${status} and cannot receive money` };
  }
  const balance = documentBalance(state);
  if (amountMinor > balance.outstandingMinor) {
    return {
      ok: false,
      reason: `overpayment: outstanding is ${balance.outstandingMinor} minor (total ${balance.totalMinor}, credited ${balance.creditedMinor}, paid ${balance.paidMinor})`,
    };
  }
  return { ok: true, balance };
}
