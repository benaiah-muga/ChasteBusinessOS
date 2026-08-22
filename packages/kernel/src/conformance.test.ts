import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";
import { assertWellFormedCapability } from "./conformance";
import { CapabilityRegistry } from "./registry";

const base = {
  title: "Do a thing",
  intent: "Does the thing it is supposed to do for the org",
  module: "demo",
  risk: "write" as const,
  permission: "demo.write",
  input: z.object({ x: z.string() }),
  output: z.object({ y: z.string() }),
  execute: async () => ({ y: "ok" }),
};

describe("capability conformance", () => {
  it("accepts a well-formed capability", () => {
    const issues = assertWellFormedCapability(defineCapability({ ...base, id: "demo.doThing" }));
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("warns when state-changing capability has no inverse", () => {
    const issues = assertWellFormedCapability(defineCapability({ ...base, id: "demo.doThing" }));
    expect(issues.some((i) => i.rule === "inverse-recommended")).toBe(true);
  });

  it("rejects malformed ids at registration time", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.register(defineCapability({ ...base, id: "demo.do.thing" }))).toThrow(/conformance/);
    expect(() => registry.register(defineCapability({ ...base, id: "other.doThing", module: "demo" }))).toThrow(
      /id-module-mismatch/,
    );
  });

  it("rejects short intents that would embed poorly", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.register(defineCapability({ ...base, id: "demo.go", intent: "short" }))).toThrow(
      /intent-too-short/,
    );
  });

  it("validateAll catches inverse targets that do not exist", () => {
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapability({
        ...base,
        id: "demo.needsUndo",
        inverse: { capabilityId: "demo.undoThing", buildInput: () => ({}) },
      }),
    );
    const issues = registry.validateAll();
    expect(issues.some((i) => i.level === "error" && i.rule === "inverse-exists")).toBe(true);

    registry.register(defineCapability({ ...base, id: "demo.undoThing" }));
    expect(registry.validateAll().some((i) => i.level === "error")).toBe(false);
  });

  it("read capabilities need no inverse", () => {
    const issues = assertWellFormedCapability(
      defineCapability({ ...base, id: "demo.readThing", risk: "read" }),
    );
    expect(issues).toHaveLength(0);
  });
});
