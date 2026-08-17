import {
  InMemoryApprovalGrantStore,
  InMemoryAuditWriter,
  InMemoryInboxStore,
  InMemoryOutboxWriter,
  createCommandRegistry,
  createQueryRegistry,
  defineCommand,
  defineQuery,
  type Actor,
  type CommandHelpers,
} from "@chaste/kernel";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemorySessionLog } from "../trajectory/index.js";
import type { AgentPlan } from "../planning/index.js";
import { createHarnessHost } from "./host.js";

const now = () => new Date("2026-08-16T10:00:00Z");

const agent: Actor = {
  kind: "ai_assisted",
  userId: "u-agent",
  organizationId: "o1",
  permissions: new Set(["alpha.read", "alpha.write", "*"]),
  aiRunId: "run-1",
};
const approver = "u-admin";

let commits: Array<{ amount: number; by: string }>;
let drafts: string[];
let commands: ReturnType<typeof createCommandRegistry>;
let queries: ReturnType<typeof createQueryRegistry>;
let inbox: InMemoryInboxStore;
let grants: InMemoryApprovalGrantStore;
let trajectory: InMemorySessionLog;

function helpers(): CommandHelpers {
  return { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
}

function planFor(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan-1",
    objective: "Commit the month close",
    assumptions: [],
    steps: [
      { id: "s1", title: "Commit ledger", command: "alpha.commit", args: { amount: 1 } },
    ],
    requiredApprovals: [
      { commandType: "alpha.commit", riskClass: "exec", reason: "irreversible" },
    ],
    risks: [{ level: "high", description: "commits the ledger" }],
    evidenceNeeded: [],
    stopConditions: [],
    ...overrides,
  };
}

beforeEach(() => {
  commits = [];
  drafts = [];
  commands = createCommandRegistry();
  queries = createQueryRegistry();
  inbox = new InMemoryInboxStore({ now });
  grants = new InMemoryApprovalGrantStore({ now });
  trajectory = new InMemorySessionLog();

  commands.register(
    defineCommand({
      name: "alpha.draft",
      permissions: ["alpha.write"],
      riskClass: "write_local",
      input: z.object({ note: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: async ({ note }) => {
        drafts.push(note);
        return { ok: true };
      },
    }),
  );
  commands.register(
    defineCommand({
      name: "alpha.commit",
      permissions: ["alpha.write"],
      riskClass: "exec",
      input: z.object({ amount: z.number() }),
      output: z.object({ amount: z.number() }),
      handler: async ({ amount }, ctx) => {
        commits.push({ amount, by: ctx.actor.userId });
        return { amount };
      },
    }),
  );
  queries.register(
    defineQuery({
      name: "alpha.ledger",
      permissions: ["alpha.read"],
      input: z.object({}),
      output: z.object({ rows: z.array(z.object({ amount: z.number() })) }),
      handler: async () => ({ rows: commits.map((c) => ({ amount: c.amount })) }),
    }),
  );
});

function buildHost() {
  return createHarnessHost({
    commands,
    queries,
    helpers: helpers(),
    grants,
    inbox,
    trajectory,
    now,
  });
}

function baseParams() {
  return {
    sessionId: "sess-1",
    organizationId: "o1",
    actor: agent,
    correlationId: "corr-1",
    origin: "agent" as const,
    reason: "month close",
  };
}

async function waitForPlanItem(store: InMemoryInboxStore) {
  for (let i = 0; i < 20; i += 1) {
    const pending = await store.pending({ organizationId: "o1" });
    const item = pending.find((it) => it.kind === "plan");
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("plan inbox item never appeared");
}

describe("harness host — tool surface from the bus", () => {
  it("exposes only tools the actor's permissions allow", () => {
    const host = buildHost();
    const surface = host.toolSurface(agent);
    expect(surface.names).toContain("alpha_commit");
    expect(surface.names).toContain("alpha_ledger");

    const limited: Actor = {
      kind: "user",
      userId: "u-reader",
      organizationId: "o1",
      permissions: new Set(["alpha.read"]),
    };
    const limitedSurface = host.toolSurface(limited);
    expect(limitedSurface.names).toContain("alpha_ledger");
    expect(limitedSurface.names).not.toContain("alpha_commit");
    expect(limitedSurface.names).not.toContain("alpha_draft");
  });
});

describe("harness host — submitPlan", () => {
  it("executes a low-risk plan immediately", async () => {
    const host = buildHost();
    const lowRisk = planFor({
      requiredApprovals: [],
      steps: [{ id: "s1", title: "Draft", command: "alpha.draft", args: { note: "x" } }],
      risks: [{ level: "low", description: "no-op" }],
    });
    const result = await host.submitPlan({ ...baseParams(), plan: lowRisk, approverUserId: approver });
    expect(result.status).toBe("executed");
    if (result.status === "executed") expect(result.result.ok).toBe(true);
    expect(drafts).toEqual(["x"]);
    expect(host.pendingPlans()).toHaveLength(0);
  });

  it("rejects a plan that fails boundary validation", async () => {
    const host = buildHost();
    const invalid = { ...planFor(), steps: [{ id: "s1" }] } as unknown as AgentPlan;
    const result = await host.submitPlan({ ...baseParams(), plan: invalid, approverUserId: approver });
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("boundary validation");
  });

  it("surfaces a medium-risk plan and runs it after approval", async () => {
    const host = buildHost();
    const result = await host.submitPlan({ ...baseParams(), plan: planFor(), approverUserId: approver });
    expect(result.status).toBe("pending_approval");
    if (result.status !== "pending_approval") return;

    expect(host.pendingPlans()).toHaveLength(1);
    const pending = await host.pendingItems({ organizationId: "o1", userId: approver });
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("plan");

    const decide = await host.decide({
      itemId: result.itemId,
      organizationId: "o1",
      userId: approver,
      resolution: "approved",
    });
    expect(decide).toMatchObject({ resolved: true, kind: "plan" });
    if (decide.resolved && decide.kind === "plan") {
      expect(decide.result.ok).toBe(true);
    }
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({ amount: 1, by: "u-agent" });
    expect(await grants.list("o1")).toHaveLength(1);
    expect(host.pendingPlans()).toHaveLength(0);
  });

  it("rejects a stored plan without executing", async () => {
    const host = buildHost();
    const result = await host.submitPlan({ ...baseParams(), plan: planFor(), approverUserId: approver });
    expect(result.status).toBe("pending_approval");
    if (result.status !== "pending_approval") return;

    const decide = await host.decide({
      itemId: result.itemId,
      organizationId: "o1",
      userId: approver,
      resolution: "rejected",
    });
    expect(decide).toMatchObject({ resolved: true, kind: "plan" });
    if (decide.resolved && decide.kind === "plan") {
      expect(decide.result.ok).toBe(false);
      expect(decide.result.reason).toContain("rejected");
    }
    expect(commits).toHaveLength(0);
    expect(await grants.list("o1")).toHaveLength(0);
    expect(host.pendingPlans()).toHaveLength(0);
  });

  it("refuses to decide an item that belongs to another caller", async () => {
    const host = buildHost();
    const result = await host.submitPlan({ ...baseParams(), plan: planFor(), approverUserId: approver });
    expect(result.status).toBe("pending_approval");
    if (result.status !== "pending_approval") return;

    const wrongUser = await host.decide({
      itemId: result.itemId,
      organizationId: "o1",
      userId: "u-intruder",
      resolution: "approved",
    });
    expect(wrongUser).toEqual({ resolved: false, reason: expect.stringContaining("does not belong") });
    expect(commits).toHaveLength(0);

    const wrongOrg = await host.decide({
      itemId: result.itemId,
      organizationId: "o2",
      userId: approver,
      resolution: "approved",
    });
    expect(wrongOrg.resolved).toBe(false);
  });
});

describe("harness host — blocking runPlan", () => {
  it("waits on the inbox and executes once approved", async () => {
    const host = buildHost();
    const running = host.runPlan({ ...baseParams(), plan: planFor(), approverUserId: approver });

    const item = await waitForPlanItem(inbox);
    expect(commits).toHaveLength(0);

    await inbox.resolve(item.id, "approved");
    const result = await running;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.grantIds).toHaveLength(1);
    expect(commits).toHaveLength(1);
  });

  it("returns a rejection result when the plan is denied", async () => {
    const host = buildHost();
    const running = host.runPlan({ ...baseParams(), plan: planFor(), approverUserId: approver });

    const item = await waitForPlanItem(inbox);
    await inbox.resolve(item.id, "deny");
    const result = await running;
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toBe("deny");
    expect(commits).toHaveLength(0);
  });
});

describe("harness host — generic inbox items", () => {
  it("resolves non-plan items through decide", async () => {
    const host = buildHost();
    const item = await inbox.addApproval({
      sessionId: "sess-1",
      organizationId: "o1",
      userId: approver,
      title: "Approve alpha.commit",
      data: { commandType: "alpha.commit" },
    });
    const decide = await host.decide({
      itemId: item.id,
      organizationId: "o1",
      userId: approver,
      resolution: "allow",
    });
    expect(decide).toEqual({ resolved: true, kind: "item" });
  });
});