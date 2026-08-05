/**
 * Channel session bindings — ported from OpenWorker `coworker/mentions.py`,
 * adapted for our multi-tenant + branch-aware model.
 *
 * The store is the durable source of truth for "this inbound message belongs to
 * this session": when an `@chaste-assistant` mention arrives from a Slack channel
 * with no subscribed session, the router spawns a chat session that OWNS that
 * thread and replies into it. A single record per thread target string
 * (`"slack:C0123:1700….000100"`), byte-identical to what the orchestrator
 * uses for delivery and for the standing-grant target — so one string serves
 * lookup, delivery, and permission.
 *
 * Organization + branch columns mean inbound sessions resolve to a tenant scope
 * on arrival, never at response time.
 */

export interface ChannelThreadBinding {
  /** `"platform:chatId:threadTs"` — the reply/grant target. */
  threadTarget: string;
  sessionId: string;
  organizationId: string;
  branchId?: string;
  /** Platform-only chat id (`"platform:chatId"`), for cleanup/debugging. */
  channel: string;
  createdAt: string;
}

export interface ChannelSessionStoreOptions {
  now?: () => Date;
}

export class ChannelSessionStore {
  private readonly threads = new Map<string, ChannelThreadBinding>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly now: () => Date;

  constructor(opts: ChannelSessionStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Upsert — a respawn over a deleted session overwrites the old mapping. */
  set(
    threadTarget: string,
    sessionId: string,
    channel: string,
    extras: { organizationId: string; branchId?: string } = { organizationId: "" },
  ): ChannelThreadBinding {
    const existing = this.threads.get(threadTarget);
    // When a thread target is re-bound to a *different* session, the previous
    // owner's bySession index must forget it — otherwise deleting the old
    // session via removeSession() would clobber this fresh binding because the
    // old session's target set still points at the (now re-pointed) thread.
    if (existing && existing.sessionId !== sessionId) {
      const oldOwners = this.bySession.get(existing.sessionId);
      if (oldOwners) {
        oldOwners.delete(threadTarget);
        if (oldOwners.size === 0) this.bySession.delete(existing.sessionId);
      }
    }
    const rec: ChannelThreadBinding = {
      threadTarget,
      sessionId,
      organizationId: extras.organizationId,
      branchId: extras.branchId,
      channel,
      createdAt: existing?.createdAt ?? this.now().toISOString(),
    };
    this.threads.set(threadTarget, rec);
    let s = this.bySession.get(sessionId);
    if (!s) {
      s = new Set();
      this.bySession.set(sessionId, s);
    }
    s.add(threadTarget);
    return rec;
  }

  get(threadTarget: string): ChannelThreadBinding | undefined {
    return this.threads.get(threadTarget);
  }

  /** Every thread this session owns — the grant re-seed set on engine rebuild. */
  targetsFor(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** Drop all of a session's thread mappings (called when it is deleted). */
  removeSession(sessionId: string): number {
    const targets = this.bySession.get(sessionId);
    if (!targets) return 0;
    let removed = 0;
    for (const t of targets) {
      if (this.threads.delete(t)) removed += 1;
    }
    this.bySession.delete(sessionId);
    return removed;
  }

  list(filter: { organizationId?: string; channel?: string } = {}): ChannelThreadBinding[] {
    const out: ChannelThreadBinding[] = [];
    for (const t of this.threads.values()) {
      if (filter.organizationId !== undefined && t.organizationId !== filter.organizationId) continue;
      if (filter.channel !== undefined && t.channel !== filter.channel) continue;
      out.push(t);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  reset(): void {
    this.threads.clear();
    this.bySession.clear();
  }
}
