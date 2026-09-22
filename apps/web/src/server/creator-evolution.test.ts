import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  approvals,
  beginLedgerMaintenance,
  createDb,
  creatorEvolutionReleases,
  creatorEvolutionOutcomes,
  creatorProposals,
  ledgerEvents,
  memberships,
  organizations,
  rolePermissions,
  roles,
  tickets,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { decideApproval } from "./approvals";
import { buildExecutor, buildRegistry, type ResolvedUser } from "./kernel";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
let pg: Database;
let db: Database["db"];
let userId: string;
let resolved: ResolvedUser;

const digest = "a".repeat(64);
const artifactRef = "artifact://creator/reserve-stock/" + digest;

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({
    id: orgId,
    name: "Creator Evolution Test Org",
    slug: `creator-evolution-${orgId.slice(0, 8)}`,
  });
  const [user] = await db
    .insert(users)
    .values({ email: `creator-evolution-${orgId.slice(0, 8)}@example.com`, name: "Evolution Approver" })
    .returning();
  userId = user!.id;
  await db.insert(memberships).values({ orgId, userId });
  const [role] = await db.insert(roles).values({ orgId, key: "owner", name: "Owner", isSystem: true }).returning();
  await db.insert(rolePermissions).values({ roleId: role!.id, permissionKey: "*", orgId });
  await db.insert(userRoles).values({ userId, roleId: role!.id, orgId });
  resolved = { userId, email: user!.email, name: user!.name, orgId, permissions: new Set(["*"]) };
});

afterAll(async () => {
  await db.delete(creatorEvolutionOutcomes).where(eq(creatorEvolutionOutcomes.orgId, orgId));
  await db.delete(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.orgId, orgId));
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
  await db.delete(creatorProposals).where(eq(creatorProposals.orgId, orgId));
  await db.delete(tickets).where(eq(tickets.orgId, orgId));
  await beginLedgerMaintenance(db, (tx) => tx.delete(ledgerEvents).where(eq(ledgerEvents.orgId, orgId)));
  await db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.delete(rolePermissions).where(eq(rolePermissions.orgId, orgId));
  await db.delete(roles).where(eq(roles.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

function candidateEvidence(candidateDigest: string): string {
  return JSON.stringify({
    kind: "isolated_creator_candidate",
    baselineCommit: "0123456789abcdef",
    candidateDigest,
    files: ["modules/inventory/src/reserveStock.ts"],
    verification: {
      passed: true,
      network: "not used by verifier",
      productionCredentials: false,
    },
  });
}

async function gapTicket(origin = "capability_gap"): Promise<string> {
  const [row] = await db
    .insert(tickets)
    .values({
      orgId,
      title: "Missing reserve-stock capability",
      description: "A durable capability gap used by the controlled evolution fixture.",
      origin,
    })
    .returning({ id: tickets.id });
  return row!.id;
}

async function proposal(status = "approved", candidateDigest = digest, gapTicketId?: string): Promise<string> {
  const [row] = await db
    .insert(creatorProposals)
    .values({
      orgId,
      title: "Verified reserve-stock candidate",
      summary: "An isolated Creator candidate with independent verification evidence.",
      diffText: "--- a/candidate\n+++ b/candidate\n+verified artifact handoff only",
      testEvidence: candidateEvidence(candidateDigest),
      riskAssessment: "No production credentials and no live source installation.",
      gapTicketId: gapTicketId ?? null,
      status,
      proposedByActorType: "agent",
    })
    .returning({ id: creatorProposals.id });
  return row!.id;
}

const agentCtx = () => ({ actor: { type: "agent" as const, id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} });

async function latestApproval(capabilityId: string) {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.capabilityId, capabilityId)))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return approval!;
}

describe("controlled Creator evolution release", () => {
  it("binds staging to exact candidate evidence and existing approval", async () => {
    const registry = buildRegistry(db);
    const executor = buildExecutor(db, registry);
    const gapTicketId = await gapTicket();
    const proposalId = await proposal("approved", digest, gapTicketId);

    const mismatch = await executor.execute("creator.stageCandidate", agentCtx(), {
      proposalId,
      gapTicketId,
      candidateDigest: "b".repeat(64),
      artifactRef: "artifact://creator/wrong/" + "b".repeat(64),
    });
    expect(mismatch.pendingApproval).toBeTruthy();
    const rejectedByEvidence = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.stageCandidate")).id,
      decision: "approve",
    });
    expect(rejectedByEvidence).toMatchObject({ ok: false, code: 422 });
    expect(await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.orgId, orgId))).toHaveLength(0);

    const request = await executor.execute("creator.stageCandidate", agentCtx(), {
      proposalId,
      gapTicketId,
      candidateDigest: digest,
      artifactRef,
    });
    expect(request.pendingApproval).toBeTruthy();
    const decision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.stageCandidate")).id,
      decision: "approve",
      comment: "verified candidate may enter the controlled release lane",
    });
    expect(decision).toMatchObject({ ok: true, status: "executed" });
    const [release] = await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.orgId, orgId));
    expect(release).toMatchObject({ proposalId, candidateDigest: digest, artifactRef, status: "staged" });
    console.log("EVOLUTION-APPROVAL-OK");
    console.log("EVOLUTION-EXACT-DIGEST-OK");
  });

  it("records an artifact handoff, then rolls back only the matching release", async () => {
    const registry = buildRegistry(db);
    const executor = buildExecutor(db, registry);
    const gapTicketId = await gapTicket();
    const proposalId = await proposal("approved", digest, gapTicketId);
    const stagedRequest = await executor.execute("creator.stageCandidate", agentCtx(), { proposalId, gapTicketId, candidateDigest: digest, artifactRef });
    const stagedDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.stageCandidate")).id,
      decision: "approve",
    });
    expect(stagedDecision.ok).toBe(true);
    const [staged] = await db
      .select()
      .from(creatorEvolutionReleases)
      .where(and(eq(creatorEvolutionReleases.orgId, orgId), eq(creatorEvolutionReleases.proposalId, proposalId)));
    expect(stagedRequest.pendingApproval).toBeTruthy();

    const promoteRequest = await executor.execute("creator.promoteCandidate", agentCtx(), {
      releaseId: staged!.id,
      candidateDigest: digest,
    });
    expect(promoteRequest.pendingApproval).toBeTruthy();
    const promotedDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.promoteCandidate")).id,
      decision: "approve",
    });
    expect(promotedDecision).toMatchObject({ ok: true, status: "executed" });
    const [promoted] = await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.id, staged!.id));
    expect(promoted?.status).toBe("promoted");

    const rollbackRequest = await executor.execute("creator.rollbackCandidate", agentCtx(), {
      releaseId: staged!.id,
      candidateDigest: digest,
    });
    expect(rollbackRequest.pendingApproval).toBeTruthy();
    const rollbackDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.rollbackCandidate")).id,
      decision: "approve",
    });
    expect(rollbackDecision).toMatchObject({ ok: true, status: "executed" });
    const [rolledBack] = await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.id, staged!.id));
    expect(rolledBack?.status).toBe("rolled_back");

    const repeat = await executor.execute("creator.rollbackCandidate", agentCtx(), {
      releaseId: staged!.id,
      candidateDigest: digest,
    });
    expect(repeat.pendingApproval).toBeTruthy();
    const repeatDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.rollbackCandidate")).id,
      decision: "approve",
    });
    expect(repeatDecision).toMatchObject({ ok: false, code: 422 });
    console.log("EVOLUTION-ARTIFACT-HANDOFF-OK");
    console.log("EVOLUTION-ROLLBACK-OK");
    console.log("EVOLUTION-FAIL-CLOSED-OK");
  });

  it("records canary outcomes against the original capability gap with a release permission", async () => {
    const registry = buildRegistry(db);
    const executor = buildExecutor(db, registry);
    const gapTicketId = await gapTicket();
    const proposalId = await proposal("approved", digest, gapTicketId);
    const stagedRequest = await executor.execute("creator.stageCandidate", agentCtx(), { proposalId, gapTicketId, candidateDigest: digest, artifactRef });
    const stagedDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.stageCandidate")).id,
      decision: "approve",
    });
    expect(stagedDecision.ok).toBe(true);
    const [release] = await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.proposalId, proposalId));
    expect(stagedRequest.pendingApproval).toBeTruthy();

    const promotedRequest = await executor.execute("creator.promoteCandidate", agentCtx(), {
      releaseId: release!.id,
      candidateDigest: digest,
    });
    const promotedDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.promoteCandidate")).id,
      decision: "approve",
    });
    expect(promotedRequest.pendingApproval).toBeTruthy();
    expect(promotedDecision.ok).toBe(true);

    const withoutReleasePermission = await executor.execute(
      "creator.recordCanaryOutcome",
      { actor: { type: "human" as const, id: userId, orgId, permissions: new Set(["platform.creator"]) }, now: new Date(), services: {} },
      { releaseId: release!.id, gapTicketId, candidateDigest: digest, verdict: "pass", evidenceRef: "evidence://canary/unauthorized", metrics: {} },
    );
    expect(withoutReleasePermission).toMatchObject({ ok: false, error: expect.stringContaining("platform.creator.release") });

    const unrelatedTicketId = await gapTicket("request");
    const unrelatedOutcome = await executor.execute("creator.recordCanaryOutcome", {
      actor: { type: "system" as const, id: null, orgId, permissions: new Set(["platform.creator.release"]) },
      now: new Date(),
      services: {},
    }, { releaseId: release!.id, gapTicketId: unrelatedTicketId, candidateDigest: digest, verdict: "pass", evidenceRef: "evidence://canary/wrong-gap", metrics: {} });
    expect(unrelatedOutcome).toMatchObject({ ok: false, error: expect.stringContaining("gap ticket does not match") });

    const passed = await executor.execute("creator.recordCanaryOutcome", {
      actor: { type: "system" as const, id: null, orgId, permissions: new Set(["platform.creator.release"]) },
      now: new Date(),
      services: {},
    }, { releaseId: release!.id, gapTicketId, candidateDigest: digest, verdict: "pass", evidenceRef: "evidence://canary/pass", metrics: { errorRate: 0, sampleSize: 25 } });
    expect(passed).toMatchObject({ ok: true, data: { phase: "canary", verdict: "pass", gapTicketId, candidateDigest: digest } });

    const [afterPass] = await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.id, release!.id));
    const [outcome] = await db.select().from(creatorEvolutionOutcomes).where(eq(creatorEvolutionOutcomes.releaseId, release!.id));
    expect(afterPass?.status).toBe("promoted");
    expect(outcome).toMatchObject({ gapTicketId, candidateDigest: digest, phase: "canary", verdict: "pass" });

    const failedGapTicketId = await gapTicket();
    const failedProposalId = await proposal("approved", digest, failedGapTicketId);
    const failedStage = await executor.execute("creator.stageCandidate", agentCtx(), { proposalId: failedProposalId, gapTicketId: failedGapTicketId, candidateDigest: digest, artifactRef });
    const failedStageDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.stageCandidate")).id,
      decision: "approve",
    });
    expect(failedStage.pendingApproval).toBeTruthy();
    expect(failedStageDecision.ok).toBe(true);
    const [failedRelease] = await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.proposalId, failedProposalId));
    const failedPromote = await executor.execute("creator.promoteCandidate", agentCtx(), { releaseId: failedRelease!.id, candidateDigest: digest });
    const failedPromoteDecision = await decideApproval(db, executor, registry, resolved, {
      approvalId: (await latestApproval("creator.promoteCandidate")).id,
      decision: "approve",
    });
    expect(failedPromote.pendingApproval).toBeTruthy();
    expect(failedPromoteDecision.ok).toBe(true);
    const failed = await executor.execute("creator.recordCanaryOutcome", {
      actor: { type: "system" as const, id: null, orgId, permissions: new Set(["platform.creator.release"]) },
      now: new Date(),
      services: {},
    }, { releaseId: failedRelease!.id, gapTicketId: failedGapTicketId, candidateDigest: digest, verdict: "fail", evidenceRef: "evidence://canary/fail", metrics: { errorRate: 1, sampleSize: 25 } });
    expect(failed).toMatchObject({ ok: true, data: { phase: "canary", verdict: "fail", gapTicketId: failedGapTicketId, candidateDigest: digest } });
    const [afterFail] = await db.select().from(creatorEvolutionReleases).where(eq(creatorEvolutionReleases.id, failedRelease!.id));
    expect(afterFail?.status).toBe("promoted");

    console.log("EVOLUTION-GAP-LINK-OK");
    console.log("EVOLUTION-RELEASE-PRINCIPAL-OK");
    console.log("EVOLUTION-CANARY-OUTCOME-OK");
  });
});
