import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  customers,
  getDb,
  supportConversations,
  supportMessages,
} from "@chaste/db";
import { hasPermission as hasPermissionFor } from "@chaste/kernel";
import { actorFromResolved, buildExecutor, buildRegistry, consoleNotifications } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { checkRateLimit } from "@/server/rate-limit";
import { SupportDraftError, draftSupportReply } from "@/server/support-agent";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), customerId: z.string().uuid(), subject: z.string().min(1).max(200) }),
  z.object({
    action: z.literal("message"),
    conversationId: z.string().uuid(),
    body: z.string().min(1).max(4000),
    // Staff record either side of the exchange; agents are recorded as agents.
    from: z.enum(["customer", "staff"]).default("staff"),
  }),
  z.object({ action: z.literal("draft"), conversationId: z.string().uuid() }),
  z.object({
    action: z.literal("send"),
    conversationId: z.string().uuid(),
    body: z.string().min(1).max(4000),
  }),
  z.object({
    action: z.literal("escalate"),
    conversationId: z.string().uuid(),
    reason: z.string().min(3).max(4000),
  }),
  z.object({ action: z.literal("resolve"), conversationId: z.string().uuid() }),
]);

/** Conversation list with customer names and last activity. */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!supportEnabled(resolved)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!hasPermissionFor({ permissions: resolved.permissions }, "support.read")) {
    return NextResponse.json({ error: "forbidden: missing permission: support.read" }, { status: 403 });
  }
  const db = getDb().db;
  const conversationId = new URL(req.url).searchParams.get("id");

  if (conversationId) {
    const [conv] = await db
      .select({
        id: supportConversations.id,
        customerId: supportConversations.customerId,
        customerName: customers.name,
        subject: supportConversations.subject,
        status: supportConversations.status,
      })
      .from(supportConversations)
      .innerJoin(customers, eq(customers.id, supportConversations.customerId))
      .where(
        and(eq(supportConversations.id, conversationId), eq(supportConversations.orgId, resolved.orgId)),
      )
      .limit(1);
    if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
    const messages = await db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.conversationId, conversationId))
      .orderBy(supportMessages.createdAt)
      .limit(200);
    return NextResponse.json({ conversation: conv, messages });
  }

  const rows = (await db.execute(sql`
    SELECT c.id, c.customer_id AS "customerId", cu.name AS "customerName",
           c.subject, c.status,
           COALESCE(m.created_at, c.created_at) AS "lastMessageAt",
           left(m.body, 140) AS "lastMessagePreview"
    FROM support_conversations c
    JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = ${resolved.orgId}
    LEFT JOIN LATERAL (
      SELECT body, created_at FROM support_messages sm
      WHERE sm.conversation_id = c.id ORDER BY created_at DESC LIMIT 1
    ) m ON true
    WHERE c.org_id = ${resolved.orgId}
    ORDER BY COALESCE(m.created_at, c.created_at) DESC
    LIMIT 100
  `)) as unknown;
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  return NextResponse.json({
    conversations: list.map((r) => ({
      id: String(r.id),
      customerId: String(r.customerId),
      customerName: String(r.customerName),
      subject: String(r.subject),
      status: String(r.status),
      lastMessageAt: r.lastMessageAt ? new Date(String(r.lastMessageAt)).toISOString() : null,
      lastMessagePreview: r.lastMessagePreview == null ? "" : String(r.lastMessagePreview),
    })),
  });
}

function supportEnabled(resolved: { enabledModules?: string[] | null }): boolean {
  return resolved.enabledModules == null || resolved.enabledModules.includes("support");
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!supportEnabled(resolved)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const input = parsed.data;

  const needsWrite = input.action !== "draft";
  if (needsWrite && !hasPermissionFor({ permissions: resolved.permissions }, "support.write")) {
    return NextResponse.json({ error: "forbidden: missing permission: support.write" }, { status: 403 });
  }
  if (input.action === "draft" && !hasPermissionFor({ permissions: resolved.permissions }, "support.read")) {
    return NextResponse.json({ error: "forbidden: missing permission: support.read" }, { status: 403 });
  }

  const db = getDb().db;

  // Drafting triggers paid model calls; bound per user per conversation.
  if (input.action === "draft") {
    const limit = checkRateLimit(`support-api:${resolved.userId}`, { max: 30, windowMs: 60_000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "too many requests" },
        { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
      );
    }
  }

  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const executorNeedsActor = input.action !== "draft";
  const ctx = executorNeedsActor ? actorFromResolved(resolved, { asAgent: false }) : null;
  if (executorNeedsActor && !ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  switch (input.action) {
    case "create": {
      const result = await executor.execute(
        "support.startConversation",
        ctx!,
        { customerId: input.customerId, subject: input.subject },
      );
      return respond(result);
    }
    case "message": {
      const result = await executor.execute(
        "support.postMessage",
        ctx!,
        { conversationId: input.conversationId, body: input.body, from: input.from },
      );
      return respond(result);
    }
    case "send": {
      // A released AI draft is recorded with agent provenance plus the
      // releasing human, so the record shows exactly who sent what.
      const result = await executor.execute(
        "support.postMessage",
        actorFromResolved(resolved, { asAgent: true })!,
        { conversationId: input.conversationId, body: input.body },
      );
      return respond(result);
    }
    case "escalate": {
      const result = await executor.execute(
        "support.escalateConversation",
        ctx!,
        { conversationId: input.conversationId, reason: input.reason },
      );
      if (result.ok) {
        // Escalation is a human-handoff signal; reuse the ticket sink so
        // webhook and email subscribers hear about it like any other gap.
        void consoleNotifications.ticketFiled(
          `Support escalation: thread ${input.conversationId.slice(0, 8)} — ${input.reason.slice(0, 120)}`,
          resolved.orgId,
        );
      }
      return respond(result);
    }
    case "resolve": {
      const result = await executor.execute("support.resolveConversation", ctx!, {
        conversationId: input.conversationId,
      });
      return respond(result);
    }
    default: {
      try {
        const draftResult = await draftSupportReply({
          db,
          registry,
          resolved: { userId: resolved.userId, orgId: resolved.orgId },
          conversationId: input.conversationId,
        });
        return NextResponse.json(draftResult);
      } catch (err) {
        if (err instanceof SupportDraftError) {
          return NextResponse.json({ error: err.message }, { status: err.code });
        }
        throw err;
      }
    }
  }
}

type ExecResult = { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown };
function respond(result: ExecResult) {
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data ?? {} });
}
