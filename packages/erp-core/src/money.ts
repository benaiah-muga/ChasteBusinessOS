/** Money is always integer minor units. Never floats. */
export function formatMinor(amountMinor: number, currency = "USD"): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${major}.${minor} ${currency}`;
}

export function parseMajorToMinor(input: string): number {
  const m = input.trim().match(/^(-?\d+)(?:\.(\d{1,2}))?$/);
  if (!m?.[1]) throw new Error(`invalid money amount: ${input}`);
  const [, major, minor] = m;
  const cents = minor ? Number(minor.padEnd(2, "0")) : 0;
  const value = Number(major) * 100 + (value_sign(major) ? -cents : cents);
  if (!Number.isSafeInteger(value)) throw new Error("amount out of range");
  return value;
}

function value_sign(major: string): boolean {
  return major.startsWith("-");
}
