/**
 * Durable workflow instances (research doc §Failure is normal, build item 10).
 *
 * A `WorkflowInstance` is the durable, resumable state of one run of a workflow
 * definition: its inputs, per-step results, status, and error. It is stored via
 * a `WorkflowInstanceStore` (in-memory in the kernel, Postgres in the runtime)
 * and mutated only through the pure helpers here (`applyStepResult`,
 * `finalizeInstance`, ...), so the state machine is testable without a store
 * and a store can never drift from the model.
 *
 * Instances checkpoint one step at a time: a crash between steps leaves the
 * instance resumable (`running`), an approval gate parks it at
 * `pending_approval`, and a terminal `completed`/`failed`/`cancelled` status is
 * written exactly once.
 */

export type WorkflowInstanceStatus =
  | "running"
  | "pending_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowInstanceStepStatus = "completed" | "failed" | "skipped" | "pending_approval";

export interface WorkflowInstanceStep {
  stepId: string;
  status: WorkflowInstanceStepStatus;
  output?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowInstance {
  id: string;
  workflowId: string;
  organizationId: string;
  status: WorkflowInstanceStatus;
  /** Run context: `input` under `input`, step outputs under their step ids. */
  context: Record<string, unknown>;
  steps: WorkflowInstanceStep[];
  error?: string;
  createdByUserId: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface NewWorkflowInstanceInput {
  id: string;
  workflowId: string;
  organizationId: string;
  createdByUserId: string;
  input?: Record<string, unknown>;
  now?: () => Date;
}

/** Create a fresh running instance seeded with the run input. */
export function newWorkflowInstance(opts: NewWorkflowInstanceInput): WorkflowInstance {
  const now = (opts.now?.() ?? new Date()).toISOString();
  const input = opts.input ?? {};
  return {
    id: opts.id,
    workflowId: opts.workflowId,
    organizationId: opts.organizationId,
    status: "running",
    context: { input: { ...input }, ...input },
    steps: [],
    createdByUserId: opts.createdByUserId,
    startedAt: now,
    updatedAt: now,
  };
}

/** Apply one step result: record the step, merge its output, update status. */
export function applyStepResult(
  instance: WorkflowInstance,
  result: WorkflowInstanceStep,
  now?: () => Date,
): WorkflowInstance {
  const others = instance.steps.filter((s) => s.stepId !== result.stepId);
  const steps = [...others, result];
  let status: WorkflowInstanceStatus = instance.status;
  if (result.status === "pending_approval") status = "pending_approval";
  else if (result.status === "failed" && status !== "failed") status = "failed";
  else if (status === "pending_approval" && result.status === "completed") {
    // An approved gate can unblock the run; the run decides its terminal state.
    status = "running";
  }
  const context = { ...instance.context };
  if (result.output) context[result.stepId] = result.output;
  return {
    ...instance,
    status,
    steps,
    context,
    updatedAt: (now?.() ?? new Date()).toISOString(),
  };
}

/** Terminal transition: completed, failed, or cancelled (written exactly once). */
export function finalizeInstance(
  instance: WorkflowInstance,
  opts: { status: "completed" | "failed" | "cancelled"; error?: string; now?: () => Date },
): WorkflowInstance {
  const now = (opts.now?.() ?? new Date()).toISOString();
  return {
    ...instance,
    status: opts.status,
    error: opts.error,
    completedAt: now,
    updatedAt: now,
  };
}

/** Step ids with a completed result (used to resume without re-executing). */
export function completedStepIds(instance: WorkflowInstance): string[] {
  return instance.steps.filter((s) => s.status === "completed").map((s) => s.stepId);
}

export interface WorkflowInstanceStore {
  save(instance: WorkflowInstance): Promise<void>;
  get(id: string): Promise<WorkflowInstance | undefined>;
  listByOrg(
    organizationId: string,
    filter?: { workflowId?: string; status?: WorkflowInstanceStatus },
  ): Promise<WorkflowInstance[]>;
}

/** In-memory workflow-instance store (tests, dev, single-process hosts). */
export class InMemoryWorkflowInstanceStore implements WorkflowInstanceStore {
  private readonly instances = new Map<string, WorkflowInstance>();

  async save(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.id, { ...instance, steps: [...instance.steps] });
  }

  async get(id: string): Promise<WorkflowInstance | undefined> {
    return this.instances.get(id);
  }

  async listByOrg(
    organizationId: string,
    filter: { workflowId?: string; status?: WorkflowInstanceStatus } = {},
  ): Promise<WorkflowInstance[]> {
    return [...this.instances.values()].filter(
      (i) =>
        i.organizationId === organizationId &&
        (filter.workflowId === undefined || i.workflowId === filter.workflowId) &&
        (filter.status === undefined || i.status === filter.status),
    );
  }
}