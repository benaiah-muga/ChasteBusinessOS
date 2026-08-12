import {
  type AutonomyLevel,
  type CommandMeta,
  type CommandRegistry,
  type QueryRegistry,
  type RequestContext,
  executeCommand,
  executeQuery,
  type CommandHelpers,
  FULL_AUTONOMOUS_WARNING,
  type ConversationMode,
  type InboxItem,
  type InboxStore,
  isReadOnly,
  classify,
  externalTargetOf,
  type RiskClass,
  type RiskClassifiable,
  classifiableFromMeta,
  effectiveAutonomyForCommand,
  commandMayAutoExecute,
  effectiveAutonomyForPlan,
  planMayAutoExecute,
  MODE_CONTEXT,
  type AutoExecMeta,
} from "@chaste/kernel";
import type { ChatMessage, UiPart } from "@chaste/ui-schema";
import type { AiExplanation } from "./explanation.js";
import { toExplanationPart } from "./explanation.js";
import type { AiProvider } from "./providers.js";
import { generateSuggestions } from "./suggestions.js";
import { normalizeFieldNames, resolveInput } from "./workflows/engine.js";
import { looksLikePromptInjection, shouldCheckInjection } from "./guardrails/index.js";
import {
  applyToOutbound,
  buildState,
  shouldCompact,
  trimState,
  triggerTokens,
  estimateTokens,
  KEEP_RECENT_FRACTION,
  type CompactionState,
  type CompactionSummarizer,
  isContextOverflow,
  type ToolCallRecord,
} from "./compaction.js";
import {
  skillCatalogText,
  disableCountermand,
  skillTools,
  type SkillStore,
  type SkillTools,
  type SkillFile,
  type SkillRecord,
  type SkillRefinement,
} from "./skills.js";
import {
  selfWakeTools,
  type WakeStore,
  type SelfWakeTools,
} from "./selfwake.js";
import type { StandingRuleDecision } from "@chaste/kernel";
import type { MemoryKind, MemoryRecord, MemoryStore } from "./memory.js";

export interface PendingPlanStep {
  command: string;
  input: unknown;
  description: string;
}

export interface PendingConfirmation {
  id: string;
  command: string;
  input: unknown;
  createdAt: string;
  /** When set, confirmation executes all plan steps in order. */
  plan?: PendingPlanStep[];
  /** Discriminator for the shared pending union (absent on legacy records). */
  type?: "confirmation";
}

/**
 * Natural-language clarification (docs/ai-intelligence-plan.md §2e). When the
 * intent is recognized but required information is missing — either by the
 * deterministic parser or the LLM assist path — the assistant parks a
 * clarification instead of guessing. The user's answer on the next turn is
 * merged through `probe` (a template with an `{answer}` placeholder) and the
 * full plan/confirm pipeline re-runs. `command`/`input`/`plan` are optional
 * purely so callers reading the shared pending union keep compiling; a real
 * clarification never carries them.
 */
export interface PendingClarification {
  id: string;
  type: "clarification";
  questions: string[];
  probe: string;
  createdAt: string;
  command?: string;
  input?: unknown;
  plan?: PendingPlanStep[];
}

export type PendingState = PendingConfirmation | PendingClarification;

/**
 * The orchestrator's in-process session shape. When the kernel `InboxStore` is
 * wired, `pending` becomes the in-chat projection of the canonical Inbox item
 * (kept here for back-compat with callers that read it synchronously); the
 * Inbox remains the store of record and is the durable surface for retries.
 */
export interface ChatSessionState {
  id: string;
  messages: ChatMessage[];
  pending?: PendingState;
  /** R3: when true, the orchestrator parks approvals in the Inbox, not inline. */
  unattended?: boolean;
  /** R6: persisted compaction state (boundary + summary + working state). */
  compactionState?: CompactionState | null;
  /** R7: skill names whose instructions are already in history (countermand source). */
  loadedSkillNames?: string[];
  /** Branch scope used for skill filtering and branch-scoped commands. */
  activeBranchId?: string;
}

export interface OrchestratorDeps {
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  autonomy: AutonomyLevel;
  provider?: AiProvider;
  allowFullAutonomous?: boolean;
  /**
   * R2 — the canonical human-attention queue. When provided, the orchestrator
   * mirrors every `pending` confirmation to the Inbox for durable resume and
   * (when `session.unattended`) cross-session/mobile approvals.
   */
  inbox?: InboxStore;
  /** R3 — default visibility for new inbox items. Defaults to `inline` (attended). */
  defaultInboxVisibility?: "inline" | "inbox";
  /**
   * R9 — conversation mode (discuss/plan/interactive). When `discuss` or
   * `plan`, the orchestrator refuses writes/exec and instead emits an
   * explanation describing the proposed change.
   */
  mode?: ConversationMode;
  /**
   * Multi-branch (platform spec §4): label of the session's active branch,
   * injected per turn so branch-scoped commands (branch.list / set_active /
   * domain queries) act on the branch the user means.
   */
  activeBranch?: { name: string; code: string };
  /** R6 — context-window-aware compaction when the outbound history is large. */
  compaction?: {
    summarizer: CompactionSummarizer;
    contextWindow?: number;
  };
  /** R1 — user-local risk overrides (per-org policy later). */
  riskOverrides?: (commandName: string) => RiskClass | null;
  /**
   * R5 — durable self-wake store. When provided, the orchestrator surfaces the
   * agent-callable `sleepFor`/`sleepUntil`/`wakeOnJob`/`wakeOnEvent` tools to
   * the LLM so a session can suspend itself and be re-invoked later.
   */
  wake?: WakeStore;
  /**
   * R7 — org/platform skill catalog exposed to the AI. When provided, the
   * per-turn catalog is injected and `loadSkill`/`saveSkill` become callable.
   */
  skills?: SkillStore;
  /**
   * Adaptive learning — org-scoped memory. When provided, prior learned context
   * is passively recalled into the per-turn view, executions write memory, and
   * the `memory.search`/`memory.store` agent tools become callable.
   */
  memory?: MemoryStore;
  /**
   * Background audit span for mechanical state extraction on compaction. When
   * unset, compaction's `workingState` is empty (preserved cap, fewer features).
   */
  auditSpanProvider?: () => ToolCallRecord[];
}

export interface ChatTurnInput {
  session: ChatSessionState;
  userText?: string;
  confirmId?: string;
  cancelId?: string;
  /** Resolution string when answering a via-inbox approval ("allow"/"always"/"deny"). */
  inboxResolution?: string;
  ctx: RequestContext;
}

export interface ChatTurnResult {
  session: ChatSessionState;
  explanation?: AiExplanation;
  /** When set, the call needs human attention; surfaced to the UI/push channels. */
  inboxItemId?: string;
}

function msg(role: ChatMessage["role"], parts: UiPart[]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    parts,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Mark interactive `confirm_action` parts as resolved so the chat log never
 * keeps a clickable Confirm/Cancel for an already-handled (or superseded)
 * approval. The canonical once-only gate lives in Inbox/`session.pending`;
 * this only keeps the rendered transcript honest for UI and automation.
 */
function resolveConfirmParts(
  messages: ChatMessage[],
  opts: {
    /** Specific confirmation id to update. Omit to touch every pending card. */
    id?: string;
    status: "confirmed" | "cancelled" | "superseded";
  },
): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "confirm_action") return part;
      const current = part.status ?? "pending";
      if (current !== "pending") return part;
      if (opts.id && part.id !== opts.id) return part;
      return { ...part, status: opts.status };
    }),
  }));
}

/**
 * R2/R3/R4 — mirror a freshly-created `session.pending` confirmation to the
 * canonical Inbox store. The Inbox becomes the durable store of record; the
 * in-chat `pending` blob remains for synchronous callers (API clients reading
 * the HTTP response, tests) but is now a projection of the Inbox, not the
 * source of truth.
 *
 * R4 — when the planned command is `external`-risk and the call names a
 * target, the Inbox carries the standing-rule metadata (taskId/commandId/
 * standingTarget) so resolving with "always" later caches a scoped rule.
 *
 * Visibility: `session.unattended` flips the visibility to `inbox` so the
 * approval surfaces in the cross-session queue (mobile, Slack dm). Default is
 * `inline` — attended sessions answer in the composer.
 */
async function mirrorToInbox(
  deps: OrchestratorDeps,
  session: ChatSessionState,
  ctx: { organizationId: string; userId: string },
  pending: PendingConfirmation,
  opts: { summary: string; commandMeta?: CommandMeta; input?: Record<string, unknown> } = {
    summary: pending.command,
  },
): Promise<InboxItem | undefined> {
  if (!deps.inbox) return undefined;
  const visibility = session.unattended ? "inbox" : (deps.defaultInboxVisibility ?? "inline");
  const pendingInput = (opts.input ?? (pending.input as Record<string, unknown>)) ?? {};
  void pendingInput; // we only need the input-derived standingTarget below
  let standingTarget: string | undefined;
  if (opts.commandMeta && pending.command) {
    const cls = classify(pending.command, {
      classifiable: {
        riskClass: opts.commandMeta.riskClass,
        externalTargetField: opts.commandMeta.externalTargetField,
      },
      overrides: deps.riskOverrides,
    });
    if (cls === "external") {
      const target = externalTargetOf(
        pending.command,
        pending.input as Record<string, unknown>,
        {
          riskClass: cls,
          externalTargetField: opts.commandMeta.externalTargetField,
        },
      );
      standingTarget = target ?? undefined;
    }
  }
  return deps.inbox.addApproval({
    sessionId: session.id,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    title: opts.summary,
    body: pending.command,
    visibility,
    toolCallId: pending.id,
    data: {
      commandId: pending.command,
      standingTarget,
      // taskId left unset by ad-hoc approvals; automation runs supply it.
    },
  });
}

/** Look up a command's metadata in the registry (undefined when module not loaded). */function commandMetaOf(deps: OrchestratorDeps, command: string): CommandMeta | undefined {
  return deps.commands.list().find((c) => c.name === command) as CommandMeta | undefined;
}

/** Effective risk of a planned command, honoring user-local overrides. */
function riskOf(
  deps: OrchestratorDeps,
  command: string,
  meta?: CommandMeta,
): RiskClass {
  return classify(command, {
    classifiable: classifiableFromMeta(meta),
    overrides: deps.riskOverrides,
  });
}

/**
 * R4 — does a standing approval rule already cover this command+target? Returns
 * the triggering rule string when yes. Only `external`-risk commands that name
 * a concrete off-platform target are eligible (the safety floor that makes
 * "allow always" scoped, never blanket).
 */
async function standingDecision(
  deps: OrchestratorDeps,
  session: ChatSessionState,
  command: string,
  input: unknown,
  meta?: CommandMeta,
): Promise<StandingRuleDecision | null> {
  if (!deps.inbox) return null;
  const classifiable = classifiableFromMeta(meta);
  if (classify(command, { classifiable, overrides: deps.riskOverrides }) !== "external") {
    return null;
  }
  const target = externalTargetOf(command, (input ?? {}) as Record<string, unknown>, classifiable);
  if (!target) return null;
  return deps.inbox.standingRuleFor({
    sessionId: session.id,
    commandId: command,
    target,
  });
}

/**
 * R6 — compaction trigger/build wiring. When the outbound history would exceed
 * the context budget, build a CompactionState (LLM summary + mechanical working
 * state) and park it on the session; the persisted transcript is untouched and
 * only what we *send* to the model is transformed. Falls back to the no-LLM
 * `trimState` when the summarizer is unavailable.
 */
async function ensureCompactionState(
  deps: OrchestratorDeps,
  session: ChatSessionState,
): Promise<ChatSessionState> {
  if (!deps.compaction) return session;
  const { summarizer, contextWindow } = deps.compaction;
  if (!shouldCompact(estimateTokens(session.messages), contextWindow)) return session;

  const auditSpan = deps.auditSpanProvider?.() ?? [];
  const trigger = triggerTokens(contextWindow, {});
  const keepTokens = Math.max(1, Math.trunc(trigger * KEEP_RECENT_FRACTION));
  const prior = session.compactionState ?? undefined;

  try {
    const state = await buildState(session.messages, auditSpan, summarizer, {
      keepTokens,
      prior,
    });
    if (state) return { ...session, compactionState: state };
  } catch {
    // summarizer down — honest no-LLM fallback, never silent drop
  }
  const trimmed = trimState(session.messages, auditSpan, { prior });
  if (trimmed) return { ...session, compactionState: trimmed };
  return session;
}

/**
 * R9 — per-turn mode context (OpenWorker's per-turn context pattern). Mode can
 * flip mid-session, so the instruction is appended to the *outbound* view each
 * turn instead of being baked into the static system prompt. Never mutates the
 * persisted transcript.
 */
function withModeContext(
  messages: ChatMessage[],
  mode: ConversationMode | undefined,
): ChatMessage[] {
  if (!mode || !isReadOnly(mode)) return messages;
  const note = MODE_CONTEXT[mode];
  if (!note || messages.length === 0) return messages;
  const copy = messages.slice();
  const last = copy[copy.length - 1]!;
  if (last.role !== "user") return copy;
  copy[copy.length - 1] = {
    ...last,
    parts: [...last.parts, { type: "text", text: `\n[${note}]` }],
  };
  return copy;
}

/** Multi-branch (platform spec §4) — per-turn active-branch context. */
function withBranchContext(
  messages: ChatMessage[],
  activeBranch: { name: string; code: string } | undefined,
): ChatMessage[] {
  if (!activeBranch || messages.length === 0) return messages;
  const copy = messages.slice();
  const last = copy[copy.length - 1]!;
  if (last.role !== "user") return copy;
  copy[copy.length - 1] = {
    ...last,
    parts: [
      ...last.parts,
      {
        type: "text",
        text: `\n[Active branch: ${activeBranch.name} (${activeBranch.code}) — scope branch-sensitive work to this branch unless the user says otherwise.]`,
      },
    ],
  };
  return copy;
}

/** R7 — per-turn skill catalog + loaded-skill disable countermand, appended to outbound. */
async function withSkillContext(
  messages: ChatMessage[],
  deps: OrchestratorDeps,
  session: ChatSessionState,
  organizationId: string,
): Promise<ChatMessage[]> {
  if (!deps.skills) return messages;
  const filter = {
    organizationId,
    branchId: session.activeBranchId,
  };
  const catalog = await skillCatalogText(deps.skills, filter);
  const countermand = await disableCountermand(deps.skills, filter, session.loadedSkillNames ?? []);
  if (!catalog && !countermand) return messages;
  const copy = messages.slice();
  const last = copy[copy.length - 1]!;
  if (last.role !== "user") return copy;
  const extras: UiPart[] = [];
  if (catalog) extras.push({ type: "text", text: catalog });
  if (countermand) extras.push({ type: "text", text: countermand });
  copy[copy.length - 1] = { ...last, parts: [...last.parts, ...extras] };
  return copy;
}

// Cap for the passively-recalled memory block so it stays a small budgeted
// context injection, not a transcript dump.
const MEMORY_RECALL_LIMIT = 5;
const MEMORY_RECALL_CHAR_CAP = 1200;

/** Stopwords + the action/domain vocabulary never become recall terms. */
const RECALL_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "about", "any", "be", "by", "can", "could",
  "create", "add", "new", "customer", "client", "vendor", "invoice", "bill",
  "product", "employee", "payroll", "remind", "reminder", "follow", "please",
  "for", "from", "get", "have", "has", "how", "is", "it", "kindly", "know",
  "let", "me", "do", "does", "our", "the", "this", "that", "these", "those",
  "to", "us", "we", "what", "when", "where", "which", "who", "will", "with",
  "work", "business", "you", "your", "please", "notes", "internal",
]);

/** Derive a few concrete recall terms from the user's message. */
function recallTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const q of text.match(/\"([^\"]+)\"|'([^']+)'/g) ?? []) {
    terms.add(q.replace(/["']/g, ""));
  }
  for (const tok of text.match(/[A-Za-z][A-Za-z0-9&.'-]{1,}/g) ?? []) {
    const lower = tok.toLowerCase();
    if (lower.length < 2 || RECALL_STOPWORDS.has(lower)) continue;
    if (/[A-Z]/.test(tok) || /\d/.test(tok) || /[&'.-]/.test(tok)) terms.add(tok);
    else terms.add(lower);
  }
  return [...terms].filter(Boolean).slice(0, 6);
}

/**
 * Adaptive learning — passive recall. Recall the most-recent org-scoped memory
 * entries that mention the user's current request, and inject a small bounded
 * block of learned context into the outbound view (sibling of the skill
 * catalog: appended to the last user message, never persisted).
 */
async function withMemoryContext(
  messages: ChatMessage[],
  deps: OrchestratorDeps,
  organizationId: string,
): Promise<ChatMessage[]> {
  if (!deps.memory || messages.length === 0) return messages;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const query =
    lastUser?.parts
      .filter((p): p is Extract<UiPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim() ?? "";
  if (!query) return messages;

  const hits = new Map<string, MemoryRecord>();
  for (const term of recallTerms(query)) {
    try {
      const found = await deps.memory.search(organizationId, term, MEMORY_RECALL_LIMIT);
      for (const r of found) {
        if (!hits.has(r.id)) hits.set(r.id, r);
        if (hits.size >= MEMORY_RECALL_LIMIT * 3) break;
      }
    } catch {
      // memory is best-effort; a failing store never breaks the turn
    }
  }
  const lines = [...hits.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((r) => r.content.trim())
    .filter(Boolean)
    .slice(0, MEMORY_RECALL_LIMIT);
  if (lines.length === 0) return messages;

  let block =
    "\n[Learned context from this workspace - these are RECORDS OF PAST EXECUTIONS only. " +
    "Never copy their field values into a new plan. If a required field is missing from the current request, ask for it.]\n" +
    lines.map((l) => `- ${l}`).join("\n");
  if (block.length > MEMORY_RECALL_CHAR_CAP) {
    block = block.slice(0, MEMORY_RECALL_CHAR_CAP) + "\n…";
  }

  const copy = messages.slice();
  const last = copy[copy.length - 1]!;
  if (last.role !== "user") return copy;
  copy[copy.length - 1] = {
    ...last,
    parts: [...last.parts, { type: "text", text: block }],
  };
  return copy;
}

/** Human-readable execution summary for memory recall ("what did we set up?"). */
function describeExecution(command: string, input: unknown, summary?: string): string {
  const base = summary && summary !== `Execute ${command}` ? summary : command;
  try {
    const entries = Object.entries((input as Record<string, unknown>) ?? {}).filter(
      ([, v]) => v != null && v !== "" && typeof v !== "object",
    );
    const detail = entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
    return detail ? `${base} (${detail})` : base;
  } catch {
    return base;
  }
}

/** Record an executed action into org memory (kind long_term_org, deduped by key). */
async function rememberExecution(
  deps: OrchestratorDeps,
  ctx: { organizationId: string; userId: string; sessionId?: string },
  executed: { command: string; input: unknown; summary?: string },
): Promise<void> {
  if (!deps.memory) return;
  try {
    const content = describeExecution(executed.command, executed.input, executed.summary);
    const key = `${executed.command}:${JSON.stringify(executed.input ?? {})}`.slice(0, 200);
    await deps.memory.write({
      organizationId: ctx.organizationId,
      kind: "long_term_org" as MemoryKind,
      key,
      content: `Executed ${content}`,
      metadata: { command: executed.command, input: executed.input },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
  } catch {
    // memory is best-effort; never fail a business action on a write error
  }
}

export interface PlannedAction {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  specialist?: string;
}

/**
 * §2e — when the previous turn asked a clarification, recap the questions and
 * the user's answer into the outbound view so the LLM assist path replans with
 * the full picture (the transcript's clarify part is not text-serialized to
 * providers). Never persisted.
 */
function withClarifyAnswerContext(
  messages: ChatMessage[],
  ctx: { questions: string[]; answer: string },
): ChatMessage[] {
  const copy = messages.slice();
  const last = copy[copy.length - 1]!;
  if (last.role !== "user") return copy;
  const recap = `\n[Earlier I asked: ${ctx.questions.join(" ")} The user replied: "${ctx.answer}". Resolve the original request with this answer.]`;
  copy[copy.length - 1] = {
    ...last,
    parts: [...last.parts, { type: "text", text: recap }],
  };
  return copy;
}

/** Split compound requests into segments for multi-step planning. */
function splitCompoundRequest(text: string): string[] {
  const parts = text
    .split(/\s+(?:and also|then|and then|, then)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  // "create X and create Y" / "create X and also create Y" / "… and add vendor Z"
  const andCreate = text.split(
    /\s+and\s+(?=(?:create|add|register|set up|make|prepare|run|hire|block|schedule)\s+|(?:vendor|product|customer|employee|invoice|bill|payroll)\s+)/i,
  );
  if (andCreate.length > 1) {
    return andCreate.map((p) => p.trim()).filter(Boolean);
  }
  return [text.trim()];
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/**
 * Deterministic schedule-question handling — the read side of the assistant.
 *
 * Recognizes natural "what do I have …" requests (schedule / agenda / tasks /
 * meetings / reminders / calendar / appointments) with an optional day window
 * (today, tomorrow, this week, next week, on <weekday>), and maps them to the
 * same read queries a human would call (core.calendar.list / core.reminder.list
 * / core.followup.list). Runs before the LLM so common questions are answered
 * reliably even without a provider, and the "nothing scheduled" case returns a
 * clear statement instead of a clarification or a made-up answer.
 */
function scheduleDayRange(
  text: string,
  now: Date = new Date(),
): { from: string; to: string; label: string } | null {
  const t = text.toLowerCase();
  const dayOfWeek = t.match(/\bon\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  let start = new Date(todayStart);
  let end: Date;
  let label: string;

  if (/\btomorrow\b/.test(t)) {
    start.setDate(start.getDate() + 1);
    end = new Date(start);
    end.setHours(23, 59, 59, 999);
    label = "tomorrow";
  } else if (/\bnext week\b/.test(t)) {
    start.setDate(start.getDate() + ((7 - start.getDay() + 1) % 7 || 7));
    end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    label = "next week";
  } else if (/\bthis week\b/.test(t)) {
    start.setDate(start.getDate() - start.getDay() + 1);
    end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    label = "this week";
  } else if (dayOfWeek?.[1]) {
    const target = DAY_NAMES.findIndex((d) => d.startsWith(dayOfWeek[1]!.slice(0, 3)));
    let delta = (target - start.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    start.setDate(start.getDate() + delta);
    end = new Date(start);
    end.setHours(23, 59, 59, 999);
    label = `on ${dayOfWeek[1].toLowerCase()}`;
  } else {
    end = new Date(todayStart);
    end.setHours(23, 59, 59, 999);
    label = "today";
  }

  return { from: start.toISOString(), to: end.toISOString(), label };
}

const SCHEDULE_QUESTION_READ_MARKERS =
  /\b(?:what|what'?s|what is|what are|do i have|does my|do we have|how many|any|show me|tell me|is there|are there|when|did i|have i)\b/i;

const SCHEDULE_QUESTION_POSSESSIVE =
  /\b(?:my|our|the|his|her|your)\s+(?:schedule|calendar|agenda|tasks|meetings|events|appointments|reminders|plans)\b/i;

const SCHEDULE_QUESTION_NOUNS =
  /\b(?:tasks|task|schedule|agenda|calendar|meetings|meeting|events|event|appointments|appointment|reminders|reminder|plans|plan|todo|todos|to-dos|itinerary)\b/i;

const SCHEDULE_ACTION_VERBS =
  /\b(?:create|add|make|register|set\s+up|book|block|remind|run|prepare|delete|remove|cancel|update|edit|move|schedule\s+(?:a|an|the|this|that|in|for|on|into|it|us))\b/i;

export function planScheduleQuestion(
  text: string,
  now: Date = new Date(),
): {
  queries: { name: string; input: Record<string, unknown> }[];
  summary: string;
  range: { from: string; to: string; label: string };
} | null {
  if (SCHEDULE_ACTION_VERBS.test(text)) return null;
  const hasMarker =
    SCHEDULE_QUESTION_READ_MARKERS.test(text) || SCHEDULE_QUESTION_POSSESSIVE.test(text);
  if (!hasMarker) return null;
  if (!SCHEDULE_QUESTION_NOUNS.test(text)) return null;
  const range = scheduleDayRange(text, now);
  if (!range) return null;
  return {
    queries: [
      { name: "core.calendar.list", input: { from: range.from, to: range.to } },
      { name: "core.reminder.list", input: {} },
      { name: "core.followup.list", input: {} },
    ],
    summary: `Schedule for ${range.label}`,
    range,
  };
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Run read queries through the same bus humans use (executeQuery — permission +
 * zod + request context) and render an answer, including a clear "nothing"
 * statement when the window is empty.
 */
async function answerScheduleQuestion(
  deps: OrchestratorDeps,
  ctx: RequestContext,
  plan: NonNullable<ReturnType<typeof planScheduleQuestion>>,
): Promise<{ parts: UiPart[]; explanation: AiExplanation }> {
  const { from, to, label } = plan.range;
  const results: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const q of plan.queries) {
    try {
      const res = await executeQuery(deps.queries, q.name, q.input, ctx);
      results.push(res.data as Record<string, unknown>);
    } catch (err) {
      errors.push(`${q.name}: ${(err as Error).message}`);
    }
  }

  const events = (results.find((r) => Array.isArray(r.events))?.events ?? []) as Record<
    string,
    unknown
  >[];
  const reminders = (results.find((r) => Array.isArray(r.reminders))?.reminders ?? []) as Record<
    string,
    unknown
  >[];
  const followUps = (results.find((r) => Array.isArray(r.followUps))?.followUps ?? []) as Record<
    string,
    unknown
  >[];

  const inRange = (fireAt: unknown): boolean => {
    const t = new Date(fireAt as string).getTime();
    return Number.isFinite(t) && t >= new Date(from).getTime() && t <= new Date(to).getTime();
  };
  const due = reminders.filter((r) => inRange(r.fireAt)).slice(0, 20);
  const dueF = followUps.filter((f) => inRange(f.fireAt)).slice(0, 20);

  const title = (r: Record<string, unknown>) => String(r.title ?? r.goal ?? "Untitled");
  const rows = [
    ...events.map((e) => ({ time: fmtTime(e.startsAt as string), type: "Meeting", title: title(e) })),
    ...due.map((r) => ({ time: fmtTime(r.fireAt as string), type: "Reminder", title: title(r) })),
    ...dueF.map((f) => ({ time: fmtTime(f.fireAt as string), type: "Follow-up", title: title(f) })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  const total = rows.length;
  const parts: UiPart[] = [
    {
      type: "text",
      text:
        total === 0
          ? `You have nothing scheduled ${label === "today" ? "today" : label}.`
          : `You have ${total} ${total === 1 ? "item" : "items"} on your schedule for ${label}:`,
    },
  ];
  if (rows.length > 0) {
    parts.push({
      type: "table",
      columns: [
        { key: "time", label: "Time" },
        { key: "type", label: "Type" },
        { key: "title", label: "Title" },
      ],
      rows,
    });
  }
  if (errors.length > 0) {
    parts.push({
      type: "text",
      text: `(Some parts of your schedule couldn't be read: ${errors.join("; ")})`,
    });
  }

  const explanation: AiExplanation = {
    runId: crypto.randomUUID(),
    summary: plan.summary,
    reasons: ["Answered from org data via the read-query bus", "Schedule window resolved deterministically"],
    rulesApplied: ["ai_manual_parity", "read_via_query_bus", "zod_validation_on_execute", "permission_check_on_execute"],
    dataUsed: ["user message", "query catalog"],
    autonomy: "recommend",
    plannedCommand: plan.queries.map((q) => q.name).join(", "),
  };

  return { parts, explanation };
}

/**
 * Deterministic datetime phrase extraction for "remind me …" / "follow up …".
 *
 * Understands a small, reliable set of phrases: "in N minutes/hours/days",
 * "on <weekday> at HH:MM[am|pm]" (next occurrence), "today at HH:MM[am|pm]",
 * "tomorrow at HH:MM[am|pm]", "at HH:MM[am|pm]" (today or next). Ambiguous
 * or missing times return `fireAt: null` so the LLM assist path can clarify.
 */
export function parseScheduleFireAt(text: string, now: Date = new Date()): {
  fireAt: string | null;
  cleaned: string;
} {
  const inRe = text.match(/\bin (\d+) (minute|minutes|hour|hours|day|days)\b/i);
  if (inRe?.[1]) {
    const n = Number(inRe[1]);
    const unit = inRe[2]!.toLowerCase();
    const ms =
      unit.startsWith("minute") ? n * 60_000 :
      unit.startsWith("hour") ? n * 3_600_000 :
      n * 86_400_000;
    const fireAt = new Date(now.getTime() + ms).toISOString();
    return { fireAt, cleaned: text.replace(inRe[0], "").trim() };
  }

  const dayRe = text.match(
    /\bon (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (dayRe?.[1]) {
    const target = DAY_NAMES.findIndex((d) => d.startsWith(dayRe[1]!.slice(0, 3).toLowerCase()));
    let hour = Number(dayRe[2]);
    const minute = Number(dayRe[3] ?? 0);
    const meridian = dayRe[4]?.toLowerCase();
    if (meridian === "pm" && hour < 12) hour += 12;
    if (meridian === "am" && hour === 12) hour = 0;

    const date = new Date(now);
    let delta = (target - date.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // next occurrence, not today
    date.setDate(date.getDate() + delta);
    date.setHours(hour, minute, 0, 0);
    return { fireAt: date.toISOString(), cleaned: text.replace(dayRe[0], "").trim() };
  }

  // "today at 4pm" | "tomorrow at 9am" | "at 4pm" | "4:30pm"
  const clockRe = text.match(
    /\b((?:today|tomorrow)\s+at|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
  );
  const clockNoMeridian = text.match(/\b((?:today|tomorrow)\s+at|at)\s+(\d{1,2})(?::(\d{2}))?\b/i);
  const m = clockRe?.[4] ? clockRe : clockNoMeridian;
  if (m?.[2] && Number(m[2]) <= 23) {
    let hour = Number(m[2]);
    const minute = Number(m[3] ?? 0);
    const meridian = m[4]?.toLowerCase();
    if (meridian === "pm" && hour < 12) hour += 12;
    if (meridian === "am" && hour === 12) hour = 0;

    const when = m[1]?.toLowerCase();
    const date = new Date(now);
    if (when?.includes("tomorrow")) {
      date.setDate(date.getDate() + 1);
    }
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= now.getTime()) {
      date.setDate(date.getDate() + 1);
    }
    return { fireAt: date.toISOString(), cleaned: text.replace(m[0], "").trim() };
  }

  return { fireAt: null, cleaned: text.trim() };
}

/**
 * Deterministic time-range extraction for calendar scheduling
 * ("block tuesday 10-11", "schedule a meeting tomorrow 2pm until 3pm").
 * Falls back to null so the LLM assist path can clarify multi-constraint times.
 */
export function parseScheduleRange(text: string, now: Date = new Date()): {
  startsAt: string;
  endsAt: string;
  cleaned: string;
} | null {
  const dayOfWeek = text.match(/\bon\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  const dayAnchor = text.match(/\b(today|tomorrow)\b/i);

  let base = new Date(now);
  if (dayAnchor?.[1]?.toLowerCase() === "tomorrow") {
    base.setDate(base.getDate() + 1);
  }
  if (dayOfWeek?.[1]) {
    const target = DAY_NAMES.findIndex((d) => d.startsWith(dayOfWeek[1]!.slice(0, 3).toLowerCase()));
    let delta = (target - base.getDay() + 7) % 7;
    if (delta === 0 && !dayAnchor) delta = 7; // next occurrence when no explicit "today"
    base.setDate(base.getDate() + delta);
  }

  const range = text.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*(?:-|–|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (!range?.[1] || !range?.[4]) return null;

  const startHour = Number(range[1]);
  const startMinute = Number(range[2] ?? 0);
  const startMeridian = range[3]?.toLowerCase();
  const endHourRaw = Number(range[4]);
  const endMinute = Number(range[5] ?? 0);
  const endMeridian = range[6]?.toLowerCase();

  let startHourFinal = startHour;
  if (startMeridian === "pm" && startHourFinal < 12) startHourFinal += 12;
  if (startMeridian === "am" && startHourFinal === 12) startHourFinal = 0;
  let endHourFinal = endHourRaw;
  if (endMeridian === "pm" && endHourFinal < 12) endHourFinal += 12;
  if (endMeridian === "am" && endHourFinal === 12) endHourFinal = 0;
  if (!endMeridian && !startMeridian && endHourRaw < startHour) {
    endHourFinal += 12; // "10-11" is 10am-11am, but "22-23" style stays 24h
  }

  const startsAt = new Date(base);
  startsAt.setHours(startHourFinal, startMinute, 0, 0);
  const endsAt = new Date(base);
  endsAt.setHours(endHourFinal, endMinute, 0, 0);
  if (endsAt <= startsAt) endsAt.setDate(endsAt.getDate() + 1);

  if (!dayAnchor && !dayOfWeek && startsAt <= now) {
    startsAt.setDate(startsAt.getDate() + 1);
    endsAt.setDate(endsAt.getDate() + 1);
  }

  const cleaned = text
    .replace(range[0], "")
    .replace(dayAnchor?.[0] ?? "", "")
    .replace(dayOfWeek?.[0] ?? "", "")
    .replace(/\b(block|schedule|book)\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), cleaned };
}

/** Strip politeness phrasing (leading and trailing) so it never changes intent. */
function normalizeRequestPhrasing(text: string): string {
  let out = text.trim();
  let previous: string;
  do {
    previous = out;
    out = out
      .replace(/^(?:please|kindly|could you|can you|would you)\s+/i, "")
      .replace(/[\s,;]*(?:please|kindly|thanks|thank you)[\s,;]*$/i, "")
      .replace(/[\s.,!;]+$/, "");
  } while (out !== previous && out.length > 0);
  return out.trim();
}

/**
 * Parse a single intent segment (no compound splitting). Returns null when the
 * segment is recognized but incomplete (so callers can clarify naturally).
 */
function planSingleSegment(text: string): PlannedAction | null {
  // Politeness/interjections never change intent.
  const trimmed = normalizeRequestPhrasing(text);

  // Reminders & follow-ups (spec: scheduling-and-comms §3). Deterministic
  // datetime phrases map to an ISO fireAt; anything else falls through to a
  // natural clarification ("when should I…") instead of an examples dump.
  let m = trimmed.match(/^(?:remind me(?: to)?|set a reminder(?: to)?)\s+(.+)$/i);
  if (m?.[1]) {
    const { fireAt, cleaned } = parseScheduleFireAt(m[1]);
    if (fireAt) {
      const title = cleaned.replace(/^to\s+/i, "").trim();
      return {
        command: "core.reminder.set",
        input: { title, fireAt },
        summary: `Remind me: ${title}`,
        specialist: "core",
      };
    }
  }

  m = trimmed.match(/^follow up(?:\s+with)?\s+(.+)$/i);
  if (m?.[1]) {
    const { fireAt, cleaned } = parseScheduleFireAt(m[1]);
    if (fireAt) {
      const goal = cleaned.replace(/^to\s+/i, "").trim();
      return {
        command: "core.followup.create",
        input: { goal, fireAt },
        summary: `Follow up: ${goal}`,
        specialist: "core",
      };
    }
  }

  m = trimmed.match(/^(?:block|schedule|book)\s+(.+)$/i);
  if (m?.[1]) {
    const range = parseScheduleRange(m[1]);
    if (range) {
      return {
        command: "core.calendar.event.create",
        input: { title: range.cleaned, startsAt: range.startsAt, endsAt: range.endsAt },
        summary: `Schedule: ${range.cleaned}`,
        specialist: "core",
      };
    }
  }

  // CRM customer — natural phrasings: create/add/register/set up [a] [new]
  // customer/client [called|named] <name> [in <city>].
  m = trimmed.match(
    /^(?:create|add|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer|client)\b(?:\s+(?:called|named))?\s+(?!in\b)(.+?)(?:\s+in\s+([A-Za-z][A-Za-z\s-]+))?$/i,
  );
  if (m?.[1]) {
    return {
      command: "crm.customer.create",
      input: { name: m[1].trim(), city: m[2]?.trim() },
      summary: `Create customer ${m[1].trim()}`,
      specialist: "crm",
    };
  }

  m = trimmed.match(/^(?:prepare|run|process|generate)\s+(?:the\s+)?payroll\s+(?:for\s+)?(.+)$/i);
  if (m?.[1]) {
    return {
      command: "hr.payroll.prepare",
      input: { periodLabel: m[1].trim() },
      summary: `Prepare payroll for ${m[1].trim()}`,
      specialist: "hr",
    };
  }

  // Invoice — (create|add|make|raise|generate|issue) [a|an] (invoice|bill) <ref> [for <amt> [CUR]].
  m = trimmed.match(
    /^(?:create|add|make|raise|generate|issue)\s+(?:an\s+|a\s+)?(?:invoice|bill)\s+(?!for\b)(\S+)(?:\s+for\s+([\d.]+))?(?:\s+([A-Z]{3}))?$/i,
  );
  if (m?.[1]) {
    return {
      command: "acc.invoice.create",
      input: {
        number: m[1],
        total: m[2] ? Number(m[2]) : 0,
        currency: m[3] ?? "USD",
      },
      summary: `Create invoice ${m[1]}`,
      specialist: "accounting",
    };
  }

  m = trimmed.match(
    /^(?:create|add|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?vendor\b(?:\s+(?:called|named))?\s+(?!in\b)(.+)$/i,
  );
  if (m?.[1]) {
    return {
      command: "pur.vendor.create",
      input: { name: m[1].trim() },
      summary: `Create vendor ${m[1].trim()}`,
      specialist: "purchasing",
    };
  }

  m = trimmed.match(
    /^(?:create|add|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?product\s+(?:(?:called|named)\s+)?(\S+)\s+(.+)$/i,
  );
  if (m?.[1] && m[2]) {
    return {
      command: "inv.product.create",
      input: { sku: m[1], name: m[2].trim() },
      summary: `Create product ${m[1]} (${m[2].trim()})`,
      specialist: "inventory",
    };
  }

  m = trimmed.match(
    /^(?:create|add|hire|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?employee\s+(?:(?:called|named)\s+)?(\S+)\s+(.+)$/i,
  );
  if (m?.[1] && m[2]) {
    return {
      command: "hr.employee.create",
      input: { employeeNumber: m[1], fullName: m[2].trim() },
      summary: `Create employee ${m[2].trim()}`,
      specialist: "hr",
    };
  }

  return null;
}

/**
 * Natural clarification for recognized-but-incomplete requests. Returns the
 * pending clarification the orchestrator parks when a deterministic intent is
 * clear but a required field/time is missing — the assistant asks a focused,
 * natural question instead of dumping examples. The probe template carries an
 * `{answer}` placeholder so the user's reply can be merged on the next turn.
 */
export function clarifyFromText(text: string): PendingClarification | null {
  const trimmed = normalizeRequestPhrasing(text);
  // Already actionable — nothing to clarify.
  if (planSingleSegment(trimmed)) return null;
  const now = new Date().toISOString();

  let m = trimmed.match(/^(?:remind me(?: to)?|set a reminder(?: to)?)\s+(.+)$/i);
  if (m?.[1] && !parseScheduleFireAt(m[1]).fireAt) {
    const clause = m[1].replace(/^to\s+/i, "").trim();
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: [
        `When should I remind you to ${clause}? (for example: "tomorrow at 9am" or "in 30 minutes")`,
      ],
      probe: `remind me {answer} to ${clause}`,
      createdAt: now,
    };
  }

  m = trimmed.match(/^follow up(?:\s+with)?\s+(.+)$/i);
  if (m?.[1] && !parseScheduleFireAt(m[1]).fireAt) {
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: [
        `When should I follow up? (for example: "tomorrow at 10am")`,
      ],
      probe: `follow up with ${m[1].replace(/^to\s+/i, "").trim()} {answer}`,
      createdAt: now,
    };
  }

  m = trimmed.match(/^(?:block|schedule|book)\s+(.+)$/i);
  if (m?.[1] && !parseScheduleRange(m[1])) {
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: [
        `When should I schedule this, and what should I call it? (for example: "tomorrow 2pm to 3pm for a stock count")`,
      ],
      probe: `block {answer}`,
      createdAt: now,
    };
  }

  const customer = trimmed.match(
    /^(?:create|add|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer|client)\b/i,
  );
  if (customer) {
    const cityTrail = trimmed.match(/\bin\s+([A-Za-z][A-Za-z\s-]+)$/i);
    const city = cityTrail?.[1]?.trim();
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: ["What is the customer's name? (for example: Acme Ltd)"],
      probe: `create customer {answer}` + (city ? ` in ${city}` : ""),
      createdAt: now,
    };
  }

  const vendor = trimmed.match(
    /^(?:create|add|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?vendor\b/i,
  );
  if (vendor) {
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: ["What is the vendor's name?"],
      probe: `create vendor {answer}`,
      createdAt: now,
    };
  }

  const invoice = trimmed.match(
    /^(?:create|add|make|raise|generate|issue)\s+(?:an\s+|a\s+)?(?:invoice|bill)\b/i,
  );
  if (invoice) {
    const amountTrail = trimmed.match(/\bfor\s+([\d.]+)(?:\s+([A-Z]{3}))?$/i);
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: ["What invoice number should I use? (for example: INV-101)"],
      probe:
        `create invoice {answer}` +
        (amountTrail ? ` for ${amountTrail[1]}${amountTrail[2] ? ` ${amountTrail[2]}` : ""}` : ""),
      createdAt: now,
    };
  }

  const product = trimmed.match(
    /^(?:create|add|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?product\b/i,
  );
  if (product) {
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: [
        "What product SKU and name should I register? (for example: SKU-9 Wireless Mouse)",
      ],
      probe: `create product {answer}`,
      createdAt: now,
    };
  }

  const employee = trimmed.match(
    /^(?:create|add|hire|register|set up)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?employee\b/i,
  );
  if (employee) {
    return {
      id: crypto.randomUUID(),
      type: "clarification",
      questions: [
        "What employee number and full name should I use? (for example: E-101 Grace Hopper)",
      ],
      probe: `create employee {answer}`,
      createdAt: now,
    };
  }

  return null;
}

/**
 * Deterministic multi-domain intent parser (always available; LLM is optional assist).
 * Returns the first matched action for back-compat with single-intent callers.
 */
export function planFromText(text: string): PlannedAction | null {
  const many = planManyFromText(text);
  return many[0] ?? null;
}

/** Parse one or more sequential intents from a compound natural-language request. */
export function planManyFromText(text: string): PlannedAction[] {
  const segments = splitCompoundRequest(text);
  const plans: PlannedAction[] = [];
  for (const segment of segments) {
    const plan = planSingleSegment(segment);
    if (plan) plans.push(plan);
  }
  // Fall back: try whole string if compound split produced nothing useful
  if (plans.length === 0) {
    const single = planSingleSegment(text.trim());
    if (single) plans.push(single);
  }
  return wireSequentialPlanInputs(plans);
}

/**
 * When multi-step plans omit cross-step links (e.g. invoice without customerId),
 * inject `${stepN.field}` templates so execution can resolve prior outputs.
 */
export function wireSequentialPlanInputs(plans: PlannedAction[]): PlannedAction[] {
  if (plans.length < 2) return plans;
  return plans.map((plan, index) => {
    if (index === 0) return plan;
    const input = { ...plan.input };
    const prior = plans.slice(0, index);

    if (
      (plan.command === "acc.invoice.create" || plan.command.startsWith("acc.invoice.")) &&
      input.customerId == null
    ) {
      const custIdx = prior.findIndex((p) => p.command === "crm.customer.create");
      if (custIdx >= 0) input.customerId = `\${step${custIdx + 1}.id}`;
    }

    if (
      (plan.command === "inv.stock.adjust" || plan.command.startsWith("inv.stock.")) &&
      input.productId == null
    ) {
      const prodIdx = prior.findIndex((p) => p.command === "inv.product.create");
      if (prodIdx >= 0) input.productId = `\${step${prodIdx + 1}.id}`;
    }

    if (
      (plan.command === "pur.po.create" || plan.command.startsWith("pur.po.")) &&
      input.vendorId == null
    ) {
      const vendIdx = prior.findIndex((p) => p.command === "pur.vendor.create");
      if (vendIdx >= 0) input.vendorId = `\${step${vendIdx + 1}.id}`;
    }

    return { ...plan, input };
  });
}

/**
 * Resolve step input against prior step outputs + auto-fill common foreign keys.
 */
export function resolvePlanStepInput(
  command: string,
  rawInput: unknown,
  stepOutputs: { command: string; data: Record<string, unknown> }[],
  stepIndex: number,
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  stepOutputs.forEach((s, i) => {
    context[`step${i + 1}`] = s.data;
    context[s.command] = s.data;
  });

  const base =
    typeof rawInput === "object" && rawInput !== null
      ? normalizeFieldNames({ ...(rawInput as Record<string, unknown>) })
      : {};
  const resolved = resolveInput(base, context) as Record<string, unknown>;

  // Auto-wire when templates were not present
  if (
    (command === "acc.invoice.create" || command.startsWith("acc.invoice.")) &&
    (resolved.customerId == null || resolved.customerId === "")
  ) {
    const cust = [...stepOutputs].reverse().find((s) => s.command === "crm.customer.create");
    if (cust?.data.id != null) resolved.customerId = cust.data.id;
  }
  if (
    (command === "inv.stock.adjust" || command.startsWith("inv.stock.")) &&
    (resolved.productId == null || resolved.productId === "")
  ) {
    const prod = [...stepOutputs].reverse().find((s) => s.command === "inv.product.create");
    if (prod?.data.id != null) resolved.productId = prod.data.id;
  }
  if (
    (command === "pur.po.create" || command.startsWith("pur.po.")) &&
    (resolved.vendorId == null || resolved.vendorId === "")
  ) {
    const vend = [...stepOutputs].reverse().find((s) => s.command === "pur.vendor.create");
    if (vend?.data.id != null) resolved.vendorId = vend.data.id;
  }

  void stepIndex;
  return resolved;
}

async function executePlanSteps(
  deps: OrchestratorDeps,
  steps: PendingPlanStep[],
  aiCtx: RequestContext,
): Promise<{ command: string; data: Record<string, unknown> }[]> {
  const stepOutputs: { command: string; data: Record<string, unknown> }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const input = resolvePlanStepInput(step.command, step.input, stepOutputs, i);
    const result = await executeCommand(deps.commands, step.command, input, aiCtx, deps.helpers);
    stepOutputs.push({
      command: step.command,
      data: result.data as Record<string, unknown>,
    });
  }
  return stepOutputs;
}

// ---------------------------------------------------------------------------
// Agent tool layer (R5 self-wake tools + R7 skill catalog tools)
//
// The provider interface is text-only, so agent tools are surfaced the
// OpenWorker way: a live per-turn catalog in the prompt, and the model may
// return `{"toolCall":{"name":"loadSkill","args":{...}}}` as part of its JSON.
// The orchestrator executes the tool, appends the result into the outbound
// view, and re-invokes the model — a bounded loop. Tool execution is safe by
// construction: skills only READ instructions into context; saveSkill parks a
// disabled draft behind an Inbox approval; refineSkill and revertSkillRefinement
// park an evidence-backed minimal patch / reversal behind an Inbox approval with
// NO state change until resolved; self-wake only creates durable wake records
// (no immediate side effect on real state).
// ---------------------------------------------------------------------------

interface AgentToolCall {
  name: string;
  args?: Record<string, unknown>;
}

interface AgentToolResult {
  message: string;
  inboxItemId?: string;
}

const AGENT_TOOL_MAX_ITERATIONS = 3;

function agentToolList(deps: OrchestratorDeps): string {
  const tools: string[] = [];
if (deps.skills) {
    tools.push(
      "loadSkill(name)",
      "saveSkill({name,title,summary,instructions,files?})",
      "refineSkill({name,summary?,instructions?,trigger,note?})",
      "revertSkillRefinement({name,refinementId,note?})",
    );
  }
  if (deps.wake) {
    tools.push(
      "sleepFor(seconds,note?)",
      "sleepUntil(isoTimestamp,note?)",
      "wakeOnJob(jobId,note?)",
      "wakeOnEvent(eventKey,note?)",
    );
  }
  if (deps.memory) {
    tools.push("memory.search(query,limit?)", "memory.store({content,kind?,key?})");
  }
  return tools.join(", ");
}

async function executeAgentTool(
  deps: OrchestratorDeps,
  session: ChatSessionState,
  ctx: { organizationId: string; userId: string; branchId?: string },
  call: AgentToolCall,
): Promise<AgentToolResult> {
  const name = call.name;
  const args = call.args ?? {};

  switch (name) {
    case "loadSkill": {
      if (!deps.skills) return { message: "Skill catalog not available on this instance." };
      const filter = { organizationId: ctx.organizationId, branchId: ctx.branchId };
      const skill = await deps.skills.get(String(args.name ?? ""), filter);
      if (!skill || !skill.enabled) {
        return { message: `Skill "${args.name}" is not available (unknown or disabled).` };
      }
      session.loadedSkillNames = [...new Set([...(session.loadedSkillNames ?? []), skill.name])];
      const files = (skill.files ?? [])
        .map((f) => `\n  [file] ${f.path}\n${f.excerpt}`)
        .join("");
      return { message: `Loaded skill "${skill.name}" (${skill.title}):\n${skill.instructions}${files}` };
    }

    case "saveSkill": {
      if (!deps.skills) return { message: "Skill store not available on this instance." };
      const tools = skillTools(deps.skills, {
        organizationId: ctx.organizationId,
        branchId: ctx.branchId,
      });
      const res = await tools.saveSkill({
        name: String(args.name ?? ""),
        title: String(args.title ?? args.name ?? ""),
        summary: String(args.summary ?? ""),
        instructions: String(args.instructions ?? ""),
        files: Array.isArray(args.files) ? (args.files as SkillFile[]) : undefined,
      });
      // Review-before-save rule: the draft is disabled until a human approves
      // through the Inbox card (no self-grant path).
      let inboxItemId: string | undefined;
      if (deps.inbox) {
        const item = await deps.inbox.addApproval({
          sessionId: session.id,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          title: `Save skill "${res.skill.name}"?`,
          body: res.skill.summary,
          data: { skillSave: res.skill.name },
        });
        inboxItemId = item.id;
      }
      return {
        message:
          `Skill "${res.skill.name}" drafted and awaiting human approval` +
          (inboxItemId ? ` (inbox item ${inboxItemId})` : "") +
          `. It is NOT active until approved.`,
        inboxItemId,
      };
    }

    case "refineSkill": {
      if (!deps.skills) return { message: "Skill store not available on this instance." };
      const tools = skillTools(deps.skills, {
        organizationId: ctx.organizationId,
        branchId: ctx.branchId,
      });
      const res = await tools.refineSkill({
        name: String(args.name ?? ""),
        summary: args.summary != null ? String(args.summary) : undefined,
        instructions: args.instructions != null ? String(args.instructions) : undefined,
        trigger: String(args.trigger ?? ""),
        note: args.note != null ? String(args.note) : undefined,
      });
      if (!res.ok) return { message: `Cannot refine skill: ${res.reason}` };
      // Continual-Harness rule: the *smallest* evidence-backed edit parks behind
      // the approval card. Unlike saveSkill we do NOT write even a disabled
      // draft — refining a live skill must leave state untouched until a human
      // resolves, so the proposal lives only in the Inbox `data` blob.
      let inboxItemId: string | undefined;
      if (deps.inbox) {
        const changed = Object.keys(res.refinement.after).join(" + ");
        const item = await deps.inbox.addApproval({
          sessionId: session.id,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          title: `Refine skill "${res.skill.name}" (${changed})?`,
          body: `Evidence/trigger: ${res.refinement.trigger}`,
          data: {
            skillRefine: {
              name: res.skill.name,
              before: res.refinement.before,
              after: res.refinement.after,
              trigger: res.refinement.trigger,
              note: res.refinement.note,
            },
          },
        });
        inboxItemId = item.id;
      }
      return {
        message:
          `Refinement for skill "${res.skill.name}" drafted and awaiting human approval` +
          (inboxItemId ? ` (inbox item ${inboxItemId})` : "") +
          `. No change is applied until approved.`,
        inboxItemId,
      };
    }

    case "revertSkillRefinement": {
      if (!deps.skills) return { message: "Skill store not available on this instance." };
      const tools = skillTools(deps.skills, {
        organizationId: ctx.organizationId,
        branchId: ctx.branchId,
      });
      const res = await tools.revertSkillRefinement({
        name: String(args.name ?? ""),
        refinementId: String(args.refinementId ?? ""),
        note: args.note != null ? String(args.note) : undefined,
      });
      if (!res.ok) return { message: `Cannot revert skill refinement: ${res.reason}` };
      // Same Continual-Harness contract as refineSkill: the reversal parks in
      // the Inbox `data` blob; nothing mutates until a human approves.
      let inboxItemId: string | undefined;
      if (deps.inbox) {
        const item = await deps.inbox.addApproval({
          sessionId: session.id,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          title: `Revert refinement of skill "${res.skill.name}"?`,
          body: `Reverts refinement "${res.refinement.reversalRefinementId}".\nEvidence/trigger: ${res.refinement.trigger}`,
          data: {
            skillRevert: {
              name: res.skill.name,
              before: res.refinement.before,
              after: res.refinement.after,
              trigger: res.refinement.trigger,
              reversalRefinementId: res.refinement.reversalRefinementId,
              note: res.refinement.note,
            },
          },
        });
        inboxItemId = item.id;
      }
      return {
        message:
          `Revert for skill "${res.skill.name}" drafted and awaiting human approval` +
          (inboxItemId ? ` (inbox item ${inboxItemId})` : "") +
          `. No change is applied until approved.`,
        inboxItemId,
      };
    }

    case "sleepFor":
    case "sleepUntil":
    case "wakeOnJob":
    case "wakeOnEvent": {
      if (!deps.wake) return { message: "Self-wake store not available on this instance." };
      const tools = selfWakeTools(deps.wake, session.id);
      switch (name) {
        case "sleepFor": {
          const r = await tools.sleepFor(Number(args.seconds ?? 0), args.note as string | undefined);
          return { message: `Sleeping ${args.seconds}s; wake ${r.wakeId} fires ${r.fireAt}.` };
        }
        case "sleepUntil": {
          const r = await tools.sleepUntil(
            String(args.isoTimestamp ?? args.when ?? ""),
            args.note as string | undefined,
          );
          return { message: `Wake ${r.wakeId} scheduled for ${r.fireAt}.` };
        }
        case "wakeOnJob": {
          const r = await tools.wakeOnJob(String(args.jobId ?? ""), args.note as string | undefined);
          return { message: `Will resume when job ${r.jobId} completes (wake ${r.wakeId}).` };
        }
        default: {
          const r = await tools.wakeOnEvent(
            String(args.eventKey ?? ""),
            args.note as string | undefined,
          );
          return { message: `Will resume when event "${r.eventKey}" fires (wake ${r.wakeId}).` };
        }
      }
    }

    case "memory.search": {
      if (!deps.memory) return { message: "Memory store not available on this instance." };
      const q = String(args.query ?? "");
      if (!q.trim()) return { message: "memory.search requires a query." };
      const limit = Number(args.limit ?? 5);
      const results = await deps.memory.search(ctx.organizationId, q, Number.isFinite(limit) ? limit : 5);
      if (results.length === 0) return { message: "No matching learned context found." };
      return { message: results.map((r) => `[${r.kind}] ${r.content}`).join("\n") };
    }

    case "memory.store": {
      if (!deps.memory) return { message: "Memory store not available on this instance." };
      const content = String(args.content ?? "");
      if (!content.trim()) return { message: "memory.store requires content." };
      const valid = new Set<MemoryKind>([
        "short_term_chat",
        "workflow_session",
        "long_term_org",
        "permanent_business_pointer",
      ]);
      const kind = valid.has(args.kind as MemoryKind) ? (args.kind as MemoryKind) : "long_term_org";
      await deps.memory.write({
        organizationId: ctx.organizationId,
        kind,
        key: args.key ? String(args.key) : undefined,
        content: content.trim(),
        userId: ctx.userId,
        sessionId: session.id,
      });
      return { message: `Stored memory (${kind}): ${content.trim().slice(0, 120)}` };
    }

    default:
      return { message: `Unknown agent tool "${name}".` };
  }
}

/**
 * Bounded model tool loop. Returns the final parsed JSON when the model stops
 * calling tools, or `null` when it never produced parseable JSON. Mutates the
 * session's `loadedSkillNames`. Tracked inbox items (skill-save approvals) are
 * surfaced through the returned `inboxItemId`.
 */
async function runAgentToolLoop(
  deps: OrchestratorDeps,
  session: ChatSessionState,
  ctx: { organizationId: string; userId: string; branchId?: string },
  system: string,
  messages: ChatMessage[],
): Promise<{ parsed: ParsedLlmResponse | null; inboxItemId?: string }> {
  if (!deps.provider || deps.provider.id === "none") return { parsed: null };
  let current = messages;
  let inboxItemId: string | undefined;

  for (let iteration = 0; iteration < AGENT_TOOL_MAX_ITERATIONS; iteration++) {
    const completion = await deps.provider.complete({ system, messages: current });
    const jsonMatch = completion.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { parsed: null };
    let parsed: ParsedLlmResponse;
    try {
      parsed = JSON.parse(jsonMatch[0]) as ParsedLlmResponse;
    } catch {
      return { parsed: null };
    }

    const call = parsed.toolCall;
    if (!call || typeof call.name !== "string") {
      return { parsed, inboxItemId };
    }

    const result = await executeAgentTool(deps, session, ctx, call);
    if (result.inboxItemId) inboxItemId = result.inboxItemId;

    current = [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: `Invoking agent tool \`${call.name}\`.` }],
        createdAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: `Tool result: ${result.message}` }],
        createdAt: new Date().toISOString(),
      },
    ];
  }
  return { parsed: null, inboxItemId };
}

interface ParsedLlmResponse {
  command?: string;
  input?: Record<string, unknown>;
  query?: string;
  clarify?: string[];
  plan?: { command: string; input?: Record<string, unknown>; description?: string }[];
  toolCall?: AgentToolCall;
}

/** Render the result of one or more read queries as an assistant answer. */
function queryResultParts(
  rows: { label: string; value: string }[],
  text: string,
  explanation: AiExplanation,
): UiPart[] {
  const parts: UiPart[] = [{ type: "text", text }];
  if (rows.length > 0) {
    parts.push({
      type: "table",
      columns: [
        { key: "label", label: "Item" },
        { key: "value", label: "Details" },
      ],
      rows,
    });
  }
  parts.push(toExplanationPart(explanation));
  return parts;
}

/** Flatten a query result object into display rows for a generic answer. */
function rowsFromQueryData(data: Record<string, unknown>): { label: string; value: string }[] {
  const arrs = Object.entries(data).filter(
    ([, v]) => Array.isArray(v) && (v as unknown[]).length > 0,
  );
  if (arrs.length === 0) {
    const scalar = Object.entries(data)
      .filter(([, v]) => v != null && typeof v !== "object")
      .map(([k, v]) => `${k}: ${String(v)}`);
    return scalar.length ? [{ label: "Result", value: scalar.join(", ") }] : [];
  }
  return arrs.flatMap(([key, items]) =>
    (items as Record<string, unknown>[]).map((item) => {
      const detail = Object.entries(item)
        .filter(([, v]) => v != null && v !== "" && typeof v !== "object")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ");
      return { label: key.replace(/_/g, " "), value: detail || "(empty)" };
    }),
  );
}

export async function handleChatTurn(
  deps: OrchestratorDeps,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  let session = {
    ...input.session,
    messages: [...input.session.messages],
  };
  // Surfaced to the caller when an agent tool (e.g. skill-save / skill-refine)
  // parked a human approval behind an Inbox card during this turn.
  let pendingInboxItemId: string | undefined;
  if (input.cancelId && session.pending?.id === input.cancelId) {
    const cancelled = session.pending;
    session.pending = undefined;
    if (deps.inbox && cancelled) {
      // Match the inbox item by `toolCallId` (what mirrorToInbox mints), not by
      // `id` — the item's id is a fresh UUID, while `toolCallId` carries the
      // in-chat pending confirmation id. Searching by `id` never matches and
      // leaves a dangling "pending" approval on cancel.
      const existing = (await deps.inbox.list({ sessionId: session.id })).find(
        (i) => i.toolCallId === cancelled.id,
      );
      if (existing) await deps.inbox.resolve(existing.id, "deny");
    }
    session.messages = resolveConfirmParts(session.messages, {
      id: cancelled.id,
      status: "cancelled",
    });
    session.messages.push(
      msg("assistant", [{ type: "text", text: "Cancelled. No changes were made." }]),
    );
    return { session };
  }

  if (
    input.userText &&
    shouldCheckInjection(deps.autonomy) &&
    looksLikePromptInjection(input.userText)
  ) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: "That message was blocked by a safety check. Please rephrase your business request.",
          code: "PROMPT_INJECTION",
        },
      ]),
    );
    return { session };
  }

  /**
 * Audit a skill-catalog mutation applied after human approval. Skill writes are
 * not (yet) kernel commands, so the Inbox resolution + this audit entry are the
 * explainability record (action/actor/evidence). `success:false` is reserved
 * for "approved but not applied" (e.g. the skill vanished mid-review).
 */
async function writeSkillAudit(
  deps: OrchestratorDeps,
  ctx: { requestId: string; actor: { userId: string; organizationId: string; aiRunId?: string } },
  action: string,
  resourceId: string,
  success: boolean,
  inputSummary: Record<string, unknown>,
  errorCode?: string,
): Promise<void> {
  await deps.helpers.audit.write({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    organizationId: ctx.actor.organizationId,
    actorUserId: ctx.actor.userId,
    actorKind: "ai_assisted",
    aiRunId: ctx.actor.aiRunId ?? crypto.randomUUID(),
    action,
    resourceType: "ai_skill",
    resourceId,
    success,
    requestId: ctx.requestId,
    inputSummary,
    errorCode,
  });
}

// R7 — skill-save approvals resolve through the same Inbox card as any other
  // approval. The draft was created disabled; an allow/always enables it, deny
  // leaves it disabled. No self-grant path exists.
  if (input.confirmId && deps.inbox && deps.skills) {
    const skillItem = (await deps.inbox.list({ sessionId: session.id, state: "pending" })).find(
      (i) => i.kind === "approval" && i.data?.skillSave != null && i.id === input.confirmId,
    );
    if (skillItem) {
      const skillName = String(skillItem.data?.skillSave);
      const resolution = input.inboxResolution ?? "allow";
      await deps.inbox.resolve(skillItem.id, resolution);
      if (resolution === "allow" || resolution === "always") {
        await deps.skills.setEnabled(
          skillName,
          { organizationId: skillItem.organizationId, branchId: session.activeBranchId },
          true,
        );
        session.messages.push(
          msg("assistant", [
            {
              type: "text",
              text: `Skill "${skillName}" was reviewed and enabled. It is now loadable by the assistant in this org.`,
            },
          ]),
        );
      } else {
        session.messages.push(
          msg("assistant", [
            { type: "text", text: `Skill "${skillName}" was rejected; it remains disabled.` },
          ]),
        );
      }
      return { session };
    }
  }

  // R7 — Continual-Harness skill-refine approvals. The proposal (minimal,
  // evidence-backed edit) was parked in the Inbox `data` blob with NO state
  // change. On allow/always we re-read the current skill and apply only the
  // proposed fields, recording the before/after snapshot + trigger as a
  // refinement entry (revertible by ID). Deny leaves the skill untouched.
  if (input.confirmId && deps.inbox && deps.skills) {
    const refineItem = (await deps.inbox.list({ sessionId: session.id, state: "pending" })).find(
      (i) => i.kind === "approval" && i.data?.skillRefine != null && i.id === input.confirmId,
    );
    if (refineItem) {
      const proposal = refineItem.data?.skillRefine as {
        name: string;
        before: { summary?: string; instructions?: string };
        after: { summary?: string; instructions?: string };
        trigger: string;
        note?: string;
      };
      const resolution = input.inboxResolution ?? "allow";
      await deps.inbox.resolve(refineItem.id, resolution);
      if (resolution === "allow" || resolution === "always") {
        const filter = { organizationId: refineItem.organizationId, branchId: session.activeBranchId };
        const current = await deps.skills.get(proposal.name, filter);
        const refinement: SkillRefinement = {
          id: crypto.randomUUID(),
          trigger: proposal.trigger,
          note: proposal.note,
          before: proposal.before,
          after: proposal.after,
          createdAt: new Date().toISOString(),
        };
        if (current) {
          const merged: Omit<SkillRecord, "createdAt" | "updatedAt"> = {
            ...current,
            summary: proposal.after.summary ?? current.summary,
            instructions: proposal.after.instructions ?? current.instructions,
            refinements: [...(current.refinements ?? []), refinement],
          };
          await deps.skills.upsert(merged);
          await writeSkillAudit(
            deps,
            {
              requestId: input.ctx.requestId,
              actor: {
                ...input.ctx.actor,
                userId: refineItem.userId,
                organizationId: refineItem.organizationId,
              },
            },
            "ai_skill.refine",
            proposal.name,
            true,
            {
              refinementId: refinement.id,
              trigger: proposal.trigger,
              before: proposal.before,
              after: proposal.after,
            },
          );
        } else {
          await writeSkillAudit(
            deps,
            {
              requestId: input.ctx.requestId,
              actor: {
                ...input.ctx.actor,
                userId: refineItem.userId,
                organizationId: refineItem.organizationId,
              },
            },
            "ai_skill.refine",
            proposal.name,
            false,
            { trigger: proposal.trigger },
            "skill_not_found",
          );
        }
        session.messages.push(
          msg("assistant", [
            {
              type: "text",
              text: current
                ? `Skill "${proposal.name}" was refined and is now active (refinement ${refinement.id}).`
                : `Refinement for "${proposal.name}" could not be applied (skill no longer exists).`,
            },
          ]),
        );
      } else {
        session.messages.push(
          msg("assistant", [
            {
              type: "text",
              text: `Skill refinement for "${proposal.name}" was rejected; no change was applied.`,
            },
          ]),
        );
      }
      return { session };
    }
  }

  // R7 — Continual-Harness skill-revert approvals. Mirrors refine: the reversal
  // parks in the Inbox and applies only on allow/always, appending a chained
  // refinement entry (`reversalRefinementId` → the entry being undone). The
  // revert itself is reversible, so double-reverting yields the forwarded state.
  if (input.confirmId && deps.inbox && deps.skills) {
    const revertItem = (await deps.inbox.list({ sessionId: session.id, state: "pending" })).find(
      (i) => i.kind === "approval" && i.data?.skillRevert != null && i.id === input.confirmId,
    );
    if (revertItem) {
      const proposal = revertItem.data?.skillRevert as {
        name: string;
        before: { summary?: string; instructions?: string };
        after: { summary?: string; instructions?: string };
        trigger: string;
        reversalRefinementId?: string;
        note?: string;
      };
      const resolution = input.inboxResolution ?? "allow";
      await deps.inbox.resolve(revertItem.id, resolution);
      if (resolution === "allow" || resolution === "always") {
        const filter = { organizationId: revertItem.organizationId, branchId: session.activeBranchId };
        const current = await deps.skills.get(proposal.name, filter);
        const reversal: SkillRefinement = {
          id: crypto.randomUUID(),
          trigger: proposal.trigger,
          note: proposal.note,
          before: proposal.before,
          after: proposal.after,
          reversalRefinementId: proposal.reversalRefinementId,
          createdAt: new Date().toISOString(),
        };
        if (current) {
          const merged: Omit<SkillRecord, "createdAt" | "updatedAt"> = {
            ...current,
            summary: proposal.after.summary ?? current.summary,
            instructions: proposal.after.instructions ?? current.instructions,
            refinements: [...(current.refinements ?? []), reversal],
          };
          await deps.skills.upsert(merged);
          await writeSkillAudit(
            deps,
            {
              requestId: input.ctx.requestId,
              actor: {
                ...input.ctx.actor,
                userId: revertItem.userId,
                organizationId: revertItem.organizationId,
              },
            },
            "ai_skill.revert",
            proposal.name,
            true,
            {
              reversalId: reversal.id,
              reverts: proposal.reversalRefinementId,
              before: proposal.before,
              after: proposal.after,
            },
          );
        } else {
          await writeSkillAudit(
            deps,
            {
              requestId: input.ctx.requestId,
              actor: {
                ...input.ctx.actor,
                userId: revertItem.userId,
                organizationId: revertItem.organizationId,
              },
            },
            "ai_skill.revert",
            proposal.name,
            false,
            { reverts: proposal.reversalRefinementId },
            "skill_not_found",
          );
        }
        session.messages.push(
          msg("assistant", [
            {
              type: "text",
              text: current
                ? `Refinement of skill "${proposal.name}" was reverted (reversal ${reversal.id}).`
                : `Revert of "${proposal.name}" could not be applied (skill no longer exists).`,
            },
          ]),
        );
      } else {
        session.messages.push(
          msg("assistant", [
            {
              type: "text",
              text: `Skill revert for "${proposal.name}" was rejected; no change was applied.`,
            },
          ]),
        );
      }
      return { session };
    }
  }

  if (input.confirmId && session.pending && session.pending.type !== "clarification" && session.pending.id === input.confirmId) {
    const pending = session.pending;
    const aiCtx: RequestContext = {
      ...input.ctx,
      actor: {
        ...input.ctx.actor,
        kind: "ai_assisted",
        aiRunId: input.ctx.actor.aiRunId ?? crypto.randomUUID(),
      },
    };

    // R2/R3: when an inbox is wired, resolve the canonical inbox item first so
    // the once-only state-machine fires even when the client retried an
    // approval from another surface (mobile, Slack). When `inboxResolution` is
    // supplied (e.g. the user pressed "allow always"), it minted a standing
    // rule + is forwarded into `resolve`. Otherwise resolve with "allow".
    if (deps.inbox) {
      // R2/R3 once-only: match the canonical inbox item by `toolCallId`. The
      // item's `id` is a fresh UUID minted by addApproval; `toolCallId` carries
      // the in-chat `pending.id` that mirrorToInbox stored, so a retry/confirm
      // from any surface finds and resolves the SAME canonical record.
      const item = (await deps.inbox.list({ sessionId: session.id })).find(
        (i) => i.toolCallId === pending.id,
      );
      if (item) {
        const resolution = input.inboxResolution ?? "allow";
        if (!(await deps.inbox.resolve(item.id, resolution))) {
          // already resolved by another surface — treat as already-executed
          session.pending = undefined;
          session.messages = resolveConfirmParts(session.messages, {
            id: pending.id,
            status: "confirmed",
          });
          session.messages.push(
            msg("assistant", [
              { type: "text", text: "This request was already actioned from another surface." },
            ]),
          );
          return { session };
        }
      }
    }

    const stepsToRun: PendingPlanStep[] =
      pending.plan && pending.plan.length > 0
        ? pending.plan
        : [{ command: pending.command, input: pending.input, description: pending.command }];

    const stepOutputs = await executePlanSteps(deps, stepsToRun, aiCtx);
    // Adaptive learning — record what was executed so later turns can recall it.
    for (let i = 0; i < stepOutputs.length; i++) {
      const step = stepOutputs[i]!;
      await rememberExecution(
        deps,
        { organizationId: input.ctx.actor.organizationId, userId: input.ctx.actor.userId, sessionId: session.id },
        { command: step.command, input: stepsToRun[i]?.input ?? step.data },
      );
    }

    session.pending = undefined;
    session.messages = resolveConfirmParts(session.messages, {
      id: pending.id,
      status: "confirmed",
    });

    const last = stepOutputs[stepOutputs.length - 1]!;
    const explanation: AiExplanation = {
      runId: aiCtx.actor.aiRunId!,
      summary:
        stepOutputs.length > 1
          ? `Executed ${stepOutputs.length}-step plan after user confirmation.`
          : `Executed ${pending.command} after user confirmation.`,
      reasons: ["User confirmed the prepared action", "Same command path as manual UI"],
      rulesApplied: ["ai_manual_parity", "permission_check", "zod_validation", "autonomy:confirm"],
      dataUsed: ["user confirmation", "prepared command input"],
      autonomy: "confirm",
      plannedCommand: pending.command,
      plannedInput: pending.input,
    };

    const parts: UiPart[] = [
      {
        type: "text",
        text:
          stepOutputs.length > 1
            ? `Done. Executed ${stepOutputs.length} steps: ${stepOutputs.map((s) => `\`${s.command}\``).join(", ")}.`
            : `Done. Executed \`${pending.command}\`.`,
      },
      toExplanationPart(explanation),
    ];

    if (stepOutputs.length > 1) {
      parts.push({
        type: "table",
        columns: [
          { key: "step", label: "Step" },
          { key: "command", label: "Command" },
          { key: "result", label: "Result" },
        ],
        rows: stepOutputs.map((s, i) => ({
          step: String(i + 1),
          command: s.command,
          result: JSON.stringify(s.data).slice(0, 120),
        })),
      });
    } else {
      parts.push({
        type: "table",
        columns: [
          { key: "field", label: "Field" },
          { key: "value", label: "Value" },
        ],
        rows: Object.entries(last.data).map(([field, value]) => ({
          field,
          value: String(value ?? ""),
        })),
      });
    }

    session.messages.push(msg("assistant", parts));

    // Generate proactive follow-up suggestions for the last command
    try {
      const { suggestions } = await generateSuggestions(last.command, last.data, deps.provider);
      if (suggestions.length > 0) {
        session.messages.push(msg("assistant", [{ type: "suggestions", suggestions }]));
      }
    } catch {
      // suggestions are optional — don't fail on errors
    }

    return { session, explanation };
  }

  if (!input.userText?.trim()) {
    session.messages.push(
      msg("assistant", [{ type: "text", text: "Send a message or confirm a pending action." }]),
    );
    return { session };
  }

  // §2e — natural clarification answer: the previous turn parked a
  // clarification (missing required info). The user's answer is merged through
  // the stored probe so intent resolution re-runs with the full picture, and
  // the recap is injected for the LLM assist path.
  let ruleText = input.userText;
  let clarifyContext: { questions: string[]; answer: string } | undefined;
  if (session.pending && session.pending.type === "clarification") {
    const prior = session.pending;
    const answer = input.userText.trim();
    ruleText = prior.probe.replace("{answer}", answer);
    clarifyContext = { questions: prior.questions, answer };
    session.pending = undefined;
  }

  session.messages.push(msg("user", [{ type: "text", text: input.userText }]));

  const catalog = deps.commands.list();
  const rulePlans = planManyFromText(ruleText);
  let planned: PlannedAction | null = rulePlans.length === 1 ? rulePlans[0]! : null;
  let multiPlan: PlannedAction[] | null = rulePlans.length > 1 ? rulePlans : null;

  // Read-query intent (R11) — schedule/task questions are answered directly
  // from org data through the same read-query bus a human uses. Runs before
  // the LLM and before the write gates: reads are side-effect free, need no
  // confirmation, and the "nothing scheduled" case gets a clear statement.
  const schedulePlan = planScheduleQuestion(ruleText);
  if (schedulePlan) {
    const { parts, explanation } = await answerScheduleQuestion(deps, input.ctx, schedulePlan);
    session.messages.push(msg("assistant", [...parts, toExplanationPart(explanation)]));
    return { session, explanation };
  }

  // R9 — read-only mode gate. In discuss/plan mode the orchestrator can still
  // plan and propose but cannot execute writes/exec. This check fires BEFORE
  // the LLM assist: rules that detected a write action emit a "describe in chat"
  // response instead. Plan mode shows the plan card; discuss mode describes.
  if (deps.mode && isReadOnly(deps.mode) && (planned || multiPlan)) {
    const proposing = multiPlan ?? (planned ? [planned] : []);
    const planSteps = proposing.map((p) => ({
      command: p.command,
      description: p.summary,
      input: p.input,
    }));
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text:
            deps.mode === "discuss"
              ? "Discuss mode is active, so I can't run this — describe it instead. Switch to plan or interactive mode to act."
              : "Plan mode is active. Here's the plan I'd execute once you approve it.",
        },
        {
          type: "plan",
          id: crypto.randomUUID(),
          title: "Proposed plan",
          steps: planSteps,
        },
      ]),
    );
    return { session };
  }

  // R6 — outbound-history compaction. When the model's context budget is
  // exceeded, replace the older portion of the OUTBOUND view with a
  // structured summary + mechanical state. The persisted transcript
  // (`session.messages`) is never modified; we only pass a transformed copy to
  // the provider. The state is (re)built here when the trigger fires.
  session = await ensureCompactionState(deps, session);
  let outboundMessages = session.messages;
  if (deps.compaction) {
    outboundMessages = applyToOutbound(session.messages, session.compactionState ?? null);
  }
  // R9 + R7 — per-turn ephemeral context: read-only mode paragraph and the
  // skill catalog / disable-countermand are appended to the outbound view every
  // turn (both can change mid-session, so they never live in the static prompt).
  outboundMessages = withModeContext(outboundMessages, deps.mode);
  outboundMessages = withBranchContext(outboundMessages, deps.activeBranch);
  outboundMessages = await withSkillContext(outboundMessages, deps, session, input.ctx.actor.organizationId);
  outboundMessages = await withMemoryContext(outboundMessages, deps, input.ctx.actor.organizationId);
  if (clarifyContext) {
    outboundMessages = withClarifyAnswerContext(outboundMessages, clarifyContext);
  }

  // Optional LLM assist when rules miss (provider may be none). Runs a bounded
  // agent-tool loop (R5 self-wake / R7 skills) and retries once after a
  // context-overflow error with a no-LLM trim.
  let llmQuery: { name: string; input: Record<string, unknown> } | undefined;
  if (!planned && !multiPlan && deps.provider && deps.provider.id !== "none") {
    const agentTools = agentToolList(deps);
    const queryCatalog = deps.queries ? deps.queries.list() : [];
    const system =
      `You are a business assistant. WRITE actions: {"command":"<name>","input":{...}} using only: ${catalog.map((c) => c.name).join(", ")}.\n` +
      `READ questions (answering from data): {"query":"<name>","input":{...}} using only: ${queryCatalog.map((q) => q.name).join(", ")}.\n` +
      `For multiple sequential write actions: {"plan":[{"command":"...","input":{...},"description":"..."},{"command":"...","input":{...}}]}\n` +
      `If ambiguous or missing required info: {"clarify":["question1","question2"]}\n` +
      `Do not copy field values from the [Learned context] block into a new plan; if a required field is absent from the request, reply {"clarify":[...]} instead.\n` +
      (agentTools
        ? `Before planning, you may call an agent tool to pull in context or schedule follow-ups.\nAvailable agent tools: ${agentTools}.\nTo call one, reply {"toolCall":{"name":"loadSkill","args":{"name":"..."}}} — you will receive the result and should then continue planning.\n`
        : "") +
      `Reply JSON only. Never invent field values — use null for unknown required fields. For a read question with no explicit date, default to today's range.`;

    let parsed: ParsedLlmResponse | null = null;
    try {
      ({ parsed, inboxItemId: pendingInboxItemId } = await runAgentToolLoop(
        deps,
        session,
        { organizationId: input.ctx.actor.organizationId, userId: input.ctx.actor.userId },
        system,
        outboundMessages,
      ));
    } catch (err) {
      if (isContextOverflow(err)) {
        // free context with an honest no-LLM trim, then retry exactly once
        const trimmed = trimState(session.messages, deps.auditSpanProvider?.() ?? [], {
          prior: session.compactionState ?? undefined,
        });
        if (trimmed) session = { ...session, compactionState: trimmed };
        outboundMessages = applyToOutbound(session.messages, session.compactionState ?? null);
        try {
          ({ parsed, inboxItemId: pendingInboxItemId } = await runAgentToolLoop(
            deps,
            session,
            { organizationId: input.ctx.actor.organizationId, userId: input.ctx.actor.userId },
            system,
            outboundMessages,
          ));
        } catch {
          parsed = null;
        }
      } else {
        parsed = null;
      }
    }

    if (parsed) {
      if (parsed.clarify && parsed.clarify.length > 0) {
        // §2e — park the clarification so the user's next answer is merged
        // through the probe and the pipeline re-runs with full context.
        session.pending = {
          id: crypto.randomUUID(),
          type: "clarification",
          questions: parsed.clarify,
          probe: "{answer}",
          createdAt: new Date().toISOString(),
        };
        session.messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [
            { type: "text" as const, text: "I need a bit more information to proceed." },
            { type: "clarify" as const, questions: parsed.clarify },
          ],
          createdAt: new Date().toISOString(),
        });
        return { session, explanation: undefined, inboxItemId: pendingInboxItemId };
      }
      if (parsed.plan && parsed.plan.length > 0) {
        const steps = wireSequentialPlanInputs(
          parsed.plan
            .filter((s) => s.command && catalog.some((c) => c.name === s.command))
            .map((s) => ({
              command: s.command!,
              input: normalizeFieldNames(s.input ?? {}),
              summary: s.description ?? `Execute ${s.command}`,
              specialist: catalog.find((c) => c.name === s.command)?.tags?.[0],
            })),
        );
        if (steps.length > 1) {
          multiPlan = steps;
        } else if (steps.length === 1) {
          planned = steps[0]!;
        }
      }
      if (!planned && !multiPlan && parsed.command && catalog.some((c) => c.name === parsed.command)) {
        planned = {
          command: parsed.command,
          input: parsed.input ?? {},
          summary: `LLM-planned ${parsed.command}`,
          specialist: catalog.find((c) => c.name === parsed.command)?.tags?.[0],
        };
      }
      if (
        !planned &&
        !multiPlan &&
        !parsed.command &&
        !parsed.plan &&
        !parsed.clarify &&
        parsed.query &&
        deps.queries?.list().some((q) => q.name === parsed.query)
      ) {
        llmQuery = { name: parsed.query, input: normalizeFieldNames(parsed.input ?? {}) };
      }
    }
  }

  // R10 — recognition guard. When the deterministic intent is recognized but
  // incomplete (the rule parser missed, yet the natural-language clarifier
  // knows exactly which required field is missing), an LLM materialized plan
  // is discarded and the focused, auditable clarification is parked instead.
  // This stops the LLM from inventing a value for the missing field (e.g.
  // copying one out of the learned-context memory block) and keeps intent
  // resolution on the deterministic probe path. Single-intent requests only;
  // multi-intent or rule-planned requests never reach this branch.
  if (
    rulePlans.length === 0 &&
    (planned || multiPlan) &&
    splitCompoundRequest(ruleText).length === 1
  ) {
    const clarification = clarifyFromText(ruleText);
    if (clarification) {
      planned = null;
      multiPlan = null;
      session.pending = clarification;
      session.messages.push(
        msg("assistant", [
          { type: "text" as const, text: "I need a bit more information to proceed." },
          { type: "clarify" as const, questions: clarification.questions },
        ]),
      );
      return { session };
    }
  }

  // R11 — LLM read-query path. When the model answered a data question with a
  // valid read query, run it through the same bus a human uses (permission +
  // zod + request context). Reads are side-effect free, so no confirmation.
  if (llmQuery) {
    try {
      const res = await executeQuery(deps.queries, llmQuery.name, llmQuery.input, input.ctx);
      const rows = rowsFromQueryData(res.data as Record<string, unknown>);
      const explanation: AiExplanation = {
        runId: crypto.randomUUID(),
        summary: `Read: ${llmQuery.name}`,
        reasons: ["Answered from org data via the read-query bus"],
        rulesApplied: ["ai_manual_parity", "read_via_query_bus", "zod_validation_on_execute", "permission_check_on_execute"],
        dataUsed: ["user message", "query catalog", `provider:${deps.provider?.id ?? "none"}`],
        autonomy: "recommend",
        plannedCommand: llmQuery.name,
      };
      const text =
        rows.length === 0
          ? `Nothing found for ${llmQuery.name}.`
          : `Here's what I found (${rows.length} ${rows.length === 1 ? "result" : "results"}):`;
      session.messages.push(msg("assistant", queryResultParts(rows, text, explanation)));
      return { session, explanation, inboxItemId: pendingInboxItemId };
    } catch (err) {
      session.messages.push(
        msg("assistant", [
          {
            type: "error" as const,
            message: `I couldn't read that: ${(err as Error).message}`,
            code: "QUERY_FAILED",
          },
          toExplanationPart({
            runId: crypto.randomUUID(),
            summary: `Read failed: ${llmQuery.name}`,
            reasons: [(err as Error).message],
            rulesApplied: ["read_via_query_bus"],
            dataUsed: ["user message", "query catalog", `provider:${deps.provider?.id ?? "none"}`],
            autonomy: "recommend",
            plannedCommand: llmQuery.name,
          }),
        ]),
      );
      return { session, inboxItemId: pendingInboxItemId };
    }
  }

  // R9 — re-apply the read-only gate after the LLM assist (the LLM may have
  // proposed a write even though the rule parser missed). Same response shape
  // as the pre-LLM gate above.
  if (deps.mode && isReadOnly(deps.mode) && (planned || multiPlan)) {
    const proposing = multiPlan ?? (planned ? [planned] : []);
    const planSteps = proposing.map((p) => ({
      command: p.command,
      description: p.summary,
      input: p.input,
    }));
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text:
            deps.mode === "discuss"
              ? "Discuss mode is active, so I can't run this — describe it instead. Switch to plan or interactive mode to act."
              : "Plan mode is active. Here's the plan I'd execute once you approve it.",
        },
        {
          type: "plan",
          id: crypto.randomUUID(),
          title: "Proposed plan",
          steps: planSteps,
        },
      ]),
    );
    return { session };
  }

  // Multi-step plan from rules or LLM
  if (multiPlan && multiPlan.length > 1) {
    const planSteps = multiPlan.map((p) => ({
      command: p.command,
      description: p.summary,
      input: p.input,
    }));
    // R1 — the plan's gate is the strictest across its steps (respects each
    // command's `minAutonomyForAuto` + risk class). Previously the plan only
    // consulted the raw configured level, so `minAutonomyForAuto` was dead
    // metadata and high-risk commands could auto-run under guarded_auto.
    const stepMetas: AutoExecMeta[] = multiPlan
      .map((p) => {
        const m = commandMetaOf(deps, p.command);
        if (!m) return undefined;
        const out: AutoExecMeta = {};
        if (m.minAutonomyForAuto) out.minAutonomyForAuto = m.minAutonomyForAuto;
        if (m.riskClass) out.riskClass = m.riskClass;
        return out;
      })
      .filter((m): m is AutoExecMeta => m !== undefined);
    const effectiveMulti = effectiveAutonomyForPlan(deps.autonomy, stepMetas);
    const planAuto = planMayAutoExecute(deps.autonomy, stepMetas);
    // R4 — a plan may skip the confirmation entirely when every step is already
    // covered by a standing approval rule (scoped to command + external target).
    const planRules = await Promise.all(
      multiPlan.map((p) =>
        standingDecision(deps, session, p.command, p.input, commandMetaOf(deps, p.command)),
      ),
    );
    const coveredByRules = planRules.every((r) => r !== null);
    const runIdMulti = crypto.randomUUID();
    const explanation: AiExplanation = {
      runId: runIdMulti,
      summary: `${multiPlan.length}-step plan prepared`,
      reasons: [
        ...multiPlan.map((p) => p.summary),
        ...(coveredByRules
          ? [`allowed by standing rule(s): ${planRules.map((r) => r!.rule).join(", ")}`]
          : []),
      ],
      rulesApplied: [
        "ai_manual_parity",
        "multi_step_plan",
        `autonomy:${effectiveMulti}`,
        "zod_validation_on_execute",
        ...(coveredByRules ? ["standing_rule"] : []),
      ],
      dataUsed: ["user message", "command catalog"],
      autonomy: effectiveMulti,
      plannedCommand: multiPlan.map((p) => p.command).join(" → "),
      plannedInput: { steps: planSteps },
    };

    if (coveredByRules || planAuto) {
      const aiCtx: RequestContext = {
        ...input.ctx,
        actor: { ...input.ctx.actor, kind: "ai_assisted", aiRunId: runIdMulti },
      };
      const parts: UiPart[] = [
        // R8 — live narration before a non-trivial execution batch.
        {
          type: "progress",
          text: `Executing ${multiPlan.length}-step plan${coveredByRules ? " (standing approval rule)" : ` (autonomy=${effectiveMulti})`}…`,
        },
        {
          type: "text",
          text: coveredByRules
            ? `Executed ${multiPlan.length} steps automatically — each step was already covered by a standing approval rule.`
            : `Executed ${multiPlan.length}-step plan automatically (autonomy=${effectiveMulti}).`,
        },
      ];
      const stepOutputs = await executePlanSteps(
        deps,
        multiPlan.map((p) => ({
          command: p.command,
          input: p.input,
          description: p.summary,
        })),
        aiCtx,
      );
      // Adaptive learning — record each auto-executed step for later recall.
      for (let i = 0; i < stepOutputs.length; i++) {
        const step = stepOutputs[i]!;
        await rememberExecution(
          deps,
          { organizationId: input.ctx.actor.organizationId, userId: input.ctx.actor.userId, sessionId: session.id },
          { command: step.command, input: multiPlan[i]?.input ?? step.data },
        );
      }
      parts.push(
        { type: "plan", id: runIdMulti, title: "Multi-step plan", steps: planSteps },
        toExplanationPart(explanation),
        {
          type: "table",
          columns: [
            { key: "step", label: "Step" },
            { key: "command", label: "Command" },
            { key: "result", label: "Result" },
          ],
          rows: stepOutputs.map((s, i) => ({
            step: String(i + 1),
            command: s.command,
            result: JSON.stringify(s.data).slice(0, 120),
          })),
        },
      );
      session.messages.push(msg("assistant", parts));
      return { session, explanation };
    }

    const confirmId = crypto.randomUUID();
    // Any earlier pending cards in the log must not stay clickable.
    session.messages = resolveConfirmParts(session.messages, { status: "superseded" });
    session.pending = {
      id: confirmId,
      command: multiPlan[0]!.command,
      input: multiPlan[0]!.input,
      plan: planSteps.map((s) => ({
        command: s.command,
        input: s.input,
        description: s.description,
      })),
      createdAt: new Date().toISOString(),
    };
    {
      const firstCmdMeta = catalog.find((c) => c.name === multiPlan[0]!.command);
      await mirrorToInbox(
        deps,
        session,
        { organizationId: input.ctx.actor.organizationId, userId: input.ctx.actor.userId },
        session.pending,
        { summary: `Execute ${multiPlan.length}-step plan`, commandMeta: firstCmdMeta },
      );
    }
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text: `I've prepared a ${multiPlan.length}-step plan. Confirm to execute each step sequentially through the same command path as the manual UI.`,
        },
        {
          type: "plan",
          id: confirmId,
          title: "Multi-step plan",
          steps: planSteps,
        },
        toExplanationPart(explanation),
        {
          type: "confirm_action",
          id: confirmId,
          title: `Execute ${multiPlan.length}-step plan`,
          description: multiPlan.map((p) => p.summary).join(" → "),
          command: multiPlan.map((p) => p.command).join(", "),
          input: { steps: planSteps },
          confirmLabel: effectiveMulti === "recommend" ? "Disabled" : "Confirm all",
          cancelLabel: "Cancel",
          status: "pending",
        },
      ]),
    );
    return { session, explanation };
  }

  if (!planned) {
    // §2e — recognized-but-incomplete intent: ask a focused natural question
    // instead of dumping examples. The user's answer merges through the probe.
    const clarification = clarifyFromText(ruleText);
    if (clarification) {
      session.pending = clarification;
      session.messages.push(
        msg("assistant", [
          { type: "text", text: "I need a bit more information to proceed." },
          { type: "clarify", questions: clarification.questions },
        ]),
      );
      return { session };
    }
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text:
            "I can prepare validated business actions. Examples:\n" +
            "• Create customer Acme Ltd in Nairobi\n" +
            "• Create invoice INV-1001 for 250.00 USD\n" +
            "• Create vendor Contoso Supplies\n" +
            "• Create product SKU-1 Widget\n" +
            "• Create employee E-100 Jane Doe\n" +
            "• Prepare payroll for March 2026",
        },
        {
          type: "explanation",
          summary: "No structured intent matched.",
          reasons: ["Rule parser and optional LLM did not produce a valid command"],
          rulesApplied: ["intent_validation"],
          dataUsed: ["user message", "command catalog", `provider:${deps.provider?.id ?? "none"}`],
        },
      ]),
    );
    return { session };
  }

  const meta = commandMetaOf(deps, planned!.command);
  if (!meta) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: `Command ${planned.command} is not available (module not loaded).`,
          code: "MODULE_MISSING",
        },
      ]),
    );
    return { session };
  }

  // R1 — the effective gate respects the command's declared `minAutonomyForAuto`
  // and its risk class (exec/external never auto-run without an explicit opt-in).
  const effective = effectiveAutonomyForCommand(deps.autonomy, meta);
  // R4 — a standing approval rule (command → external target) lets the call run
  // without a fresh confirmation; the rule string is recorded for audit.
  const standing = await standingDecision(deps, session, planned!.command, planned!.input, meta);
  const runId = crypto.randomUUID();

  const explanation: AiExplanation = {
    runId,
    summary: planned.summary,
    reasons: [
      "Matched business intent",
      planned.specialist ? `Specialist tag: ${planned.specialist}` : "General routing",
      "Tool is module command — not a privileged AI API",
      ...(standing ? [`allowed by standing rule: ${standing.rule}`] : []),
    ],
    rulesApplied: [
      "ai_manual_parity",
      `autonomy:${effective}`,
      "zod_validation_on_execute",
      "permission_check_on_execute",
      ...(standing ? ["standing_rule"] : []),
    ],
    dataUsed: ["user message", "command catalog", "org autonomy policy"],
    autonomy: effective,
    plannedCommand: planned.command,
    plannedInput: planned.input,
  };

  if (deps.autonomy === "full_autonomous" && deps.allowFullAutonomous === false) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: "Full autonomous mode is not enabled on this platform.",
          code: "AUTONOMY_DISABLED",
        },
        {
          type: "text",
          text: FULL_AUTONOMOUS_WARNING,
        },
      ]),
    );
    return { session };
  }

  if (standing || commandMayAutoExecute(deps.autonomy, meta)) {
    const aiCtx: RequestContext = {
      ...input.ctx,
      actor: { ...input.ctx.actor, kind: "ai_assisted", aiRunId: runId },
    };
    const result = await executeCommand(
      deps.commands,
      planned.command,
      planned.input,
      aiCtx,
      deps.helpers,
    );
    // Adaptive learning — record the auto-executed action for later recall.
    await rememberExecution(
      deps,
      { organizationId: input.ctx.actor.organizationId, userId: input.ctx.actor.userId, sessionId: session.id },
      { command: planned.command, input: planned.input, summary: planned.summary },
    );
    const parts: UiPart[] = [
      // R8 — live narration line for a consequential single command.
      {
        type: "progress",
        text: standing
          ? `Running ${planned.command} (covered by standing rule: ${standing.rule})…`
          : `Running ${planned.command} (autonomy=${effective})…`,
      },
      {
        type: "text",
        text: standing
          ? `Executed \`${planned.command}\` automatically — covered by your standing rule ${standing.rule}.`
          : `Executed automatically (autonomy=${effective}).`,
      },
      toExplanationPart(explanation),
    ];
    if (effective === "full_autonomous") {
      parts.push({ type: "text", text: FULL_AUTONOMOUS_WARNING });
    }
    parts.push({
      type: "table",
      columns: [
        { key: "field", label: "Field" },
        { key: "value", label: "Value" },
      ],
      rows: Object.entries(result.data as Record<string, unknown>).map(([field, value]) => ({
        field,
        value: String(value ?? ""),
      })),
    });
    session.messages.push(msg("assistant", parts));
    return { session, explanation };
  }

  const confirmId = crypto.randomUUID();
  // Any earlier pending cards in the log must not stay clickable.
  session.messages = resolveConfirmParts(session.messages, { status: "superseded" });
  session.pending = {
    id: confirmId,
    command: planned.command,
    input: planned.input,
    createdAt: new Date().toISOString(),
  };

  // R2/R3 — mirror single-command approvals to the canonical Inbox, exactly as
  // multi-step plans are mirrored. This makes a single external/write action
  // approvable from any surface (mobile, Slack) and from unattended sessions,
  // not just multi-step plans. The item carries `toolCallId === pending.id` so
  // the shared confirm/cancel handler (which now looks up by toolCallId) finds
  // and resolves the same canonical record.
  await mirrorToInbox(
    deps,
    session,
    { organizationId: input.ctx.actor.organizationId, userId: input.ctx.actor.userId },
    session.pending,
    { summary: planned.summary, commandMeta: meta, input: planned.input as Record<string, unknown> },
  );

  const recommendOnly = effective === "recommend";
  session.messages.push(
    msg("assistant", [
      {
        type: "text",
        text: recommendOnly
          ? "Recommendation only (autonomy=recommend). Raise autonomy to confirm or auto-execute."
          : "Prepared a validated action. Confirm to run it through the same business command as the manual UI.",
      },
      toExplanationPart(explanation),
      {
        type: "confirm_action",
        id: confirmId,
        title: planned.summary,
        description: `${planned.command}`,
        command: planned.command,
        input: planned.input,
        confirmLabel: recommendOnly ? "Disabled" : "Confirm",
        cancelLabel: "Cancel",
        status: "pending",
      },
    ]),
  );

  return { session, explanation, inboxItemId: pendingInboxItemId };
}

/**
 * C5 — agent follow-up harness re-entry.
 *
 * A due follow-up is a natural-language goal that re-enters the orchestrator as
 * a synthesized user turn running under the follow-up's owning user/org policy
 * (spec: scheduling-and-comms §2.3). The regular plan/confirm pipeline applies,
 * so under confirm/guarded autonomy the user is notified with a plan instead of
 * anything executing silently. The goal is passed verbatim so the deterministic
 * rule parser can match it; the origin (automatic follow-up) is visible in the
 * audit trail via the run id.
 */
export async function runFollowUpTurn(
  deps: OrchestratorDeps,
  input: {
    session: ChatSessionState;
    ctx: RequestContext;
    goal: string;
  },
): Promise<ChatTurnResult> {
  return handleChatTurn(deps, {
    session: input.session,
    userText: input.goal,
    ctx: input.ctx,
  });
}
