import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES, assertHarnessProfile, compositionDigest, profileDigest } from "./profile";

describe("harness profiles", () => {
  it("keeps profile and composition digests deterministic", () => {
    const profile = assertHarnessProfile(BUILTIN_PROFILES["erp-prod"]);
    const first = compositionDigest({
      profile,
      bundles: [{ id: "erp-core", version: "1.0.0", serviceIds: ["kernel"] }],
      patches: [{ id: "defaults", version: "1.0.0", values: { mode: "safe" } }],
    });
    const second = compositionDigest({
      profile: { ...profile, allowedModules: [...profile.allowedModules] },
      bundles: [{ id: "erp-core", version: "1.0.0", serviceIds: ["kernel"] }],
      patches: [{ id: "defaults", version: "1.0.0", values: { mode: "safe" } }],
    });
    expect(first).toBe(second);
    expect(profileDigest(profile)).toHaveLength(64);
  });

  it("fails closed when a restricted profile tries to add source or code authority", () => {
    expect(() =>
      assertHarnessProfile({
        ...BUILTIN_PROFILES["erp-prod"],
        authority: { ...BUILTIN_PROFILES["erp-prod"].authority, allowCodeExecution: true },
      }),
    ).toThrow("expands restricted authority");
    console.log("HARNESS-PROFILE-OK");
  });
});
