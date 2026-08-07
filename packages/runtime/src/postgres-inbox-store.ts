/**
 * Postgres-backed `InboxStore` over the `pending_approvals` table.
 *
 * ARCH-4 — the durable counterpart to the kernel's `InMemoryInboxStore`. Both
 * implement the same `InboxStore` interface from `@chaste/kernel`, so the
 * orchestrator and every host swap stores freely. Unlike the in-memory store,
 * rows (including minted "always" standing rules, derived from resolved
 * approvals) are shared across processes: a rule approved through the API is
 * honored by the worker's follow-up harness on the next call.
 *
 * Once-only semantics are enforced atomically in Postgres (`UPDATE ... WHERE
 * state = 'pending'`), so the first responder wins across surfaces/processes.
 * `wait()` is a single-process affordance (tests + same-process approval
 * flows); cross-process hosts poll `pending()`/`list()` as the orchestrator
 * already does.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  type AddApprovalInput,
  type AddNotificationInput,
  type AddPlanInput,
  type AddQuestionInput,
  type InboxItem,
  type InboxKind,
  type InboxState,
  type InboxStore,
  type InboxVisibility,
  type StandingRuleDecision,
  type StandingRules,
} from "@chaste/kernel";
import { schema, type Db } from "@chaste/db";
const { pendingApprovals } = schema;

export interface PostgresInboxStoreOptions {
  /** Optional clock — tests inject deterministic time. */
  now?: () => Date;
}

interface ApprovalRow {
  id: string;
  sessionId: string;
  organizationId: string;
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  state: string;
  resolution: string | null;
  inbox: string;
  visibility: string;
  toolCallId: string | null;
  options: string[] | null;
  allowText: boolean;
  multi: boolean;
  data: Record<string, unknown> | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export class PostgresInboxStore implements InboxStore {
  private readonly now: () => Date;
  private readonly waiters = new Map<string, Array<(resolution: string) => void>>();

  constructor(
    private readonly db: Db,
    opts: PostgresInboxStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async addApproval(input: AddApprovalInput): Promise<InboxItem> {
    return this.addWithIdempotency({
      kind: "approval",
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      title: input.title,
      body: input.body,
      inbox: input.inbox ?? "default",
      visibility: input.visibility ?? "inbox",
      toolCallId: input.toolCallId,
      options: null,
      allowText: true,
      multi: false,
      data: input.data ?? null,
    });
  }

  async addQuestion(input: AddQuestionInput): Promise<InboxItem> {
    return this.addWithIdempotency({
      kind: "question",
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      title: input.title,
      body: input.body,
      inbox: input.inbox ?? "default",
      visibility: input.visibility ?? "inbox",
      toolCallId: input.toolCallId,
      options: input.options ?? [],
      allowText: input.allowText ?? true,
      multi: input.multi ?? false,
      data: input.data ?? null,
    });
  }

  async addNotification(input: AddNotificationInput): Promise<InboxItem> {
    return this.addWithIdempotency({
      kind: "notification",
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      title: input.title,
      body: input.body,
      inbox: input.inbox ?? "default",
      visibility: input.visibility ?? "inbox",
      toolCallId: undefined,
      options: null,
      allowText: true,
      multi: false,
      data: null,
    });
  }

  async addPlan(input: AddPlanInput): Promise<InboxItem> {
    return this.addWithIdempotency({
      kind: "plan",
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      title: input.title,
      body: input.body,
      inbox: input.inbox ?? "default",
      visibility: input.visibility ?? "inbox",
      toolCallId: input.toolCallId,
      options: null,
      allowText: true,
      multi: false,
      data: input.data ?? null,
    });
  }

  async get(itemId: string): Promise<InboxItem | undefined> {
    const rows = await this.db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.id, itemId))
      .limit(1);
    return rows.length > 0 ? this.toItem(rows[0]!) : undefined;
  }

  async list(filter: {
    sessionId?: string;
    organizationId?: string;
    state?: InboxState;
    visibility?: InboxVisibility;
    kind?: InboxKind;
  } = {}): Promise<InboxItem[]> {
    const conditions = [];
    if (filter.sessionId !== undefined) conditions.push(eq(pendingApprovals.sessionId, filter.sessionId));
    if (filter.organizationId !== undefined)
      conditions.push(eq(pendingApprovals.organizationId, filter.organizationId));
    if (filter.state !== undefined) conditions.push(eq(pendingApprovals.state, filter.state));
    if (filter.visibility !== undefined) conditions.push(eq(pendingApprovals.visibility, filter.visibility));
    if (filter.kind !== undefined) conditions.push(eq(pendingApprovals.kind, filter.kind));
    const rows = conditions.length > 0
      ? await this.db.select().from(pendingApprovals).where(and(...conditions))
      : await this.db.select().from(pendingApprovals);
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.map((r) => this.toItem(r));
  }

  async pending(filter: { sessionId?: string; organizationId?: string } = {}): Promise<InboxItem[]> {
    return this.list({ ...filter, state: "pending" });
  }

  /**
   * Resolve an item exactly once, atomically in Postgres. First responder wins;
   * later attempts (from any surface/process) are no-ops returning false. When
   * `resolution === "always"` on a standing-eligible approval, the rule is
   * recorded as the resolved row itself — `standingRuleFor` derives rules from
   * the table, so they're durable and shared across processes.
   */
  async resolve(itemId: string, resolution: string): Promise<boolean> {
    const now = this.now();
    const updated = await this.db
      .update(pendingApprovals)
      .set({ state: "resolved", resolution, resolvedAt: now })
      .where(and(eq(pendingApprovals.id, itemId), eq(pendingApprovals.state, "pending")))
      .returning({ id: pendingApprovals.id });
    if (updated.length === 0) return false;

    const waiters = this.waiters.get(itemId);
    if (waiters) {
      this.waiters.delete(itemId);
      for (const w of waiters) w(resolution);
    }
    return true;
  }

  async resolveSession(sessionId: string, resolution = "session deleted"): Promise<number> {
    const now = this.now();
    const updated = await this.db
      .update(pendingApprovals)
      .set({ state: "resolved", resolution, resolvedAt: now })
      .where(and(eq(pendingApprovals.sessionId, sessionId), eq(pendingApprovals.state, "pending")))
      .returning({ id: pendingApprovals.id });
    return updated.length;
  }

  /**
   * Check whether a call is allowed by an existing standing rule — i.e. a
   * previously resolved approval with `resolution = "always"` for the same
   * command+target owned by the same task (or session when no task).
   */
  async standingRuleFor(opts: {
    taskId?: string;
    sessionId: string;
    commandId: string;
    target: string;
  }): Promise<StandingRuleDecision | null> {
    const ownerCond = opts.taskId
      ? sql`${pendingApprovals.data}->>'taskId' = ${opts.taskId}`
      : and(eq(pendingApprovals.sessionId, opts.sessionId), sql`${pendingApprovals.data}->>'taskId' IS NULL`);
    const rows = await this.db
      .select()
      .from(pendingApprovals)
      .where(
        and(
          eq(pendingApprovals.kind, "approval"),
          eq(pendingApprovals.state, "resolved"),
          eq(pendingApprovals.resolution, "always"),
          sql`${pendingApprovals.data}->>'commandId' = ${opts.commandId}`,
          sql`${pendingApprovals.data}->>'standingTarget' = ${opts.target}`,
          ownerCond,
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    const rule = `${opts.commandId} → ${opts.target}`;
    return {
      allowed: true,
      rule,
      ...(opts.taskId ? { taskId: opts.taskId } : { sessionId: opts.sessionId }),
    };
  }

  /** Test/debug hook — derives the rule table from resolved "always" approvals. */
  async inspectStandingRules(): Promise<StandingRules> {
    const rows = await this.db
      .select()
      .from(pendingApprovals)
      .where(
        and(
          eq(pendingApprovals.kind, "approval"),
          eq(pendingApprovals.state, "resolved"),
          eq(pendingApprovals.resolution, "always"),
          sql`${pendingApprovals.data}->>'commandId' IS NOT NULL`,
          sql`${pendingApprovals.data}->>'standingTarget' IS NOT NULL`,
        ),
      );
    const byOwner = new Map<string, Map<string, Set<string>>>();
    for (const r of rows) {
      const ownerKey = String((r.data as Record<string, unknown> | null)?.taskId ?? r.sessionId);
      let cmds = byOwner.get(ownerKey);
      if (!cmds) {
        cmds = new Map();
        byOwner.set(ownerKey, cmds);
      }
      const d = (r.data as Record<string, unknown> | null) ?? {};
      const commandId = String(d.commandId);
      const target = String(d.standingTarget);
      let targets = cmds.get(commandId);
      if (!targets) {
        targets = new Set();
        cmds.set(commandId, targets);
      }
      targets.add(target);
    }
    return { byOwner };
  }

  /** Test/debug hook — clears all inbox rows. Not used by the orchestrator. */
  async reset(): Promise<void> {
    await this.db.delete(pendingApprovals);
  }

  /** Promise that resolves with the recorded resolution when the item is answered (same-process). */
  async wait(itemId: string): Promise<string> {
    const existing = await this.get(itemId);
    if (existing?.state === "resolved") return existing.resolution ?? "";
    return new Promise((resolve) => {
      const arr = this.waiters.get(itemId) ?? [];
      arr.push(resolve);
      this.waiters.set(itemId, arr);
    });
  }

  async reconcile(sessionId: string): Promise<{ pending: InboxItem[]; recap: InboxItem[] }> {
    return {
      pending: await this.pending({ sessionId }),
      recap: await this.list({ sessionId, state: "resolved" }),
    };
  }

  // ---- internals -------------------------------------------------------

  private async addWithIdempotency(input: {
    kind: InboxKind;
    sessionId: string;
    organizationId: string;
    userId: string;
    title: string;
    body?: string;
    inbox: string;
    visibility: InboxVisibility;
    toolCallId?: string;
    options: string[] | null;
    allowText: boolean;
    multi: boolean;
    data: Record<string, unknown> | null;
  }): Promise<InboxItem> {
    if (input.toolCallId) {
      const existing = await this.forToolCall(input.sessionId, input.toolCallId);
      if (existing) return existing;
    }
    const id = crypto.randomUUID();
    await this.db.insert(pendingApprovals).values({
      id,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      state: "pending",
      inbox: input.inbox,
      visibility: input.visibility,
      toolCallId: input.toolCallId ?? null,
      options: input.options,
      allowText: input.allowText,
      multi: input.multi,
      data: input.data ?? {},
      createdAt: this.now(),
    });
    return (await this.get(id))!;
  }

  private async forToolCall(sessionId: string, toolCallId: string): Promise<InboxItem | undefined> {
    const rows = await this.db
      .select()
      .from(pendingApprovals)
      .where(and(eq(pendingApprovals.sessionId, sessionId), eq(pendingApprovals.toolCallId, toolCallId)))
      .limit(1);
    return rows.length > 0 ? this.toItem(rows[0]!) : undefined;
  }

  private toItem(r: ApprovalRow): InboxItem {
    return {
      id: r.id,
      sessionId: r.sessionId,
      organizationId: r.organizationId,
      userId: r.userId,
      kind: r.kind as InboxKind,
      title: r.title,
      body: r.body ?? undefined,
      state: r.state as InboxState,
      resolution: r.resolution ?? undefined,
      inbox: r.inbox,
      visibility: r.visibility as InboxVisibility,
      toolCallId: r.toolCallId ?? undefined,
      options: r.options ?? undefined,
      allowText: r.allowText,
      multi: r.multi,
      data: r.data ?? undefined,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString(),
    };
  }
}
