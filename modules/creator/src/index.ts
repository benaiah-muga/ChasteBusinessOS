import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@chaste/db";
import { creatorProposals } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

/**
 * Creator Mode turns the agent's self-improvement into a governed workflow.
 * The agent never patches the running system: it files a proposal with diff,
 * test evidence, and risk assessment. A human approves; merging happens
 * through normal version control where CI runs again on the real change.
 */

const submitProposal = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.submitProposal",
    title: "Submit platform-change proposal",
    intent:
      "File a proposed improvement to this platform itself: what changes, why, a unified diff, test evidence, and an honest risk assessment. Nothing merges without human approval",
    module: "creator",
    risk: "write",
    permission: "platform.creator",
    input: z.object({
      title: z.string().min(4).max(120),
      summary: z.string().min(20).max(4000),
      diffText: z.string().min(10).max(100_000).describe("unified diff of the proposed change"),
      testEvidence: z.string().max(20_000).optional(),
      riskAssessment: z.string().min(10).max(4000),
    }),
    output: z.object({ proposalId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(creatorProposals)
        .values({
          orgId: ctx.actor.orgId,
          title: input.title,
          summary: input.summary,
          diffText: input.diffText,
          testEvidence: input.testEvidence ?? null,
          riskAssessment: input.riskAssessment,
          status: "in_review",
          sessionId: ctx.sessionId ?? null,
          proposedByActorType: ctx.actor.type,
          proposedByActorId: ctx.actor.id,
        })
        .returning({ id: creatorProposals.id });
      return { proposalId: row!.id };
    },
  });

const listProposals = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.listProposals",
    title: "List platform-change proposals",
    intent:
      "Show proposals to improve this platform, with their status and who reviewed them, so pending work is visible",
    module: "creator",
    risk: "read",
    permission: "platform.creator",
    input: z.object({ status: z.enum(["in_review", "approved", "rejected", "merged"]).optional() }),
    output: z.object({
      proposals: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select({
          id: creatorProposals.id,
          title: creatorProposals.title,
          status: creatorProposals.status,
          createdAt: creatorProposals.createdAt,
        })
        .from(creatorProposals)
        .where(
          input.status
            ? and(eq(creatorProposals.orgId, ctx.actor.orgId), eq(creatorProposals.status, input.status))
            : eq(creatorProposals.orgId, ctx.actor.orgId),
        )
        .orderBy(desc(creatorProposals.createdAt))
        .limit(50);
      return {
        proposals: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      };
    },
  });

export function registerCreatorCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(submitProposal(deps));
  registry.register(listProposals(deps));
}
