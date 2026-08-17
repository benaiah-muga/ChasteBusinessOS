/**
 * Durable Workflow Instances — the command/query surface for resumable runs.
 *
 * ADR 0014 tranche 9 (build item 10): each run of a workflow definition is a
 * `WorkflowInstance` checkpointed one step at a time into a
 * `WorkflowInstanceStore`. A crash between steps leaves the instance `running`
 * and resumable; an approval gate parks it at `pending_approval`; `advance`
 * resumes from the checkpoint without re-executing completed steps.
 *
 * Humans and agents exercise the same bus contract (`workflow.instance.*`),
 * so AI/manual parity holds by construction. The module owns no storage and no
 * definition store: definitions are read through the `core.workflow.get` query
 * and steps execute through the same command registry the host uses.
 */
import {
  NotFoundError,
  ValidationError,
  applyStepResult,
  completedStepIds,
  defineCommand,
  defineQuery,
  executeQuery,
  finalizeInstance,
  newWorkflowInstance,
  type BusinessModule,
  type CommandHelpers,
  type CommandRegistry,
  type QueryRegistry,
  type RequestContext,
  type WorkflowInstance,
  type WorkflowInstanceStore,
} from "@chaste/kernel";
import {
  executeDynamicWorkflow,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowRunResult,
} from "@chaste/ai-core";
import { z } from "zod";

const instanceStepSchema = z
  .object({
    stepId: z.string(),
    status: z.enum(["completed", "failed", "skipped", "pending_approval"]),
    output: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .strict();

const instanceOutputSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  organizationId: z.string(),
  status: z.enum(["running", "pending_approval", "completed", "failed", "cancelled"]),
  context: z.record(z.unknown()),
  steps: z.array(instanceStepSchema),
  error: z.string().optional(),
  createdByUserId: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

const runOutputSchema = z.object({
  runId: z.string(),
  success: z.boolean(),
  stepResults: z.array(instanceStepSchema),
  error: z.string().optional(),
});

function toRunOutput(run: WorkflowRunResult) {
  return {
    runId: run.runId,
    success: run.success,
    stepResults: run.stepResults.map((s) => ({ ...s })),
    error: run.error,
  };
}

async function getWorkflowDef(
  queries: QueryRegistry,
  workflowId: string,
  ctx: RequestContext,
): Promise<WorkflowDefinition> {
  const res = await executeQuery(queries, "core.workflow.get", { workflowId }, ctx);
  const parsed = workflowDefinitionSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new ValidationError("Invalid persisted workflow definition", parsed.error.flatten());
  }
  return parsed.data;
}

async function requireInstance(
  store: WorkflowInstanceStore,
  id: string,
  ctx: RequestContext,
): Promise<WorkflowInstance> {
  const instance = await store.get(id);
  if (!instance || instance.organizationId !== ctx.actor.organizationId) {
    throw new NotFoundError("Workflow instance");
  }
  return instance;
}

/**
 * Run the engine against an instance, checkpointing each step result onto the
 * instance, and return the final (possibly terminal) instance along with the run.
 */
async function runEngine(
  commands: CommandRegistry,
  def: WorkflowDefinition,
  instance: WorkflowInstance,
  ctx: RequestContext,
  helpers: CommandHelpers,
  opts: { approvedStepIds?: string[] } = {},
): Promise<{ run: WorkflowRunResult; instance: WorkflowInstance }> {
  let live = instance;
  const run = await executeDynamicWorkflow(
    def,
    {},
    { registry: commands, requestCtx: ctx, helpers },
    {
      runId: live.id,
      skipStepIds: completedStepIds(live),
      baseContext: live.context,
      approvedStepIds: opts.approvedStepIds,
      checkpoint: async (s) => {
        live = applyStepResult(live, s, ctx.now);
      },
    },
  );
  if (run.success) {
    live = finalizeInstance(live, { status: "completed", now: ctx.now });
  } else if (!run.pendingApproval) {
    live = finalizeInstance(live, {
      status: "failed",
      error: run.error ?? "workflow run failed",
      now: ctx.now,
    });
  }
  // Otherwise the checkpoint parked it at pending_approval; stays resumable.
  return { run, instance: live };
}

export function createWorkflowInstancesModule(stores: {
  instances: WorkflowInstanceStore;
}): BusinessModule {
  const { instances } = stores;

  return {
    manifest: {
      id: "workflow-instances",
      name: "Durable Workflow Instances",
      version: "0.1.0",
      description: "Resumable, checkpointed runs of workflow definitions",
      dependencies: [],
      permissions: ["workflow.instance.read", "workflow.instance.write"],
      capabilities: ["workflow.instances"],
      specialist: {
        id: "workflow-instances",
        displayName: "Workflow Instances Agent",
        description: "Start, advance, and cancel durable workflow runs",
        toolTags: ["core"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "workflow.instance.start",
          description: "Start a durable run of a workflow definition",
          permissions: ["workflow.instance.write"],
          tags: ["workflow"],
          input: z
            .object({
              workflowId: z.string(),
              input: z.record(z.unknown()).optional(),
            })
            .strict(),
          output: z.object({ instance: instanceOutputSchema, run: runOutputSchema }),
          handler: async (input, ctx, helpers) => {
            const def = await getWorkflowDef(queries, input.workflowId, ctx);
            const seed = newWorkflowInstance({
              id: crypto.randomUUID(),
              workflowId: def.id,
              organizationId: ctx.actor.organizationId,
              createdByUserId: ctx.actor.userId,
              input: input.input,
              now: ctx.now,
            });
            const { run, instance } = await runEngine(commands, def, seed, ctx, helpers);
            await instances.save(instance);
            return { instance, run: toRunOutput(run) };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "workflow.instance.advance",
          description: "Resume a durable workflow instance from its checkpoint",
          permissions: ["workflow.instance.write"],
          tags: ["workflow"],
          input: z
            .object({
              instanceId: z.string(),
              approvedStepIds: z.array(z.string()).optional(),
            })
            .strict(),
          output: z.object({ instance: instanceOutputSchema, run: runOutputSchema }),
          handler: async (input, ctx, helpers) => {
            const found = await requireInstance(instances, input.instanceId, ctx);
            if (
              found.status === "completed" ||
              found.status === "failed" ||
              found.status === "cancelled"
            ) {
              throw new ValidationError("Workflow instance already terminated");
            }
            const def = await getWorkflowDef(queries, found.workflowId, ctx);
            const { run, instance } = await runEngine(commands, def, found, ctx, helpers, {
              approvedStepIds: input.approvedStepIds,
            });
            await instances.save(instance);
            return { instance, run: toRunOutput(run) };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "workflow.instance.cancel",
          description: "Cancel a running or pending-approval workflow instance",
          permissions: ["workflow.instance.write"],
          tags: ["workflow"],
          input: z
            .object({
              instanceId: z.string(),
              reason: z.string().optional(),
            })
            .strict(),
          output: z.object({ instance: instanceOutputSchema }),
          handler: async (input, ctx) => {
            const found = await requireInstance(instances, input.instanceId, ctx);
            if (
              found.status === "completed" ||
              found.status === "failed" ||
              found.status === "cancelled"
            ) {
              throw new ValidationError("Workflow instance already terminated");
            }
            const cancelled = finalizeInstance(found, {
              status: "cancelled",
              error: input.reason,
              now: ctx.now,
            });
            await instances.save(cancelled);
            return { instance: cancelled };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "workflow.instance.get",
          description: "Get a durable workflow instance by id",
          permissions: ["workflow.instance.read"],
          tags: ["workflow"],
          input: z.object({ instanceId: z.string() }).strict(),
          output: instanceOutputSchema,
          handler: async (input, ctx) => requireInstance(instances, input.instanceId, ctx),
        }),
      );

      queries.register(
        defineQuery({
          name: "workflow.instance.list",
          description: "List durable workflow instances for the organization",
          permissions: ["workflow.instance.read"],
          tags: ["workflow"],
          input: z
            .object({
              workflowId: z.string().optional(),
              status: z
                .enum(["running", "pending_approval", "completed", "failed", "cancelled"])
                .optional(),
            })
            .strict(),
          output: z.object({ items: z.array(instanceOutputSchema) }),
          handler: async (input, ctx) => ({
            items: await instances.listByOrg(ctx.actor.organizationId, {
              workflowId: input.workflowId,
              status: input.status,
            }),
          }),
        }),
      );
    },
  };
}