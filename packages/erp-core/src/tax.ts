export interface TaxTotals {
  outputTaxMinor: number;
  inputTaxMinor: number;
}

export interface TaxSettlementDelta {
  outputDeltaMinor: number;
  inputDeltaMinor: number;
  taxDeltaMinor: number;
}

export function calculateTaxSettlementDelta(current: TaxTotals, settled: TaxTotals = { outputTaxMinor: 0, inputTaxMinor: 0 }): TaxSettlementDelta {
  for (const [label, amount] of [
    ["current output tax", current.outputTaxMinor],
    ["current input tax", current.inputTaxMinor],
    ["settled output tax", settled.outputTaxMinor],
    ["settled input tax", settled.inputTaxMinor],
  ] as const) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative safe integer`);
  }
  const outputDeltaMinor = current.outputTaxMinor - settled.outputTaxMinor;
  const inputDeltaMinor = current.inputTaxMinor - settled.inputTaxMinor;
  const taxDeltaMinor = outputDeltaMinor - inputDeltaMinor;
  if (![outputDeltaMinor, inputDeltaMinor, taxDeltaMinor].every(Number.isSafeInteger)) {
    throw new Error("tax settlement delta exceeds the supported amount range");
  }
  return { outputDeltaMinor, inputDeltaMinor, taxDeltaMinor };
}
