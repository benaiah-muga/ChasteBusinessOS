import { afterEach, describe, expect, it } from "vitest";
import { activeCurrencyCode, formatMoney, formatMoneyWhole, minorToInputIn, setActiveCurrency, toMinor, toMinorIn } from "./format";
import { formatMoneyIn } from "./prefs";

afterEach(() => {
  setActiveCurrency("USD");
});

describe("money presentation", () => {
  it("renders USD with two decimals", () => {
    setActiveCurrency("USD");
    expect(formatMoney(123_456)).toBe("$1,234.56");
    expect(formatMoney(-50)).toBe("−$0.50");
  });

  it("renders UGX with zero decimals (ISO 4217 exponent 0)", () => {
    setActiveCurrency("UGX");
    expect(formatMoney(8_000_000)).toBe("USh 8,000,000");
    expect(formatMoney(-250)).toBe("−USh 250");
    expect(activeCurrencyCode()).toBe("UGX");
  });

  it("renders KES with its friendly symbol and two decimals", () => {
    setActiveCurrency("KES");
    expect(formatMoney(1_000)).toBe("KSh 10.00");
  });

  it("falls back to the code as the symbol for unknown currencies", () => {
    setActiveCurrency("JPY");
    expect(formatMoney(1_000)).toContain("JPY 1,000");
  });

  it("whole rendering drops decimals but keeps zero-decimal currencies exact", () => {
    setActiveCurrency("USD");
    expect(formatMoneyWhole(123_456)).toBe("$1,235");
    setActiveCurrency("UGX");
    expect(formatMoneyWhole(8_000_000)).toBe("USh 8,000,000");
  });

  it("parses input in presentation-currency major units", () => {
    setActiveCurrency("USD");
    expect(toMinor("12.34")).toBe(1_234);
    setActiveCurrency("UGX");
    expect(toMinor("80000")).toBe(80_000);
    expect(toMinor("")).toBe(0);
  });
  it("rejects unknown currency codes and keeps the previous style", () => {
    setActiveCurrency("USD");
    expect(setActiveCurrency("nope")).toBe(false);
    expect(activeCurrencyCode()).toBe("USD");
  });

  it("formatMoneyIn honors minor units of the given code", () => {
    expect(formatMoneyIn("UGX", 8_000_000)).toBe("USh 8,000,000");
    expect(formatMoneyIn("USD", 123_456)).toBe("$1,234.56");
  });

  it("parses and prefills amounts in the document currency, including zero-decimal currencies", () => {
    expect(toMinorIn("UGX", "1200")).toBe(1_200);
    expect(toMinorIn("USD", "12.34")).toBe(1_234);
    expect(toMinorIn("USD", "1.005")).toBe(101);
    expect(toMinorIn("USD", ".5")).toBe(50);
    expect(minorToInputIn("UGX", 1_200)).toBe("1200");
    expect(minorToInputIn("USD", 1_234)).toBe("12.34");
  });

  it("rejects malformed currency codes and unsafe entered amounts", () => {
    expect(Number.isNaN(toMinorIn("b@d", "10"))).toBe(true);
    expect(Number.isNaN(toMinorIn("UGX", "9007199254740992"))).toBe(true);
    expect(Number.isNaN(toMinorIn("USD", "1e3"))).toBe(true);
    expect(minorToInputIn("UGX", Number.MAX_SAFE_INTEGER + 1)).toBe("");
  });
});
