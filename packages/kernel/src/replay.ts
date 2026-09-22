import type { LoopMessage, ToolCall } from "./loop";

export interface PersistedTrajectoryEvent {
  seq: number;
  role: string;
  content: unknown;
}

export interface ReplayObservation {
  seq: number;
  name: string;
  result: string;
}

export interface ReplayTrace {
  messages: LoopMessage[];
  observations: ReplayObservation[];
  finalMessage: string;
  eventCount: number;
}

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reconstructs the model-visible trajectory from persisted observations.
 * This intentionally has no registry, executor, or model dependency: replay
 * is a read of what happened, never a permission check followed by re-run.
 */
export function replayTrajectory(events: readonly PersistedTrajectoryEvent[]): ReplayTrace {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const messages: LoopMessage[] = [];
  const observations: ReplayObservation[] = [];
  const pendingCalls: ToolCall[] = [];
  let finalMessage = "";
  let previousSeq = 0;

  for (const event of ordered) {
    if (!Number.isInteger(event.seq) || event.seq <= previousSeq) {
      throw new Error("trajectory replay requires strictly increasing event sequence numbers");
    }
    previousSeq = event.seq;
    const content = objectContent(event.content);

    if (event.role === "user") {
      const text = typeof content.text === "string" ? content.text : JSON.stringify(event.content);
      messages.push({ role: "user", content: text });
    } else if (event.role === "assistant") {
      const text = typeof content.text === "string" ? content.text : JSON.stringify(event.content);
      finalMessage = text;
      messages.push({ role: "assistant", content: text });
    } else if (event.role === "tool_call") {
      if (typeof content.name !== "string") throw new Error("tool_call observation is missing its name");
      const call: ToolCall = {
        id: `replay-${event.seq}`,
        name: content.name,
        args: content.args,
      };
      pendingCalls.push(call);
      messages.push({ role: "assistant", content: "", toolCalls: [call] });
    } else if (event.role === "tool") {
      if (typeof content.name !== "string" || typeof content.result !== "string") {
        throw new Error("tool observation is missing its name or stored result");
      }
      const call = [...pendingCalls].reverse().find((candidate) => candidate.name === content.name);
      observations.push({ seq: event.seq, name: content.name, result: content.result });
      messages.push({ role: "tool", content: content.result, toolCallId: call?.id });
    }
  }

  return { messages, observations, finalMessage, eventCount: ordered.length };
}
