import { describe, it, expect } from "vitest";
import {
  InMemorySkillStore,
  buildSkillRefinement,
  buildSkillRevert,
  skillTools,
  type SkillRecord,
} from "./skills.js";

const existing: SkillRecord = {
  name: "crm.lead-prioritization",
  scope: "organization",
  organizationId: "o1",
  title: "Lead prioritization",
  summary: "Score leads by RFM",
  instructions: "Use RFM scoring; update the priority field.",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("buildSkillRefinement — smallest evidence-backed edit", () => {
  it("proposes only the fields that differ", () => {
    const res = buildSkillRefinement(existing, {
      name: "crm.lead-prioritization",
      instructions: "Use RFM scoring, then confirm high-value leads with the owner.",
      trigger: "Turn 12: user asked to confirm with the owner before following up.",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.refinement.before).toEqual({ instructions: "Use RFM scoring; update the priority field." });
    expect(res.refinement.after).toEqual({
      instructions: "Use RFM scoring, then confirm high-value leads with the owner.",
    });
    expect(res.refinement.trigger).toContain("Turn 12");
    expect(res.skill.summary).toBe("Score leads by RFM"); // untouched
    expect(res.skill.instructions).toBe(
      "Use RFM scoring, then confirm high-value leads with the owner.",
    );
    expect(res.skill.refinements).toHaveLength(1);
  });

  it("rejects a no-op refinement (nothing differs)", () => {
    const res = buildSkillRefinement(existing, {
      name: "crm.lead-prioritization",
      summary: "Score leads by RFM",
      trigger: "trajectory evidence",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("no-op");
  });

  it("appends to the existing refinement history", () => {
    const once = buildSkillRefinement(existing, {
      name: "crm.lead-prioritization",
      summary: "Score and rank leads by RFM",
      trigger: "first evidence",
    });
    if (!once.ok) throw new Error("expected ok");
    const twice = buildSkillRefinement(once.skill, {
      name: "crm.lead-prioritization",
      instructions: "Use RFM scoring; rank within the same week.",
      trigger: "second evidence",
    });
    if (!twice.ok) throw new Error("expected ok");
    expect(twice.skill.refinements).toHaveLength(2);
    expect(twice.skill.refinements![0]!.after.summary).toBe("Score and rank leads by RFM");
  });
});

describe("refineSkill tool", () => {
  it("parks a proposal for an existing skill without mutating state", async () => {
    const store = new InMemorySkillStore();
    await store.upsert(existing);
    const tools = skillTools(store, { organizationId: "o1" });

    const res = await tools.refineSkill({
      name: "crm.lead-prioritization",
      instructions: "Use RFM scoring, then confirm with the owner.",
      trigger: "Trajectory evidence: owner confirmation was requested.",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.requiresApproval).toBe(true);
    // The proposal is NOT written to the store — no state change before approval.
    const stored = await store.get("crm.lead-prioritization", { organizationId: "o1" });
    expect(stored!.instructions).toBe("Use RFM scoring; update the priority field.");
    expect(stored!.refinements).toBeUndefined();
  });

  it("rejects refining an unknown skill", async () => {
    const store = new InMemorySkillStore();
    const tools = skillTools(store, { organizationId: "o1" });
    const res = await tools.refineSkill({
      name: "does.not.exist",
      summary: "x",
      trigger: "evidence",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("unknown skill");
  });

  it("rejects a no-op proposal", async () => {
    const store = new InMemorySkillStore();
    await store.upsert(existing);
    const tools = skillTools(store, { organizationId: "o1" });
    const res = await tools.refineSkill({
      name: "crm.lead-prioritization",
      summary: "Score leads by RFM",
      trigger: "evidence",
    });
    expect(res.ok).toBe(false);
  });

  it("rejects an empty or whitespace-only trigger (missing evidence)", async () => {
    const store = new InMemorySkillStore();
    await store.upsert(existing);
    const tools = skillTools(store, { organizationId: "o1" });
    const res = await tools.refineSkill({
      name: "crm.lead-prioritization",
      instructions: "New instructions",
      trigger: "   ",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("trigger");
  });
});

const refined: SkillRecord = {
  ...existing,
  instructions: "Use RFM scoring, then confirm high-value leads with the owner.",
  refinements: [
    {
      id: "ref-1",
      trigger: "Turn 12: confirm with the owner",
      before: { instructions: "Use RFM scoring; update the priority field." },
      after: { instructions: "Use RFM scoring, then confirm high-value leads with the owner." },
      createdAt: "2026-02-01T00:00:00.000Z",
    },
  ],
};

describe("buildSkillRevert — reversal from the stored snapshot", () => {

  it("reapplies the target's before snapshot as a chained reversal", () => {
    const res = buildSkillRevert(refined, refined.refinements![0]!);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.refinement.reversalRefinementId).toBe("ref-1");
    expect(res.refinement.before).toEqual({
      instructions: "Use RFM scoring, then confirm high-value leads with the owner.",
    });
    expect(res.refinement.after).toEqual({ instructions: "Use RFM scoring; update the priority field." });
    expect(res.skill.instructions).toBe("Use RFM scoring; update the priority field.");
    expect(res.skill.refinements).toHaveLength(2);
  });

  it("rejects a no-op revert (already at the pre-refinement state)", () => {
    const already = { ...existing }; // never refined
    const target = refined.refinements![0]!;
    const res = buildSkillRevert(already, target);
    expect(res.ok).toBe(false);
  });
});

describe("revertSkillRefinement tool", () => {
  it("parks a reversal without mutating state, chained to the target id", async () => {
    const store = new InMemorySkillStore();
    await store.upsert(refined);
    const tools = skillTools(store, { organizationId: "o1" });

    const res = await tools.revertSkillRefinement({ name: "crm.lead-prioritization", refinementId: "ref-1" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.requiresApproval).toBe(true);
    expect(res.refinement.reversalRefinementId).toBe("ref-1");
    expect(res.refinement.after.instructions).toBe("Use RFM scoring; update the priority field.");
    const stored = await store.get("crm.lead-prioritization", { organizationId: "o1" });
    expect(stored!.refinements).toHaveLength(1); // untouched until approval
  });

  it("rejects an unknown refinement id", async () => {
    const store = new InMemorySkillStore();
    await store.upsert(refined);
    const tools = skillTools(store, { organizationId: "o1" });
    const res = await tools.revertSkillRefinement({
      name: "crm.lead-prioritization",
      refinementId: "nope",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("No refinement");
  });

  it("rejects reverting on an unknown skill", async () => {
    const store = new InMemorySkillStore();
    const tools = skillTools(store, { organizationId: "o1" });
    const res = await tools.revertSkillRefinement({ name: "nope", refinementId: "ref-1" });
    expect(res.ok).toBe(false);
  });
});
