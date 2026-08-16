import type {
  ContextBundle,
  ContextSection,
  ContextTier,
  ModelRoute,
  OmittedContext,
  SectionPurpose,
  SectionSource,
  TokenBudget,
} from "./types.js";
import { estimateTextTokens } from "./types.js";
import {
  allocateBudget,
  ALLOCATION_ORDER,
  type AllocateBudgetOptions,
  type TaskKind,
} from "./budget.js";

/**
 * Deterministic context builder (research doc §Context Engineering
 * Specification). Admission rules:
 *  - a section enters model context only if it has source, purpose, token
 *    estimate, and authorization proof;
 *  - required sections that cannot fit fail closed (overflow=true) — the agent
 *    must ask, summarize with explicit loss, choose a larger route, or fail
 *    with a clear blocker;
 *  - unauthorized evidence is redacted/omitted, never silently admitted.
 */

export interface ContextSectionInput {
  /** Stable key, e.g. "system.invariants", "tool_schema.procurement". */
  key: string;
  tier: ContextTier;
  purpose: SectionPurpose;
  source: SectionSource;
  renderedText: string;
  required?: boolean;
  /** Authorization proof. Defaults to true; false sections are never admitted. */
  authorized?: boolean;
  visibility?: "model" | "trace_only";
  contentRef?: string;
  ttl?: string;
  /** Defaults to `estimateTokens(renderedText)`. */
  tokenEstimate?: number;
}

export interface ContextInput {
  sessionId: string;
  organizationId: string;
  turn: number;
  modelRoute: ModelRoute;
  sections: ContextSectionInput[];
  /** Evidence refs attached to the bundle (also captured per-section). */
  evidence?: ContextBundle["evidence"];
  budget: AllocateBudgetOptions;
}

const TIER_FALLBACK_PRIORITY: Record<number, number> = {
  0: 1,
  1: 2,
  2: 3,
  3: 4,
  4: 7,
  5: 8,
};

const NAMED_PRIORITY = new Map<string, number>(ALLOCATION_ORDER.map((e) => [e.key, e.priority]));

function priorityOf(section: { key: string; tier: ContextTier }): number {
  return NAMED_PRIORITY.get(section.key) ?? TIER_FALLBACK_PRIORITY[section.tier] ?? 9;
}

export interface BuildResult {
  bundle: ContextBundle;
}

export function buildContextBundle(input: ContextInput): BuildResult {
  const budget = allocateBudget(input.budget);
  const sections: ContextSection[] = [];
  const omitted: OmittedContext[] = [];
  const redactions: ContextBundle["redactions"] = [];

  const ordered = [...input.sections].sort((a, b) => {
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    return pa === pb ? 0 : pa - pb;
  });

  let overflow = false;
  for (const s of ordered) {
    const tokenEstimate = s.tokenEstimate ?? estimateTextTokens(s.renderedText);
    const id = `sec:${s.key}:${input.turn}:${sections.length}`;
    const required = s.required ?? false;

    if (s.authorized === false) {
      redactions.push({ field: s.key, sectionId: id, reason: "unauthorized" });
      omitted.push({ sectionId: id, reason: "unauthorized", tokenEstimate });
      if (required) overflow = true;
      continue;
    }

    if (budget.usedTokens + tokenEstimate > budget.hardBudget) {
      omitted.push({ sectionId: id, reason: "budget", tokenEstimate });
      if (required) overflow = true;
      continue;
    }

    sections.push({
      id,
      tier: s.tier,
      purpose: s.purpose,
      source: s.source,
      visibility: s.visibility ?? "model",
      contentRef: s.contentRef,
      renderedText: s.renderedText,
      tokenEstimate,
      required,
      ttl: s.ttl,
      authorization: {
        allowed: true,
        basis: s.authorized === undefined ? "caller-default" : "explicit-allow",
      },
    });
    budget.usedTokens += tokenEstimate;
  }

  budget.overflow = overflow;

  const bundle: ContextBundle = {
    bundleId: crypto.randomUUID(),
    sessionId: input.sessionId,
    organizationId: input.organizationId,
    turn: input.turn,
    modelRoute: input.modelRoute,
    tokenBudget: budget,
    sections,
    evidence: input.evidence ?? [],
    redactions,
    omitted,
    summariesUsed: [],
    cacheKeys: [],
  };

  return { bundle };
}

/**
 * Human- and audit-facing explanation of the assembled context: why each
 * section was included, summarized, or omitted. This is the doc's "the engine
 * can explain why a section was included, summarized, or omitted" criterion.
 */
export function explainContext(bundle: ContextBundle): string[] {
  const lines = [
    `Context bundle ${bundle.bundleId} — turn ${bundle.turn}, route ${bundle.modelRoute.provider}/${bundle.modelRoute.model}`,
    `  budget: ${bundle.tokenBudget.usedTokens}/${bundle.tokenBudget.hardBudget} tokens (reserve ${bundle.tokenBudget.reserveTokens})${
      bundle.tokenBudget.overflow ? " — OVERFLOW: required context omitted, fail closed" : ""
    }`,
    ...bundle.sections.map(
      (s) =>
        `  + ${s.id} [tier ${s.tier}, ${s.purpose}/${s.source}, ${s.visibility}] ~${s.tokenEstimate}t${s.required ? " (required)" : ""}${s.contentRef ? ` → ${s.contentRef}` : ""}`,
    ),
    ...bundle.redactions.map((r) => `  ✂ redacted ${r.field} (${r.reason})`),
    ...bundle.omitted.map((o) => `  − omitted ${o.sectionId} (${o.reason}, ~${o.tokenEstimate}t)`),
  ];
  return lines;
}
