import type { EvidenceRef } from "@chaste/kernel";
import type { PlanStep } from "../planning/index.js";
import { sessionEvent } from "../trajectory/index.js";
import type { SessionLog } from "../trajectory/index.js";

/**
 * Pure plan-step ordering (research doc §Planning). Steps run in dependency
 * order; a cycle or a missing dependency makes the plan un-runnable.
 */
export function topoSort(
  steps: PlanStep[],
): { ok: true; order: PlanStep[] } | { ok: false; reason: string } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();
  const order: PlanStep[] = [];

  const visit = (step: PlanStep): { ok: true } | { ok: false; reason: string } => {
    const mark = state.get(step.id);
    if (mark === "done") return { ok: true };
    if (mark === "visiting") return { ok: false, reason: `step dependency cycle at ${step.id}` };
    state.set(step.id, "visiting");
    for (const depId of step.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (!dep) return { ok: false, reason: `step ${step.id} depends on missing step ${depId}` };
      const result = visit(dep);
      if (!result.ok) return result;
    }
    state.set(step.id, "done");
    order.push(step);
    return { ok: true };
  };

  for (const step of steps) {
    const result = visit(step);
    if (!result.ok) return result;
  }
  return { ok: true, order };
}

/** Has the run hit a stop condition? (substring match on summary or result.) */
export function matchesStopCondition(
  stopConditions: string[],
  summary: string,
  structured: unknown,
): string | undefined {
  const haystack = `${summary}\n${JSON.stringify(structured)}`;
  return stopConditions.find((c) => c.length > 0 && haystack.includes(c));
}

/** Attach evidence refs for a successful step's `expectedEvidence` ids. */
export async function attachStepEvidence(
  trajectory: SessionLog | undefined,
  opts: {
    sessionId: string;
    organizationId: string;
    step: PlanStep;
    commandType: string;
    requestId: string;
    now?: () => Date;
  },
): Promise<string[]> {
  const attached: string[] = [];
  for (const refId of opts.step.expectedEvidence ?? []) {
    const evidence: EvidenceRef = {
      id: refId,
      type: "tool_result",
      ref: `${opts.commandType}:${opts.requestId}`,
      note: `produced by plan step ${opts.step.id}`,
    };
    attached.push(refId);
    if (trajectory) {
      await trajectory.append(
        sessionEvent(opts.sessionId, opts.organizationId, "evidence/attached", evidence, {
          now: opts.now,
        }),
      );
    }
  }
  return attached;
}