import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceRef = z.string().regex(/^(artifact|evidence|git):\/\//);
const metrics = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({});
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("stage"),
    proposalId: z.string().uuid(),
    gapTicketId: z.string().uuid(),
    candidateDigest: digest,
    artifactRef: z.string().regex(/^(artifact|git):\/\//),
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    action: z.literal("promote"),
    releaseId: z.string().uuid(),
    candidateDigest: digest,
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    action: z.literal("rollback"),
    releaseId: z.string().uuid(),
    candidateDigest: digest,
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    action: z.literal("canary"),
    releaseId: z.string().uuid(),
    gapTicketId: z.string().uuid(),
    candidateDigest: digest,
    verdict: z.enum(["pass", "fail"]),
    evidenceRef,
    metrics,
    intentId: z.string().min(1).max(200).optional(),
  }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const capabilityId = {
    stage: "creator.stageCandidate",
    promote: "creator.promoteCandidate",
    rollback: "creator.rollbackCandidate",
    canary: "creator.recordCanaryOutcome",
  }[parsed.data.action];
  const { action: _action, intentId: _intentId, ...input } = parsed.data;
  const result = await buildExecutor(getDb().db, buildRegistry(getDb().db)).execute(capabilityId, ctx, input);
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error ?? "approval requested" }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error ?? "action failed" }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
