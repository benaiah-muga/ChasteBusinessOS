/**
 * Risk class taxonomy — ported & adapted from OpenWorker `coworker/risk.py`.
 *
 * Risk is a *declared property* of a command (or tool), inspected via a single
 * `classify()` entry point. It is orthogonal to the RBAC permission strings every
 * command already declares: permissions answer "may this actor call this command",
 * risk answers "what kind of side effect does this command have" — which in turn
 * drives autonomy gates, unattended-mode routing, and standing-rule eligibility
 * (see `inbox.ts` and the orchestrator's autonomy gate).
 *
 * The four classes:
 * - `READ`        — queries; no side effects; always allowed.
 * - `WRITE_LOCAL` — in-tenant writes that touch only org data (mutable through the
 *                   normal command bus + outbox, audited, reversible where policy allows).
 * - `EXEC`        — side effects that escape the org boundary but stay within the
 *                   platform's own surfaces (a workflow step that runs internally,
 *                   a long-running job). Mode-gated.
 * - `EXTERNAL`    — side effects that leave the platform entirely: outgoing email,
 *                   Slack send, payment gateway, bank, webhook. The unattended-Inbox
 *                   hook and the standing-rule eligibility requirement both key off
 *                   this class.
 *
 * Default classification is by command metadata (`CommandMeta.riskClass`) with a
 * sensible fallback ladder (see `classify`). Override resolvers are not yet used
 * in our codebase but the interface is preserved for parity with OpenWorker's
 * user-local override store, in case we add per-org risk policy later.
 */

export type RiskClass = "read" | "write_local" | "exec" | "external";

export const RISK_CLASS_ORDER: Record<RiskClass, number> = {
  read: 0,
  write_local: 1,
  exec: 2,
  external: 3,
};

/** Anything but a pure read needs the autonomy gate's attention. */
export function isConsequential(risk: RiskClass): boolean {
  return risk !== "read";
}

export function stricterRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_CLASS_ORDER[a] >= RISK_CLASS_ORDER[b] ? a : b;
}

/**
 * A user-local override resolver (per-org risk policy later). `null` means
 * "defer to the base classification". Kept for parity with OpenWorker's
 * `RiskOverrides`; not yet wired.
 */
export type RiskOverrideResolver = (commandName: string) => RiskClass | null;

export interface RiskClassifiable {
  /** Declared risk class. When absent the classifier falls back to heuristics. */
  riskClass?: RiskClass;
  /**
   * Heuristic markers used when `riskClass` is absent.
   * - `sideEffects: true` is treated as `exec` (the standard OpenAI tool convention).
   * - `externalTarget: string` (e.g. a Slack channel name) forces `external`.
   * - otherwise default to `read` for queries, `write_local` for commands.
   */
  sideEffects?: boolean;
  /**
   * Concrete off-platform target string (e.g. `"#ops-alerts"`). When set on
   * classifiable metadata it forces `external` risk *and* becomes the standing
   * rule binding — useful for static targets known at registration time.
   */
  externalTarget?: string;
  /**
   * Name of the *input field* that carries the off-platform target
   * (e.g. `"channel"` for a Slack send). Used by `externalTargetOf` to resolve
   * the standing-rule binding from the call's arguments.
   */
  externalTargetField?: string;
}

export interface ClassifyContext {
  /** Whether the call is against a query (read by definition) vs a command. */
  isQuery?: boolean;
  /** A callable to consult CommandMeta-derived heuristics. */
  classifiable?: RiskClassifiable;
  /** User-local override resolver; wins over everything else. */
  overrides?: RiskOverrideResolver;
}

/**
 * Effective risk of a command call. Resolution ladder:
 * 1. user-local override (`overrides(commandName)`)
 * 2. declared `riskClass` on the command metadata
 * 3. heuristic markers (`externalTarget` > `sideEffects`)
 * 4. default by call surface (query → read, command → write_local)
 */
export function classify(commandName: string, ctx: ClassifyContext = {}): RiskClass {
  const { overrides, classifiable, isQuery } = ctx;

  if (overrides) {
    const ov = overrides(commandName);
    if (ov !== null) return ov;
  }

  if (classifiable?.riskClass) return classifiable.riskClass;

  if (classifiable?.externalTarget) return "external";
  if (classifiable?.sideEffects) return "exec";

  if (isQuery) return "read";
  return "write_local";
}

/**
 * Names the "external target" of a command call — the string that identifies
 * the off-platform recipient/destination (e.g. `"slack:C0123"`, `"email:user@x.com"`).
 *
 * Returns `null` when the call is not external-risk or the target is absent.
 * A standing approval rule cannot be minted without this: it's what makes
 * "Allow `email.send` always" safe — the binding becomes
 * "Allow `email.send` to `user@x.com` always".
 */
export function externalTargetOf(
  commandName: string,
  input: Record<string, unknown>,
  classifiable?: RiskClassifiable,
): string | null {
  const cls = classify(commandName, { classifiable });
  if (cls !== "external") return null;

  // Prefer declared external target from classifiable metadata; else the
  // declared field name on the call's input; else common target-shaped keys.
  // We deliberately do NOT consult user-local overrides here — the binding must
  // be the *actual* target the call names, not policy-level reclassification.
  if (classifiable?.externalTarget) return classifiable.externalTarget;

  const candidates = [
    ...(classifiable?.externalTargetField ? [classifiable.externalTargetField] : []),
    "to",
    "recipient",
    "channel",
    "target",
    "webhook",
  ];
  for (const key of candidates) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      return String(v[0]);
    }
  }
  return null;
}

/** Build a RiskClassifiable from CommandMeta-shaped metadata. */
export function classifiableFromMeta(meta?: {
  riskClass?: RiskClass;
  externalTargetField?: string;
  sideEffects?: boolean;
}): RiskClassifiable | undefined {
  if (!meta) return undefined;
  return {
    riskClass: meta.riskClass,
    externalTargetField: meta.externalTargetField,
    sideEffects: meta.sideEffects,
  };
}
