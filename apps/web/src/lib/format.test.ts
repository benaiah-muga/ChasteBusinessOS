import { afterEach, describe, expect, it } from "vitest";
import { formatMoney, formatMoneyWhole, setDisplayCurrency } from "./format";

afterEach(() => setDisplayCurrency("USD"));

describe("display currency", () => {
  it("renders shared money helpers with the selected currency symbol", () => {
    setDisplayCurrency("UGX");
    expect(formatMoney(125000)).toBe("USh1,250.00");
    expect(formatMoneyWhole(-125000)).toBe("−USh1,250");
  });

  it("falls back to dollars for unsupported display codes", () => {
    setDisplayCurrency("XYZ");
    expect(formatMoney(100)).toBe("$1.00");
  });
});
