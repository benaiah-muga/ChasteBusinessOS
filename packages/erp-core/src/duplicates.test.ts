import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findDuplicate, normalizeCustomerName, normalizeEmail } from "./duplicates.js";

describe("normalizeCustomerName", () => {
  it("strips legal suffixes, punctuation, and case", () => {
    expect(normalizeCustomerName("Acme LLC")).toBe("acme");
    expect(normalizeCustomerName("Acme, Incorporated!")).toBe("acme");
    expect(normalizeCustomerName("  North-Wind Trading Co. ")).toBe("north wind trading");
  });

  it("a name made only of a suffix has no identity", () => {
    expect(normalizeCustomerName("LLC")).toBe("");
  });

  it("property: idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        expect(normalizeCustomerName(normalizeCustomerName(s))).toBe(normalizeCustomerName(s));
      }),
    );
  });

  it("property: ASCII output only", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        expect(/[^a-z0-9 ]/.test(normalizeCustomerName(s))).toBe(false);
      }),
    );
  });
});

describe("findDuplicate", () => {
  it("matches on email regardless of case, before name", () => {
    const existing = [{ name: "Different Name Co", email: "Bill@Acme.com" }];
    expect(findDuplicate(existing, { name: "another", email: "bill@acme.com" })).toEqual({
      duplicate: true,
      reason: "email",
      existingName: "Different Name Co",
    });
  });

  it("matches on normalized name when emails differ", () => {
    const existing = [{ name: "Acme LLC", email: "a@x.com" }];
    expect(findDuplicate(existing, { name: "acme", email: "b@y.com" })).toEqual({
      duplicate: true,
      reason: "name",
      existingName: "Acme LLC",
    });
  });

  it("different names with different emails never match", () => {
    expect(
      findDuplicate([{ name: "Globex", email: "g@x.com" }], { name: "Initech", email: "i@y.com" }).duplicate,
    ).toBe(false);
  });

  it("property: symmetric verdict", () => {
    const nameArb = fc.constantFrom("Acme Corp", "acme llc", "Globex", "Initech Ltd", "north wind");
    const emailArb = fc.option(fc.constantFrom("a@x.com", "A@X.com", "b@y.com"), { nil: undefined });
    fc.assert(
      fc.property(
        fc.tuple(nameArb, emailArb),
        fc.tuple(nameArb, emailArb),
        ([n1, e1], [n2, e2]) => {
          const ab = findDuplicate([{ name: n1, email: e1 }], { name: n2, email: e2 });
          const ba = findDuplicate([{ name: n2, email: e2 }], { name: n1, email: e1 });
          expect(ab.duplicate).toBe(ba.duplicate);
        },
      ),
    );
  });

  it("property: empty existing never yields a duplicate", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.option(fc.string({ maxLength: 40 }), { nil: undefined }), (n, e) => {
        expect(findDuplicate([], { name: n, email: e }).duplicate).toBe(false);
      }),
    );
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims; null-safe", () => {
    expect(normalizeEmail("  Bill@Acme.COM ")).toBe("bill@acme.com");
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });
});
