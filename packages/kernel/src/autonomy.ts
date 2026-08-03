import { z } from "zod";
import type { RiskClass } from "./risk.js";

export const autonomyLevelSchema = z.enum([
  "recommend",
  "confirm",
  "guarded_auto",
  "full_autonomous",
]);

export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

export const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  recommend: 0,
  confirm: 1,
  guarded_auto: 2,
  full_autonomous: 3,
};

/** Higher gate wins (more restrictive). */
export function stricterAutonomy(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_RANK[a] <= AUTONOMY_RANK[b] ? a : b;
}

export function canAutoExecute(level: AutonomyLevel): boolean {
  return level === "guarded_auto" || level === "full_autonomous";
}

export function requiresConfirmation(level: AutonomyLevel): boolean {
  return level === "confirm" || level === "recommend";
}

export const FULL_AUTONOMOUS_WARNING =
  "Full autonomous mode allows AI to execute approved-capability actions without per-step confirmation. " +
  "While ChasteBusinessOS emphasizes integrity and auditability, AI can still make mistakes. " +
  "Your organization is responsible for outcomes. Use with care.";

/**
 * Command-level auto-execute requirements. These are the two orthogonal axes the
 * orchestrator combines with the user's configured autonomy level:
 *
 * - `minAutonomyForAuto` — the minimum configured autonomy required before this
 *   command may run *without* a confirm. `"full_autonomous"` means "only ever
 *   auto-run for full_autonomous users; everyone else confirms".
 * - `riskClass` — the declared side-effect class (R1). `exec`/`external`
 *   commands leave the org boundary, so they get a safety floor: unless the
 *   command explicitly declares an auto-run level (`minAutonomyForAuto`), the
 *   orchestrator must NOT auto-run them below `confirm`.
 */
export interface AutoExecMeta {
  minAutonomyForAuto?: "guarded_auto" | "full_autonomous";
  riskClass?: RiskClass;
}

/**
 * The effective autonomy gate for a command = the stricter of the configured
 * level and the command's declared requirements. Reported in explanations and
 * used to drive the confirm/cancel card; `commandMayAutoExecute` still consults
 * the *configured* level so a command never auto-runs past the user's policy.
 */
export function effectiveAutonomyForCommand(
  configured: AutonomyLevel,
  meta?: AutoExecMeta,
): AutonomyLevel {
  let effective = configured;

  if (meta?.minAutonomyForAuto && AUTONOMY_RANK[effective] < AUTONOMY_RANK[meta.minAutonomyForAuto]) {
    effective = meta.minAutonomyForAuto;
  }

  // R1 risk floor: side effects that escape the org boundary (exec/external)
  // never auto-run unless the command explicitly declares an auto-run level.
  // The safety floor is "always confirm" for risky commands without an opt-in —
  // regardless of how autonomous the user configured the session.
  const risky = meta?.riskClass === "exec" || meta?.riskClass === "external";
  if (risky && !meta?.minAutonomyForAuto) {
    effective = "confirm";
  }

  return effective;
}

/**
 * May the configured autonomy auto-run this command? True only when BOTH the
 * user's level and the command's declared requirements are met:
 * - configured is `guarded_auto`/`full_autonomous`, and
 * - configured meets `minAutonomyForAuto` (if declared), and
 * - the command is not `exec`/`external` without an explicit auto-run declaration.
 */
export function commandMayAutoExecute(
  configured: AutonomyLevel,
  meta?: AutoExecMeta,
): boolean {
  if (!canAutoExecute(configured)) return false;

  if (
    meta?.minAutonomyForAuto &&
    AUTONOMY_RANK[configured] < AUTONOMY_RANK[meta.minAutonomyForAuto]
  ) {
    return false;
  }

  const risky = meta?.riskClass === "exec" || meta?.riskClass === "external";
  if (risky && !meta?.minAutonomyForAuto) return false;

  return true;
}

/**
 * The strictest gate across every step of a multi-step plan.
 *
 * Each step is scored INDEPENDENTLY against the *original* configured level,
 * then the strictest (lowest autonomy rank) wins. We must NOT re-feed a running
 * gate as the next step's "configured" level: `effectiveAutonomyForCommand` only
 * ever raises toward a step's own requirements, so a later step declaring a high
 * `minAutonomyForAuto` would wrongly lift the gate back above an earlier step's
 * risk-confirm floor (e.g. an `external` command that never auto-runs). Scoring
 * each step from the configured baseline preserves every floor.
 */
export function effectiveAutonomyForPlan(
  configured: AutonomyLevel,
  metas: AutoExecMeta[],
): AutonomyLevel {
  return metas.reduce(
    (gate, m) => stricterAutonomy(gate, effectiveAutonomyForCommand(configured, m)),
    configured,
  );
}

/** Every step must individually allow auto-run for the whole plan to auto-run. */
export function planMayAutoExecute(
  configured: AutonomyLevel,
  metas: AutoExecMeta[],
): boolean {
  return metas.every((m) => commandMayAutoExecute(configured, m));
}

/**
 * Conversation modality (ported from OpenWorker's `Mode` enum).
 *
 * Where `AutonomyLevel` answers "may the agent take this action without
 * asking", `ConversationMode` answers "what shape does this conversation take
 * right now?". The two combine — modes set read-only enforcement on top of
 * whatever autonomy the user has configured.
 *
 * - `DISCUSS` — read-only. No plans or writes happen; the agent explores and
 *   answers. The mode contract: "describe changes in chat instead of making them."
 * - `PLAN` — read-only until the agent calls `proposePlan`; on approval the
 *   session flips to `INTERACTIVE` mid-stream and execution proceeds.
 * - `INTERACTIVE` (default) — normal: writes/exec gated by autonomy.
 *
 * The orchestrator consults `isReadOnly(mode)` BEFORE any mutation step; a
 * read-only mode short-circuits to a friendly refusal (the agent then describes
 * the proposed change instead of attempting it).
 */
export type ConversationMode = "discuss" | "plan" | "interactive";

export const conversationModeSchema = z.enum(["discuss", "plan", "interactive"]);

export const READ_ONLY_MODES: ReadonlySet<ConversationMode> = new Set(["discuss", "plan"]);

export function isReadOnly(mode: ConversationMode): boolean {
  return READ_ONLY_MODES.has(mode);
}

/**
 * The per-mode context paragraph appended to the latest user message every turn
 * while that mode is active. Mode can flip mid-session (plan approval flips
 * back to interactive), so this is checked per turn — never baked into the
 * static system prompt. Ported from OpenWorker's `_DISCUSS_MODE_CONTEXT` /
 * `_PLAN_MODE_CONTEXT`.
 */
export const MODE_CONTEXT: Record<ConversationMode, string> = {
  discuss:
    "Discuss mode is active: write/exec tools are disabled. Explore and answer freely; if the user asks for a change, describe it in chat instead of attempting it (they can switch to plan or interactive mode to have you make it).",
  plan:
    "Plan mode is active: write/exec tools are blocked. Explore read-only and design an approach. When you've committed to one, present it with `proposePlan` (what you'll change, which commands, how you'll verify) — don't describe edits as if you were making them. If the plan is approved, this session switches to interactive mode and you implement it; if rejected, revise the plan using the feedback.",
  interactive: "", // default — no extra paragraph
};
