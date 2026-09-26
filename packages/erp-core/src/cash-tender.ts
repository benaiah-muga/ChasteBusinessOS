export interface CashTenderResult {
  tenderedMinor: number;
  changeGivenMinor: number;
}

export function calculateCashTender(totalMinor: number, tenderedMinor = totalMinor): CashTenderResult {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
    throw new RangeError("sale total must be a positive safe integer in minor units");
  }
  if (!Number.isSafeInteger(tenderedMinor) || tenderedMinor < totalMinor) {
    throw new RangeError("cash received must be a safe integer at least equal to the sale total");
  }
  return { tenderedMinor, changeGivenMinor: tenderedMinor - totalMinor };
}
