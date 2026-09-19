import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { creatorEvolutionOutcomes, creatorEvolutionReleases, creatorProposals, getDb } from "@chaste/db";
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
  const releases = await db
    .select()
    .from(creatorEvolutionReleases)
    .where(eq(creatorEvolutionReleases.orgId, resolved.orgId));
  const outcomes = await db
    .select()
    .from(creatorEvolutionOutcomes)
    .where(eq(creatorEvolutionOutcomes.orgId, resolved.orgId));
  return NextResponse.json({
    proposals: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      releases: releases
        .filter((release) => release.proposalId === r.id)
        .map((release) => ({
          ...release,
          stagedAt: release.stagedAt.toISOString(),
          promotedAt: release.promotedAt?.toISOString() ?? null,
          rolledBackAt: release.rolledBackAt?.toISOString() ?? null,
          createdAt: release.createdAt.toISOString(),
          outcomes: outcomes
            .filter((outcome) => outcome.releaseId === release.id)
            .map((outcome) => ({ ...outcome, observedAt: outcome.observedAt.toISOString(), createdAt: outcome.createdAt.toISOString() })),
        })),
    })),
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
    .select({ id: creatorProposals.id })
    .from(creatorProposals)
    .where(and(eq(creatorProposals.id, body.data.proposalId), eq(creatorProposals.orgId, resolved.orgId)))
    .limit(1);
  if (!proposal) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Compare-and-set decision (N34): the status check lives in the UPDATE, so
  // two concurrent reviewers produce exactly one decision and one conflict —
  // never two writes.
  const decided = await db
    .update(creatorProposals)
    .set({
      status: body.data.decision,
      reviewedByUserId: resolved.userId,
      reviewComment: body.data.comment ?? null,
      reviewedAt: new Date(),
    })
    .where(and(eq(creatorProposals.id, proposal.id), eq(creatorProposals.status, "in_review")))
    .returning({ id: creatorProposals.id });
  if (decided.length === 0) {
    return NextResponse.json({ error: "conflict: proposal already decided or no longer in review" }, { status: 409 });
  }

  // Approving records the human decision; the diff itself merges through
  // version control where CI re-verifies it. The platform is never patched live.
  return NextResponse.json({ ok: true, note: "decision recorded; merge the change through your normal PR flow" });
}
