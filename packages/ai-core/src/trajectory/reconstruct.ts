import type { EvidenceRef, PolicyDecision } from "@chaste/kernel";
import type { AgentSessionEvent, ModelRequestPayload } from "./session-log.js";

/**
 * Model-visible reconstruction (research doc §Session and Trajectory Log).
 *
 * Replays a session's append-only event stream into the model-visible request:
 * system prompt sections, user messages, tool schemas, evidence, memory reads,
 * and policy decisions. The reconstruction is the *verification* of the hard
 * invariant — if `complete` is false, the request must not have been served to
 * a model for a regulated/auditable operation.
 */

export interface ReconstructedModelRequest {
  sessionId: string;
  systemPromptSections: string[];
  messages: Array<{ role: string; content: string }>;
  toolSchemas: unknown[];
  evidenceRefs: EvidenceRef[];
  memoryReads: string[];
  policyDecisions: PolicyDecision[];
  contextBundleIds: string[];
  modelRoutes: string[];
  /** True when the stream contains enough durable events to rebuild the request. */
  complete: boolean;
  /** Named gaps that would prevent faithful reconstruction. */
  gaps: string[];
}

const asModelRequest = (payload: unknown): ModelRequestPayload | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.provider !== "string" && typeof p.modelRoute !== "string") return undefined;
  return p as unknown as ModelRequestPayload;
};

/**
 * Replay events into a reconstructed model request. Order matters; events are
 * assumed to arrive in append order (SessionLog.list returns them in order).
 */
export function reconstructModelRequest(
  sessionId: string,
  events: AgentSessionEvent[],
): ReconstructedModelRequest {
  const out: ReconstructedModelRequest = {
    sessionId,
    systemPromptSections: [],
    messages: [],
    toolSchemas: [],
    evidenceRefs: [],
    memoryReads: [],
    policyDecisions: [],
    contextBundleIds: [],
    modelRoutes: [],
    complete: false,
    gaps: [],
  };

  let sawModelRequest = false;
  const handled = new Set<string>();

  for (const e of events) {
    switch (e.type) {
      case "session/start":
        handled.add("session/start");
        break;
      case "user/message": {
        const m = e.payload as { content?: string; role?: string } | null;
        if (m?.content != null) {
          out.messages.push({ role: m.role ?? "user", content: m.content });
        }
        break;
      }
      case "prompt/rendered": {
        const p = e.payload as { sections?: string[] } | null;
        out.systemPromptSections.push(...(p?.sections ?? []));
        break;
      }
      case "context/assembled": {
        const c = e.payload as { bundleId?: string; turn?: number } | null;
        if (c?.bundleId) out.contextBundleIds.push(c.bundleId);
        break;
      }
      case "model/request": {
        sawModelRequest = true;
        const r = asModelRequest(e.payload);
        if (r) {
          if (r.systemPromptSections?.length)
            out.systemPromptSections.push(...r.systemPromptSections);
          if (r.messages?.length) out.messages.push(...r.messages);
          if (r.toolSchemas?.length) out.toolSchemas.push(...r.toolSchemas);
          if (r.evidenceRefs?.length) out.evidenceRefs.push(...r.evidenceRefs);
          if (r.memoryReads?.length) out.memoryReads.push(...r.memoryReads);
          if (r.contextBundleId) out.contextBundleIds.push(r.contextBundleId);
          if (r.modelRoute) out.modelRoutes.push(r.modelRoute);
        }
        break;
      }
      case "tool/schema-presented": {
        const t = e.payload as { schema?: unknown } | null;
        if (t?.schema != null) out.toolSchemas.push(t.schema);
        break;
      }
      case "tool/call":
        handled.add("tool/call");
        break;
      case "policy/decision": {
        const d = e.payload as PolicyDecision | null;
        if (d && typeof d.kind === "string" && d.policy) {
          out.policyDecisions.push({
            kind: d.kind,
            policy: d.policy,
            reason: d.reason,
            evaluatedAt: d.evaluatedAt,
            context: d.context,
          });
        }
        break;
      }
      case "evidence/attached": {
        const ev = e.payload as EvidenceRef | null;
        if (ev?.ref) out.evidenceRefs.push(ev);
        break;
      }
      case "memory/read": {
        const m = e.payload as { summary?: string } | null;
        if (m?.summary != null) out.memoryReads.push(m.summary);
        break;
      }
      case "command/dispatched":
      case "command/result":
      case "query/dispatched":
      case "query/result":
      case "approval/requested":
      case "approval/granted":
      case "approval/rejected":
      case "plan/proposed":
      case "workflow/scheduled":
      case "session/forked":
      case "session/resumed":
      case "session/end":
      case "model/chunk":
      case "model/message":
        break;
    }
  }

  // Completeness checks for the hard invariant.
  const gaps: string[] = [];
  if (!sawModelRequest) gaps.push("no model/request event");
  if (out.systemPromptSections.length === 0) gaps.push("no system prompt sections");
  if (out.messages.length === 0) gaps.push("no user or model messages");
  if (out.toolSchemas.length === 0) gaps.push("no tool schemas presented");

  return {
    ...out,
    complete: gaps.length === 0,
    gaps,
  };
}

/**
 * High-signal summary of what the model saw for a given turn — the human- and
 * audit-facing projection of a reconstructed request.
 */
export function summarizeModelRequest(r: ReconstructedModelRequest): string[] {
  const lines = [
    `Session ${r.sessionId} — model routes: ${r.modelRoutes.join(", ") || "(none)"}`,
    `  system prompt sections: ${r.systemPromptSections.length}`,
    `  messages: ${r.messages.length}`,
    `  tool schemas: ${r.toolSchemas.length}`,
    `  evidence refs: ${r.evidenceRefs.length}`,
    `  memory reads: ${r.memoryReads.length}`,
    `  policy decisions: ${r.policyDecisions.length}`,
    `  context bundles: ${r.contextBundleIds.length}`,
    `  reconstruction: ${r.complete ? "complete" : `INCOMPLETE (${r.gaps.join("; ")})`}`,
  ];
  return lines;
}
