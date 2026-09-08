/**
 * Needs-attention signals (ADR 0034): the shared shape every module uses to
 * say "this deserves the owner's attention" — and the one shape every
 * consumer (home dashboard, app overviews, routines, the agent) reads.
 *
 * Signals are advisory by definition: a suggestedAction names a governed
 * capability, it never executes anything. Producers are deterministic
 * functions over live data; there is no model in the compute path.
 */

export type SignalSeverity = "red" | "orange" | "green";

export interface SignalEvidence {
  refType: string;
  refId?: string | null;
}

export interface SignalSuggestedAction {
  capabilityId: string;
  /** Advisory draft input for the suggested capability; advisory only. */
  inputDraft?: Record<string, unknown>;
}

export interface BusinessSignal {
  /** Stable within an org, e.g. "inventory.reorder:CEM-42". */
  id: string;
  severity: SignalSeverity;
  module: string;
  /** One-line human subject, e.g. "Cement 50kg may run out this week". */
  subject: string;
  /** The arithmetic or fact behind the signal, in plain language. */
  detail: string;
  evidence?: SignalEvidence | null;
  suggestedAction?: SignalSuggestedAction | null;
}

/**
 * A producer collects one module's signals for one org. Purely derived from
 * live data — no LLM, no randomness, no clock beyond the caller's now.
 */
export type SignalProducer = (orgId: string, now: Date) => Promise<BusinessSignal[]>;

export const SEVERITY_ORDER: Record<SignalSeverity, number> = { red: 0, orange: 1, green: 2 };

/** Sorts reds first, then severity, then module and id for stable rendering. */
export function sortSignals(signals: BusinessSignal[]): BusinessSignal[] {
  return [...signals].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return `${a.module}:${a.id}`.localeCompare(`${b.module}:${b.id}`);
  });
}

const SEVERITIES: SignalSeverity[] = ["red", "orange", "green"];

/** Structural guard so one broken producer cannot poison the whole list. */
export function isBusinessSignal(value: unknown): value is BusinessSignal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.severity === "string" &&
    SEVERITIES.includes(v.severity as SignalSeverity) &&
    typeof v.module === "string" &&
    v.module.length > 0 &&
    typeof v.subject === "string" &&
    v.subject.length > 0 &&
    typeof v.detail === "string" &&
    v.detail.length > 0
  );
}
