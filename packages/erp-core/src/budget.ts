/** Pure budget comparison math. Values are minor units in one currency. */

export interface BudgetComparisonInput {
  planMinor: number;
  actualMinor: number;
  committedMinor: number;
}

export interface BudgetComparison {
  planMinor: number;
  actualMinor: number;
  committedMinor: number;
  projectedMinor: number;
  remainingBeforeCommitmentsMinor: number;
  varianceMinor: number;
  utilizationBps: number | null;
}

function assertAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

/** Positive variance means projected spend is over plan. */
export function compareBudget(input: BudgetComparisonInput): BudgetComparison {
  assertAmount(input.planMinor, "plan");
  assertAmount(input.committedMinor, "commitments");
  if (!Number.isSafeInteger(input.actualMinor)) throw new Error("actual must be a safe integer");
  const plan = BigInt(input.planMinor);
  const actual = BigInt(input.actualMinor);
  const committed = BigInt(input.committedMinor);
  const projected = actual + committed;
  const remaining = plan - actual;
  const variance = projected - plan;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if ([projected, remaining, variance].some((value) => value < -max || value > max)) {
    throw new Error("budget comparison exceeds the supported amount range");
  }
  const utilization = input.planMinor === 0 ? null : (() => {
    const numerator = projected * 10_000n;
    const sign = numerator < 0n ? -1n : 1n;
    const absolute = numerator < 0n ? -numerator : numerator;
    const rounded = sign * ((absolute + plan / 2n) / plan);
    return rounded < -max || rounded > max ? null : Number(rounded);
  })();
  return {
    ...input,
    projectedMinor: Number(projected),
    remainingBeforeCommitmentsMinor: Number(remaining),
    varianceMinor: Number(variance),
    utilizationBps: utilization,
  };
}

/** Keep open purchase commitments aligned with PO net value after bills post. */
export function remainingCommitmentMinor(orderedNetMinor: number, billedNetMinor: number): number {
  assertAmount(orderedNetMinor, "ordered commitment");
  assertAmount(billedNetMinor, "billed commitment");
  return Math.max(0, orderedNetMinor - billedNetMinor);
}

/** Round a percentage tax amount half-up without floating point arithmetic. */
export function calculateTaxMinor(taxableMinor: number, rateBasisPoints: number): number {
  if (!Number.isSafeInteger(taxableMinor) || taxableMinor < 0) throw new Error("taxable amount must be a non-negative safe integer");
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) throw new Error("tax rate must be non-negative basis points");
  const numerator = BigInt(taxableMinor) * BigInt(rateBasisPoints);
  const amount = (numerator + 5_000n) / 10_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("tax amount exceeds the supported amount range");
  return Number(amount);
}

/** Apply a non-negative percentage uplift to a money amount with half-up rounding. */
export function applyBasisPointUplift(amountMinor: number, upliftBasisPoints: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error("amount must be a non-negative safe integer");
  if (!Number.isSafeInteger(upliftBasisPoints) || upliftBasisPoints < 0) throw new Error("uplift must be non-negative basis points");
  const scaled = (BigInt(amountMinor) * (10_000n + BigInt(upliftBasisPoints)) + 5_000n) / 10_000n;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("uplifted amount exceeds the supported amount range");
  return Number(scaled);
}

export interface TaxLineAmounts {
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
}

/** Calculate a line from quantity in thousandths and a unit price in minor units. */
export function calculateTaxLine(
  quantityThousandths: number,
  unitPriceMinor: number,
  rateBasisPoints: number,
  priceIncludesTax = false,
): TaxLineAmounts {
  if (!Number.isSafeInteger(quantityThousandths) || quantityThousandths <= 0) throw new Error("quantity must be positive thousandths");
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) throw new Error("unit price must be a non-negative safe integer");
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) throw new Error("tax rate must be non-negative basis points");
  const numerator = BigInt(quantityThousandths) * BigInt(unitPriceMinor);
  const grossOrNet = Number((numerator + 500n) / 1_000n);
  if (!Number.isSafeInteger(grossOrNet)) throw new Error("line amount exceeds the supported amount range");
  if (!priceIncludesTax) {
    const taxMinor = calculateTaxMinor(grossOrNet, rateBasisPoints);
    const grossMinor = grossOrNet + taxMinor;
    if (!Number.isSafeInteger(grossMinor)) throw new Error("line total exceeds the supported amount range");
    return { netMinor: grossOrNet, taxMinor, grossMinor };
  }
  const denominator = 10_000n + BigInt(rateBasisPoints);
  const net = (BigInt(grossOrNet) * 10_000n * 2n + denominator) / (2n * denominator);
  const netMinor = Number(net);
  if (!Number.isSafeInteger(netMinor)) throw new Error("line amount exceeds the supported amount range");
  return { netMinor, taxMinor: grossOrNet - netMinor, grossMinor: grossOrNet };
}

/** Convert open balances at historical and close rates; positive means asset gain. */
export function fxRevaluationDeltaMinor(
  outstandingForeignMinor: number,
  historicalBaseMinor: number,
  closeBaseMinor: number,
): number {
  for (const [value, name] of [
    [outstandingForeignMinor, "foreign outstanding"],
    [historicalBaseMinor, "historical carrying amount"],
    [closeBaseMinor, "close valuation"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  return closeBaseMinor - historicalBaseMinor;
}
