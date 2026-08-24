import { describe, expect, it } from "vitest";
import {
  renderCapabilitySource,
  renderProposalDiff,
  renderRiskDoc,
  renderTestSkeleton,
  type ScaffoldSpec,
} from "./scaffold";

const spec: ScaffoldSpec = {
  module: "warehouse",
  action: "cycleCount",
  title: "Cycle count adjustment",
  intent: "Record a cycle-count variance against stock with a reason and actor attribution",
  risk: "write",
  permission: "inventory.write",
  inputFields: [
    { name: "sku", type: "string", description: "item SKU" },
    { name: "countedThousandths", type: "number" },
  ],
};

describe("scaffolding generator", () => {
  it("emits source whose capability id matches module.action", () => {
    const src = renderCapabilitySource(spec);
    expect(src).toContain('id: "warehouse.cycleCount"');
    expect(src).toContain("module: \"warehouse\"");
    expect(src).toContain("risk: \"write\"");
    expect(src).toContain("z.string()");
    expect(src).toContain(".describe(\"item SKU\")");
  });

  it("registers under the correct export name for kebab modules", () => {
    expect(renderCapabilitySource({ ...spec, module: "stock-room" })).toContain(
      "registerStockRoomCapabilities",
    );
  });

  it("risk doc names the risk class and reversibility stance", () => {
    const doc = renderRiskDoc(spec);
    expect(doc).toContain("Risk class: write");
    expect(doc).toContain("declare an inverse");
    expect(doc).not.toContain("undefined");
  });

  it("read-class risk doc states no inverse needed", () => {
    expect(renderRiskDoc({ ...spec, risk: "read" })).toContain("no inverse needed");
  });

  it("destructive risk doc demands human approval", () => {
    expect(renderRiskDoc({ ...spec, risk: "destructive" })).toContain("Always human-approved");
  });

  it("proposal diff is a valid-looking unified diff header plus additions", () => {
    const diff = renderProposalDiff(spec, "modules/warehouse/src/index.ts");
    expect(diff.startsWith("--- /dev/null")).toBe(true);
    expect(diff).toContain("+++ b/modules/warehouse/src/index.ts");
    for (const line of diff.split("\n").slice(4)) {
      if (line) expect(line.startsWith("+")).toBe(true);
    }
  });

  it("test skeleton is non-empty text", () => {
    expect(renderTestSkeleton(spec)).toContain("cycleCount");
  });
});
