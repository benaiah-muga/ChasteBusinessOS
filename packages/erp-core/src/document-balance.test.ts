import { describe, expect, it } from "vitest";
import { canAcceptPayment, documentBalance } from "./document-balance";

/**
 * N11 property floor: with credits present, every derivation agrees - a
 * 100 invoice with a 40 credit and no payment exposes 60 outstanding, can
 * accept at most 60, and no consumer can reconstruct a 100 debt.
 */

describe("documentBalance", () => {
  it("floors outstanding at zero and reports over-allocation", () => {
    const over = documentBalance({ totalMinor: 100, paidMinor: 80, creditedMinor: 40 });
    expect(over.outstandingMinor).toBe(0);
    expect(over.overallocatedMinor).toBe(20);
    expect(over.fullySettled).toBe(true);
  });

  it("counts credits toward settlement", () => {
    const b = documentBalance({ totalMinor: 100, paidMinor: 0, creditedMinor: 40 });
    expect(b.outstandingMinor).toBe(60);
    expect(b.fullySettled).toBe(false);
  });

  it("throws on negative or fractional money", () => {
    expect(() => documentBalance({ totalMinor: 100, paidMinor: -1, creditedMinor: 0 })).toThrow(RangeError);
    expect(() => documentBalance({ totalMinor: 100.5, paidMinor: 0, creditedMinor: 0 })).toThrow(RangeError);
  });

  it("property: outstanding + allocated conserves the gross across arbitrary states", () => {
    // Pseudo-random deterministic sweep instead of a float-random source.
    for (let total = 0; total <= 40; total += 7) {
      for (let paid = 0; paid <= 30; paid += 5) {
        for (let credited = 0; credited <= 30; credited += 3) {
          const b = documentBalance({ totalMinor: total, paidMinor: paid, creditedMinor: credited });
          const allocated = Math.min(total, paid + credited);
          expect(b.outstandingMinor).toBe(total - allocated);
          expect(b.overallocatedMinor).toBe(Math.max(0, paid + credited - total));
          expect(b.fullySettled).toBe(paid + credited >= total);
        }
      }
    }
  });
});

describe("canAcceptPayment", () => {
  it("caps acceptance at the credit-adjusted outstanding", () => {
    const state = { totalMinor: 100, paidMinor: 0, creditedMinor: 40 };
    expect(canAcceptPayment(state, "sent", 60).ok).toBe(true);
    expect(canAcceptPayment(state, "sent", 61)).toMatchObject({ ok: false });
    expect(canAcceptPayment(state, "sent", 100)).toMatchObject({ ok: false, reason: expect.stringContaining("60") });
  });

  it("refuses ineligible lifecycle states and non-positive amounts", () => {
    const state = { totalMinor: 100, paidMinor: 0, creditedMinor: 0 };
    expect(canAcceptPayment(state, "draft", 10)).toMatchObject({ ok: false, reason: expect.stringContaining("draft") });
    expect(canAcceptPayment(state, "void", 10)).toMatchObject({ ok: false, reason: expect.stringContaining("void") });
    expect(canAcceptPayment(state, "sent", 0)).toMatchObject({ ok: false });
    expect(canAcceptPayment(state, "sent", -5)).toMatchObject({ ok: false });
  });

  it("property: accepted amounts never exceed outstanding, whatever the state", () => {
    for (let total = 0; total <= 20; total += 4) {
      for (let paid = 0; paid <= 12; paid += 3) {
        for (let credited = 0; credited <= 12; credited += 2) {
          const state = { totalMinor: total, paidMinor: paid, creditedMinor: credited };
          const balance = documentBalance(state);
          const verdict = canAcceptPayment(state, "sent", balance.outstandingMinor);
          expect(verdict.ok).toBe(balance.outstandingMinor > 0);
        }
      }
    }
  });
});
