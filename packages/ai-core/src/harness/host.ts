import type {
  Actor,
  ApprovalGrantStore,
  CommandHelpers,
  CommandRegistry,
  InboxItem,
  InboxStore,
  QueryRegistry,
} from "@chaste/kernel";
import type { SessionLog } from "../trajectory/index.js";
import { grantPlanApprovals, proposePlanApproval, validatePlan } from "../planning/index.js";
import { buildToolsFromBus } from "../tools/from-bus.js";
import type { BusToolInfo } from "../tools/from-bus.js";
import type { ToolOutcome, ToolRegistry } from "../tools/index.js";
import { createHarness, runPlanSteps } from "./harness.js";
import { createToolContextFactory } from "./tool-context.js";
import type {
  Harness,
  PlanRunParams,
  PlanRunResult,
  ToolCallParams,
  ToolSurface,
} from "./types.js";
import type { PlanStore, PendingPlanEntry } from "./plan-store.js";

export type { PendingPlanEntry } from "./plan-store.js";

/**
 * Host layer (research doc build item 9 — the surface that runs the harness):
 *
 * `createHarnessHost` wires the harness to a runtime's durable stores and, by
 * default, populates the tool registry from the command/query bus itself (a
 * tool per bus entry, wrapping the same Zod contracts and permissions). It is
 * the object an HTTP/chat host calls instead of the ad-hoc orchestrator:
 *
 * - `runPlan`    — blocking harness run (waits on the inbox for approval).
 * - `submitPlan` — non-blocking: low-risk plans execute immediately;
 *   medium/high-risk plans surface an inbox item (`via: "awaiting"`) and are
 *   stored for later execution.
 * - `decide`     — a human's decision on an inbox item: approving a stored plan
 *   mints its durable grants and executes the steps; rejecting records the
 *   rejection. Other item kinds resolve generically.
 * - `pendingItems` / `pendingPlans` — what awaits human attention.
 *
 * The host never elevates the agent: every step and call dispatches through
 * the bus under the actor's own permissions, and approval flows through
 * durable grants (ADR 0014 tranche 3).
 */

/** Pending plan awaiting a human decision, keyed by its inbox item id. */

export interface HarnessHostOptions {
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  /** Durable grant store; approval-required calls stay requests without it. */
  grants?: ApprovalGrantStore;
  /** Human-attention queue used for approvals and plan review. */
  inbox?: InboxStore;
  /** Append-only session trajectory. */
  trajectory?: SessionLog;
  /** Durable pending-plan store; falls back to a process-local map without it. */
  planStore?: PlanStore;
  grantTtlMs?: number;
  now?: () => Date;
  /** Tool registry; defaults to one built from the command/query bus. */
  registry?: ToolRegistry;
  /** Filter applied when building the default bus-backed registry. */
  tools?: { include?: (def: BusToolInfo) => boolean };
}

export type SubmitPlanResult =
  | { status: "executed"; result: PlanRunResult }
  | { status: "pending_approval"; itemId: string; planId: string; reason: string }
  | { status: "rejected"; reason: string };

export type DecideResult =
  | { resolved: true; kind: "plan"; result: PlanRunResult }
  | { resolved: true; kind: "item" }
  | { resolved: false; reason: string };

export interface HarnessHost {
  /** A harness bound to one approver (each host call may name its approver). */
  harnessFor(approverUserId?: string): Harness;
  toolSurface(actor: Actor): ToolSurface;
  call(params: ToolCallParams): Promise<ToolOutcome>;
  /** Blocking plan run (waits on the inbox for approval when needed). */
  runPlan(params: PlanRunParams & { approverUserId?: string }): Promise<PlanRunResult>;
  /** Non-blocking plan submission; pending plans execute after `decide`. */
  submitPlan(params: PlanRunParams & { approverUserId: string }): Promise<SubmitPlanResult>;
  /** Resolve an inbox item; approving a stored plan executes its steps. */
  decide(input: {
    itemId: string;
    organizationId: string;
    /** The user resolving the item; must match the item's target user. */
    userId: string;
    resolution: string;
  }): Promise<DecideResult>;
  pendingItems(filter?: { organizationId?: string; userId?: string }): Promise<InboxItem[]>;
  pendingPlans(): Promise<PendingPlanEntry[]>;
}

export function createHarnessHost(opts: HarnessHostOptions): HarnessHost {
  const registry =
    opts.registry ??
    buildToolsFromBus({
      commands: opts.commands,
      queries: opts.queries,
      include: opts.tools?.include,
    });

  const pending = new Map<string, PendingPlanEntry>();

  /** Persist a pending entry durably, or to the process-local map. */
  function storePending(entry: PendingPlanEntry): Promise<void> {
    return opts.planStore ? opts.planStore.save(entry) : (pending.set(entry.itemId, entry), Promise.resolve());
  }

  /** Look up a pending entry by inbox item id or plan id. */
  async function loadPending(itemId: string, planId?: string): Promise<PendingPlanEntry | undefined> {
    if (opts.planStore) {
      return (
        (await opts.planStore.getByItemId(itemId)) ??
        (planId ? await opts.planStore.getByPlanId(planId) : undefined)
      );
    }
    return pending.get(itemId) ?? [...pending.values()].find((e) => e.plan.id === planId);
  }

  /** Remove a resolved pending entry from wherever it lives. */
  async function removePending(itemId: string): Promise<void> {
    if (opts.planStore) await opts.planStore.remove(itemId);
    else pending.delete(itemId);
  }

  const buildToolContext = (approverUserId?: string) =>
    createToolContextFactory({
      commands: opts.commands,
      queries: opts.queries,
      helpers: opts.helpers,
      grants: opts.grants,
      inbox: opts.inbox,
      approverUserId,
      trajectory: opts.trajectory,
      now: opts.now,
      grantTtlMs: opts.grantTtlMs,
    });

  function harnessFor(approverUserId?: string): Harness {
    return createHarness({
      registry,
      commands: opts.commands,
      queries: opts.queries,
      helpers: opts.helpers,
      grants: opts.grants,
      inbox: opts.inbox,
      approverUserId,
      trajectory: opts.trajectory,
      now: opts.now,
      grantTtlMs: opts.grantTtlMs,
    });
  }

  function toolSurface(actor: Actor): ToolSurface {
    return harnessFor().toolSurface(actor);
  }

  function call(params: ToolCallParams): Promise<ToolOutcome> {
    return harnessFor().call(params);
  }

  function runPlan(params: PlanRunParams & { approverUserId?: string }): Promise<PlanRunResult> {
    return harnessFor(params.approverUserId).runPlan(params);
  }

  async function submitPlan(
    params: PlanRunParams & { approverUserId: string },
  ): Promise<SubmitPlanResult> {
    const validation = validatePlan(params.plan);
    if (!validation.ok) {
      return {
        status: "rejected",
        reason: `plan failed boundary validation: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      };
    }
    const plan = validation.plan;
    const approval = await proposePlanApproval(plan, {
      sessionId: params.sessionId,
      organizationId: params.organizationId,
      userId: params.actor.userId,
      approverUserId: params.approverUserId,
      grantTtlMs: opts.grantTtlMs,
      inbox: opts.inbox,
      grants: opts.grants,
      trajectory: opts.trajectory,
      now: opts.now,
    });

    if (approval.approved) {
      const result = await runPlan({ ...params, plan });
      return { status: "executed", result };
    }
    if (approval.via === "awaiting" && approval.itemId) {
      await storePending({
        plan,
        itemId: approval.itemId,
        params: { ...params, plan },
        approverUserId: params.approverUserId,
      });
      return {
        status: "pending_approval",
        itemId: approval.itemId,
        planId: plan.id,
        reason: approval.reason,
      };
    }
    return { status: "rejected", reason: approval.reason };
  }

  async function decide(input: {
    itemId: string;
    organizationId: string;
    userId: string;
    resolution: string;
  }): Promise<DecideResult> {
    const item = opts.inbox ? await opts.inbox.get(input.itemId) : undefined;
    if (!item) return { resolved: false, reason: "no such inbox item" };
    if (item.organizationId !== input.organizationId || item.userId !== input.userId) {
      return { resolved: false, reason: "inbox item does not belong to this caller" };
    }

    const entry = await loadPending(input.itemId, item.data?.planId as string | undefined);

    if (item.kind === "plan" && entry) {
      if (input.resolution === "approved") {
        await opts.inbox!.resolve(item.id, "approved");
        const grantIds = await grantPlanApprovals(entry.plan, {
          sessionId: entry.params.sessionId,
          organizationId: input.organizationId,
          userId: entry.params.actor.userId,
          approverUserId: entry.approverUserId,
          grantTtlMs: opts.grantTtlMs,
          inbox: opts.inbox,
          grants: opts.grants,
          trajectory: opts.trajectory,
          now: opts.now,
        });
        const run = await runPlanSteps({
          plan: entry.plan,
          actor: entry.params.actor,
          sessionId: entry.params.sessionId,
          organizationId: input.organizationId,
          correlationId: entry.params.correlationId,
          causationId: entry.params.causationId,
          origin: entry.params.origin,
          reason: entry.params.reason,
          evidenceRefs: entry.params.evidenceRefs,
          policyContext: entry.params.policyContext,
          registry,
          buildToolContext: buildToolContext(entry.approverUserId),
          trajectory: opts.trajectory,
          now: opts.now,
        });
        await removePending(input.itemId);
        return {
          resolved: true,
          kind: "plan",
          result: { ok: true, grantIds, steps: run.steps, stopped: run.stopped, stopReason: run.stopReason },
        };
      }
      await opts.inbox!.resolve(item.id, input.resolution);
      await removePending(input.itemId);
      return {
        resolved: true,
        kind: "plan",
        result: {
          ok: false,
          reason: `Plan rejected (${input.resolution})`,
          grantIds: [],
          steps: [],
        },
      };
    }

    const resolved = await opts.inbox!.resolve(item.id, input.resolution);
    return resolved ? { resolved: true, kind: "item" } : { resolved: false, reason: "could not resolve item" };
  }

  async function pendingItems(filter?: {
    organizationId?: string;
    userId?: string;
  }): Promise<InboxItem[]> {
    if (!opts.inbox) return [];
    const items = filter?.organizationId
      ? await opts.inbox.pending({ organizationId: filter.organizationId })
      : await opts.inbox.pending();
    return filter?.userId ? items.filter((i) => i.userId === filter.userId) : items;
  }

  async function pendingPlans(): Promise<PendingPlanEntry[]> {
    return opts.planStore ? opts.planStore.listAll() : [...pending.values()];
  }

  return { harnessFor, toolSurface, call, runPlan, submitPlan, decide, pendingItems, pendingPlans };
}