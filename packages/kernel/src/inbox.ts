/**
 * The Inbox — the canonical human-attention queue.
 *
 * Direct TS port of OpenWorker `coworker/inbox.py`, adapted to our server-first,
 * multi-tenant command-bus world. Where OpenWorker writes JSON files to the local
 * machine, the kernel store remains pure logic; the durable Postgres schema for
 * the same records lives in `@chaste/db` (`pending_approvals`) and a
 * Postgres-backed `InboxStore` can implement this interface against that table —
 * so callers swap stores freely.
 *
 * Anti-race contract (verbatim from OpenWorker): each item is `pending → resolved`,
 * resolved **once**, idempotent + first-responder-wins — so answering from any
 * surface (in-app, Slack, mobile) is safe. The orchestrator converts a permission
 * request into an item and suspends (here: awaits a Promise) until that item is
 * resolved.
 *
 * Visibility (the unattended-mode decision from R3): INLINE = an attended session
 * answers in the composer (parked server-side, redelivered on reconnect, never in
 * the cross-session list). INBOX = the session is unattended, so the item joins
 * the cross-session queue (mobile push, Slack dm, …). Either way it's the same
 * parked, awaitable, resolve-from-anywhere record — only the visibility differs.
 *
 * Standing rules (R4): when a user answers an `approval` item with "always", the
 * rule `{commandId → set[allowedTargets]}` is minted against the owning task
 * (or against the session, when no task owns it). Future eligible calls —
 * `external` risk only, the call names a target — are auto-allowed; the trigger
 * `rule` string is preserved on the resulting decision so the in-app card can
 * say "allowed by standing rule: email.send → user@x.com".
 */

export type InboxKind = "approval" | "question" | "notification" | "plan";

export type InboxState = "pending" | "resolved";

export type InboxVisibility = "inline" | "inbox";

/**
 * The recorded resolution of an `approval` item. "always" mints a standing rule
 * scoped against the item's owning task (or session, when none).
 */
export type ApprovalResolution = "allow" | "always" | "deny";

/**
 * Durable record shape. The full `data` payload carries the automation-run context
 * for standing scoped approvals: `{ taskId, taskTitle, standingTarget? }`. Tools
 * that touch the platform directly (audit, outbox) MUST inspect the store before
 * resolving to honor the once-only contract.
 */
export interface InboxItem {
  id: string;
  sessionId: string;
  organizationId: string;
  userId: string;
  kind: InboxKind;
  title: string;
  body?: string;
  state: InboxState;
  /** approval: "allow" / "always" / "deny"; question: answer text; plan: "approved" / "rejected". */
  resolution?: string;
  /** Named inbox / delivery binding (later phases route by this). */
  inbox: string;
  visibility: InboxVisibility;
  /** The command/tool call this prompt is blocking. Idempotent by (sessionId, toolCallId). */
  toolCallId?: string;
  /** Optional quick-reply choices for question items; `allowText` adds the "Other" escape. */
  options?: string[];
  allowText?: boolean;
  multi?: boolean;
  /** Kind-specific payload (plan text, suggested target, etc.). */
  data?: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
}

export interface AddApprovalInput {
  sessionId: string;
  organizationId: string;
  userId: string;
  title: string;
  body?: string;
  inbox?: string;
  visibility?: InboxVisibility;
  toolCallId?: string;
  data?: Record<string, unknown>;
}

export interface AddQuestionInput {
  sessionId: string;
  organizationId: string;
  userId: string;
  title: string;
  body?: string;
  inbox?: string;
  visibility?: InboxVisibility;
  toolCallId?: string;
  options?: string[];
  allowText?: boolean;
  multi?: boolean;
  data?: Record<string, unknown>;
}

export interface AddNotificationInput {
  sessionId: string;
  organizationId: string;
  userId: string;
  title: string;
  body?: string;
  inbox?: string;
  visibility?: InboxVisibility;
}

export interface AddPlanInput {
  sessionId: string;
  organizationId: string;
  userId: string;
  title: string;
  body?: string;
  inbox?: string;
  visibility?: InboxVisibility;
  toolCallId?: string;
  data?: Record<string, unknown>;
}

export interface StandingRules {
  /** key → set of allowed off-platform targets. Keyed by `taskId ?? sessionId`. */
  byOwner: Map<string, Map<string, Set<string>>>;
}

export interface StandingRuleDecision {
  allowed: true;
  rule: string;
  taskId?: string;
  sessionId?: string;
}

export interface InboxStoreOptions {
  /** Optional clock — tests inject deterministic time. */
  now?: () => Date;
}

export class InboxStore {
  private readonly items = new Map<string, InboxItem>();
  private readonly waiters = new Map<string, Array<(resolution: string) => void>>();
  /** task_id → (command_id → set[allowed targets]); sessions without a task fall back to their id. */
  private readonly rules: Map<string, Map<string, Set<string>>> = new Map();
  private readonly now: () => Date;

  constructor(opts: InboxStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Idempotent by (sessionId, toolCallId): a resume re-raises the same prompt. */
  addApproval(input: AddApprovalInput): InboxItem {
    if (input.toolCallId) {
      const existing = this.forToolCall(input.sessionId, input.toolCallId);
      if (existing) return existing;
    }
    return this.put({
      kind: "approval",
      ...input,
      ...this.defaults(input),
    });
  }

  addQuestion(input: AddQuestionInput): InboxItem {
    if (input.toolCallId) {
      const existing = this.forToolCall(input.sessionId, input.toolCallId);
      if (existing) return existing;
    }
    return this.put({
      kind: "question",
      ...input,
      options: input.options ?? [],
      allowText: input.allowText ?? true,
      multi: input.multi ?? false,
      ...this.defaults(input),
    });
  }

  addNotification(input: AddNotificationInput): InboxItem {
    return this.put({
      kind: "notification",
      ...input,
      ...this.defaults(input),
    });
  }

  addPlan(input: AddPlanInput): InboxItem {
    if (input.toolCallId) {
      const existing = this.forToolCall(input.sessionId, input.toolCallId);
      if (existing) return existing;
    }
    return this.put({
      kind: "plan",
      ...input,
      ...this.defaults(input),
    });
  }

  get(itemId: string): InboxItem | undefined {
    return this.items.get(itemId);
  }

  list(filter: {
    sessionId?: string;
    organizationId?: string;
    state?: InboxState;
    visibility?: InboxVisibility;
    kind?: InboxKind;
  } = {}): InboxItem[] {
    const out: InboxItem[] = [];
    for (const item of this.items.values()) {
      if (filter.sessionId !== undefined && item.sessionId !== filter.sessionId) continue;
      if (filter.organizationId !== undefined && item.organizationId !== filter.organizationId) continue;
      if (filter.state !== undefined && item.state !== filter.state) continue;
      if (filter.visibility !== undefined && item.visibility !== filter.visibility) continue;
      if (filter.kind !== undefined && item.kind !== filter.kind) continue;
      out.push(item);
    }
    // oldest first
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  pending(filter: { sessionId?: string; organizationId?: string } = {}): InboxItem[] {
    return this.list({ ...filter, state: "pending" });
  }

  /**
   * Resolve an item exactly once. First responder wins; later attempts are no-ops
   * (return false). Fires any awaiting agent. When `resolution === "always"` and
   * the item is an approval carrying `data.taskId` + `data.standingTarget` +
   * `data.commandId` (set by the orchestrator when the call is standing-rule
   * eligible), the rule is minted/cached here so subsequent eligible calls
   * are auto-allowed.
   */
  resolve(itemId: string, resolution: string): boolean {
    const item = this.items.get(itemId);
    if (!item || item.state === "resolved") return false;

    item.state = "resolved";
    item.resolution = resolution;
    item.resolvedAt = this.now().toISOString();
    this.items.set(itemId, item);

    if (
      item.kind === "approval" &&
      resolution === "always" &&
      item.data?.commandId &&
      item.data?.standingTarget
    ) {
      // R4: standing rules are scoped to the owning task when present, else the
      // session. The orchestrator supplies `taskId` for automation-owned calls;
      // ad-hoc interactive approvals leave it unset and the binding keys on
      // the session id — both shapes are durable across restarts.
      this.recordStandingRule(
        String(item.data.taskId ?? item.sessionId),
        String(item.data.commandId),
        String(item.data.standingTarget),
      );
    }

    const waiters = this.waiters.get(itemId);
    if (waiters) {
      this.waiters.delete(itemId);
      for (const w of waiters) w(resolution);
    }
    return true;
  }

  /** Resolve every still-pending item of a session (called when a session is deleted). */
  resolveSession(sessionId: string, resolution = "session deleted"): number {
    let closed = 0;
    for (const item of this.pending({ sessionId })) {
      if (this.resolve(item.id, resolution)) closed += 1;
    }
    return closed;
  }

  /**
   * Check whether a call is allowed by an existing standing rule.
   * Returns the triggering rule string when yes; `null` when no.
   */
  standingRuleFor(opts: {
    taskId?: string;
    sessionId: string;
    commandId: string;
    target: string;
  }): StandingRuleDecision | null {
    const ownerKey = opts.taskId ?? opts.sessionId;
    const cmds = this.rules.get(ownerKey);
    if (!cmds) return null;
    const targets = cmds.get(opts.commandId);
    if (!targets || !targets.has(opts.target)) return null;
    const rule = `${opts.commandId} → ${opts.target}`;
    return {
      allowed: true,
      rule,
      ...(opts.taskId ? { taskId: opts.taskId } : { sessionId: opts.sessionId }),
    };
  }

  /** Test/debug hook — exposes the rule table without exposing internals. */
  inspectStandingRules(): StandingRules {
    return { byOwner: this.rules };
  }

  /** Test/debug hook — clears the store. Not used by the orchestrator. */
  reset(): void {
    this.items.clear();
    this.waiters.clear();
    this.rules.clear();
  }

  /** Promise that resolves with the recorded resolution when the item is answered. */
  wait(itemId: string): Promise<string> {
    const item = this.items.get(itemId);
    if (item?.state === "resolved") return Promise.resolve(item.resolution ?? "");
    return new Promise((resolve) => {
      const arr = this.waiters.get(itemId) ?? [];
      arr.push(resolve);
      this.waiters.set(itemId, arr);
    });
  }

  /**
   * Surfaced by `reconcileOnResume` on the OpenWorker side; we route via
   * `pending({...})` from callers, so this is mostly a convenience.
   */
  reconcile(sessionId: string): { pending: InboxItem[]; recap: InboxItem[] } {
    return {
      pending: this.pending({ sessionId }),
      recap: this.list({ sessionId, state: "resolved" }),
    };
  }

  // ---- internals -------------------------------------------------------

  private recordStandingRule(taskId: string, commandId: string, target: string): void {
    let cmds = this.rules.get(taskId);
    if (!cmds) {
      cmds = new Map();
      this.rules.set(taskId, cmds);
    }
    let targets = cmds.get(commandId);
    if (!targets) {
      targets = new Set();
      cmds.set(commandId, targets);
    }
    targets.add(target);
  }

  private forToolCall(sessionId: string, toolCallId: string): InboxItem | undefined {
    for (const item of this.items.values()) {
      if (item.sessionId === sessionId && item.toolCallId === toolCallId) return item;
    }
    return undefined;
  }

  private defaults(input: { inbox?: string; visibility?: InboxVisibility }): {
    state: InboxState;
    inbox: string;
    visibility: InboxVisibility;
    createdAt: string;
  } {
    return {
      state: "pending",
      inbox: input.inbox ?? "default",
      visibility: input.visibility ?? "inbox",
      createdAt: this.now().toISOString(),
    };
  }

  private put(input: Omit<InboxItem, "id"> & { id?: never }): InboxItem {
    const id = crypto.randomUUID();
    const record: InboxItem = { id, ...input };
    this.items.set(id, record);
    return record;
  }
}

/**
 * Human-readable preview of the arguments tuple, used as an approval card's body
 * so a mirrored "Run `email.send`?" card shows *what* — recipient/subject —
 * not just the tool name. Ported almost verbatim from OpenWorker's
 * `args_preview`.
 */
export function argsPreview(
  args: Record<string, unknown> | undefined,
  limit = 240,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    let s = typeof v === "string" ? v : safeJson(v);
    s = s.replace(/\s+/g, " ");
    if (s.length > 80) s = s.slice(0, 79) + "…";
    parts.push(`${k}: ${s}`);
  }
  const out = parts.join(" · ");
  return out.length >= limit ? out.slice(0, limit - 1) + "…" : out;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
