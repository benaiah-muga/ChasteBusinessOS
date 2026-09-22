import { describe, expect, it } from "vitest";
import { compositionDigest, type HarnessBundleManifest, type HarnessConfigPatch } from "@chaste/harness";
import { type Database } from "@chaste/db";
import { BUILTIN_PROFILES, CAPABILITY_BRIDGE_SERVICE_ID } from "@chaste/harness";
import { createChasteHarness, type ChasteHarnessBundleResolver } from "./harness";

const erpBundle: HarnessBundleManifest = {
  id: "chaste-erp",
  version: "1.0.0",
  serviceIds: [CAPABILITY_BRIDGE_SERVICE_ID],
};

const creatorBundle: HarnessBundleManifest = {
  id: "approved-creator",
  version: "2.1.0",
  serviceIds: ["creator.catalog"],
};

const patch: HarnessConfigPatch = {
  id: "creator-settings",
  version: "1.0.0",
  values: { creatorSecret: "must-not-appear-in-inspection" },
};

const creatorResolver: ChasteHarnessBundleResolver = (manifest) => {
  if (manifest.id !== creatorBundle.id || manifest.version !== creatorBundle.version) return undefined;
  return {
    manifest,
    services: [
      {
        id: "creator.catalog",
        version: "2.1.0",
        mount: ({ config }) => ({ value: { configured: config.creatorSecret === patch.values.creatorSecret } }),
      },
    ],
  };
};

describe("approved harness bundle resolution", () => {
  it("mounts registered bundles and keeps the kernel bridge as the ERP authority", async () => {
    const harness = createChasteHarness({} as Database["db"], {
      profile: BUILTIN_PROFILES["erp-review"],
      bundles: [erpBundle, creatorBundle],
      patches: [patch],
      bundleResolvers: [creatorResolver],
    });

    await harness.runtime.mount();
    try {
      expect(harness.runtime.mountedServiceIds()).toEqual([CAPABILITY_BRIDGE_SERVICE_ID, "creator.catalog"]);
      expect(harness.runtime.service<{ configured: boolean }>("creator.catalog")).toEqual({ configured: true });
      expect(harness.bridge.resolve("signals.list").id).toBe("signals.list");
      expect(harness.runtime.inspect().bundles).toHaveLength(2);
      expect(JSON.stringify(harness.runtime.inspect())).not.toContain("must-not-appear-in-inspection");
      console.log("BUNDLE-RESOLUTION-OK");
    } finally {
      await harness.runtime.unmount();
    }
  });

  it("pins patches in the runtime identity while exposing only safe metadata", () => {
    const harness = createChasteHarness({} as Database["db"], {
      profile: BUILTIN_PROFILES["erp-review"],
      bundles: [erpBundle, creatorBundle],
      patches: [patch],
      bundleResolvers: [creatorResolver],
    });
    const inspection = harness.runtime.inspect();
    expect(inspection.compositionDigest).toBe(
      compositionDigest({ profile: BUILTIN_PROFILES["erp-review"], bundles: [erpBundle, creatorBundle], patches: [patch] }),
    );
    expect(inspection.patches).toEqual([{ id: patch.id, version: patch.version, configKeys: ["creatorSecret"] }]);
    expect(JSON.stringify(inspection)).not.toContain("must-not-appear-in-inspection");
    console.log("BUNDLE-IDENTITY-OK");
  });

  it("rejects an unregistered bundle before runtime creation", () => {
    expect(() =>
      createChasteHarness({} as Database["db"], {
        bundles: [{ id: "unregistered", version: "1.0.0", serviceIds: ["unknown.service"] }],
      }),
    ).toThrow("no approved bundle resolver");
    console.log("BUNDLE-FAIL-CLOSED-OK");
  });
});
