/**
 * Inventory quantities are integers in thousandths of a unit (same
 * convention as invoice quantities). The stock ledger is append-only;
 * on-hand is always the derived sum. Cost uses a moving average that only
 * advances on inward movements.
 */

export interface StockMovement {
  quantityDelta: number; // signed thousandths: +in / −out
}

export function onHand(movements: StockMovement[]): number {
  return movements.reduce((sum, m) => sum + m.quantityDelta, 0);
}

export interface CostedMovement extends StockMovement {
  /** Unit cost for inward movements (minor units per unit). */
  unitCostMinor?: number | undefined;
  /** Quantity sold out (positive number), for outward movements. */
  quantityOut?: number | undefined;
  /**
   * Transfer legs relocate quantity between locations without acquiring or
   * consuming value; valuation replay skips them entirely so round trips
   * cannot drift the moving average (ADR 0033).
   */
  valueNeutral?: boolean | undefined;
}

export interface ValuationState {
  quantityOnHand: number; // thousandths
  totalValueMinor: number;
}

export const EMPTY_VALUATION: ValuationState = {
  quantityOnHand: 0,
  totalValueMinor: 0,
};

/** Unit cost implied by the current valuation (minor units per whole unit). */
export function averageUnitCost(state: ValuationState): number {
  if (state.quantityOnHand <= 0) return 0;
  return Math.round((state.totalValueMinor * 1000) / state.quantityOnHand);
}

/**
 * Applies one movement to a valuation state.
 * Inward: value grows by qty × unit cost. Outward: value leaves
 * proportionally, which is the moving-average method without storing an
 * averaged number that would compound rounding error. Never goes negative;
 * callers must validate availability first, this refuses anyway.
 */
export function applyMovement(state: ValuationState, m: CostedMovement): ValuationState {
  if (m.quantityDelta > 0) {
    const cost = m.unitCostMinor ?? averageUnitCost(state);
    return {
      quantityOnHand: state.quantityOnHand + m.quantityDelta,
      totalValueMinor: state.totalValueMinor + Math.round((m.quantityDelta * cost) / 1000),
    };
  }
  if (m.quantityDelta < 0) {
    const out = -m.quantityDelta;
    if (out > state.quantityOnHand) throw new Error("insufficient stock");
    const valueOut =
      state.quantityOnHand === 0 ? 0 : Math.round((state.totalValueMinor * out) / state.quantityOnHand);
    return {
      quantityOnHand: state.quantityOnHand - out,
      totalValueMinor: state.totalValueMinor - valueOut,
    };
  }
  return state;
}

export function needsReorder(quantityOnHand: number, reorderPoint: number): boolean {
  return reorderPoint > 0 && quantityOnHand <= reorderPoint;
}

/**
 * Replays an ordered movement history into the current valuation state.
 * The stock ledger is append-only, so on-hand value is always derivable;
 * outward movements without stored cost leave proportionally from whatever
 * value the replay has accumulated so far.
 */
export function replayValuation(history: readonly CostedMovement[]): ValuationState {
  let state = EMPTY_VALUATION;
  for (const m of history) {
    // Transfer legs relocate quantity without value effect (ADR 0033).
    if (m.valueNeutral) {
      state = { ...state, quantityOnHand: state.quantityOnHand + m.quantityDelta };
      continue;
    }
    const delta = m.quantityDelta;
    if (delta > 0) {
      state = applyMovement(state, { quantityDelta: delta, unitCostMinor: m.unitCostMinor });
    } else if (delta < 0) {
      state = applyMovement(state, { quantityDelta: delta });
    }
  }
  return state;
}

// ── Three-way match ─────────────────────────────────────────────────────

export interface MatchLineInput {
  orderedQty: number; // thousandths
  receivedQty: number; // thousandths
  billedQty: number; // thousandths
  poUnitPriceMinor: number;
  billUnitPriceMinor: number;
}

export interface MatchViolation {
  kind: "overbilled_qty" | "price_mismatch" | "unreceived_bill";
  detail: string;
}

/** Default price tolerance: 2% either way covers freight adjustments, not fraud. */
export const PRICE_TOLERANCE_PCT = 2;

/**
 * Classic three-way check for one line: purchase order ↔ goods receipt ↔ bill.
 * You may not bill more than was received, more than was ordered, or at a
 * price that drifts past tolerance from the ordered price.
 */
export function matchThreeWay(line: MatchLineInput): MatchViolation[] {
  const violations: MatchViolation[] = [];
  if (line.billedQty > line.receivedQty) {
    violations.push({
      kind: "unreceived_bill",
      detail: `billed ${line.billedQty} exceeds received ${line.receivedQty}`,
    });
  }
  if (line.billedQty > line.orderedQty) {
    violations.push({
      kind: "overbilled_qty",
      detail: `billed ${line.billedQty} exceeds ordered ${line.orderedQty}`,
    });
  }
  const expected = Math.round((line.poUnitPriceMinor * (100 - PRICE_TOLERANCE_PCT)) / 100);
  const maxAllowed = Math.round((line.poUnitPriceMinor * (100 + PRICE_TOLERANCE_PCT)) / 100);
  if (
    line.billUnitPriceMinor > 0 &&
    (line.billUnitPriceMinor < expected || line.billUnitPriceMinor > maxAllowed)
  ) {
    violations.push({
      kind: "price_mismatch",
      detail: `bill price ${line.billUnitPriceMinor} outside ${PRICE_TOLERANCE_PCT}% of ordered ${line.poUnitPriceMinor}`,
    });
  }
  return violations;
}
