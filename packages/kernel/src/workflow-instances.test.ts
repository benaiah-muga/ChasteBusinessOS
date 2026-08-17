import { describe, expect, it } from "vitest";
import {
  applyStepResult,
  completedStepIds,
  finalizeInstance,
  InMemoryWorkflowInstanceStore,
  newWorkflowInstance,
  type WorkflowInstance,
} from "./workflow-instances.js";

const now = () => new Date("2026-08-17T09:00:00Z");

function instance(): WorkflowInstance {
  return newWorkflowInstance({
    id: "inst-1",
    workflowId: "wf-1",
    organizationId: "o1",
    createdByUserId: "u1",
    input: { customer: "acme" },
    now,
  });
}

describe("newWorkflowInstance", () => {
  it("seeds a running instance with input in context", () => {
    const i = instance();
    expect(i.status).toBe("running");
    expect(i.steps).toEqual([]);
    expect(i.context.input).toEqual({ customer: "acme" });
    expect(i.context.customer).toBe("acme");
    expect(i.startedAt).toBe(now().toISOString());
  });
});

describe("applyStepResult", () => {
  it("records the step, merges its output, and keeps running", () => {
    const i = applyStepResult(instance(), {
      stepId: "s1",
      status: "completed",
      output: { id: "cust-1" },
    }, now);
    expect(i.steps).toHaveLength(1);
    expect(i.steps[0]?.status).toBe("completed");
    expect(i.context.s1).toEqual({ id: "cust-1" });
    expect(i.status).toBe("running");
  });

  it("parks the instance at pending_approval on an approval gate", () => {
    const i = applyStepResult(instance(), { stepId: "gate", status: "pending_approval" }, now);
    expect(i.status).toBe("pending_approval");
  });

  it("fails the instance on a failed step", () => {
    const i = applyStepResult(instance(), { stepId: "s1", status: "failed", error: "boom" }, now);
    expect(i.status).toBe("failed");
    expect(i.steps[0]?.error).toBe("boom");
  });

  it("replaces a prior result for the same step id", () => {
    let i = applyStepResult(instance(), { stepId: "s1", status: "completed", output: { id: "a" } }, now);
    i = applyStepResult(i, { stepId: "s1", status: "completed", output: { id: "b" } }, now);
    expect(i.steps).toHaveLength(1);
    expect(i.context.s1).toEqual({ id: "b" });
  });

  it("marks completed steps for resumable skip", () => {
    const i = applyStepResult(instance(), { stepId: "s1", status: "completed" }, now);
    expect(completedStepIds(i)).toEqual(["s1"]);
  });
});

describe("finalizeInstance", () => {
  it("writes the terminal status exactly once", () => {
    const f = finalizeInstance(instance(), { status: "completed", now });
    expect(f.status).toBe("completed");
    expect(f.completedAt).toBe(now().toISOString());

    const failed = finalizeInstance(instance(), { status: "failed", error: "boom", now });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
  });
});

describe("InMemoryWorkflowInstanceStore", () => {
  it("saves, gets, and lists by org with filters", async () => {
    const store = new InMemoryWorkflowInstanceStore();
    const a = instance();
    const b = newWorkflowInstance({
      id: "inst-2",
      workflowId: "wf-2",
      organizationId: "o1",
      createdByUserId: "u2",
      now,
    });
    await store.save(a);
    await store.save(b);

    expect(await store.get("inst-1")).toMatchObject({ id: "inst-1" });
    expect((await store.listByOrg("o1")).length).toBe(2);
    expect((await store.listByOrg("o1", { workflowId: "wf-1" }))[0]?.id).toBe("inst-1");
    expect(
      (await store.listByOrg("o1", { status: "pending_approval" })).length,
    ).toBe(0);
    expect(await store.listByOrg("o2")).toHaveLength(0);

    const saved = instance();
    await store.save(saved);
    saved.steps.push({ stepId: "mut", status: "completed" });
    expect((await store.get("inst-1"))?.steps).toHaveLength(0);
  });
});