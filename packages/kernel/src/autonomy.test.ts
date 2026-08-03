import { describe, expect, it } from "vitest";
import {
  commandMayAutoExecute,
  effectiveAutonomyForCommand,
  effectiveAutonomyForPlan,
  planMayAutoExecute,
  type AutoExecMeta,
} from "./autonomy.js";

describe("effectiveAutonomyForCommand (R1 risk-aware gate)", () => {
  it("passes through the configured level for ordinary (write_local/read) commands", () => {
    expect(effectiveAutonomyForCommand("confirm", {})).toBe("confirm");
    expect(effectiveAutonomyForCommand("guarded_auto", {})).toBe("guarded_auto");
  });

  it("raises the gate to the declared minAutonomyForAuto when configured is below it", () => {
    const meta: AutoExecMeta = { minAutonomyForAuto: "full_autonomous" };
    expect(effectiveAutonomyForCommand("guarded_auto", meta)).toBe("full_autonomous");
    expect(effectiveAutonomyForCommand("full_autonomous", meta)).toBe("full_autonomous");
  });

  it("forces confirm for exec/external commands without an explicit opt-in, at any level", () => {
    const external: AutoExecMeta = { riskClass: "external" };
    const exec: AutoExecMeta = { riskClass: "exec" };
    expect(effectiveAutonomyForCommand("guarded_auto", external)).toBe("confirm");
    expect(effectiveAutonomyForCommand("full_autonomous", external)).toBe("confirm");
    expect(effectiveAutonomyForCommand("confirm", exec)).toBe("confirm");
  });

  it("an explicit minAutonomyForAuto IS the opt-in for a risky command", () => {
    const meta: AutoExecMeta = { riskClass: "external", minAutonomyForAuto: "guarded_auto" };
    expect(effectiveAutonomyForCommand("guarded_auto", meta)).toBe("guarded_auto");
    expect(effectiveAutonomyForCommand("full_autonomous", meta)).toBe("full_autonomous");
  });
});

describe("commandMayAutoExecute", () => {
  it("only auto-runs when the configured level is high enough AND the risk allows it", () => {
    expect(commandMayAutoExecute("confirm", {})).toBe(false);
    expect(commandMayAutoExecute("guarded_auto", {})).toBe(true);
    expect(commandMayAutoExecute("full_autonomous", {})).toBe(true);
    // risky without opt-in → never auto
    expect(commandMayAutoExecute("full_autonomous", { riskClass: "external" })).toBe(false);
    // risky with explicit opt-in → auto at the declared level
    expect(
      commandMayAutoExecute("guarded_auto", {
        riskClass: "external",
        minAutonomyForAuto: "guarded_auto",
      }),
    ).toBe(true);
    // declared full_autonomous but user only guarded_auto → confirm
    expect(
      commandMayAutoExecute("guarded_auto", { minAutonomyForAuto: "full_autonomous" }),
    ).toBe(false);
    expect(commandMayAutoExecute("full_autonomous", { minAutonomyForAuto: "full_autonomous" })).toBe(
      true,
    );
  });
});

describe("plan gate helpers", () => {
  it("the plan gate is the strictest across its steps", () => {
    const metas: AutoExecMeta[] = [{ riskClass: "external" }, { minAutonomyForAuto: "full_autonomous" }];
    expect(effectiveAutonomyForPlan("guarded_auto", metas)).toBe("full_autonomous");
  });

  it("a plan only auto-runs when EVERY step allows it", () => {
    expect(
      planMayAutoExecute("full_autonomous", [{}, { minAutonomyForAuto: "full_autonomous" }]),
    ).toBe(true);
    expect(
      planMayAutoExecute("full_autonomous", [{ riskClass: "external" }, {}]),
    ).toBe(false);
  });
});
