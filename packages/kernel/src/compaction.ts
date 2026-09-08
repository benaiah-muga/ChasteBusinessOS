/**
 * Context-window hygiene for long agent sessions.
 *
 * Compaction rewrites the message list once it exceeds a character budget:
 * the system prefix is untouched (it is the KV-cache anchor), old tool
 * traffic collapses into stubs, and the recent window stays verbatim.
 * Compaction events are emitted so replays show where context was folded.
 */

import type { LoopMessage } from "./loop";

export const COMPACTION_STUB = "[earlier tool output compacted]";

export interface CompactionResult {
  messages: LoopMessage[];
  compactedCount: number;
}

export function estimateTokens(messages: readonly LoopMessage[]): number {
  // ~4 chars/token is the usual English-code heuristic; good enough for
  // budgeting without a tokenizer dependency.
  return Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4);
}

/**
 * Folds all but the most recent `keepRecent` messages into stubs.
 * System messages and the final assistant answer survive untouched;
 * tool responses are the bulk of old context and collapse hardest.
 */
export function compactTrajectory(
  messages: readonly LoopMessage[],
  opts: { keepRecent?: number; charBudget?: number } = {},
): CompactionResult {
  const keepRecent = opts.keepRecent ?? 6;
  if (messages.length <= keepRecent) return { messages: [...messages], compactedCount: 0 };

  const cut = messages.length - keepRecent;
  let charsSaved = 0;
  const out: LoopMessage[] = [];
  for (let i = 0; i < cut; i++) {
    const m = messages[i]!;
    if (m.role === "system") {
      out.push(m);
      continue;
    }
    charsSaved += m.content.length;
    out.push({
      role: "assistant",
      content:
        m.role === "tool"
          ? `${COMPACTION_STUB} (${m.toolCallId ?? "tool"})`
          : `${COMPACTION_STUB}`,
    });
  }
  void charsSaved;
  return { messages: [...out, ...messages.slice(cut)], compactedCount: cut };
}

/** Default assumed model context window when the caller does not declare one. */
export const DEFAULT_CONTEXT_WINDOW = 131_072;
/** Headroom kept for the model's reply when budgeting a context window. */
export const DEFAULT_RESERVE_TOKENS = 24_576;

export interface CompactionTriggerOptions {
  /** Fixed token budget (legacy mode). Ignored when contextWindow is set. */
  tokenBudget?: number;
  /** Model context window; compaction triggers at window minus reserve. */
  contextWindow?: number;
  /** Tokens reserved for the model's reply; default 24,576. */
  reserveTokens?: number;
}

/**
 * True when the transcript exceeds its budget (char-estimated). Two modes:
 * a fixed tokenBudget (legacy, default 24k), or a share of the model's
 * context window: compact once the transcript could crowd out the reply,
 * i.e. estimated tokens > contextWindow - reserveTokens. The window mode
 * means a 200k-window model compacts much later than a 32k one, instead of
 * folding context at the same fixed point for every model.
 */
export function shouldCompact(
  messages: readonly LoopMessage[],
  opts: CompactionTriggerOptions | number = 24_000,
): boolean {
  if (typeof opts === "number") return estimateTokens(messages) > opts;
  if (opts.contextWindow !== undefined) {
    const budget = Math.max(
      4_000,
      opts.contextWindow - (opts.reserveTokens ?? DEFAULT_RESERVE_TOKENS),
    );
    return estimateTokens(messages) > budget;
  }
  return estimateTokens(messages) > (opts.tokenBudget ?? 24_000);
}
