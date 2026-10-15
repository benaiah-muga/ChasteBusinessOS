import { describe, expect, it } from "vitest";
import {
  CapabilityExecutionPendingSchema,
  CapabilityExecutionRefusalSchema,
  CapabilityExecutionSuccessSchema,
  capabilityExecutionRequest,
} from "./capability-execution";

describe("generic capability execution contract", () => {
  it("builds a request using the generated open-ended wire type", () => {
    expect(capabilityExecutionRequest("accounting.read", { period: 2026 }, "intent-1")).toEqual({
      capabilityId: "accounting.read",
      input: { period: 2026 },
      intentId: "intent-1",
    });
    expect(capabilityExecutionRequest("inventory.stockReport", [])).toEqual({
      capabilityId: "inventory.stockReport",
      input: [],
    });
  });

  it("validates only the generic 200, 202, and 422 response envelopes", () => {
    expect(CapabilityExecutionSuccessSchema.safeParse({ ok: true, data: { items: [] } }).success).toBe(true);
    expect(CapabilityExecutionPendingSchema.safeParse({
      ok: false,
      pendingApproval: true,
      reason: "Needs review",
      approvalId: "approval-1",
    }).success).toBe(true);
    expect(CapabilityExecutionRefusalSchema.safeParse({ ok: false, error: "Not allowed" }).success).toBe(true);
    expect(CapabilityExecutionRefusalSchema.safeParse({
      ok: false,
      data: { retryAfterVersion: "9007199254740993" },
      replayed: true,
    }).success).toBe(true);

    expect(CapabilityExecutionSuccessSchema.safeParse({ ok: true, data: {}, extra: true }).success).toBe(false);
    expect(CapabilityExecutionPendingSchema.safeParse({ ok: false, pendingApproval: true }).success).toBe(false);
    expect(CapabilityExecutionRefusalSchema.safeParse({ ok: true, error: "Not allowed" }).success).toBe(false);
    expect(CapabilityExecutionRefusalSchema.safeParse({ ok: false, pendingApproval: true }).success).toBe(false);
  });
});
