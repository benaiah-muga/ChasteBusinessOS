import { describe, expect, it } from "vitest";
import { type Database } from "@chaste/db";
import { CAPABILITY_BRIDGE_SERVICE_ID } from "@chaste/harness";
import { createChasteHarness } from "./harness";

describe("Chaste Harness adapter", () => {
  it("mounts the existing registry and executor behind one bridge", async () => {
    const harness = createChasteHarness({} as Database["db"]);
    await harness.runtime.mount();
    expect(harness.runtime.mountedServiceIds()).toEqual([CAPABILITY_BRIDGE_SERVICE_ID]);
    expect(harness.runtime.service(CAPABILITY_BRIDGE_SERVICE_ID)).toBe(harness.bridge);
    expect(harness.registry.all().length).toBeGreaterThan(0);
    expect(harness.runtime.inspect().compositionDigest).toHaveLength(64);
    await harness.runtime.unmount();
    console.log("HARNESS-ADAPTER-OK");
  });
});
