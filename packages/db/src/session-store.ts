/**
 * DB-backed session store for AI conversation memory.
 * Uses normalized chat_sessions + chat_messages tables.
 * Stores full ChatMessage JSON (id, role, parts, createdAt) in the parts column
 * as a single-row-per-message approach.
 */
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { chatMessages, chatSessions } from "./schema.js";

/** Stored message — full ChatMessage serialized as parts column content. */
export interface StoredMessage {
  id: string;
  role: string;
  parts: unknown[];
  createdAt: string;
}

export interface DbSession {
  id: string;
  /** Owner — used to enforce session ownership (F4): only the owner may load a session. */
  userId: string;
  messages: StoredMessage[];
  /**
   * In-chat pending state: either a command/plan confirmation
   * (PendingConfirmation) or a natural-language clarification request
   * (PendingClarification). Kept structurally open so the DB layer does not
   * depend on @chaste/ai-core types.
   */
  pending?: { id: string; createdAt: string; [key: string]: unknown };
  /** R3 — session is unattended: approvals park in the cross-session Inbox. */
  unattended?: boolean;
  /** R6 — compaction watermark/summary state for the session. */
  compactionState?: unknown | null;
  createdAt: Date;
}

export interface SessionStore {
  load(sessionId: string): Promise<DbSession | undefined>;
  loadByOrgUser(orgId: string, userId: string): Promise<DbSession | undefined>;
  save(
    sessionId: string,
    messages: StoredMessage[],
    /**
     * Opaque JSON pending state (command confirmation or clarification). The
     * DB layer must not depend on @chaste/ai-core types, so the boundary is
     * `unknown` and the JSONB write casts at the implementation. Serializers
     * (e.g. PendingState) satisfy this structurally.
     */
    pending?: unknown,
    opts?: { unattended?: boolean; compactionState?: unknown | null },
  ): Promise<void>;
  create(sessionId: string, orgId: string, userId: string): Promise<void>;
}

export class DbSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async load(sessionId: string): Promise<DbSession | undefined> {
    // Load session metadata for pending
    const sessionRow = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRow.length === 0) return undefined;
    const sess = sessionRow[0]!;

    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    if (rows.length === 0) {
      return {
        id: sessionId,
        userId: sess.userId,
        messages: [],
        pending: (sess.pending as DbSession["pending"]) ?? undefined,
        unattended: sess.unattended ?? undefined,
        compactionState: sess.compactionState,
        createdAt: sess.createdAt,
      };
    }

    // Each row's `parts` column stores a full ChatMessage wrapped in an array
    const messages: StoredMessage[] = rows.map((r) => {
      const stored = r.parts as unknown[];
      const msg = (stored[0] ?? stored) as StoredMessage;
      return {
        id: msg.id ?? r.id,
        role: msg.role ?? r.role,
        parts: msg.parts ?? [],
        createdAt: msg.createdAt ?? r.createdAt.toISOString(),
      };
    });

    return {
      id: sessionId,
      userId: sess.userId,
      messages,
      pending: (sess.pending as DbSession["pending"]) ?? undefined,
      unattended: sess.unattended ?? undefined,
      compactionState: sess.compactionState,
      createdAt: sess.createdAt,
    };
  }

  async loadByOrgUser(orgId: string, userId: string): Promise<DbSession | undefined> {
    const sessions = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.organizationId, orgId))
      .limit(10);

    const userSessions = sessions
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (userSessions.length === 0) return undefined;
    const latest = userSessions[0]!;
    return this.load(latest.id);
  }

  async save(
    sessionId: string,
    messages: StoredMessage[],
    pending?: unknown,
    opts?: { unattended?: boolean; compactionState?: unknown | null },
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (existing.length === 0) {
      throw new Error(`Session ${sessionId} does not exist. Call create() first.`);
    }

    // Update pending + runtime state on the session. `pending` is opaque JSON;
    // narrow to the JSONB column type at the boundary.
    await this.db
      .update(chatSessions)
      .set({
        pending: (pending ?? null) as unknown as (typeof chatSessions.$inferInsert)["pending"],
        unattended: opts?.unattended ?? false,
        compactionState: opts?.compactionState ?? null,
      })
      .where(eq(chatSessions.id, sessionId));

    // Delete existing messages
    await this.db.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId));

    // Insert each ChatMessage as a single row — store the full message as the JSON payload
    if (messages.length > 0) {
      await this.db.insert(chatMessages).values(
        messages.map((m) => ({
          sessionId,
          role: m.role,
          parts: [m] as unknown[],
        })),
      );
    }
  }

  async create(sessionId: string, orgId: string, userId: string): Promise<void> {
    await this.db.insert(chatSessions).values({
      id: sessionId,
      organizationId: orgId,
      userId,
    });
  }
}
