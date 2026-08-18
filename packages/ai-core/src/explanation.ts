import type { AutonomyLevel } from "@chaste/kernel";
import type { ExplanationPart } from "@chaste/ui-schema";

export interface AiExplanation {
  runId: string;
  summary: string;
  reasons: string[];
  rulesApplied: string[];
  dataUsed: string[];
  autonomy: AutonomyLevel;
  plannedCommand?: string;
  plannedInput?: unknown;
}

export function toExplanationPart(exp: AiExplanation): ExplanationPart {
  return {
    type: "explanation",
    summary: exp.summary,
    reasons: exp.reasons,
    rulesApplied: exp.rulesApplied,
    dataUsed: exp.dataUsed,
    ...(exp.plannedCommand != null ? { plannedCommand: exp.plannedCommand } : {}),
    ...(exp.plannedInput != null ? { plannedInput: exp.plannedInput } : {}),
  };
}
