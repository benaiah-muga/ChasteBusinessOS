/**
 * Internal transfers move quantity between locations without touching
 * value: a transfer relocates stock, it never acquires or consumes it.
 * Every leg is written as a pair of ledger deltas with reason "transfer",
 * and valuation replay treats those legs as value-neutral (see
 * replayValuation) — otherwise a round trip would drift the moving
 * average by rounding residue.
 */

export interface TransferLeg {
  /** Signed delta for one location: negative at the source, positive at the destination. */
  quantityDelta: number;
}

/**
 * The paired ledger deltas for one confirmed transfer line. The source leg
 * is the negation of the destination leg; total quantity is conserved by
 * construction.
 */
export function transferLegs(quantityThousandths: number): { out: number; inn: number } {
  if (!Number.isInteger(quantityThousandths) || quantityThousandths <= 0) {
    throw new Error("transfer quantity must be a positive integer (thousandths)");
  }
  return { out: -quantityThousandths, inn: quantityThousandths };
}

/**
 * A source location may never go below zero: availability is checked
 * against the same ledger inside the same transaction by the caller; this
 * refuses anyway (the ledger refuses to be corrupted, whatever the caller).
 */
export function assertTransferFeasible(
  sourceOnHandThousandths: number,
  quantityThousandths: number,
): void {
  if (quantityThousandths > sourceOnHandThousandths) {
    throw new Error(
      `insufficient stock at source location: ${sourceOnHandThousandths} thousandths on hand, ${quantityThousandths} requested`,
    );
  }
}

/** Two-bucket conservation check used by tests and cycle-count sanity. */
export function transferConserved(
  before: { source: number; destination: number },
  after: { source: number; destination: number },
): boolean {
  return (
    before.source + before.destination === after.source + after.destination &&
    after.source >= 0 &&
    after.destination >= 0
  );
}
