import { describe, expect, it } from "vitest";
import { normalizeRetryActorId } from "./retry-scope";

describe("normalizeRetryActorId", () => {
  it("preserves a bounded opaque identity after trimming", () => {
    expect(normalizeRetryActorId(" a5zVJvRUGPkJNBQMEuSH_CkoB7ubSjXd ")).toBe("a5zVJvRUGPkJNBQMEuSH_CkoB7ubSjXd");
  });

  it("rejects missing, oversized, and control-character identities", () => {
    expect(normalizeRetryActorId("  ")).toBeNull();
    expect(normalizeRetryActorId("x".repeat(256))).toBeNull();
    expect(normalizeRetryActorId("auth\u0000user")).toBeNull();
  });
});
