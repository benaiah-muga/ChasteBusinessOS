/**
 * Lightweight prompt guardrails — no agent framework dependency.
 * Used by the orchestrator chat path to reject obvious injection attempts.
 */
import type { AutonomyLevel } from "@chaste/kernel";

const INJECTION_PATTERNS = [
  /ignore\s+(?:previous|all|above)\s+instructions/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /disregard\s+(?:your|the|all)\s+(?:rules|instructions|guidelines)/i,
  /system\s*:\s*/i,
  /jailbreak/i,
  /\bDAN\b/,
  /act\s+as\s+if\s+you\s+have\s+no\s+(?:rules|restrictions)/i,
];

/** Returns true if the user text looks like a prompt-injection attempt. */
export function looksLikePromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether input-side injection checks should run for this autonomy level.
 * Higher autonomy = more automation = stricter input checks.
 */
export function shouldCheckInjection(autonomy: AutonomyLevel): boolean {
  return autonomy === "confirm" || autonomy === "guarded_auto" || autonomy === "full_autonomous";
}
