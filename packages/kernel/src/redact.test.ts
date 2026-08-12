import { describe, expect, it } from "vitest";
import { redactForAudit } from "./redact.js";

describe("redactForAudit (F12)", () => {
  it("redacts sensitive free-text keys and keeps structural ids", () => {
    const out = redactForAudit({
      name: "Send email",
      to: "user@example.com",
      body: "confidential email body",
      customerId: "cust-1",
    });
    expect(out).toEqual({
      name: "Send email",
      to: "user@example.com",
      body: "[redacted]",
      customerId: "cust-1",
    });
  });

  it("redacts nested sensitive values", () => {
    const out = redactForAudit({
      employee: { fullName: "Jane", baseSalary: 1200, role: "dev" },
      goal: "chase an invoice",
    });
    expect(out).toEqual({
      employee: { fullName: "Jane", baseSalary: "[redacted]", role: "dev" },
      goal: "[redacted]",
    });
  });

  it("caps runaway structures", () => {
    const out = redactForAudit({ a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } });
    // Deep values are replaced by the cap marker; the structure stays finite.
    expect(JSON.stringify(out)).not.toContain("deep");
    expect(out).toEqual({ a: { b: { c: { d: { e: { f: { g: "[redacted]" } } } } } } });
  });

  it("passes through arrays up to a cap", () => {
    const arr = Array.from({ length: 250 }, (_, i) => ({ body: `note ${i}` }));
    const out = redactForAudit(arr) as Array<{ body: string }>;
    expect(out).toHaveLength(100);
    expect(out[0]).toEqual({ body: "[redacted]" });
  });

  it("keeps primitives and empty values intact", () => {
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit(42)).toBe(42);
    expect(redactForAudit("hello")).toBe("hello");
  });
});
