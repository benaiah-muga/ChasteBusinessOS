import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  customers,
  getDb,
  marketingCampaigns,
  marketingSegments,
  marketingSends,
} from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Marketing-lite (M13). Reads are direct org-scoped drizzle queries; every
 * write/report goes through the module's governed capabilities so humans and
 * agents share one audited path.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;

  const segmentRows = await db
    .select({
      id: marketingSegments.id,
      name: marketingSegments.name,
      minSpendMinor: marketingSegments.minSpendMinor,
      createdAt: marketingSegments.createdAt,
    })
    .from(marketingSegments)
    .where(eq(marketingSegments.orgId, resolved.orgId))
    .orderBy(desc(marketingSegments.createdAt))
    .limit(100);

  const campaignRows = await db
    .select({
      id: marketingCampaigns.id,
      segmentId: marketingCampaigns.segmentId,
      name: marketingCampaigns.name,
      subject: marketingCampaigns.subject,
      body: marketingCampaigns.body,
      sentAt: marketingCampaigns.sentAt,
      createdAt: marketingCampaigns.createdAt,
    })
    .from(marketingCampaigns)
    .where(eq(marketingCampaigns.orgId, resolved.orgId))
    .orderBy(desc(marketingCampaigns.createdAt))
    .limit(100);

  const sendCountRows = await db
    .select({ campaignId: marketingSends.campaignId, count: sql<number>`count(*)` })
    .from(marketingSends)
    .where(eq(marketingSends.orgId, resolved.orgId))
    .groupBy(marketingSends.campaignId);

  // The send log IS the analytics: show it, honestly, with no derived guesses.
  const recentSendRows = await db
    .select({
      id: marketingSends.id,
      campaignId: marketingSends.campaignId,
      customerName: customers.name,
      customerEmail: customers.email,
      sentAt: marketingSends.sentAt,
    })
    .from(marketingSends)
    .innerJoin(customers, eq(customers.id, marketingSends.customerId))
    .where(eq(marketingSends.orgId, resolved.orgId))
    .orderBy(desc(marketingSends.sentAt))
    .limit(50);

  return NextResponse.json({
    segments: segmentRows.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
    campaigns: campaignRows.map((c) => ({
      ...c,
      sentAt: c.sentAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    sendCounts: sendCountRows.map((r) => ({ campaignId: r.campaignId, count: Number(r.count) })),
    recentSends: recentSendRows.map((r) => ({ ...r, sentAt: r.sentAt.toISOString() })),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createSegment"),
    name: z.string().min(1).max(120),
    minSpendMinor: z.number().int().nonnegative().default(0),
  }),
  z.object({
    action: z.literal("createCampaign"),
    segmentId: z.string().uuid(),
    name: z.string().min(1).max(120),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(10000),
  }),
  z.object({
    action: z.literal("sendCampaign"),
    campaignId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("campaignAnalytics"),
    campaignId: z.string().uuid(),
  }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.issues }, { status: 400 });

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  let result;
  if (body.data.action === "createSegment") {
    result = await executor.execute("marketing.createSegment", humanCtx, {
      name: body.data.name,
      minSpendMinor: body.data.minSpendMinor,
    });
  } else if (body.data.action === "createCampaign") {
    result = await executor.execute("marketing.createCampaign", humanCtx, {
      segmentId: body.data.segmentId,
      name: body.data.name,
      subject: body.data.subject,
      body: body.data.body,
    });
  } else if (body.data.action === "sendCampaign") {
    result = await executor.execute("marketing.sendCampaign", humanCtx, {
      campaignId: body.data.campaignId,
    });
  } else {
    result = await executor.execute("marketing.campaignAnalytics", humanCtx, {
      campaignId: body.data.campaignId,
    });
  }

  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
