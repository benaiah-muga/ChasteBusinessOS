import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

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

const releaseArtifactRef = z.string().regex(/^(artifact|git):\/\//);
const evolutionOutputSchemas = {
  stage: z.object({
    releaseId: z.string(),
    status: z.literal("staged"),
    gapTicketId: z.string(),
    candidateDigest: digest,
    artifactRef: releaseArtifactRef,
  }).strict(),
  promote: z.object({
    releaseId: z.string(),
    status: z.literal("promoted"),
    gapTicketId: z.string(),
    candidateDigest: digest,
    artifactRef: releaseArtifactRef,
  }).strict(),
  rollback: z.object({
    releaseId: z.string(),
    status: z.literal("rolled_back"),
    candidateDigest: digest,
    artifactRef: releaseArtifactRef,
  }).strict(),
  canary: z.object({
    outcomeId: z.string(),
    releaseId: z.string(),
    gapTicketId: z.string(),
    candidateDigest: digest,
    phase: z.literal("canary"),
    verdict: z.enum(["pass", "fail"]),
  }).strict(),
} as const;

const noStore = { "Cache-Control": "no-store" };

function goUnavailable() {
  return NextResponse.json(
    { error: "Creator evolution service unavailable; check release status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function goEvolutionResponse(action: z.infer<typeof actionSchema>["action"], result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return goUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({
        ok: z.literal(true),
        data: evolutionOutputSchemas[action],
        replayed: z.boolean().optional(),
      }).strict().safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({
        ok: z.literal(false),
        pendingApproval: z.literal(true),
        reason: z.string(),
        approvalId: z.string().optional(),
      }).strict().safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(
        { ok: false, pendingApproval: true, reason: parsed.data.reason },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).strict().safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 422, headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).strict().safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 401, headers: noStore });
    }
    if (result.response.status === 400 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).strict().safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return goUnavailable();
  }

  return goUnavailable();
}

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

  if (process.env.GO_CREATOR_EVOLUTION_WRITES === "1") {
    try {
      return await goEvolutionResponse(parsed.data.action, await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId,
        input,
      }));
    } catch {
      return goUnavailable();
    }
  }

  const result = await buildExecutor(getDb().db, buildRegistry(getDb().db)).execute(capabilityId, ctx, input);
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error ?? "approval requested" }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error ?? "action failed" }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
