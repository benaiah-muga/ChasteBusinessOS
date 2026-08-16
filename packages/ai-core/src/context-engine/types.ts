import type { EvidenceRef } from "@chaste/kernel";

/**
 * Context engine v1 (research doc §Context Engine, §Context Engineering
 * Specification). Context is assembled by a deterministic builder into a
 * versioned, tiered, budgeted `ContextBundle` — never by prompt concatenation.
 */

/** Context tiers per the research doc. */
export type ContextTier = 0 | 1 | 2 | 3 | 4 | 5;

export type SectionPurpose =
  "instruction" | "state" | "evidence" | "tool_schema" | "memory" | "workflow" | "policy";

export type SectionSource =
  "system" | "module" | "query" | "memory" | "document" | "summary" | "skill";

export type SectionVisibility = "model" | "trace_only";

export interface ContextSection {
  id: string;
  tier: ContextTier;
  purpose: SectionPurpose;
  source: SectionSource;
  visibility: SectionVisibility;
  /** Reference to the versioned artifact this section renders (if any). */
  contentRef?: string;
  renderedText?: string;
  tokenEstimate: number;
  required: boolean;
  /** When set, the section is stale after this time. */
  ttl?: string;
  /** Authorization decision that admitted this section into model context. */
  authorization?: { allowed: boolean; basis: string };
}

export interface TokenBudget {
  /** Model context capacity in tokens. */
  capacity: number;
  /** Reserved for the model response + emergency budget. */
  reserveTokens: number;
  /** Effective hard budget = capacity - reserve. */
  hardBudget: number;
  /** Tokens actually consumed by assembled sections. */
  usedTokens: number;
  /** Whether any required section had to be omitted (fail-closed signal). */
  overflow: boolean;
}

export interface RedactionDecision {
  field: string;
  sectionId?: string;
  reason: string;
}

export interface OmittedContext {
  sectionId: string;
  reason: "budget" | "unauthorized" | "not_relevant" | "policy";
  tokenEstimate: number;
}

export interface SummaryRef {
  id: string;
  /** Durable event range this summary covers (e.g. "session/events:100..200"). */
  coversRange: string;
  summary: string;
}

export interface CacheKey {
  scope: string;
  key: string;
  /** Context sections this cache entry serves. */
  sections: string[];
}

export interface ModelRoute {
  routeId: string;
  provider: string;
  model: string;
  costClass?: "cheap" | "standard" | "reasoning" | "vision" | "local";
}

export interface ContextBundle {
  bundleId: string;
  sessionId: string;
  organizationId: string;
  turn: number;
  modelRoute: ModelRoute;
  tokenBudget: TokenBudget;
  sections: ContextSection[];
  evidence: EvidenceRef[];
  redactions: RedactionDecision[];
  omitted: OmittedContext[];
  summariesUsed: SummaryRef[];
  cacheKeys: CacheKey[];
}

/** Deterministic, injectable token estimator (chars / 4 ≈ GPT-style tokens). */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
