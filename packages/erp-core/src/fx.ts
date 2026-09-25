/**
 * Multi-currency arithmetic (ADR 0021 phases 2-3).
 *
 * Rules that keep the ledger trustworthy:
 *  - FX rates are exact integer ratios (num/den), never floats; a decimal
 *    string like "1.0875" converts losslessly through BigInt reduction.
 *  - Foreign amounts stay integer minor units in their own currency end to
 *    end; conversion happens once, at a captured rate, with deterministic
 *    half-up rounding on magnitude.
 *  - Every function here is pure: property tests pin the invariants.
 */

export interface FxRate {
  /** 1 unit of the QUOTE currency = num/den units of the BASE currency. */
  num: number;
  den: number;
}

/** ISO-4217 minor-unit exponents that differ from the ubiquitous 2. */
const SPECIAL_MINOR_UNITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  UGX: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  IQD: 3,
  LYD: 3,
};

/** Minor units for a currency code; null when the code is not recognized. */
export function currencyMinorUnits(code: string): number | null {
  const up = code.toUpperCase();
  if (!/^[A-Z]{3}$/.test(up)) return null;
  return SPECIAL_MINOR_UNITS[up] ?? 2;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a < 0n ? -a : a;
}

/**
 * Parses a positive decimal rate string into an exact reduced fraction.
 * Accepts up to 12 fractional digits; rejects anything that could surprise
 * (negatives, zero, exponent notation). Returns null instead of throwing so
 * capability schemas can produce clean validation errors.
 */
export function fxRateFromDecimal(input: string): FxRate | null {
  const s = input.trim();
  if (!/^\d{1,9}(\.\d{1,12})?$/.test(s)) return null;
  const [intPart, fracPart = ""] = s.split(".");
  const den = 10n ** BigInt(fracPart.length);
  const raw = BigInt((intPart || "0") + fracPart);
  if (raw === 0n) return null;
  const d = gcd(raw, den);
  const num = raw / d;
  const reducedDen = den / d;
  if (num > BigInt(Number.MAX_SAFE_INTEGER) || reducedDen > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { num: Number(num), den: Number(reducedDen) };
}

/** Formats a ratio back to a plain decimal string (audit display), ≤12 dp. */
export function fxRateToDecimal(rate: FxRate): string {
  const N = BigInt(rate.num);
  const D = BigInt(rate.den);
  const whole = N / D;
  let n = N % D;
  if (n === 0n) return whole.toString();
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  let precision = 12;
  while (precision > 0 && (whole + 1n) * 10n ** BigInt(precision) > maxSafe) precision -= 1;
  let digits = "";
  for (let i = 0; i < precision && n !== 0n; i += 1) {
    n *= 10n;
    digits += (n / D).toString();
    n %= D;
  }
  return `${whole}.${digits.replace(/0+$/, "")}`;
}

/** Multiplies an integer amount by an exact ratio; half-up on magnitude.
 *  Returns quotient and the *post-rounding* remainder so
 *  result*den + sign(remainder)*|remainder| reconstructs amount*num exactly. */
export function applyRate(
  amountMinor: number,
  rate: FxRate,
): { result: number; remainder: number } {
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(rate.num) || !Number.isSafeInteger(rate.den) || rate.num <= 0 || rate.den <= 0) {
    throw new Error("Amounts must be safe integers and FX rates must be positive safe integer ratios");
  }
  const A = BigInt(Math.trunc(amountMinor));
  const D = BigInt(rate.den);
  const raw = A * BigInt(rate.num);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const sign = negative ? -1n : 1n;
  const q = abs / D;
  const r = abs % D;
  if (r * 2n >= D) {
    const result = sign * (q + 1n);
    const remainder = sign * (r - D);
    if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("FX result exceeds the supported amount range");
    return { result: Number(result), remainder: Number(remainder) };
  }
  const result = sign * q;
  const remainder = sign * r;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("FX result exceeds the supported amount range");
  return { result: Number(result), remainder: Number(remainder) };
}

/** Converts foreign minor units to base minor units at a major-unit FX rate. */
export function toBaseMinor(
  foreignMinor: number,
  rate: FxRate,
  quoteCurrency = "USD",
  baseCurrency = "USD",
): number {
  const quoteUnits = currencyMinorUnits(quoteCurrency);
  const baseUnits = currencyMinorUnits(baseCurrency);
  if (quoteUnits === null || baseUnits === null) throw new Error("unknown currency code for FX conversion");
  if (!Number.isSafeInteger(foreignMinor) || !Number.isSafeInteger(rate.num) || !Number.isSafeInteger(rate.den) || rate.num <= 0 || rate.den <= 0) {
    throw new Error("Amounts must be safe integers and FX rates must be positive safe integer ratios");
  }
  const numerator = BigInt(foreignMinor) * BigInt(rate.num) * 10n ** BigInt(baseUnits);
  const denominator = BigInt(rate.den) * 10n ** BigInt(quoteUnits);
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let converted = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) converted += 1n;
  if (negative) converted = -converted;
  if (converted > BigInt(Number.MAX_SAFE_INTEGER) || converted < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("FX result exceeds the supported amount range");
  }
  return Number(converted);
}

/**
 * Realized gain/loss in base minor units when an amount invoiced at one
 * rate settles at another. Positive = gain.
 */
export function realizedGainLoss(
  foreignMinor: number,
  invoiceRate: FxRate,
  settleRate: FxRate,
  quoteCurrency = "USD",
  baseCurrency = "USD",
): number {
  return toBaseMinor(foreignMinor, settleRate, quoteCurrency, baseCurrency) - toBaseMinor(foreignMinor, invoiceRate, quoteCurrency, baseCurrency);
}
