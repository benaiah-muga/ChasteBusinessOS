import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  customers,
  getDb,
  memberships,
  supportConversations,
  supportMessages,
  supportSettings,
} from "@chaste/db";
import { buildRegistry } from "@/server/kernel";
import { checkRateLimit } from "@/server/rate-limit";
import { SupportDraftError, draftSupportReply } from "@/server/support-agent";

/**
 * Public boundary for the embeddable customer-care widget. Auth is the
 * per-org embed token; behavior is fixed server code, never model-driven
 * input. Only this conversation's own messages are ever readable.
 */

const MESSAGE_MAX = 2000;
const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    token: z.string().min(16),
    name: z.string().min(1).max(80).optional(),
    email: z.string().email(),
    subject: z.string().min(1).max(200).optional(),
  }),
  z.object({
    action: z.literal("message"),
    token: z.string().min(16),
    conversationId: z.string().uuid(),
    body: z.string().min(1).max(MESSAGE_MAX),
  }),
  z.object({
    action: z.literal("human"),
    token: z.string().min(16),
    conversationId: z.string().uuid(),
  }),
]);

async function loadOrgByToken(token: string) {
  const db = getDb().db;
  const [row] = await db
    .select({ orgId: supportSettings.orgId, autoReply: supportSettings.autoReplyEnabled })
    .from(supportSettings)
    .where(eq(supportSettings.embedToken, token))
    .limit(1);
  return row ?? null;
}

function ipOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const conversationId = url.searchParams.get("conversationId") ?? "";
  const after = url.searchParams.get("after") ?? "";
  const org = await loadOrgByToken(token);
  if (!org) return NextResponse.json({ error: "unknown widget" }, { status: 404 });
  const limit = checkRateLimit(`widget-poll:${ipOf(req)}:${org.orgId}`, { max: 120, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const db = getDb().db;
  const [conv] = await db
    .select({ status: supportConversations.status })
    .from(supportConversations)
    .where(and(eq(supportConversations.id, conversationId), eq(supportConversations.orgId, org.orgId)))
    .limit(1);
  if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  const rows = await db
    .select({
      id: supportMessages.id,
      senderType: supportMessages.senderType,
      body: supportMessages.body,
      createdAt: supportMessages.createdAt,
    })
    .from(supportMessages)
    .where(
      and(
        eq(supportMessages.conversationId, conversationId),
        after ? gt(supportMessages.createdAt, new Date(after)) : undefined,
      ),
    )
    .orderBy(asc(supportMessages.createdAt))
    .limit(100);
  return NextResponse.json({ status: conv.status, messages: rows });
}

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const data = parsed.data;
  const org = await loadOrgByToken(data.token);
  if (!org) return NextResponse.json({ error: "unknown widget" }, { status: 404 });
  const limit = checkRateLimit(`widget-post:${ipOf(req)}:${org.orgId}`, { max: 12, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "too many messages; try again shortly" }, { status: 429 });
  const db = getDb().db;

  if (data.action === "start") {
    // Find-or-create the visitor as a customer so the whole desk pipeline
    // (binding, order lookup, history) works unchanged for widget traffic.
    let [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.orgId, org.orgId), eq(customers.email, data.email)))
      .limit(1);
    if (!customer) {
      [customer] = await db
        .insert(customers)
        .values({
          orgId: org.orgId,
          name: data.name?.trim() || data.email.split("@")[0] || "Website visitor",
          email: data.email,
        })
        .returning({ id: customers.id });
    }
    const [conv] = await db
      .insert(supportConversations)
      .values({
        orgId: org.orgId,
        customerId: customer!.id,
        subject: (data.subject?.trim() || "Website chat").slice(0, 200),
        createdByActorType: "widget",
      })
      .returning({ id: supportConversations.id });
    const [settings] = await db
      .select({ greeting: supportSettings.greeting })
      .from(supportSettings)
      .where(eq(supportSettings.orgId, org.orgId))
      .limit(1);
    await db.insert(supportMessages).values({
      orgId: org.orgId,
      conversationId: conv!.id,
      senderType: "system",
      body: settings?.greeting ?? "Hello! How can we help?",
    });
    return NextResponse.json({ conversationId: conv!.id });
  }

  // Both remaining actions address an existing conversation: verify it
  // belongs to the token's org before anything else.
  const [conv] = await db
    .select({ id: supportConversations.id, status: supportConversations.status })
    .from(supportConversations)
    .where(and(eq(supportConversations.id, data.conversationId), eq(supportConversations.orgId, org.orgId)))
    .limit(1);
  if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  if (data.action === "human") {
    await db
      .update(supportConversations)
      .set({ status: "escalated", updatedAt: new Date() })
      .where(eq(supportConversations.id, conv.id));
    await db.insert(supportMessages).values({
      orgId: org.orgId,
      conversationId: conv.id,
      senderType: "system",
      body: "A human teammate has been called in.",
    });
    return NextResponse.json({ ok: true, status: "escalated" });
  }

  if (conv.status === "resolved")
    return NextResponse.json({ error: "this conversation is closed" }, { status: 409 });
  await db.insert(supportMessages).values({
    orgId: org.orgId,
    conversationId: conv.id,
    senderType: "customer",
    body: data.body.slice(0, MESSAGE_MAX),
  });
  await db
    .update(supportConversations)
    .set({ updatedAt: new Date() })
    .where(eq(supportConversations.id, conv.id));

  // Auto-reply only while open: escalated threads belong to humans.
  let replied = false;
  if (org.autoReply && conv.status === "open") {
    try {
      const [owner] = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.orgId, org.orgId))
        .limit(1);
      if (owner) {
        const draft = await draftSupportReply({
          db,
          registry: buildRegistry(db),
          resolved: { userId: owner.userId, orgId: org.orgId },
          conversationId: conv.id,
        });
        await db.insert(supportMessages).values({
          orgId: org.orgId,
          conversationId: conv.id,
          senderType: "agent",
          body: draft.draft.slice(0, MESSAGE_MAX),
        });
        replied = true;
      }
    } catch (err) {
      if (!(err instanceof SupportDraftError))
        console.warn("[widget] auto-reply failed:", err instanceof Error ? err.message : err);
      // Draft failures stay silent for the visitor; staff see the open thread.
    }
  }
  return NextResponse.json({ ok: true, replied });
}
