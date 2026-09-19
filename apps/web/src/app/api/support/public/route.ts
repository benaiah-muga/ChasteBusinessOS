import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import {
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
 * Public boundary for the embeddable customer-care widget (N04).
 *
 * Identity containment: a visitor-supplied email never binds a customer.
 * Widget conversations start UNBOUND - the email is stored on the thread
 * with a per-conversation secret (hashed, issued once), and only verified
 * staff action may attach a real customer. Knowing a former customer's
 * email plus the public token therefore reveals nothing about them: no
 * account facts, no invoice history, no drafts bound to their record.
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
    secret: z.string().min(16),
    body: z.string().min(1).max(MESSAGE_MAX),
  }),
  z.object({
    action: z.literal("human"),
    token: z.string().min(16),
    conversationId: z.string().uuid(),
    secret: z.string().min(16),
  }),
]);

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

function secretMatches(stored: string | null | undefined, presented: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(hashSecret(presented), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  const secret = url.searchParams.get("secret") ?? "";
  const after = url.searchParams.get("after") ?? "";
  const org = await loadOrgByToken(token);
  if (!org) return NextResponse.json({ error: "unknown widget" }, { status: 404 });
  const limit = checkRateLimit(`widget-poll:${ipOf(req)}:${org.orgId}`, { max: 120, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const db = getDb().db;
  const [conv] = await db
    .select({ status: supportConversations.status, visitorSecretHash: supportConversations.visitorSecretHash })
    .from(supportConversations)
    .where(and(eq(supportConversations.id, conversationId), eq(supportConversations.orgId, org.orgId)))
    .limit(1);
  // The thread address is guessable (a uuid in client hands); the secret is
  // what makes the thread the visitor's. No match, no messages.
  if (!conv || !secretMatches(conv.visitorSecretHash, secret))
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
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
    // N04 containment: the conversation starts UNBOUND. The email is contact
    // information on the thread, never a customer binding - a visitor naming
    // an existing customer's address cannot see or touch that customer's
    // account. Verified staff bind a customer later, on the record.
    const secret = randomBytes(24).toString("hex");
    const [conv] = await db
      .insert(supportConversations)
      .values({
        orgId: org.orgId,
        customerId: null,
        visitorEmail: data.email.toLowerCase(),
        visitorSecretHash: hashSecret(secret),
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
    // The secret is returned exactly once; only its hash is stored.
    return NextResponse.json({ conversationId: conv!.id, secret });
  }

  // Both remaining actions address an existing conversation: the org token
  // narrows the tenant, the visitor secret proves the thread.
  const [conv] = await db
    .select({
      id: supportConversations.id,
      status: supportConversations.status,
      visitorSecretHash: supportConversations.visitorSecretHash,
    })
    .from(supportConversations)
    .where(and(eq(supportConversations.id, data.conversationId), eq(supportConversations.orgId, org.orgId)))
    .limit(1);
  if (!conv || !secretMatches(conv.visitorSecretHash, data.secret))
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });

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

  // Auto-reply only while open: escalated threads belong to humans. For an
  // unbound thread the care agent's order tool honestly reports "no account
  // on file", so replies can lean on published knowledge, never account
  // facts (N04).
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
