/**
 * N14 bank-reconciliation allocation math. A statement line is explained
 * when its signed amount is fully covered by allocations that share its
 * sign; a statement period is reconciled when the unexplained difference
 * is exactly zero. Pure - the caller owns locking and persistence.
 */

export type AllocationKind = "payment" | "entry" | "fee" | "fx_difference";

export interface BankStatementLine {
  id: string;
  /** Signed: positive = money in, negative = money out (bank convention). */
  amountMinor: number;
  status: "unmatched" | "matched" | "excluded";
}

export interface ProposedAllocation {
  kind: AllocationKind;
  amountMinor: number;
}

export interface ReconciliationLine {
  id: string;
  amountMinor: number;
  status: BankStatementLine["status"];
  allocatedMinor: number;
  unexplainedMinor: number;
}

export interface ReconciliationTotals {
  linesMinor: number;
  allocatedMinor: number;
  unexplainedMinor: number;
  reconciled: boolean;
}

export function assertMinor(value: number, field: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${field} must be an integer minor amount, got ${value}`);
}

/** The part of a statement line's money no allocation has explained yet. */
export function lineUnexplained(line: BankStatementLine, allocatedMinor: number): number {
  assertMinor(line.amountMinor, "line amount");
  assertMinor(allocatedMinor, "allocated amount");
  return line.amountMinor - allocatedMinor;
}

/**
 * Validate a proposed set of allocations against one statement line:
 * every allocation must share the line's sign and fit inside what is
 * still unexplained. Returns the allocations to record.
 */
export function planLineAllocations(
  line: BankStatementLine,
  existingAllocatedMinor: number,
  proposed: ProposedAllocation[],
): ProposedAllocation[] {
  assertMinor(existingAllocatedMinor, "existing allocated amount");
  if (line.status === "excluded") {
    throw new Error("an excluded statement line cannot take allocations; unexclude it first");
  }
  if (proposed.length === 0) throw new Error("at least one allocation is required");
  let running = existingAllocatedMinor;
  for (const p of proposed) {
    assertMinor(p.amountMinor, "allocation amount");
    if (p.amountMinor === 0) throw new Error("allocation amount must be nonzero");
    // An allocation explains part of the line's money, so it must move in
    // the line's direction - a positive slice cannot explain a debit line.
    if (line.amountMinor > 0 && p.amountMinor < 0) {
      throw new Error(`allocation direction mismatch: line is money in (${line.amountMinor}), allocation is ${p.amountMinor}`);
    }
    if (line.amountMinor < 0 && p.amountMinor > 0) {
      throw new Error(`allocation direction mismatch: line is money out (${line.amountMinor}), allocation is ${p.amountMinor}`);
    }
    running += p.amountMinor;
    if (Math.abs(running) > Math.abs(line.amountMinor)) {
      throw new Error(
        `allocation exceeds the statement line: line is ${line.amountMinor}, allocations would reach ${running}`,
      );
    }
  }
  return proposed;
}

/** A payment's remaining unallocated amount after the proposed slice. */
export function paymentRemaining(paymentAmountMinor: number, allocatedMinor: number, proposedMinor: number): number {
  assertMinor(paymentAmountMinor, "payment amount");
  assertMinor(allocatedMinor, "allocated amount");
  assertMinor(proposedMinor, "proposed amount");
  const remaining = paymentAmountMinor - allocatedMinor - proposedMinor;
  if (remaining < 0) {
    throw new Error(
      `payment over-allocated: payment is ${paymentAmountMinor}, allocations would reach ${allocatedMinor + proposedMinor}`,
    );
  }
  return remaining;
}

/**
 * The reconciled definition: group every non-excluded line with its
 * allocations; the statement period is reconciled only when the total
 * unexplained difference is exactly zero.
 */
export function reconciliationTotals(
  lines: BankStatementLine[],
  allocatedByLine: Map<string, number>,
): { lines: ReconciliationLine[]; totals: ReconciliationTotals } {
  const detailed: ReconciliationLine[] = [];
  let linesMinor = 0;
  let allocatedMinor = 0;
  for (const line of lines) {
    if (line.status === "excluded") {
      detailed.push({ ...line, allocatedMinor: 0, unexplainedMinor: 0 });
      continue;
    }
    const allocated = allocatedByLine.get(line.id) ?? 0;
    const unexplained = lineUnexplained(line, allocated);
    if (Math.abs(allocated) > Math.abs(line.amountMinor)) {
      throw new Error(`line ${line.id} is over-allocated: ${allocated} against ${line.amountMinor}`);
    }
    detailed.push({ ...line, allocatedMinor: allocated, unexplainedMinor: unexplained });
    linesMinor += line.amountMinor;
    allocatedMinor += allocated;
  }
  const unexplainedMinor = linesMinor - allocatedMinor;
  return {
    lines: detailed,
    totals: { linesMinor, allocatedMinor, unexplainedMinor, reconciled: unexplainedMinor === 0 },
  };
}
