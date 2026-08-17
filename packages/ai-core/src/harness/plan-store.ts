/**
 * Durable pending plans — the stored form of a plan awaiting a human decision.
 *
 * ADR 0014 tranche 10: the harness host's pending-plan map is process-local, so
 * a gated plan submitted on the API host cannot be decided on the worker host.
 * `PlanStore` replaces that map with a durable store (in-memory here,
 * Postgres-backed in `@chaste/runtime`) keyed by inbox item id, without
 * changing the host contract.
 *
 * The stored record is fully serializable: the plan's `Actor.permissions` Set
 * is normalized to an array on the way in and rebuilt on the way out, so a
 * replayed decision re-executes under the exact same authority.
 */
import { z } from "zod";
import { agentPlanSchema } from "../planning/index.js";
import type { PlanRunParams } from "./types.js";

/** Plans pass through `validatePlan` at the boundary, so they match the schema. */
type StoredPlan = z.infer<typeof agentPlanSchema>;

/** Pending plan awaiting a human decision, keyed by its inbox item id. */
export interface PendingPlanEntry {
  plan: StoredPlan;
  itemId: string;
  params: PlanRunParams;
  approverUserId: string;
}

export interface PlanStore {
  save(entry: PendingPlanEntry): Promise<void>;
  getByItemId(itemId: string): Promise<PendingPlanEntry | undefined>;
  getByPlanId(planId: string): Promise<PendingPlanEntry | undefined>;
  listByOrg(organizationId: string): Promise<PendingPlanEntry[]>;
  /** All pending plans (host-level surface, e.g. `pendingPlans()`). */
  listAll(): Promise<PendingPlanEntry[]>;
  /** Resolve/remove a pending plan by its inbox item id. */
  remove(itemId: string): Promise<void>;
}

// ─── Serializable record ────────────────────────────────────────────────────

const evidenceRefRecordSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    ref: z.string(),
    version: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const actorRecordSchema = z
  .object({
    kind: z.enum(["user", "system", "ai_assisted", "api_key"]),
    userId: z.string(),
    organizationId: z.string(),
    aiRunId: z.string().optional(),
    clientId: z.string().optional(),
    displayName: z.string().optional(),
    permissions: z.array(z.string()),
  })
  .strict();

/** PlanRunParams without the plan (stored once at the record's top level). */
const paramsRecordSchema = z
  .object({
    sessionId: z.string(),
    organizationId: z.string(),
    actor: actorRecordSchema,
    correlationId: z.string(),
    causationId: z.string().optional(),
    origin: z.enum(["human", "agent", "workflow", "integration", "scheduled"]).optional(),
    reason: z.string().optional(),
    evidenceRefs: z.array(evidenceRefRecordSchema).optional(),
    policyContext: z.record(z.unknown()).optional(),
  })
  .strict();

export const pendingPlanRecordSchema = z
  .object({
    plan: agentPlanSchema,
    itemId: z.string().min(1),
    approverUserId: z.string().min(1),
    params: paramsRecordSchema,
  })
  .strict();

export type PendingPlanRecord = z.infer<typeof pendingPlanRecordSchema>;

/** Serialize a live entry into its storable record (permissions → array). */
export function toPendingPlanRecord(entry: PendingPlanEntry): PendingPlanRecord {
  const { params } = entry;
  return {
    plan: entry.plan,
    itemId: entry.itemId,
    approverUserId: entry.approverUserId,
    params: {
      sessionId: params.sessionId,
      organizationId: params.organizationId,
      actor: { ...params.actor, permissions: [...params.actor.permissions] },
      correlationId: params.correlationId,
      causationId: params.causationId,
      origin: params.origin,
      reason: params.reason,
      evidenceRefs: params.evidenceRefs,
      policyContext: params.policyContext,
    },
  };
}

/** Rebuild a live entry from a stored record (array → permissions Set). */
export function fromPendingPlanRecord(record: PendingPlanRecord): PendingPlanEntry {
  return {
    plan: record.plan,
    itemId: record.itemId,
    approverUserId: record.approverUserId,
    params: {
      ...record.params,
      actor: { ...record.params.actor, permissions: new Set(record.params.actor.permissions) },
      plan: record.plan,
    },
  };
}

/** In-memory plan store (tests, dev, single-process hosts). */
export class InMemoryPlanStore implements PlanStore {
  private readonly entries = new Map<string, PendingPlanEntry>();

  async save(entry: PendingPlanEntry): Promise<void> {
    this.entries.set(entry.itemId, {
      ...entry,
      params: {
        ...entry.params,
        actor: { ...entry.params.actor, permissions: new Set(entry.params.actor.permissions) },
      },
    });
  }

  async getByItemId(itemId: string): Promise<PendingPlanEntry | undefined> {
    return this.entries.get(itemId);
  }

  async getByPlanId(planId: string): Promise<PendingPlanEntry | undefined> {
    for (const entry of this.entries.values()) {
      if (entry.plan.id === planId) return entry;
    }
    return undefined;
  }

  async listByOrg(organizationId: string): Promise<PendingPlanEntry[]> {
    return [...this.entries.values()].filter(
      (e) => e.params.organizationId === organizationId,
    );
  }

  async listAll(): Promise<PendingPlanEntry[]> {
    return [...this.entries.values()];
  }

  async remove(itemId: string): Promise<void> {
    this.entries.delete(itemId);
  }
}