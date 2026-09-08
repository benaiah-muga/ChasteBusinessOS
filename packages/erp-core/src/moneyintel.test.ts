import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findDuplicatePayments, type PaymentRecord } from "./moneyintel.js";

/** Deterministic double-payment detection: order-independent, window-honest. */

const base = new Date(Date.UTC(2026, 7, 1));

function pay(id: string, invoiceId: string, amountMinor: number, days: number): PaymentRecord {
  return { id, invoiceId, amountMinor, receivedAt: new Date(base.getTime() + days * 86_400_000) };
}

describe("duplicate payment detection (M10.3)", () => {
  it("flags a same-amount repeat inside the window, on the same invoice only", () => {
    const payments = [
      pay("a", "inv-1", 5_000, 0),
      pay("b", "inv-1", 5_000, 2),
      pay("c", "inv-2", 5_000, 3), // different invoice — never flags
      pay("d", "inv-1", 6_000, 1), // different amount — never flags
      pay("e", "inv-1", 5_000, 30), // outside window — never flags
    ];
    const dupes = findDuplicatePayments(payments);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toMatchObject({ paymentIdA: "a", paymentIdB: "b", invoiceId: "inv-1", amountMinor: 5_000, daysApart: 2 });
  });

  it("property: output is order-independent and symmetric", () => {
    const arb = fc
      .array(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 6 }),
          invoiceId: fc.constantFrom("i1", "i2", "i3"),
          amountMinor: fc.constantFrom(1_000, 2_000, 3_000),
          day: fc.nat(10),
        }),
        { maxLength: 12 },
      )
      .map((rows) => rows.map((r, i) => pay(`${r.id}-${i}`, r.invoiceId, r.amountMinor, r.day)));
    fc.assert(
      fc.property(arb, fc.nat(5), (payments, _seed) => {
        const a = findDuplicatePayments(payments);
        const shuffled = [...payments].reverse();
        const b = findDuplicatePayments(shuffled);
        expect(a).toEqual(b);
        for (const d of a) {
          expect(d.paymentIdA < d.paymentIdB).toBe(true);
        }
      }),
    );
  });

  it("property: identical pairs always flag, distinct invoices never do", () => {
    const identical = [pay("x", "same", 700, 0), pay("y", "same", 700, 1)];
    expect(findDuplicatePayments(identical)).toHaveLength(1);
    const distinct = [pay("x", "one", 700, 0), pay("y", "two", 700, 0)];
    expect(findDuplicatePayments(distinct)).toHaveLength(0);
  });

  it("window is honest: day 7 flags, day 8 does not", () => {
    const edge = [pay("a", "i", 100, 0), pay("b", "i", 100, 7)];
    expect(findDuplicatePayments(edge)).toHaveLength(1);
    const outside = [pay("a", "i", 100, 0), pay("b", "i", 100, 8)];
    expect(findDuplicatePayments(outside)).toHaveLength(0);
  });
});
