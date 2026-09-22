import { and, eq, or } from "drizzle-orm";
import {
  creatorEvolutionOutcomes,
  creatorEvolutionReleases,
  creatorProposals,
  tickets,
  type Database,
} from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { z } from "zod";

const candidateEvidenceSchema = z.object({
  kind: z.literal("isolated_creator_candidate"),
  baselineCommit: z.string().min(7),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.string().min(1)).min(1),
  verification: z.object({
    passed: z.literal(true),
    network: z.string().min(1),
    productionCredentials: z.literal(false),
  }),
});

const artifactRef = z.string().regex(/^(artifact|git):\/\/[^\s]+$/, "immutable artifact reference required");

type EvolutionDeps = { db: Database["db"] };

const releaseEvidenceRef = z.string().regex(/^(artifact|evidence|git):\/\/[^\s]+$/, "immutable evidence reference required");

export async function verifyCapabilityGapTicket(db: Database["db"], orgId: string, gapTicketId: string): Promise<void> {
  const [ticket] = await db
    .select({ id: tickets.id, origin: tickets.origin })
    .from(tickets)
    .where(and(eq(tickets.id, gapTicketId), eq(tickets.orgId, orgId)))
    .limit(1);
  if (!ticket) throw new Error("capability gap ticket not found for organization");
  if (ticket.origin !== "capability_gap") throw new Error("outcome must link to a capability gap ticket");
}

async function verifiedCandidate(db: Database["db"], orgId: string, proposalId: string, candidateDigest: string) {
  const [proposal] = await db
    .select({ id: creatorProposals.id, status: creatorProposals.status, gapTicketId: creatorProposals.gapTicketId, testEvidence: creatorProposals.testEvidence })
    .from(creatorProposals)
    .where(and(eq(creatorProposals.id, proposalId), eq(creatorProposals.orgId, orgId)))
    .limit(1);
  if (!proposal) throw new Error("creator proposal not found for organization");
  if (proposal.status !== "approved") throw new Error(`proposal is ${proposal.status}; approval is required before release`);
  const evidence = candidateEvidenceSchema.safeParse(proposal.testEvidence ? JSON.parse(proposal.testEvidence) : null);
  if (!evidence.success) throw new Error("proposal lacks valid isolated candidate evidence");
  if (evidence.data.candidateDigest !== candidateDigest) throw new Error("candidate digest does not match verified evidence");
  return { evidence: evidence.data, gapTicketId: proposal.gapTicketId };
}

const stageCandidate = (deps: EvolutionDeps) =>
  defineCapability({
    id: "creator.stageCandidate",
    title: "Stage an approved Creator candidate",
    intent:
      "Record the exact independently verified Creator artifact that may enter controlled release without installing or executing candidate source",
    module: "creator",
    risk: "identity",
    permission: "platform.creator",
    input: z.object({ proposalId: z.string().uuid(), gapTicketId: z.string().uuid(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), artifactRef }),
    output: z.object({ releaseId: z.string(), status: z.literal("staged"), gapTicketId: z.string(), candidateDigest: z.string(), artifactRef }),
    inverse: {
      capabilityId: "creator.rollbackCandidate",
      buildInput: (_input, output) => ({ releaseId: output.releaseId, candidateDigest: output.candidateDigest }),
    },
    execute: async (ctx, input) => {
      const candidate = await verifiedCandidate(deps.db, ctx.actor.orgId, input.proposalId, input.candidateDigest);
      if (candidate.gapTicketId !== input.gapTicketId) throw new Error("candidate proposal is not linked to the requested capability gap");
      await verifyCapabilityGapTicket(deps.db, ctx.actor.orgId, input.gapTicketId);
      const [existing] = await deps.db
        .select()
        .from(creatorEvolutionReleases)
        .where(
          and(
            eq(creatorEvolutionReleases.orgId, ctx.actor.orgId),
            eq(creatorEvolutionReleases.proposalId, input.proposalId),
            eq(creatorEvolutionReleases.candidateDigest, input.candidateDigest),
            eq(creatorEvolutionReleases.artifactRef, input.artifactRef),
            eq(creatorEvolutionReleases.status, "staged"),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.gapTicketId !== input.gapTicketId) throw new Error("release gap ticket does not match the requested gap");
        return { releaseId: existing.id, status: "staged" as const, gapTicketId: existing.gapTicketId, candidateDigest: existing.candidateDigest, artifactRef: existing.artifactRef };
      }
      const [release] = await deps.db
        .insert(creatorEvolutionReleases)
        .values({
          orgId: ctx.actor.orgId,
          proposalId: input.proposalId,
          gapTicketId: input.gapTicketId,
          candidateDigest: input.candidateDigest,
          artifactRef: input.artifactRef,
          status: "staged",
        })
        .returning();
      if (!release) throw new Error("creator evolution release was not recorded");
      return { releaseId: release.id, status: "staged" as const, gapTicketId: release.gapTicketId!, candidateDigest: release.candidateDigest, artifactRef: release.artifactRef };
    },
  });

const promoteCandidate = (deps: EvolutionDeps) =>
  defineCapability({
    id: "creator.promoteCandidate",
    title: "Promote an exact Creator artifact",
    intent:
      "Promote the exact staged Creator artifact after human approval while preserving the digest and leaving production source installation outside this runtime",
    module: "creator",
    risk: "identity",
    permission: "platform.creator",
    input: z.object({ releaseId: z.string().uuid(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: z.object({ releaseId: z.string(), status: z.literal("promoted"), gapTicketId: z.string(), candidateDigest: z.string(), artifactRef }),
    inverse: {
      capabilityId: "creator.rollbackCandidate",
      buildInput: (_input, output) => ({ releaseId: output.releaseId, candidateDigest: output.candidateDigest }),
    },
    execute: async (ctx, input) => {
      const [release] = await deps.db
        .select()
        .from(creatorEvolutionReleases)
        .where(and(eq(creatorEvolutionReleases.id, input.releaseId), eq(creatorEvolutionReleases.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!release) throw new Error("creator evolution release not found for organization");
      if (release.candidateDigest !== input.candidateDigest) throw new Error("release digest mismatch");
      if (release.status !== "staged") throw new Error(`release is ${release.status}; only staged artifacts may be promoted`);
      const [promoted] = await deps.db
        .update(creatorEvolutionReleases)
        .set({ status: "promoted", promotedAt: new Date() })
        .where(and(eq(creatorEvolutionReleases.id, release.id), eq(creatorEvolutionReleases.status, "staged")))
        .returning();
      if (!promoted) throw new Error("release changed before promotion");
      return { releaseId: promoted.id, status: "promoted" as const, gapTicketId: promoted.gapTicketId!, candidateDigest: promoted.candidateDigest, artifactRef: promoted.artifactRef };
    },
  });

const rollbackCandidate = (deps: EvolutionDeps) =>
  defineCapability({
    id: "creator.rollbackCandidate",
    title: "Roll back a Creator artifact handoff",
    intent:
      "Mark a staged or promoted Creator artifact handoff rolled back when its exact digest is supplied, without deleting the immutable proposal or executing compensation code",
    module: "creator",
    risk: "destructive",
    permission: "platform.creator",
    input: z.object({ releaseId: z.string().uuid(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: z.object({ releaseId: z.string(), status: z.literal("rolled_back"), candidateDigest: z.string(), artifactRef }),
    execute: async (ctx, input) => {
      const [rolledBack] = await deps.db
        .update(creatorEvolutionReleases)
        .set({ status: "rolled_back", rolledBackAt: new Date() })
        .where(
          and(
            eq(creatorEvolutionReleases.id, input.releaseId),
            eq(creatorEvolutionReleases.orgId, ctx.actor.orgId),
            eq(creatorEvolutionReleases.candidateDigest, input.candidateDigest),
            or(eq(creatorEvolutionReleases.status, "staged"), eq(creatorEvolutionReleases.status, "promoted")),
          ),
        )
        .returning();
      if (!rolledBack) throw new Error("release not found or digest mismatch");
      return { releaseId: rolledBack.id, status: "rolled_back" as const, candidateDigest: rolledBack.candidateDigest, artifactRef: rolledBack.artifactRef };
    },
  });

const recordCanaryOutcome = (deps: EvolutionDeps) =>
  defineCapability({
    id: "creator.recordCanaryOutcome",
    title: "Record a Creator canary outcome",
    intent:
      "Attach verified canary evidence to the original capability gap for a promoted Creator artifact without changing deployment or rollback state",
    module: "creator",
    risk: "write",
    permission: "platform.creator.release",
    input: z.object({
      releaseId: z.string().uuid(),
      gapTicketId: z.string().uuid(),
      candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
      verdict: z.enum(["pass", "fail"]),
      evidenceRef: releaseEvidenceRef,
      metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    }),
    output: z.object({
      outcomeId: z.string(),
      releaseId: z.string(),
      gapTicketId: z.string(),
      candidateDigest: z.string(),
      phase: z.literal("canary"),
      verdict: z.enum(["pass", "fail"]),
    }),
    execute: async (ctx, input) => {
      const [release] = await deps.db
        .select()
        .from(creatorEvolutionReleases)
        .where(and(eq(creatorEvolutionReleases.id, input.releaseId), eq(creatorEvolutionReleases.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!release) throw new Error("creator evolution release not found for organization");
      if (release.status !== "promoted") throw new Error(`release is ${release.status}; canary evidence requires a promoted release`);
      if (release.candidateDigest !== input.candidateDigest) throw new Error("release digest mismatch");
      if (release.gapTicketId !== input.gapTicketId) throw new Error("outcome gap ticket does not match the release");
      await verifyCapabilityGapTicket(deps.db, ctx.actor.orgId, input.gapTicketId);
      const [outcome] = await deps.db
        .insert(creatorEvolutionOutcomes)
        .values({
          orgId: ctx.actor.orgId,
          releaseId: release.id,
          gapTicketId: input.gapTicketId,
          candidateDigest: input.candidateDigest,
          phase: "canary",
          verdict: input.verdict,
          evidenceRef: input.evidenceRef,
          metrics: input.metrics,
        })
        .returning();
      if (!outcome) throw new Error("creator canary outcome was not recorded");
      return {
        outcomeId: outcome.id,
        releaseId: outcome.releaseId,
        gapTicketId: outcome.gapTicketId,
        candidateDigest: outcome.candidateDigest,
        phase: "canary" as const,
        verdict: outcome.verdict as "pass" | "fail",
      };
    },
  });

export function registerEvolutionCapabilities(registry: CapabilityRegistry, deps: EvolutionDeps): void {
  registry.register(stageCandidate(deps));
  registry.register(promoteCandidate(deps));
  registry.register(rollbackCandidate(deps));
  registry.register(recordCanaryOutcome(deps));
}
