import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import {
  actorHasPermission,
  defineCommand,
  defineQuery,
  type BusinessModule,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "@chaste/kernel";
import { and, asc, desc, eq, inArray, lt, ne, or, type SQL } from "drizzle-orm";
import { z } from "zod";

const THREAD_READ = "messaging.thread.read";
const THREAD_WRITE = "messaging.thread.write";
const GROUP_CREATE = "messaging.group.create";
const GROUP_MANAGE = "messaging.group.manage";

const threadTypeSchema = z.enum(["direct", "group"]);

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  senderId: z.string(),
  senderName: z.string().nullable(),
  kind: z.string(),
  body: z.string(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deleted: z.boolean(),
});

const memberSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: z.string(),
});

const threadDetailSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: threadTypeSchema,
  name: z.string().nullable(),
  isArchived: z.boolean(),
  members: z.array(memberSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const threadSummarySchema = z.object({
  id: z.string(),
  type: threadTypeSchema,
  name: z.string().nullable(),
  otherMemberNames: z.array(z.string()),
  lastMessageBody: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  lastSenderId: z.string().nullable(),
  lastSenderName: z.string().nullable(),
  unreadCount: z.number(),
  isArchived: z.boolean(),
  updatedAt: z.string(),
});

const DEFAULT_PAGE = 50;

type UserRow = typeof schema.users.$inferSelect;
type ThreadRow = typeof schema.msgThreads.$inferSelect;
type MemberRow = typeof schema.msgThreadMembers.$inferSelect;
type MessageRow = typeof schema.msgMessages.$inferSelect;
type ReadRow = typeof schema.msgReads.$inferSelect;

async function notifyUser(
  db: Db,
  input: {
    organizationId: string;
    userId: string;
    kind?: string;
    title: string;
    body?: string;
    href?: string;
    resourceType?: string;
    resourceId?: string;
  },
): Promise<void> {
  await db.insert(schema.notifications).values({
    organizationId: input.organizationId,
    userId: input.userId,
    kind: input.kind ?? "info",
    title: input.title,
    body: input.body,
    href: input.href,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  });
}

async function getThreadRow(db: Db, orgId: string, threadId: string) {
  const rows = await db
    .select()
    .from(schema.msgThreads)
    .where(and(eq(schema.msgThreads.id, threadId), eq(schema.msgThreads.organizationId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("Thread");
  return row;
}

async function requireMember(db: Db, orgId: string, threadId: string, userId: string) {
  const rows = await db
    .select()
    .from(schema.msgThreadMembers)
    .where(
      and(
        eq(schema.msgThreadMembers.threadId, threadId),
        eq(schema.msgThreadMembers.userId, userId),
      ),
    )
    .limit(1);
  const member = rows[0];
  if (!member) {
    throw new PermissionError("You are not a member of this thread");
  }
  void orgId;
  return member;
}

async function requireThreadAdmin(db: Db, threadId: string, userId: string) {
  const rows = await db
    .select()
    .from(schema.msgThreadMembers)
    .where(
      and(
        eq(schema.msgThreadMembers.threadId, threadId),
        eq(schema.msgThreadMembers.userId, userId),
        eq(schema.msgThreadMembers.role, "admin"),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new PermissionError("Only thread admins can do that");
}

async function resolveMembers(db: Db, orgId: string, userIds: string[]): Promise<UserRow[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const users = await db
    .select()
    .from(schema.users)
    .where(and(inArray(schema.users.id, unique), eq(schema.users.organizationId, orgId)));
  return unique
    .map((id) => users.find((u) => u.id === id))
    .filter((u): u is UserRow => Boolean(u));
}

export function createMessagingModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "messaging",
      name: "Messaging",
      version: "0.1.0",
      description: "Direct and group conversations for the organization",
      dependencies: [],
      permissions: [THREAD_READ, THREAD_WRITE, GROUP_CREATE, GROUP_MANAGE],
      capabilities: ["messaging.threads", "messaging.groups"],
      specialist: {
        id: "messaging",
        displayName: "Messaging Agent",
        description: "Internal conversations, direct messages and groups",
        toolTags: ["messaging"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "messaging.thread.create",
          description: "Open a direct or group conversation",
          permissions: [THREAD_WRITE],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z
            .object({
              kind: threadTypeSchema,
              name: z.string().min(1).max(120).optional(),
              memberIds: z.array(z.string().uuid()).max(200).default([]),
            })
            .superRefine((v, ctx) => {
              if (v.kind === "group" && !v.name) {
                ctx.addIssue({ code: "custom", message: "A group conversation requires a name", path: ["name"] });
              }
              if (v.kind === "group" && v.memberIds.length === 0) {
                ctx.addIssue({ code: "custom", message: "A group needs at least one other member", path: ["memberIds"] });
              }
              if (v.kind === "direct" && v.memberIds.length !== 1) {
                ctx.addIssue({ code: "custom", message: "A direct conversation needs exactly one other member", path: ["memberIds"] });
              }
            }),
          output: threadDetailSchema,
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const me = ctx.actor.userId;
            if (input.kind === "group" && !actorHasPermission(ctx.actor, GROUP_CREATE)) {
              throw new PermissionError(GROUP_CREATE);
            }
            const members = await resolveMembers(db, orgId, [me, ...input.memberIds]);
            if (members.length !== 1 + input.memberIds.length) {
              throw new ValidationError("One or more members are not valid users of this organization");
            }
            // Avoid duplicate direct threads between the same two users.
            if (input.kind === "direct") {
              const other = input.memberIds[0]!;
              const existing = await db
                .select({ threadId: schema.msgThreads.id })
                .from(schema.msgThreads)
                .innerJoin(
                  schema.msgThreadMembers,
                  eq(schema.msgThreadMembers.threadId, schema.msgThreads.id),
                )
                .where(
                  and(
                    eq(schema.msgThreads.organizationId, orgId),
                    eq(schema.msgThreads.type, "direct"),
                    or(
                      eq(schema.msgThreadMembers.userId, me),
                      eq(schema.msgThreadMembers.userId, other),
                    ),
                  ),
                );
              // Existing DM found when both members appear under the same direct thread.
              const candidateIds = [...new Set(existing.map((e) => e.threadId))];
              for (const candidate of candidateIds) {
                const m = await db
                  .select()
                  .from(schema.msgThreadMembers)
                  .where(eq(schema.msgThreadMembers.threadId, candidate));
                const ids = m.map((x) => x.userId).sort();
                if (ids.length === 2 && ids[0] === [me, other].sort()[0] && ids[1] === [me, other].sort()[1]) {
                  const row = await getThreadRow(db, orgId, candidate);
                  return buildThreadDetail(db, row);
                }
              }
            }

            const [thread] = await db
              .insert(schema.msgThreads)
              .values({
                organizationId: orgId,
                type: input.kind,
                name: input.kind === "group" ? input.name : null,
                createdBy: me,
              })
              .returning();
            await db.insert(schema.msgThreadMembers).values({ threadId: thread!.id, userId: me, role: "admin" });
            for (const uid of input.memberIds) {
              await db.insert(schema.msgThreadMembers).values({ threadId: thread!.id, userId: uid, role: "member" });
            }
            return buildThreadDetail(db, thread!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "messaging.thread.send",
          description: "Send a message to a thread you belong to",
          permissions: [THREAD_WRITE],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            threadId: z.string().uuid(),
            body: z.string().min(1).max(8000),
            parentId: z.string().uuid().optional(),
          }),
          output: messageSchema,
          handler: async (input, ctx, helpers) => {
            const orgId = ctx.actor.organizationId;
            const me = ctx.actor.userId;
            await getThreadRow(db, orgId, input.threadId);
            await requireMember(db, orgId, input.threadId, me);
            const displayName = (
              await db.select().from(schema.users).where(eq(schema.users.id, me)).limit(1)
            )[0]?.displayName;
            const [msg] = await db
              .insert(schema.msgMessages)
              .values({
                organizationId: orgId,
                threadId: input.threadId,
                senderId: me,
                kind: "text",
                body: input.body,
                parentId: input.parentId,
              })
              .returning();
            await db
              .update(schema.msgThreads)
              .set({ updatedAt: new Date() })
              .where(eq(schema.msgThreads.id, input.threadId));
            await upsertRead(db, input.threadId, me, msg!.id);

            const others = await db
              .select({ userId: schema.msgThreadMembers.userId })
              .from(schema.msgThreadMembers)
              .where(
                and(
                  eq(schema.msgThreadMembers.threadId, input.threadId),
                  ne(schema.msgThreadMembers.userId, me),
                ),
              );
            for (const other of others) {
              await notifyUser(db, {
                organizationId: orgId,
                userId: other.userId,
                kind: "message",
                title: `${displayName ?? "A colleague"} messaged you`,
                body: input.body.slice(0, 300),
                href: `/messaging?thread=${input.threadId}`,
                resourceType: "thread",
                resourceId: input.threadId,
              });
            }
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "messaging.message.sent",
              organizationId: orgId,
              occurredAt: ctx.now().toISOString(),
              payload: { threadId: input.threadId, messageId: msg!.id, sentById: me },
              correlationId: ctx.requestId,
            });
            return {
              id: msg!.id,
              threadId: msg!.threadId,
              senderId: me,
              senderName: displayName ?? null,
              kind: "text",
              body: input.body,
              parentId: input.parentId ?? null,
              createdAt: ctx.now().toISOString(),
              editedAt: null,
              deleted: false,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "messaging.thread.add_member",
          description: "Add a member to a group conversation",
          permissions: [GROUP_MANAGE],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ threadId: z.string().uuid(), userId: z.string().uuid() }),
          output: threadDetailSchema,
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const thread = await getThreadRow(db, orgId, input.threadId);
            if (thread.type !== "group") throw new ValidationError("Only group conversations can add members");
            await requireMember(db, orgId, input.threadId, ctx.actor.userId);
            await requireThreadAdmin(db, input.threadId, ctx.actor.userId);
            const users = await resolveMembers(db, orgId, [input.userId]);
            if (users.length !== 1) throw new ValidationError("Member is not a valid user of this organization");
            await db
              .insert(schema.msgThreadMembers)
              .values({ threadId: input.threadId, userId: input.userId, role: "member" })
              .onConflictDoNothing({ target: [schema.msgThreadMembers.threadId, schema.msgThreadMembers.userId] });
            await insertSystem(db, orgId, input.threadId, ctx.actor.userId, "added");
            return buildThreadDetail(db, thread);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "messaging.thread.remove_member",
          description: "Remove a member from a group conversation",
          permissions: [GROUP_MANAGE],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ threadId: z.string().uuid(), userId: z.string().uuid() }),
          output: threadDetailSchema,
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const thread = await getThreadRow(db, orgId, input.threadId);
            if (thread.type !== "group") throw new ValidationError("Only group conversations can remove members");
            await requireMember(db, orgId, input.threadId, ctx.actor.userId);
            await requireThreadAdmin(db, input.threadId, ctx.actor.userId);
            if (input.userId === ctx.actor.userId) throw new ValidationError("Use leave to exit a conversation");
            await db
              .delete(schema.msgThreadMembers)
              .where(and(eq(schema.msgThreadMembers.threadId, input.threadId), eq(schema.msgThreadMembers.userId, input.userId)));
            await insertSystem(db, orgId, input.threadId, ctx.actor.userId, "removed");
            return buildThreadDetail(db, thread);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "messaging.thread.leave",
          description: "Leave a conversation",
          permissions: [THREAD_WRITE],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ threadId: z.string().uuid() }),
          output: z.object({ threadId: z.string(), left: z.literal(true) }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            await getThreadRow(db, orgId, input.threadId);
            await db
              .delete(schema.msgThreadMembers)
              .where(and(eq(schema.msgThreadMembers.threadId, input.threadId), eq(schema.msgThreadMembers.userId, ctx.actor.userId)));
            return { threadId: input.threadId, left: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "messaging.thread.rename",
          description: "Rename a group conversation",
          permissions: [GROUP_MANAGE],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ threadId: z.string().uuid(), name: z.string().min(1).max(120) }),
          output: threadDetailSchema,
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const thread = await getThreadRow(db, orgId, input.threadId);
            if (thread.type !== "group") throw new ValidationError("Only group conversations can be renamed");
            await requireMember(db, orgId, input.threadId, ctx.actor.userId);
            await requireThreadAdmin(db, input.threadId, ctx.actor.userId);
            const [updated] = await db
              .update(schema.msgThreads)
              .set({ name: input.name, updatedAt: new Date() })
              .where(and(eq(schema.msgThreads.id, input.threadId), eq(schema.msgThreads.organizationId, orgId)))
              .returning();
            await insertSystem(db, orgId, input.threadId, ctx.actor.userId, "renamed");
            void thread;
            return buildThreadDetail(db, updated!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "messaging.thread.archive",
          description: "Archive or unarchive a conversation you belong to",
          permissions: [THREAD_READ],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ threadId: z.string().uuid(), archived: z.boolean() }),
          output: threadDetailSchema,
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const thread = await getThreadRow(db, orgId, input.threadId);
            await requireMember(db, orgId, input.threadId, ctx.actor.userId);
            const [updated] = await db
              .update(schema.msgThreads)
              .set({ isArchived: input.archived, updatedAt: new Date() })
              .where(and(eq(schema.msgThreads.id, input.threadId), eq(schema.msgThreads.organizationId, orgId)))
              .returning();
            void thread;
            return buildThreadDetail(db, updated!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "messaging.thread.mark_read",
          description: "Advance your read cursor in a conversation",
          permissions: [THREAD_READ],
          tags: ["messaging"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ threadId: z.string().uuid(), lastReadMessageId: z.string().uuid().optional() }),
          output: z.object({ threadId: z.string(), read: z.literal(true) }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            await getThreadRow(db, orgId, input.threadId);
            await requireMember(db, orgId, input.threadId, ctx.actor.userId);
            await db
              .insert(schema.msgReads)
              .values({
                threadId: input.threadId,
                userId: ctx.actor.userId,
                lastReadMessageId: input.lastReadMessageId ?? null,
                lastReadAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [schema.msgReads.threadId, schema.msgReads.userId],
                set: {
                  lastReadMessageId: input.lastReadMessageId ?? null,
                  lastReadAt: new Date(),
                },
              });
            return { threadId: input.threadId, read: true as const };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "messaging.thread.list",
          description: "List your conversations with preview and unread counts",
          permissions: [THREAD_READ],
          tags: ["messaging"],
          input: z.object({ includeArchived: z.boolean().default(false) }).default({}),
          output: z.object({ items: z.array(threadSummarySchema) }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const me = ctx.actor.userId;
            const threadCond: (SQL | undefined)[] = [
              eq(schema.msgThreadMembers.userId, me),
              eq(schema.msgThreads.organizationId, orgId),
            ];
            if (!input.includeArchived) {
              threadCond.push(eq(schema.msgThreads.isArchived, false));
            }
            const threadsJoin = await db
              .select({ thread: schema.msgThreads })
              .from(schema.msgThreads)
              .innerJoin(
                schema.msgThreadMembers,
                eq(schema.msgThreadMembers.threadId, schema.msgThreads.id),
              )
              .where(and(...threadCond))
              .orderBy(desc(schema.msgThreads.updatedAt));
            const threadRows = threadsJoin.map((r) => r.thread);
            const threadIds = threadRows.map((t) => t.id);
            if (threadIds.length === 0) return { items: [] };

            // All members of these threads (for names).
            const allMembers: MemberRow[] = await db
              .select()
              .from(schema.msgThreadMembers)
              .where(inArray(schema.msgThreadMembers.threadId, threadIds));
            const memberUserIds = [...new Set(allMembers.map((m) => m.userId))];
            const nameRows: UserRow[] = memberUserIds.length
              ? await db
                  .select()
                  .from(schema.users)
                  .where(and(inArray(schema.users.id, memberUserIds), eq(schema.users.organizationId, orgId)))
              : [];
            const nameById = new Map<string, string>(nameRows.map((u) => [u.id, u.displayName]));
            const byThread = new Map<string, MemberRow[]>();
            for (const m of allMembers) {
              const arr = byThread.get(m.threadId) ?? [];
              arr.push(m);
              byThread.set(m.threadId, arr);
            }

            // Read cursors for me.
            const reads: ReadRow[] = await db
              .select()
              .from(schema.msgReads)
              .where(and(inArray(schema.msgReads.threadId, threadIds), eq(schema.msgReads.userId, me)));
            const readAt = new Map<string, Date | null>(reads.map((r) => [r.threadId, r.lastReadAt]));

            // Messages for these threads (bounded for alpha: last 200 per thread).
            const lastMessages: MessageRow[] = await db
              .select()
              .from(schema.msgMessages)
              .where(and(inArray(schema.msgMessages.threadId, threadIds), eq(schema.msgMessages.organizationId, orgId)))
              .orderBy(asc(schema.msgMessages.createdAt));
            const byThreadMsgs = new Map<string, MessageRow[]>();
            for (const m of lastMessages) {
              const arr = byThreadMsgs.get(m.threadId) ?? [];
              arr.push(m);
              byThreadMsgs.set(m.threadId, arr);
            }

            return {
              items: threadRows.map((t) => {
                const others = (byThread.get(t.id) ?? [])
                  .filter((m) => m.userId !== me)
                  .map((m) => nameById.get(m.userId) ?? "Unknown");
                const msgs = byThreadMsgs.get(t.id) ?? [];
                const last = msgs[msgs.length - 1];
                const cursor = readAt.get(t.id);
                const unread = msgs.filter(
                  (m) => m.kind === "text" && m.senderId !== me && (cursor == null || m.createdAt > cursor),
                ).length;
                return {
                  id: t.id,
                  type: t.type as "direct" | "group",
                  name: t.name,
                  otherMemberNames: others,
                  lastMessageBody: last ? (last.deletedAt ? "[deleted]" : last.body) : null,
                  lastMessageAt: last?.createdAt.toISOString() ?? null,
                  lastSenderId: last?.senderId ?? null,
                  lastSenderName: last ? (nameById.get(last.senderId) ?? "Unknown") : null,
                  unreadCount: unread,
                  isArchived: t.isArchived,
                  updatedAt: t.updatedAt.toISOString(),
                };
              }),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "messaging.thread.get",
          description: "Get a conversation with its members and messages",
          permissions: [THREAD_READ],
          tags: ["messaging"],
          input: z.object({
            threadId: z.string().uuid(),
            before: z.string().optional(),
            limit: z.number().int().min(1).max(200).optional(),
          }),
          output: z.object({
            thread: threadDetailSchema,
            messages: z.array(messageSchema),
            nextCursor: z.string().nullable(),
          }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const thread = await getThreadRow(db, orgId, input.threadId);
            await requireMember(db, orgId, input.threadId, ctx.actor.userId);
            const limit = input.limit ?? DEFAULT_PAGE;
            const conds = [
              eq(schema.msgMessages.threadId, input.threadId),
              eq(schema.msgMessages.organizationId, orgId),
            ];
            if (input.before) {
              conds.push(lt(schema.msgMessages.createdAt, new Date(input.before)));
            }
            const rows = await db
              .select()
              .from(schema.msgMessages)
              .where(and(...conds))
              .orderBy(desc(schema.msgMessages.createdAt))
              .limit(limit + 1);
            const hasMore = rows.length > limit;
            const page = rows.slice(0, limit).reverse();
            const senders = [...new Set(page.map((m) => m.senderId))];
            const sendersRows: UserRow[] = senders.length
              ? await db.select().from(schema.users).where(inArray(schema.users.id, senders))
              : [];
            const sendName = new Map<string, string>(sendersRows.map((u) => [u.id, u.displayName]));
            return {
              thread: await buildThreadDetail(db, thread),
              messages: page.map((m) => ({
                id: m.id,
                threadId: m.threadId,
                senderId: m.senderId,
                senderName: sendName.get(m.senderId) ?? null,
                kind: m.kind,
                body: m.body,
                parentId: m.parentId,
                createdAt: m.createdAt.toISOString(),
                editedAt: m.editedAt?.toISOString() ?? null,
                deleted: m.deletedAt !== null,
              })),
              nextCursor: hasMore ? page[0]?.createdAt.toISOString() ?? null : null,
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "messaging.unread.count",
          description: "Total unread messages across your conversations",
          permissions: [THREAD_READ],
          tags: ["messaging"],
          input: z.object({}).default({}),
          output: z.object({ unread: z.number() }),
          handler: async (_input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const me = ctx.actor.userId;
            const threads = await db
              .select({ threadId: schema.msgThreadMembers.threadId })
              .from(schema.msgThreadMembers)
              .innerJoin(schema.msgThreads, eq(schema.msgThreads.id, schema.msgThreadMembers.threadId))
              .where(and(eq(schema.msgThreadMembers.userId, me), eq(schema.msgThreads.organizationId, orgId)));
            const threadIds = threads.map((r) => r.threadId);
            if (threadIds.length === 0) return { unread: 0 };
            const reads: ReadRow[] = await db
              .select()
              .from(schema.msgReads)
              .where(and(inArray(schema.msgReads.threadId, threadIds), eq(schema.msgReads.userId, me)));
            const readAt = new Map<string, Date | null>(reads.map((r) => [r.threadId, r.lastReadAt]));
            const msgs: MessageRow[] = await db
              .select()
              .from(schema.msgMessages)
              .where(and(inArray(schema.msgMessages.threadId, threadIds), eq(schema.msgMessages.organizationId, orgId)));
            const unread = msgs.filter((m) => {
              const cursor = readAt.get(m.threadId);
              return m.kind === "text" && m.senderId !== me && (cursor == null || m.createdAt > cursor);
            }).length;
            return { unread };
          },
        }),
      );
    },
  };
}

async function upsertRead(db: Db, threadId: string, userId: string, messageId: string) {
  await db
    .insert(schema.msgReads)
    .values({ threadId, userId, lastReadMessageId: messageId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.msgReads.threadId, schema.msgReads.userId],
      set: { lastReadMessageId: messageId, lastReadAt: new Date() },
    });
}

async function insertSystem(
  db: Db,
  orgId: string,
  threadId: string,
  actorUserId: string,
  action: "added" | "removed" | "renamed",
) {
  const actor = (
    await db.select().from(schema.users).where(eq(schema.users.id, actorUserId)).limit(1)
  )[0];
  const text =
    action === "added"
      ? `${actor?.displayName ?? "Someone"} added a member`
      : action === "removed"
        ? `${actor?.displayName ?? "Someone"} removed a member`
        : `${actor?.displayName ?? "Someone"} renamed the conversation`;
  await db
    .insert(schema.msgMessages)
    .values({ organizationId: orgId, threadId, senderId: actorUserId, kind: "system", body: text });
}

async function buildThreadDetail(db: Db, thread: ThreadRow) {
  const memberRows = await db
    .select()
    .from(schema.msgThreadMembers)
    .where(eq(schema.msgThreadMembers.threadId, thread.id));
  const userIds = memberRows.map((m) => m.userId);
  const users = (userIds.length
    ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds))
    : []) as UserRow[];
  const byId = new Map<UserRow["id"], UserRow>(users.map((u) => [u.id, u]));
  return {
    id: thread.id,
    organizationId: thread.organizationId,
    type: thread.type as "direct" | "group",
    name: thread.name,
    isArchived: thread.isArchived,
    members: memberRows.map((m) => {
      const u = byId.get(m.userId);
      return { userId: m.userId, displayName: u?.displayName ?? "Unknown", email: u?.email ?? "", role: m.role };
    }),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}