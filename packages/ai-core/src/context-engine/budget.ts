import type { TokenBudget } from "./types.js";

/**
 * Token budget policy (research doc §Context Engineering Specification).
 *
 * hard budget = min(model capacity − response reserve, tenant/task cost cap)
 * reserve scales by task kind; emergency budget is carved out for tool results
 * and approval messages.
 */
export type TaskKind = "ordinary" | "document_report" | "tool_heavy";

export const RESERVE_FRACTION: Record<TaskKind, { min: number; max: number; emergency: number }> = {
  ordinary: { min: 0.15, max: 0.25, emergency: 0.08 },
  document_report: { min: 0.3, max: 0.4, emergency: 0.05 },
  tool_heavy: { min: 0.12, max: 0.2, emergency: 0.15 },
};

export interface AllocateBudgetOptions {
  capacity: number;
  taskKind?: TaskKind;
  /** Optional tenant/task cost cap in tokens. */
  costCapTokens?: number;
  /** Optional explicit response reserve fraction override within [min,max]. */
  reserveFraction?: number;
}

export function allocateBudget(opts: AllocateBudgetOptions): TokenBudget {
  const { capacity, taskKind = "ordinary", costCapTokens, reserveFraction } = opts;
  const spec = RESERVE_FRACTION[taskKind];
  const clamped = Math.min(spec.max, Math.max(spec.min, reserveFraction ?? spec.min));
  const reserveTokens = Math.floor(capacity * clamped);
  const hardBudget = Math.min(capacity - reserveTokens, costCapTokens ?? capacity);
  return {
    capacity,
    reserveTokens,
    hardBudget,
    usedTokens: 0,
    overflow: false,
  };
}

/** The doc's allocation order: lowest priority wins omission first. */
export const ALLOCATION_ORDER = [
  { key: "invariants", tier: 0, priority: 1 },
  { key: "task_intent", tier: 2, priority: 2 },
  { key: "workflow_state", tier: 2, priority: 3 },
  { key: "tool_schemas", tier: 3, priority: 4 },
  { key: "cited_evidence", tier: 3, priority: 5 },
  { key: "recent_turns", tier: 2, priority: 6 },
  { key: "summaries_memory", tier: 4, priority: 7 },
  { key: "examples_longtail", tier: 5, priority: 8 },
] as const;

export function isUnderBudget(budget: TokenBudget, additionalTokens: number): boolean {
  return budget.usedTokens + additionalTokens <= budget.hardBudget;
}
