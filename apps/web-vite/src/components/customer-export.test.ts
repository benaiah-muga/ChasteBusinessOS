import { describe, expect, it } from "vitest";
import { selectedCustomersCsv } from "./customer-export";

describe("selectedCustomersCsv", () => {
  it("exports only selected customers with the legacy columns and spreadsheet formula protection", () => {
    const customers = [
      { id: "one", name: '=HYPERLINK("https://bad.test")', email: "ada@example.test", ownerName: "Avery", tags: ["priority", "renewal"], deactivatedAt: null },
      { id: "two", name: "Inactive, Inc.", email: null, ownerName: null, tags: [], deactivatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "three", name: "Not selected", email: null, ownerName: null, tags: [], deactivatedAt: null },
    ];

    expect(selectedCustomersCsv(customers, ["one", "two"])).toBe([
      "Name,Email,Owner,Tags,Status",
      `"'=HYPERLINK(""https://bad.test"")","ada@example.test","Avery","priority; renewal","Active"`,
      `"Inactive, Inc.","","","","Inactive"`,
    ].join("\n"));
  });

  it("returns the header when there are no selected customers", () => {
    expect(selectedCustomersCsv([], [])).toBe("Name,Email,Owner,Tags,Status");
  });

  it("protects formulas after leading whitespace and control characters", () => {
    const customers = [
      { id: "space", name: " =1+1", email: null, ownerName: null, tags: [], deactivatedAt: null },
      { id: "tab", name: "\t=1+1", email: null, ownerName: null, tags: [], deactivatedAt: null },
      { id: "line-break", name: "\n@SUM(A1:A2)", email: null, ownerName: null, tags: [], deactivatedAt: null },
    ];

    expect(selectedCustomersCsv(customers, ["space", "tab", "line-break"])).toBe([
      "Name,Email,Owner,Tags,Status",
      `"' =1+1","","","","Active"`,
      `"'\t=1+1","","","","Active"`,
      `"'\n@SUM(A1:A2)","","","","Active"`,
    ].join("\n"));
  });
});
