import { describe, expect, it } from "vitest";
import {
  PLATFORM_SKILL_DEFS,
  domainDoctrineText,
  platformSkillRecords,
  routeDomain,
} from "./platform-skills.js";

describe("platform skills", () => {
  it("defines a non-empty set with unique names and required fields", () => {
    expect(PLATFORM_SKILL_DEFS.length).toBeGreaterThan(0);
    const names = PLATFORM_SKILL_DEFS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of PLATFORM_SKILL_DEFS) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.summary.length).toBeGreaterThan(0);
      expect(d.instructions.length).toBeGreaterThan(0);
      expect(d.keywords.length).toBeGreaterThan(0);
    }
  });

  it("produces enabled platform-scoped records", () => {
    const records = platformSkillRecords();
    expect(records).toHaveLength(PLATFORM_SKILL_DEFS.length);
    for (const r of records) {
      expect(r.scope).toBe("platform");
      expect(r.enabled).toBe(true);
      expect(r.organizationId).toBeUndefined();
      expect(r.createdAt).toBeDefined();
      expect(r.updatedAt).toBeDefined();
    }
  });

  it("routes by domain keywords", () => {
    expect(routeDomain("Add a new vendor for purchase orders").map((d) => d.name)).toContain("platform.purchasing");
    expect(routeDomain("Raise an invoice for a customer").map((d) => d.name)).toContain("platform.sales");
    expect(routeDomain("Check stock levels for SKU-100").map((d) => d.name)).toContain("platform.inventory");
    expect(routeDomain("Create a new branch in Kampala").map((d) => d.name)).toContain("platform.operations");
    expect(routeDomain("How many purchase orders did we place").map((d) => d.name)).toContain("platform.purchasing");
  });

  it("does not route an unrelated message to any domain", () => {
    expect(routeDomain("Good morning")).toEqual([]);
    expect(domainDoctrineText("Good morning")).toBe("");
  });

  it("emits inline doctrine only for matched domains", () => {
    const text = domainDoctrineText("Create a purchase order");
    expect(text).toContain("platform.purchasing");
    expect(text).toContain("existence gate");
    expect(domainDoctrineText("Hello there")).toBe("");
  });
});