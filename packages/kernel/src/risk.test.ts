import { describe, expect, it } from "vitest";
import {
  classify,
  externalTargetOf,
  isConsequential,
  stricterRisk,
  type RiskClass,
  type RiskClassifiable,
} from "./risk.js";

describe("classify", () => {
  it("returns read for queries by default", () => {
    expect(classify("crm.customer.list", { isQuery: true })).toBe<RiskClass>("read");
  });

  it("returns write_local for commands by default (the safe default)", () => {
    expect(classify("crm.customer.create", {})).toBe<RiskClass>("write_local");
  });

  it("honors an explicitly-declared command risk class", () => {
    const classifiable: RiskClassifiable = { riskClass: "external" };
    expect(classify("email.send", { classifiable })).toBe<RiskClass>("external");
  });

  it("`externalTarget` heuristic overrides the query/command default but not explicit declaration", () => {
    expect(
      classify("slack.send", {
        classifiable: { externalTarget: "slack:C0123" },
        isQuery: false,
      }),
    ).toBe<RiskClass>("external");
    // explicit declaration still wins
    expect(
      classify("slack.send", {
        classifiable: { riskClass: "exec", externalTarget: "slack:C0123" },
      }),
    ).toBe<RiskClass>("exec");
  });

  it("`sideEffects` heuristic lifts to exec when neither override nor declaration is present", () => {
    expect(
      classify("wf.run", { classifiable: { sideEffects: true } }),
    ).toBe<RiskClass>("exec");
  });

  it("user-local overrides win over declared risk class", () => {
    expect(
      classify("email.send", {
        classifiable: { riskClass: "external" },
        overrides: () => "read",
      }),
    ).toBe<RiskClass>("read");
    // and a `null` override defers to the declared class
    expect(
      classify("email.send", {
        classifiable: { riskClass: "external" },
        overrides: () => null,
      }),
    ).toBe<RiskClass>("external");
  });
});

describe("externalTargetOf", () => {
  it("returns null for non-external risk by default", () => {
    expect(externalTargetOf("crm.customer.create", { name: "Acme" })).toBeNull();
  });

  it("reads declared externalTargetField name from input when the command is external", () => {
    const classifiable: RiskClassifiable = {
      riskClass: "external",
      externalTargetField: "channel",
    };
    expect(
      externalTargetOf("slack.send", { channel: "C0123", text: "hi" }, classifiable),
    ).toBe("C0123");
  });

  it("uses externalTargetField even when it is not a common fallback key", () => {
    expect(
      externalTargetOf(
        "webhook.dispatch",
        { destinationUrl: "https://hooks.example/x" },
        { riskClass: "external", externalTargetField: "destinationUrl" },
      ),
    ).toBe("https://hooks.example/x");
  });

  it("falls back to common target-shaped input field names", () => {
    expect(
      externalTargetOf("email.send", { to: "user@x.com" }, { riskClass: "external" }),
    ).toBe("user@x.com");
    expect(
      externalTargetOf("email.send", { recipients: ["a@b.co", "c@d.co"] }, {
        riskClass: "external",
      }),
    ).toBeNull(); // `recipients` is not a recognized fallback key
    expect(
      externalTargetOf("email.send", { recipient: "a@b.co" }, { riskClass: "external" }),
    ).toBe("a@b.co");
  });

  it("prefers the metadata externalTarget string over heuristic input keys", () => {
    const classifiable: RiskClassifiable = { riskClass: "external", externalTarget: "channel:#ops" };
    expect(
      externalTargetOf("slack.send", { channel: "ignored" }, classifiable),
    ).toBe("channel:#ops");
  });

  it("returns null when no target input is named at all", () => {
    expect(
      externalTargetOf("email.send", { body: "x" }, { riskClass: "external" }),
    ).toBeNull();
  });
});

describe("isConsequential / stricterRisk", () => {
  it("treats only read as non-consequential", () => {
    expect(isConsequential("read")).toBe(false);
    expect(isConsequential("write_local")).toBe(true);
    expect(isConsequential("exec")).toBe(true);
    expect(isConsequential("external")).toBe(true);
  });

  it("stricterRisk returns the higher-impact class", () => {
    expect(stricterRisk("read", "write_local")).toBe<RiskClass>("write_local");
    expect(stricterRisk("write_local", "exec")).toBe<RiskClass>("exec");
    expect(stricterRisk("exec", "external")).toBe<RiskClass>("external");
    // ties: either side returned
    expect(stricterRisk("external", "external")).toBe<RiskClass>("external");
  });
});
