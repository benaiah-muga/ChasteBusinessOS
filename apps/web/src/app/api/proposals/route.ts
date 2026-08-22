import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { creatorProposals, getDb } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId || !hasPermission({ permissions: resolved.permissions }, "platform.creator")) {
    return NextResponse.json({ error: "requires platform.creator permission" }, { status: 403 });
  }
  const statusFilter = new URL(req.url).searchParams.get("status");
  const db = getDb().db;
  const rows = await db
    .select()
    .from(creatorProposals)
    .where(
      statusFilter
        ? and(eq(creatorProposals.orgId, resolved.orgId), eq(creatorProposals.status, statusFilter))
        : eq(creatorProposals.orgId, resolved.orgId),
    )
    .orderBy(desc(creatorProposals.createdAt))
    .limit(50);
  return NextResponse.json({
    proposals: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), reviewedAt: r.reviewedAt?.toISOString() ?? null })),
  });
}

const reviewSchema = z.object({
  proposalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(4000).optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId || !hasPermission({ permissions: resolved.permissions }, "platform.creator")) {
    return NextResponse.json({ error: "requires platform.creator permission" }, { status: 403 });
  }
  const body = reviewSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const [proposal] = await db
    .select()
    .from(creatorProposals)
    .where(and(eq(creatorProposals.id, body.data.proposalId), eq(creatorProposals.orgId, resolved.orgId)))
    .limit(1);
  if (!proposal) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (proposal.status !== "in_review") {
    return NextResponse.json({ error: `already ${proposal.status}` }, { status: 409 });
  }

  await db
    .update(creatorProposals)
    .set({
      status: body.data.decision,
      reviewedByUserId: resolved.userId,
      reviewComment: body.data.comment ?? null,
      reviewedAt: new Date(),
    })
    .where(eq(creatorProposals.id, proposal.id));

  // Approving records the human decision; the diff itself merges through
  // version control where CI re-verifies it. The platform is never patched live.
  return NextResponse.json({ ok: true, note: "decision recorded; merge the change through your normal PR flow" });
}
