import {
  type AutonomyLevel,
  type CommandMeta,
  type CommandRegistry,
  type QueryRegistry,
  type RequestContext,
  executeCommand,
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
} from "./skills.js";
import {
  selfWakeTools,
  type WakeStore,
  type SelfWakeTools,
} from "./selfwake.js";
import type { StandingRuleDecision } from "@chaste/kernel";

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
}

/**
 * The orchestrator's in-process session shape. When the kernel `InboxStore` is
 * wired, `pending` becomes the in-chat projection of the canonical Inbox item
 * (kept here for back-compat with callers that read it synchronously); the
 * Inbox remains the store of record and is the durable surface for retries.
 */
export interface ChatSessionState {
  id: string;
  messages: ChatMessage[];
  pending?: PendingConfirmation;
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
function mirrorToInbox(
  deps: OrchestratorDeps,
  session: ChatSessionState,
  ctx: { organizationId: string; userId: string },
  pending: PendingConfirmation,
  opts: { summary: string; commandMeta?: CommandMeta; input?: Record<string, unknown> } = {
    summary: pending.command,
  },
): InboxItem | undefined {
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

/** Look up a command's metadata in the registry (undefined when module not loaded). */
function commandMetaOf(deps: OrchestratorDeps, command: string): CommandMeta | undefined {
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
function standingDecision(
  deps: OrchestratorDeps,
  session: ChatSessionState,
  command: string,
  input: unknown,
  meta?: CommandMeta,
): StandingRuleDecision | null {
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
function withSkillContext(
  messages: ChatMessage[],
  deps: OrchestratorDeps,
  session: ChatSessionState,
  organizationId: string,
): ChatMessage[] {
  if (!deps.skills) return messages;
  const filter = {
    organizationId,
    branchId: session.activeBranchId,
  };
  const catalog = skillCatalogText(deps.skills, filter);
  const countermand = disableCountermand(deps.skills, filter, session.loadedSkillNames ?? []);
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

export interface PlannedAction {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  specialist?: string;
}

/** Split compound requests into segments for multi-step planning. */
function splitCompoundRequest(text: string): string[] {
  const parts = text
    .split(/\s+(?:and also|then|and then|, then)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  // "create X and create Y" / "create X and also create Y"
  const andCreate = text.split(/\s+and\s+(?=create\s+|prepare\s+)/i);
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
 * Deterministic datetime phrase extraction for "remind me …" / "follow up …".
 *
 * Understands a small, reliable set of phrases: "in N minutes/hours/days",
 * "on <weekday> at HH:MM[am|pm]" (next occurrence), "today at HH:MM[am|pm]",
 * "tomorrow at HH:MM[am|pm]", "at HH:MM[am|pm]" (today or next). Ambiguous
 * or missing times return `fireAt: null` so the LLM assist path can clarify.
 */
export function parseScheduleFireAt(text: string): { fireAt: string | null; cleaned: string } {
  const now = new Date();

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

/** Parse a single intent segment (no compound splitting). */
function planSingleSegment(text: string): PlannedAction | null {
  const trimmed = text.trim().replace(/[.!]+$/, "");

  // Reminders & follow-ups (spec: scheduling-and-comms §3). Deterministic
  // datetime phrases map to an ISO fireAt; anything else falls through to the
  // LLM assist path, which may clarify the time.
  let m = trimmed.match(/^(?:remind me(?: to)?|set a reminder(?: to)?)\s+(.+)$/i);
  if (m?.[1]) {
    const { fireAt, cleaned } = parseScheduleFireAt(m[1]);
    if (fireAt) {
      return {
        command: "core.reminder.set",
        input: { title: cleaned, fireAt },
        summary: `Remind me: ${cleaned}`,
        specialist: "core",
      };
    }
  }

  m = trimmed.match(/^follow up(?:\s+with)?\s+(.+)$/i);
  if (m?.[1]) {
    const { fireAt, cleaned } = parseScheduleFireAt(m[1]);
    if (fireAt) {
      return {
        command: "core.followup.create",
        input: { goal: cleaned, fireAt },
        summary: `Follow up: ${cleaned}`,
        specialist: "core",
      };
    }
  }

  m = trimmed.match(
    /^create\s+customer\s+(.+?)(?:\s+in\s+([A-Za-z][A-Za-z\s-]+))?$/i,
  );
  if (m?.[1]) {
    return {
      command: "crm.customer.create",
      input: { name: m[1].trim(), city: m[2]?.trim() },
      summary: `Create customer ${m[1].trim()}`,
      specialist: "crm",
    };
  }

  m = trimmed.match(/^prepare\s+payroll\s+for\s+(.+)$/i);
  if (m?.[1]) {
    return {
      command: "hr.payroll.prepare",
      input: { periodLabel: m[1].trim() },
      summary: `Prepare payroll for ${m[1].trim()}`,
      specialist: "hr",
    };
  }

  m = trimmed.match(
    /^create\s+(?:invoice|bill)\s+(\S+)(?:\s+for\s+([\d.]+))?(?:\s+([A-Z]{3}))?$/i,
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

  m = trimmed.match(/^create\s+vendor\s+(.+)$/i);
  if (m?.[1]) {
    return {
      command: "pur.vendor.create",
      input: { name: m[1].trim() },
      summary: `Create vendor ${m[1].trim()}`,
      specialist: "purchasing",
    };
  }

  m = trimmed.match(/^create\s+product\s+(\S+)\s+(.+)$/i);
  if (m?.[1] && m[2]) {
    return {
      command: "inv.product.create",
      input: { sku: m[1], name: m[2].trim() },
      summary: `Create product ${m[1]} (${m[2].trim()})`,
      specialist: "inventory",
    };
  }

  m = trimmed.match(/^create\s+employee\s+(\S+)\s+(.+)$/i);
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
// disabled draft behind an Inbox approval; self-wake only creates durable wake
// records (no immediate side effect on real state).
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
    tools.push("loadSkill(name)", "saveSkill({name,title,summary,instructions,files?})");
  }
  if (deps.wake) {
    tools.push(
      "sleepFor(seconds,note?)",
      "sleepUntil(isoTimestamp,note?)",
      "wakeOnJob(jobId,note?)",
      "wakeOnEvent(eventKey,note?)",
    );
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
      const skill = deps.skills.get(String(args.name ?? ""), filter);
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
      const res = tools.saveSkill({
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
        const item = deps.inbox.addApproval({
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

    case "sleepFor":
    case "sleepUntil":
    case "wakeOnJob":
    case "wakeOnEvent": {
      if (!deps.wake) return { message: "Self-wake store not available on this instance." };
      const tools = selfWakeTools(deps.wake, session.id);
      switch (name) {
        case "sleepFor": {
          const r = tools.sleepFor(Number(args.seconds ?? 0), args.note as string | undefined);
          return { message: `Sleeping ${args.seconds}s; wake ${r.wakeId} fires ${r.fireAt}.` };
        }
        case "sleepUntil": {
          const r = tools.sleepUntil(
            String(args.isoTimestamp ?? args.when ?? ""),
            args.note as string | undefined,
          );
          return { message: `Wake ${r.wakeId} scheduled for ${r.fireAt}.` };
        }
        case "wakeOnJob": {
          const r = tools.wakeOnJob(String(args.jobId ?? ""), args.note as string | undefined);
          return { message: `Will resume when job ${r.jobId} completes (wake ${r.wakeId}).` };
        }
        default: {
          const r = tools.wakeOnEvent(
            String(args.eventKey ?? ""),
            args.note as string | undefined,
          );
          return { message: `Will resume when event "${r.eventKey}" fires (wake ${r.wakeId}).` };
        }
      }
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
  clarify?: string[];
  plan?: { command: string; input?: Record<string, unknown>; description?: string }[];
  toolCall?: AgentToolCall;
}

export async function handleChatTurn(
  deps: OrchestratorDeps,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  let session = {
    ...input.session,
    messages: [...input.session.messages],
  };
  if (input.cancelId && session.pending?.id === input.cancelId) {
    const cancelled = session.pending;
    session.pending = undefined;
    if (deps.inbox && cancelled) {
      const existing = deps.inbox.list({ sessionId: session.id }).find((i) => i.id === cancelled.id);
      if (existing) deps.inbox.resolve(existing.id, "deny");
    }
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

  // R7 — skill-save approvals resolve through the same Inbox card as any other
  // approval. The draft was created disabled; an allow/always enables it, deny
  // leaves it disabled. No self-grant path exists.
  if (input.confirmId && deps.inbox && deps.skills) {
    const skillItem = deps.inbox
      .list({ sessionId: session.id, state: "pending" })
      .find((i) => i.kind === "approval" && i.data?.skillSave != null && i.id === input.confirmId);
    if (skillItem) {
      const skillName = String(skillItem.data?.skillSave);
      const resolution = input.inboxResolution ?? "allow";
      deps.inbox.resolve(skillItem.id, resolution);
      if (resolution === "allow" || resolution === "always") {
        deps.skills.setEnabled(
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

  if (input.confirmId && session.pending?.id === input.confirmId) {
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
      const item = deps.inbox.list({ sessionId: session.id }).find((i) => i.id === pending.id);
      if (item) {
        const resolution = input.inboxResolution ?? "allow";
        if (!deps.inbox.resolve(item.id, resolution)) {
          // already resolved by another surface — treat as already-executed
          session.pending = undefined;
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

    session.pending = undefined;
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

  session.messages.push(msg("user", [{ type: "text", text: input.userText }]));

  const catalog = deps.commands.list();
  const rulePlans = planManyFromText(input.userText);
  let planned: PlannedAction | null = rulePlans.length === 1 ? rulePlans[0]! : null;
  let multiPlan: PlannedAction[] | null = rulePlans.length > 1 ? rulePlans : null;

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
  outboundMessages = withSkillContext(outboundMessages, deps, session, input.ctx.actor.organizationId);

  // Optional LLM assist when rules miss (provider may be none). Runs a bounded
  // agent-tool loop (R5 self-wake / R7 skills) and retries once after a
  // context-overflow error with a no-LLM trim.
  if (!planned && !multiPlan && deps.provider && deps.provider.id !== "none") {
    const agentTools = agentToolList(deps);
    const system =
      `You map user requests to JSON actions using only: ${catalog.map((c) => c.name).join(", ")}.\n` +
      `For a single action: {"command":"...","input":{...}}\n` +
      `For multiple sequential actions: {"plan":[{"command":"...","input":{...},"description":"..."},{"command":"...","input":{...}}]}\n` +
      `If ambiguous or missing required info: {"clarify":["question1","question2"]}\n` +
      (agentTools
        ? `Before planning, you may call an agent tool to pull in context or schedule follow-ups.\nAvailable agent tools: ${agentTools}.\nTo call one, reply {"toolCall":{"name":"loadSkill","args":{"name":"..."}}} — you will receive the result and should then continue planning.\n`
        : "") +
      `Reply JSON only. Never invent field values — use null for unknown required fields.`;

    let parsed: ParsedLlmResponse | null = null;
    let inboxItemId: string | undefined;
    try {
      ({ parsed, inboxItemId } = await runAgentToolLoop(
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
          ({ parsed, inboxItemId } = await runAgentToolLoop(
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
        session.messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [
            { type: "text" as const, text: "I need a bit more information to proceed." },
            { type: "clarify" as const, questions: parsed.clarify },
          ],
          createdAt: new Date().toISOString(),
        });
        return { session, explanation: undefined, inboxItemId };
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
    const planRules = multiPlan.map((p) =>
      standingDecision(deps, session, p.command, p.input, commandMetaOf(deps, p.command)),
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
      void mirrorToInbox(
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
        },
      ]),
    );
    return { session, explanation };
  }

  if (!planned) {
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
  const standing = standingDecision(deps, session, planned!.command, planned!.input, meta);
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
  session.pending = {
    id: confirmId,
    command: planned.command,
    input: planned.input,
    createdAt: new Date().toISOString(),
  };

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
      },
    ]),
  );

  return { session, explanation };
}
