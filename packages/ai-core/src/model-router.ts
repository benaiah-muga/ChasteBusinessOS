/**
 * Model router + cost controls (research doc §Harness Runtime — the `ModelRouter`
 * between the prompt envelope and the LLM call; ADR 0014 tranche 11).
 *
 * A `ModelRouter` selects a provider per *task class* (rules / chat / planning /
 * report), records every completion into a durable `UsageLedger` with an
 * estimated cost, and enforces budget caps (per-org monthly, per-session)
 * before dispatching. The ledger is in-memory here and Postgres-backed in
 * `@chaste/runtime`, so spend is shared across hosts and survives restarts.
 *
 * Routing and cost policy are explicit configuration, never model invention.
 * A request is refused (fail closed) when its task class has no route or its
 * budget is exhausted.
 */
import { z } from "zod";
import type { AiProvider, CompletionRequest, CompletionResult } from "./providers.js";

export const taskClassSchema = z.enum(["rules", "chat", "planning", "report"]);

export type TaskClass = z.infer<typeof taskClassSchema>;

export interface UsageRecord {
  id?: string;
  organizationId: string;
  sessionId: string;
  taskClass: TaskClass;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCents: number;
  createdAt: string;
}

export interface UsageLedger {
  record(usage: UsageRecord): Promise<void>;
  /** Sum of estimated cost (cents) for an org since `since` (inclusive). */
  spendForOrganization(organizationId: string, since: Date): Promise<number>;
  /** Sum of estimated cost (cents) for a session. */
  spendForSession(sessionId: string): Promise<number>;
}

export class InMemoryUsageLedger implements UsageLedger {
  private readonly records: UsageRecord[] = [];

  async record(usage: UsageRecord): Promise<void> {
    this.records.push({ ...usage });
  }

  async spendForOrganization(organizationId: string, since: Date): Promise<number> {
    return this.records
      .filter((r) => r.organizationId === organizationId && new Date(r.createdAt) >= since)
      .reduce((sum, r) => sum + r.estimatedCostCents, 0);
  }

  async spendForSession(sessionId: string): Promise<number> {
    return this.records
      .filter((r) => r.sessionId === sessionId)
      .reduce((sum, r) => sum + r.estimatedCostCents, 0);
  }
}

/** Task class → provider id. Missing routes fall back to `defaultRoute`. */
export interface ModelRouterConfig {
  routes?: Partial<Record<TaskClass, string>>;
  defaultRoute?: string;
}

export interface BudgetPolicy {
  enabled: boolean;
  /** Cap on cumulative estimated cost (cents) per organization per month. */
  organizationMonthlyCents?: number;
  /** Cap on cumulative estimated cost (cents) per session. */
  sessionCents?: number;
}

/** Provider id → price per 1M tokens, in cents. Missing prices estimate 0. */
export type PriceTable = Record<string, { promptCents?: number; completionCents?: number }>;

export interface RouterCallContext {
  organizationId: string;
  sessionId: string;
}

export interface RouterCompletionResult extends CompletionResult {
  taskClass: TaskClass;
  estimatedCostCents: number;
}

export interface ModelRouter {
  /** The provider id selected for a task class (throws when unroutable). */
  route(taskClass: TaskClass): string;
  /**
   * Dispatch a completion for a task class: route, budget-check, execute, and
   * record usage. Throws `BudgetLimitError` before dispatch when the cap is
   * exhausted.
   */
  complete(
    taskClass: TaskClass,
    req: CompletionRequest,
    ctx: RouterCallContext,
  ): Promise<RouterCompletionResult>;
}

export class ModelRouteError extends Error {
  constructor(taskClass: TaskClass, providerId: string) {
    super(`No provider available for task class "${taskClass}" (route "${providerId}")`);
    this.name = "ModelRouteError";
  }
}

export class BudgetLimitError extends Error {
  constructor(kind: "organization_monthly" | "session", cents: number) {
    super(`AI budget exhausted (${kind}, spent >= ${cents} cents)`);
    this.name = "BudgetLimitError";
  }
}

/** Estimate cost in cents from token usage and a per-1M-token price. */
export function estimateCostCents(
  price: { promptCents?: number; completionCents?: number } | undefined,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): number {
  if (!price) return 0;
  const prompt = ((usage?.promptTokens ?? 0) / 1_000_000) * (price.promptCents ?? 0);
  const completion = ((usage?.completionTokens ?? 0) / 1_000_000) * (price.completionCents ?? 0);
  return Math.round(prompt + completion);
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface CreateModelRouterOptions {
  /** Provider instances keyed by id (the routing targets). */
  providers: Record<string, AiProvider>;
  config: ModelRouterConfig;
  budget?: BudgetPolicy;
  prices?: PriceTable;
  ledger: UsageLedger;
  now?: () => Date;
}

export function createModelRouter(opts: CreateModelRouterOptions): ModelRouter {
  const now = opts.now ?? (() => new Date());
  const budget = opts.budget ?? { enabled: false };
  const ledger = opts.ledger;
  const providers = opts.providers;

  function route(taskClass: TaskClass): string {
    const providerId = opts.config.routes?.[taskClass] ?? opts.config.defaultRoute ?? "main";
    if (!providers[providerId]) {
      throw new ModelRouteError(taskClass, providerId);
    }
    return providerId;
  }

  async function checkBudget(ctx: RouterCallContext): Promise<void> {
    if (!budget.enabled) return;
    if (budget.organizationMonthlyCents !== undefined) {
      const spent = await ledger.spendForOrganization(ctx.organizationId, startOfMonth(now()));
      if (spent >= budget.organizationMonthlyCents) {
        throw new BudgetLimitError("organization_monthly", budget.organizationMonthlyCents);
      }
    }
    if (budget.sessionCents !== undefined) {
      const spent = await ledger.spendForSession(ctx.sessionId);
      if (spent >= budget.sessionCents) {
        throw new BudgetLimitError("session", budget.sessionCents);
      }
    }
  }

  async function complete(
    taskClass: TaskClass,
    req: CompletionRequest,
    ctx: RouterCallContext,
  ): Promise<RouterCompletionResult> {
    const providerId = route(taskClass);
    const provider = providers[providerId]!;
    await checkBudget(ctx);
    const result = await provider.complete(req);
    const estimatedCostCents = estimateCostCents(
      opts.prices?.[providerId],
      result.usage,
    );
    await ledger.record({
      organizationId: ctx.organizationId,
      sessionId: ctx.sessionId,
      taskClass,
      providerId,
      model: result.model,
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
      estimatedCostCents,
      createdAt: now().toISOString(),
    });
    return { ...result, taskClass, estimatedCostCents };
  }

  return { route, complete };
}