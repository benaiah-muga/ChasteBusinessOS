import type {
  AddPlanInput,
  ApprovalGrantStore,
  InboxItem,
  InboxStore,
} from "@chaste/kernel";
import { InMemoryApprovalGrantStore } from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { InMemorySessionLog } from "../trajectory/index.js";
import { requestPlanApproval } from "./approve.js";
import { planRequiresApproval, planRisk, renderPlan, summarizePlan } from "./plan.js";
import { validatePlan } from "./schema.js";
import type { AgentPlan } from "./types.js";

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan-1",
    objective: "Import QuickBooks exports",
    assumptions: ["Exports are in USD"],
    steps: [
      {
        id: "s1",
        title: "Profile the export",
        command: "query/import_profile",
        riskClass: "read",
      },
      {
        id: "s2",
        title: "Map chart of accounts",
        command: "crm/mapping_suggest",
        riskClass: "read",
      },
    ],
    requiredApprovals: [],
    risks: [],
    evidenceNeeded: [],
    stopConditions: [],
    ...overrides,
  };
}

/** Inbox whose `wait` returns a canned resolution (test-side decision surface). */
class FakeInbox implements InboxStore {
  waitValue = "approved";
  items: InboxItem[] = [];
  planCount = 0;

  async addPlan(input: AddPlanInput): Promise<InboxItem> {
    this.planCount += 1;
    const item: InboxItem = {
      id: `plan-${this.planCount}`,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      kind: "plan",
      title: input.title,
      body: input.body,
      state: "pending",
      inbox: input.inbox ?? "default",
      visibility: input.visibility ?? "inbox",
      data: input.data,
      createdAt: new Date().toISOString(),
    };
    this.items.push(item);
    return item;
  }

  async wait(): Promise<string> {
    return this.waitValue;
  }

  async addApproval(): Promise<InboxItem> {
    throw new Error("unused");
  }
  async addQuestion(): Promise<InboxItem> {
    throw new Error("unused");
  }
  async addNotification(): Promise<InboxItem> {
    throw new Error("unused");
  }
  async get(): Promise<InboxItem | undefined> {
    throw new Error("unused");
  }
  async list(): Promise<InboxItem[]> {
    throw new Error("unused");
  }
  async pending(): Promise<InboxItem[]> {
    throw new Error("unused");
  }
  async resolve(): Promise<boolean> {
    throw new Error("unused");
  }
  async resolveSession(): Promise<number> {
    throw new Error("unused");
  }
  async standingRuleFor(): Promise<null> {
    return null;
  }
  async inspectStandingRules(): Promise<never> {
    throw new Error("unused");
  }
  async reset(): Promise<void> {
    throw new Error("unused");
  }
  async reconcile(): Promise<never> {
    throw new Error("unused");
  }
}

describe("plan risk classification", () => {
  it("classifies a read-only plan as low", () => {
    expect(planRisk(plan()).level).toBe("low");
  });

  it("escalates to medium on a write_local step", () => {
    const p = plan({
      steps: [
        ...plan().steps,
        { id: "s3", title: "Stage rows", command: "cmd/stage", riskClass: "write_local" },
      ],
    });
    const risk = planRisk(p);
    expect(risk.level).toBe("medium");
    expect(risk.reasons.join(" ")).toContain("s3");
  });

  it("escalates to high on an external step", () => {
    const p = plan({
      steps: [
        ...plan().steps,
        { id: "s3", title: "Send email", command: "msg/send", riskClass: "external" },
      ],
    });
    expect(planRisk(p).level).toBe("high");
  });

  it("escalates to high from a required approval risk class", () => {
    const p = plan({
      steps: [],
      requiredApprovals: [{ riskClass: "exec", reason: "run migration" }],
    });
    expect(planRisk(p).level).toBe("high");
  });

  it("escalates to high from a declared plan risk", () => {
    const p = plan({ risks: [{ level: "high", description: "irreversible commit" }] });
    expect(planRisk(p).level).toBe("high");
  });

  it("planRequiresApproval is false for low risk, true otherwise", () => {
    expect(planRequiresApproval(plan())).toBe(false);
    expect(
      planRequiresApproval(
        plan({
          steps: [
            ...plan().steps,
            { id: "s3", title: "Stage rows", riskClass: "write_local" },
          ],
        }),
      ),
    ).toBe(true);
    expect(planRequiresApproval(plan({ requiredApprovals: [{ riskClass: "read", reason: "double-check" }] }))).toBe(true);
  });
});

describe("plan rendering", () => {
  it("summarizePlan captures objective, risk, and steps", () => {
    const s = summarizePlan(plan());
    expect(s).toContain("Import QuickBooks exports");
    expect(s).toContain("risk=low");
    expect(s).toContain("2 steps");
    expect(s).toContain("query/import_profile");
  });

  it("renderPlan is human-readable and lists approvals", () => {
    const p = plan({
      requiredApprovals: [{ commandType: "cmd/commit", riskClass: "exec", reason: "irreversible" }],
    });
    const text = renderPlan(p);
    expect(text).toContain("# Import QuickBooks exports");
    expect(text).toContain("s1 Profile the export");
    expect(text).toContain("cmd/commit: irreversible");
  });
});

describe("validatePlan (Zod boundary)", () => {
  it("accepts a well-formed plan", () => {
    const r = validatePlan(plan());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.objective).toBe("Import QuickBooks exports");
  });

  it("rejects a plan without an objective", () => {
    const r = validatePlan(plan({ objective: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === "objective")).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    const r = validatePlan({ ...plan(), stray: true });
    expect(r.ok).toBe(false);
  });
});

describe("requestPlanApproval", () => {
  const ctx = {
    sessionId: "sess-1",
    organizationId: "org-1",
    userId: "ai-1",
    approverUserId: "human-1",
    now: () => new Date("2026-01-01T00:00:00Z"),
  };

  it("auto-runs a low-risk plan without an inbox item or grants", async () => {
    const inbox = new FakeInbox();
    const grants: ApprovalGrantStore = new InMemoryApprovalGrantStore();
    const trajectory = new InMemorySessionLog();

    const result = await requestPlanApproval(plan(), { ...ctx, inbox, grants, trajectory });

    expect(result).toEqual({ approved: true, via: "low_risk", grantIds: [] });
    expect(inbox.planCount).toBe(0);
    expect(await grants.list("org-1")).toHaveLength(0);
    const events = await trajectory.list("sess-1");
    expect(events.map((e) => e.type)).toEqual(["plan/proposed"]);
  });

  it("surfaces a medium-risk plan, mints durable grants on approval", async () => {
    const inbox = new FakeInbox();
    const grants: ApprovalGrantStore = new InMemoryApprovalGrantStore();
    const trajectory = new InMemorySessionLog();
    const p = plan({
      requiredApprovals: [{ commandType: "cmd/commit", riskClass: "exec", reason: "irreversible" }],
    });

    const result = await requestPlanApproval(p, { ...ctx, inbox, grants, trajectory });

    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.via).toBe("human");
      expect(result.grantIds).toHaveLength(1);
    }
    expect(inbox.planCount).toBe(1);
    expect(inbox.items[0].kind).toBe("plan");
    expect(inbox.items[0].body).toContain("cmd/commit: irreversible");
    expect(await grants.list("org-1")).toHaveLength(1);

    const events = await trajectory.list("sess-1");
    expect(events.map((e) => e.type)).toEqual(["plan/proposed", "approval/granted"]);
  });

  it("does not mint grants when the plan is rejected", async () => {
    const inbox = new FakeInbox();
    inbox.waitValue = "rejected";
    const grants: ApprovalGrantStore = new InMemoryApprovalGrantStore();
    const trajectory = new InMemorySessionLog();
    const p = plan({
      requiredApprovals: [{ commandType: "cmd/commit", riskClass: "exec", reason: "irreversible" }],
    });

    const result = await requestPlanApproval(p, { ...ctx, inbox, grants, trajectory });

    expect(result).toEqual({ approved: false, via: "rejected", reason: "rejected" });
    expect(await grants.list("org-1")).toHaveLength(0);
    const events = await trajectory.list("sess-1");
    expect(events.map((e) => e.type)).toEqual(["plan/proposed", "approval/rejected"]);
  });

  it("fails closed when no decision surface is wired", async () => {
    const trajectory = new InMemorySessionLog();
    const result = await requestPlanApproval(
      plan({ requiredApprovals: [{ riskClass: "read", reason: "double-check" }] }),
      { ...ctx, trajectory },
    );
    expect(result).toEqual({
      approved: false,
      via: "no_decision_surface",
      reason: "No decision surface wired for plan approval",
    });
  });

  it("minted grant covers the approved command for the granted actor", async () => {
    const inbox = new FakeInbox();
    const grants: ApprovalGrantStore = new InMemoryApprovalGrantStore();
    const p = plan({
      requiredApprovals: [{ commandType: "cmd/commit", riskClass: "exec", reason: "irreversible" }],
    });

    const result = await requestPlanApproval(p, { ...ctx, inbox, grants });
    expect(result.approved).toBe(true);

    const check = await grants.check({
      organizationId: "org-1",
      userId: "ai-1",
      commandType: "cmd/commit",
      now: ctx.now,
    });
    expect(check.ok).toBe(true);

    const wrongActor = await grants.check({
      organizationId: "org-1",
      userId: "other-ai",
      commandType: "cmd/commit",
      now: ctx.now,
    });
    expect(wrongActor.ok).toBe(false);
  });
});