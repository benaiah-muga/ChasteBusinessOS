import { z } from "zod";

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
