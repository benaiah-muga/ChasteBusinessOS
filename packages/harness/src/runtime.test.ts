import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES } from "./profile";
import { createHarnessRuntime, type HarnessCleanup } from "./runtime";

describe("harness runtime lifecycle", () => {
  it("mounts dependencies first and unmounts them last", async () => {
    const order: string[] = [];
    const service = (id: string, dependsOn: string[] = [], fail = false) => ({
      id,
      version: "1.0.0",
      dependsOn,
      mount: async (): Promise<HarnessCleanup> => {
        order.push(`mount:${id}`);
        if (fail) throw new Error(`failed:${id}`);
        return () => {
          order.push(`unmount:${id}`);
        };
      },
    });
    const runtime = createHarnessRuntime({
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [
        { manifest: { id: "erp", version: "1.0.0", serviceIds: ["consumer", "kernel"] }, services: [service("consumer", ["kernel"]), service("kernel")] },
      ],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await runtime.mount();
    expect(order).toEqual(["mount:kernel", "mount:consumer"]);
    const inspection = runtime.inspect();
    expect(inspection.profileDigest).toHaveLength(64);
    expect(inspection.bundles[0]?.serviceIds).toEqual(["consumer", "kernel"]);
    expect(inspection.patches).toEqual([]);
    await runtime.unmount();
    expect(order).toEqual(["mount:kernel", "mount:consumer", "unmount:consumer", "unmount:kernel"]);
    expect(runtime.status).toBe("unmounted");
    console.log("HARNESS-RUNTIME-IDENTITY-OK");
  });

  it("rolls back already-mounted services after a later mount fails", async () => {
    const order: string[] = [];
    const runtime = createHarnessRuntime({
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [
        {
          manifest: { id: "erp", version: "1.0.0", serviceIds: ["first", "second"] },
          services: [
            { id: "first", version: "1.0.0", mount: () => () => { order.push("rollback:first"); } },
            { id: "second", version: "1.0.0", dependsOn: ["first"], mount: () => { throw new Error("boom"); } },
          ],
        },
      ],
    });
    await expect(runtime.mount()).rejects.toThrow("boom");
    expect(runtime.status).toBe("failed");
    expect(runtime.mountedServiceIds()).toEqual([]);
    expect(order).toEqual(["rollback:first"]);
    console.log("HARNESS-LIFECYCLE-OK");
  });
});
