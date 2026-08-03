/**
 * Auto-compaction of long session histories — TS port of OpenWorker's
 * `coworker/compaction.py` (approved design ocw `auto-compaction-spec`).
 *
 * When the outbound history (the messages we send to the model) approaches the
 * model's context limit, the older portion of the *outbound* view is replaced
 * with (a) an LLM-written structured summary and (b) mechanically-extracted
 * state; the newest turns and the human-authored user messages survive.
 * The persisted transcript (`chat_sessions.messages`) is **never modified**;
 * only what is sent to the model is transformed.
 *
 * The split: we keep a `CompactionState` per session that's persisted in
 * `chat_sessions.compaction_state` (JSONB) — the orchestrator calls
 * `applyToOutbound(messages, state)` before each LLM call, so compaction is a
 * function over what we *show*, not what we *store*. This module owns the pure
 * helpers; the engine decides *when* and *with what model*, both injected here
 * as in OpenWorker — so compaction is fully unit-testable without a provider.
 *
 * Mechanical extraction (R11) walks our own command-bus audit entries (already
 * richer than OpenWorker's tool-call records) to produce a deterministic
 * `Working state` block: commands written, recent shell calls (+ exit status),
 * artifacts produced. The summarizer may fabricate; the mechanical block
 * cannot.
 */

import type { ChatMessage } from "@chaste/ui-schema";

/** Defaults that match OpenWorker's constants; tune later. */
export const DEFAULT_THRESHOLD_PCT = 0.8;
/** Cap exists so 1M-context models compact early; quality degrades well before the nominal window. */
/** Cap so 1M-context models compact early (OpenWorker uses 250k; quality degrades well before nominal). */
export const DEFAULT_CAP_TOKENS = 250_000;
/** Conservative fallback for providers without a verified context window. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Newest slice kept verbatim as a fraction of the trigger budget. */
export const KEEP_RECENT_FRACTION = 0.25;
/** The summarizer call: tools off, modest ceiling. */
export const SUMMARY_MAX_TOKENS = 3000;
/** Per-message tool-result clip when rendering the span for the summarizer. */
const SPAN_TOOL_RESULT_CLIP = 400;
const SPAN_BUDGET_CHARS = 200_000;
const USER_MESSAGE_CLIP = 600;
const USER_MESSAGES_MAX = 40;
const TRIM_FRACTION = 0.1;

export function estimateTokens(messages: ChatMessage[] | unknown[]): number {
  let total = 0;
  for (const m of messages as Record<string, unknown>[]) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      total += String(m).length;
    }
  }
  // chars/4 over the serialized messages
  return Math.trunc(total / 4);
}

export function triggerTokens(
  contextWindow: number | undefined,
  opts: { thresholdPct?: number; capTokens?: number } = {},
): number {
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const capTokens = opts.capTokens ?? DEFAULT_CAP_TOKENS;
  const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return Math.min(Math.trunc(thresholdPct * window), Math.trunc(capTokens));
}

export function shouldCompact(
  signal: number,
  contextWindow: number | undefined,
  opts: { thresholdPct?: number; capTokens?: number } = {},
): boolean {
  return signal >= triggerTokens(contextWindow, opts);
}

export interface CompactionState {
  /** Index into the canonical message list; messages before it are summarized. */
  boundaryIndex: number;
  /** LLM-written structured summary (8 sections per OpenWorker contract). */
  summaryText: string;
  /** Mechanically-extracted deterministic block (zero hallucination risk). */
  workingState: string;
  /** User messages from the compressed span, preserved verbatim (chronological). */
  userMessages: string[];
  /** Running total of older user messages dropped across compactions. */
  userMessagesDropped: number;
  createdAt: number;
  modelUsed: string;
  /** True when this state came from the no-summary `trim` fallback. */
  trimmed: boolean;
}

export const emptyCompactionState: CompactionState | null = null;

/**
 * Best-effort boundary detection: the earliest user-message start whose suffix
 * fits the keep budget. Falls back to assistant turns when the newest user
 * turn alone exceeds the budget. Returns `null` when there's nothing to summarize.
 */
export function pickBoundary(
  messages: ChatMessage[],
  keepTokens: number,
): number | null {
  const startIndex = 0;
  const users: number[] = [];
  const assistants: number[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") users.push(i);
    else if (role === "assistant") assistants.push(i);
  }

  function fitIndex(candidates: number[]): number | null {
    for (const i of candidates) {
      if (estimateTokens(messages.slice(i)) <= keepTokens) return i;
    }
    return null;
  }

  let boundary: number | null = fitIndex(users);
  if (boundary === null && users.length > 0) {
    // newest user turn alone blows the budget — cut inside it at an iteration boundary
    const lastUser = users[users.length - 1]!;
    const inside = assistants.filter((i) => i > lastUser);
    boundary = fitIndex(inside) ?? (inside.length ? inside[inside.length - 1]! : lastUser);
  }
  if (boundary === null) boundary = fitIndex(assistants);
  if (boundary === null || boundary <= startIndex) return null;
  return boundary;
}

// ----- mechanical state extraction (zero hallucination) --------------

export interface ToolCallRecord {
  command: string;
  data: Record<string, unknown>;
  success: boolean;
  /** When set: probe this input field for the *off-platform* artifact target. */
  externalTargetField?: string;
}

const WRITE_HINTS = ["create", "update", "delete", "save", "post", "send", "publish", "pay", "issue", "prepare"];
const ARTIFACT_HINTS = ["invoice", "po.", "purchase", "payroll", "order", "report", "payment"];

/**
 * Mechanical extraction walking our own structured audit entries. Order matches
 * command-bus invocation; we record the command, success flag, and any artifact
 * ids. NO LLM involved.
 */
export function extractWorkingState(span: ToolCallRecord[]): string {
  const commands: { line: string; status: string }[] = [];
  const writes: string[] = [];
  const artifacts: string[] = [];

  for (const rec of span) {
    const lowered = rec.command.toLowerCase();
    const data = rec.data ?? {};
    const id = typeof data.id === "string" ? (data.id as string) : undefined;
    const line = `${rec.command}` + (id ? ` (${id.slice(0, 12)})` : "") + `  [${rec.success ? "ok" : "error"}]`;
    commands.push({ line: truncate(line, 160), status: rec.success ? "ok" : "error" });

    if (WRITE_HINTS.some((h) => lowered.includes(h))) {
      const tag = String(data.number ?? data.sku ?? data.employeeNumber ?? data.name ?? "—").slice(0, 80);
      writes.push(`${rec.command} → ${tag}`);
    }

    if (ARTIFACT_HINTS.some((h) => lowered.includes(h))) {
      const label =
        (typeof data.number === "string" ? (data.number as string) : "") ||
        (typeof data.reference === "string" ? (data.reference as string) : "") ||
        (id ?? "");
      if (label) artifacts.push(`${rec.command}: ${label}`);
    }
  }

  const lines: string[] = ["## Working state (extracted mechanically from command-bus audit entries)"];
  const recent = dedupeRecentFirst(writes, 20);
  if (recent.length) {
    lines.push("Writes (most recent first):");
    lines.push(...recent.map((p) => `- ${p}`));
  }
  if (commands.length) {
    lines.push("Recent commands:");
    lines.push(...commands.slice(-10).map((c) => `- ${c.line}`));
  }
  const made = dedupeRecentFirst(artifacts, 10);
  if (made.length) {
    lines.push("Artifacts produced:");
    lines.push(...made.map((a) => `- ${a}`));
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function dedupeRecentFirst(items: string[], limit: number): string[] {
  const seen: string[] = [];
  for (let i = items.length - 1; i >= 0 && seen.length < limit; i--) {
    const v = items[i]!;
    if (!seen.includes(v)) seen.push(v);
  }
  return seen;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function extractUserMessages(span: ChatMessage[], clip = USER_MESSAGE_CLIP): string[] {
  const out: string[] = [];
  for (const m of span) {
    if (m.role !== "user") continue;
    const text = m.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ");
    if (!text) continue;
    out.push(text.length > clip ? text.slice(0, clip - 1) + "…" : text);
  }
  return out;
}

function capUserMessages(
  messages: string[],
  priorDropped: number,
  limit = USER_MESSAGES_MAX,
): { messages: string[]; dropped: number } {
  if (messages.length <= limit) return { messages, dropped: priorDropped };
  return { messages: messages.slice(-limit), dropped: priorDropped + (messages.length - limit) };
}

// ----- summarizer prompt (8-section OpenWorker contract) -----------

export const SUMMARY_SYSTEM_PROMPT = `You are compacting an AI business assistant's session history so the assistant can continue working in a smaller context. Write a structured summary of the conversation below. It is the assistant's ONLY memory of these turns, so preserve everything load-bearing.

Produce ALL of the following sections, in this order, each as a markdown heading:

1. **Primary request and intent** — what the user is trying to get done, in their terms, including standing constraints stated at any point (e.g. "never post without my approval"). Constraints outlive the turns they were stated in.
2. **Key concepts and decisions** — business facts, technical choices, and rationale established so far. Include the WHY, not just the what — a decision without its reason gets relitigated.
3. **Artifacts and records** — every business record created, modified, or read that still matters: command, record id, and a short excerpt of load-bearing content only.
4. **Errors and fixes** — problems hit and how they were resolved, including user corrections ("no, do it this way") — those are feedback with lasting force.
5. **All user messages** — a chronological list of every user message (trimmed of pasted bulk). This is the intent audit-trail.
6. **Pending tasks** — explicitly incomplete items, promised follow-ups, things the user said "later" about.
7. **Current work** — precisely what was in progress at this point: which step, which command, what state.
8. **Next step** — the immediate next action, justified by the user's request.

Rules:
- Do NOT carry full record contents as truth. Note THAT a record was created/edited; the assistant re-reads if it needs the content again. Stale memory of a record is worse than no memory.
- Be concrete: command names, record ids, customers/payroll periods — not vague references.
- Output only the summary sections, no preamble.`;

export const CONTINUATION_CONTRACT =
  "Continue where you left off: pick up the current work and next step exactly as described. Do not re-ask answered questions, do not recap, do not mention that the context was compacted. If you need a record noted above, re-read it.";

// ----- compaction construction ------------------------------------

/** Inject into your provider via the builder interface shown below. */
export interface CompactionSummarizer {
  summarize(messages: ChatMessage[], priorSummary: string): Promise<string>;
  modelUsed: string;
}

export async function buildState(
  messages: ChatMessage[],
  auditSpan: ToolCallRecord[],
  summarizer: CompactionSummarizer,
  opts: { keepTokens: number; prior?: CompactionState },
): Promise<CompactionState | null> {
  const boundary = pickBoundary(messages, opts.keepTokens);
  if (boundary === null) return null;
  if (opts.prior && boundary <= opts.prior.boundaryIndex) return null;

  const spanStart = opts.prior?.boundaryIndex ?? 0;
  const span = messages.slice(spanStart, boundary);
  const priorUsers = opts.prior?.userMessages ?? [];

  const summary = await summarizer.summarize(span, opts.prior?.summaryText ?? "");
  const { messages: capped, dropped } = capUserMessages(
    priorUsers.concat(extractUserMessages(span)),
    opts.prior?.userMessagesDropped ?? 0,
  );

  // We do NOT know from these helpers which messages in `span` produced audit
  // entries; the orchestrator supplies them. They are extracted into the same
  // mechanical block shape OpenWorker uses.
  const workingState = extractWorkingState(auditSpan);

  return {
    boundaryIndex: boundary,
    summaryText: summary,
    workingState,
    userMessages: capped,
    userMessagesDropped: dropped,
    createdAt: Date.now(),
    modelUsed: summarizer.modelUsed,
    trimmed: false,
  };
}

/** The no-LLM fallback (no provider configured / provider down). */
export function trimState(
  messages: ChatMessage[],
  auditSpan: ToolCallRecord[],
  opts: { prior?: CompactionState; fraction?: number } = {},
): CompactionState | null {
  const prior = opts.prior;
  const start = prior?.boundaryIndex ?? 0;
  const remaining = messages.length - start;
  if (remaining <= 2) return null;
  const step = Math.max(1, Math.trunc(remaining * (opts.fraction ?? TRIM_FRACTION)));
  const target = start + step;

  let boundary: number | null = null;
  for (let i = target; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user" || role === "assistant") {
      boundary = i;
      break;
    }
  }
  if (boundary === null || boundary <= start || boundary >= messages.length) return null;

  const span = messages.slice(start, boundary);
  const priorUsers = prior?.userMessages ?? [];
  const summary =
    (prior?.summaryText ? prior.summaryText + "\n\n" : "") +
    "(Older turns were trimmed to fit the context window; no summary is available for them. Re-read records and re-run commands if earlier results are needed.)";
  const { messages: capped, dropped } = capUserMessages(
    priorUsers.concat(extractUserMessages(span)),
    prior?.userMessagesDropped ?? 0,
  );

  return {
    boundaryIndex: boundary,
    summaryText: summary,
    workingState: extractWorkingState(auditSpan),
    userMessages: capped,
    userMessagesDropped: dropped,
    createdAt: Date.now(),
    modelUsed: "",
    trimmed: true,
  };
}

export function compactedBlock(state: CompactionState): string {
  const parts: string[] = [
    "<compacted-history>",
    "Earlier turns of this session were compacted. The summary below is your memory of them.",
    "",
    state.summaryText,
  ];
  if (state.workingState) {
    parts.push("", state.workingState);
  }
  if (state.userMessages.length) {
    parts.push("", "## User messages in the compacted span (verbatim, chronological)");
    if (state.userMessagesDropped > 0) {
      parts.push(
        `(${state.userMessagesDropped} earlier user messages omitted — their intent is covered by the summary above)`,
      );
    }
    parts.push(...state.userMessages.map((u) => `- ${u}`));
  }
  parts.push("", CONTINUATION_CONTRACT, "</compacted-history>");
  return parts.join("\n");
}

/**
 * Build the outbound view: [system?] + the compacted block (as a user message) +
 * the verbatim tail from `state.boundaryIndex`. Canonical history untouched.
 *
 * ChasteBusinessOS ChatMessages all carry `id/role/parts/createdAt`. The
 * compacted block lives in a synthetic user message.
 */
export function applyToOutbound(
  messages: ChatMessage[],
  state: CompactionState | null,
): ChatMessage[] {
  if (!state || state.boundaryIndex <= 0 || state.boundaryIndex >= messages.length) {
    return messages;
  }
  const block: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: compactedBlock(state) }],
    createdAt: new Date(state.createdAt).toISOString(),
  };
  return [block, ...messages.slice(state.boundaryIndex)];
}

/** Signature of provider errors that signal context overflow (for re-compaction). */
const OVERFLOW_MARKERS = [
  "context_length_exceeded",
  "maximum context length",
  "context window",
  "prompt is too long",
  "input is too long",
  "too many tokens",
  "input length and `max_tokens` exceed",
  "exceeds the maximum number of tokens",
];

export function isContextOverflow(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  return OVERFLOW_MARKERS.some((m) => text.includes(m));
}
