import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@chaste/db";
import { creatorProposals, marketplaceListings } from "@chaste/db";
import {
  pluginManifestSchema,
  verifyPlugin,
  type PluginManifest,
} from "@chaste/plugin-kit";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { renderCapabilitySource, renderProposalDiff, renderRiskDoc, renderTestSkeleton } from "./scaffold";

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

// ── Scaffolding generator ───────────────────────────────────────────────

const riskEnum = z.enum(["read", "write", "money", "identity", "destructive", "secret"]);
const scaffoldInput = z.object({
  module: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase-kebab module name"),
  action: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, "PascalOrCamel action name"),
  title: z.string().min(4).max(120),
  intent: z.string().min(20).max(500),
  risk: riskEnum,
  permission: z.string().min(3),
  inputFields: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
        type: z.enum(["string", "number", "boolean"]),
        description: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .default([]),
});

const scaffoldCapability = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.scaffoldCapability",
    title: "Scaffold a new capability",
    intent:
      "Generate the source file, test skeleton, and risk document for a proposed new capability so it can be reviewed as a governed proposal",
    module: "creator",
    risk: "read",
    permission: "platform.creator",
    input: scaffoldInput.extend({
      submitAsProposal: z.boolean().default(true),
    }),
    output: z.object({
      files: z.array(z.object({ path: z.string(), content: z.string() })),
      proposalId: z.string().optional(),
    }),
    execute: async (ctx, input) => {
      const spec = {
        module: input.module,
        action: input.action,
        title: input.title,
        intent: input.intent,
        risk: input.risk,
        permission: input.permission,
        inputFields: input.inputFields,
      };
      const filePath = `modules/${input.module}/src/${input.action}.ts`;
      const files = [
        { path: filePath, content: renderCapabilitySource(spec) },
        { path: `modules/${input.module}/src/${input.action}.test.ts`, content: renderTestSkeleton(spec) },
        { path: `docs/proposals/${input.module}-${input.action}-risk.md`, content: renderRiskDoc(spec) },
      ];
      if (!input.submitAsProposal) return { files };

      const [row] = await deps.db
        .insert(creatorProposals)
        .values({
          orgId: ctx.actor.orgId,
          title: `New capability: ${spec.module}.${spec.action}`,
          summary: `${spec.title}, ${spec.intent}\n\nRisk class ${spec.risk}, permission ${spec.permission}. Generated by Creator Mode scaffolding; awaiting human review.`,
          diffText: renderProposalDiff(spec, filePath),
          testEvidence: renderTestSkeleton(spec),
          riskAssessment: renderRiskDoc(spec),
          status: "in_review",
          sessionId: ctx.sessionId ?? null,
          proposedByActorType: ctx.actor.type,
          proposedByActorId: ctx.actor.id,
        })
        .returning({ id: creatorProposals.id });
      return { files, proposalId: row!.id };
    },
  });

// ── Plugin verification + marketplace groundwork ────────────────────────

const verifyPluginCapability = (_deps: ModuleDeps) =>
  defineCapability({
    id: "creator.verifyPlugin",
    title: "Verify a plugin package",
    intent:
      "Check a signed plugin manifest against its publisher key: schema validity, declared risks, and ed25519 signature, without installing anything",
    module: "creator",
    risk: "read",
    permission: "platform.creator",
    input: z.object({
      manifest: z.unknown(),
      signatureBase64: z.string(),
      publisherPublicKeyBase64: z.string(),
    }),
    output: z.object({ valid: z.boolean(), reason: z.string().optional() }),
    execute: async (_ctx, input) => {
      const r = verifyPlugin(input.manifest, input.signatureBase64, input.publisherPublicKeyBase64);
      return { valid: r.valid, reason: r.reason };
    },
  });

const publishListing = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.publishListing",
    title: "Publish a plugin to the marketplace",
    intent:
      "Publish a signed capability package listing after verifying its signature; invalid signatures are refused, never stored as verified",
    module: "creator",
    risk: "write",
    permission: "platform.creator",
    inverse: {
      capabilityId: "creator.retractListing",
      buildInput: (_input, output) => ({ slug: (output as { slug: string }).slug }),
    },
    input: z.object({
      manifest: pluginManifestSchema,
      signatureBase64: z.string().min(16),
      publisherPublicKeyBase64: z.string().min(16),
    }),
    output: z.object({ listingId: z.string(), slug: z.string(), status: z.string() }),
    execute: async (ctx, input) => {
      const verdict = verifyPlugin(input.manifest, input.signatureBase64, input.publisherPublicKeyBase64);
      if (!verdict.valid) throw new Error(`refused: ${verdict.reason}`);
      const manifest = input.manifest as PluginManifest;
      // Slug ownership: a listing may only be created or re-versioned by the
      // org that published it originally. Without this gate any org could
      // overwrite a trusted publisher's slug with attacker-signed content
      // and have it stored as verified (supply-chain takeover). The
      // transaction-scoped advisory lock serializes concurrent publishes for
      // the same slug, closing the check-then-insert race.
      return deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${manifest.slug}, 42))`);
        const [existing] = await tx
          .select({ id: marketplaceListings.id, version: marketplaceListings.version, submittedByOrgId: marketplaceListings.submittedByOrgId })
          .from(marketplaceListings)
          .where(eq(marketplaceListings.slug, manifest.slug))
          .limit(1);
        if (existing && existing.submittedByOrgId !== ctx.actor.orgId) {
          throw new Error(`slug "${manifest.slug}" is owned by another publisher`);
        }
        if (existing && existing.version === manifest.version) {
          throw new Error(`${manifest.slug}@${manifest.version} is already published`);
        }
        const values = {
          slug: manifest.slug,
          name: manifest.name,
          version: manifest.version,
          summary: manifest.summary,
          manifest,
          signature: input.signatureBase64,
          publisherPublicKey: input.publisherPublicKeyBase64,
          capabilityIds: manifest.capabilities,
          status: "verified",
          submittedByOrgId: ctx.actor.orgId,
        };
        const [row] = await tx
          .insert(marketplaceListings)
          .values(values)
          .onConflictDoUpdate({
            target: marketplaceListings.slug,
            set: { ...values, updatedAt: new Date() },
            // Belt and braces: even under unexpected concurrency the upsert
            // itself refuses to touch another publisher's row.
            setWhere: eq(marketplaceListings.submittedByOrgId, ctx.actor.orgId),
          })
          .returning({ id: marketplaceListings.id });
        return { listingId: row!.id, slug: manifest.slug, status: "verified" };
      });
    },
  });

const retractListing = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.retractListing",
    title: "Retract a marketplace listing",
    intent:
      "Mark one of our published capability packages retracted so orgs see it before installing updates",
    module: "creator",
    risk: "write",
    permission: "platform.creator",
    input: z.object({ slug: z.string() }),
    output: z.object({ retracted: z.boolean() }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(marketplaceListings)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(marketplaceListings.slug, input.slug),
            eq(marketplaceListings.submittedByOrgId, ctx.actor.orgId),
          ),
        )
        .returning({ id: marketplaceListings.id });
      if (updated.length === 0) throw new Error("no such listing published by your org");
      return { retracted: true };
    },
  });

const installListing = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.installListing",
    title: "Install a marketplace plugin",
    intent:
      "Record this organization's installation of a verified community capability package after re-checking its cryptographic signature",
    module: "creator",
    risk: "identity",
    permission: "platform.creator",
    inverse: {
      capabilityId: "creator.uninstallListing",
      buildInput: (input) => ({ listingId: (input as { listingId: string }).listingId }),
    },
    input: z.object({ listingId: z.string() }),
    output: z.object({ installed: z.boolean(), slug: z.string(), version: z.string() }),
    execute: async (ctx, input) => {
      // Read-modify-write on a jsonb array loses concurrent updates; both
      // mutators serialize on a per-listing advisory lock inside a transaction.
      return deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.listingId}, 43))`);
        const [listing] = await tx
          .select()
          .from(marketplaceListings)
          .where(eq(marketplaceListings.id, input.listingId))
          .limit(1);
        if (!listing) throw new Error("listing not found");
        if (listing.status !== "verified") throw new Error(`listing is ${listing.status}; refusing install`);

        const recheck = verifyPlugin(
          listing.manifest,
          listing.signature,
          listing.publisherPublicKey,
        );
        if (!recheck.valid) throw new Error(`signature no longer verifies: ${recheck.reason}`);

        const installed = new Set<string>(
          Array.isArray(listing.installedByOrgIds) ? (listing.installedByOrgIds as string[]) : [],
        );
        installed.add(ctx.actor.orgId);
        await tx
          .update(marketplaceListings)
          .set({ installedByOrgIds: [...installed], updatedAt: new Date() })
          .where(eq(marketplaceListings.id, listing.id));
        return { installed: true, slug: listing.slug, version: listing.version };
      });
    },
  });

const uninstallListing = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.uninstallListing",
    title: "Uninstall a marketplace plugin",
    intent: "Remove this organization from a capability package's installer list",
    module: "creator",
    risk: "write",
    permission: "platform.creator",
    input: z.object({ listingId: z.string() }),
    output: z.object({ uninstalled: z.boolean() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.listingId}, 43))`);
        const [listing] = await tx
          .select()
          .from(marketplaceListings)
          .where(eq(marketplaceListings.id, input.listingId))
          .limit(1);
        if (!listing) throw new Error("listing not found");
        const installed = new Set<string>(
          Array.isArray(listing.installedByOrgIds) ? (listing.installedByOrgIds as string[]) : [],
        );
        installed.delete(ctx.actor.orgId);
        await tx
          .update(marketplaceListings)
          .set({ installedByOrgIds: [...installed], updatedAt: new Date() })
          .where(eq(marketplaceListings.id, listing.id));
        return { uninstalled: true };
      });
    },
  });

const listMarketplace = (deps: ModuleDeps) =>
  defineCapability({
    id: "creator.listMarketplace",
    title: "Browse the marketplace",
    intent:
      "List community capability packages with their verification status and version so orgs can decide what to install",
    module: "creator",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      listings: z.array(
        z.object({
          id: z.string(),
          slug: z.string(),
          name: z.string(),
          version: z.string(),
          summary: z.string(),
          status: z.string(),
          installedHere: z.boolean(),
        }),
      ),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.status, "verified"))
        .orderBy(desc(marketplaceListings.updatedAt))
        .limit(100);
      return {
        listings: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          version: r.version,
          summary: r.summary,
          status: r.status,
          installedHere: Array.isArray(r.installedByOrgIds)
            ? (r.installedByOrgIds as string[]).includes(ctx.actor.orgId)
            : false,
        })),
      };
    },
  });

export function registerCreatorCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(submitProposal(deps));
  registry.register(listProposals(deps));
  registry.register(scaffoldCapability(deps));
  registry.register(verifyPluginCapability(deps));
  registry.register(publishListing(deps));
  registry.register(retractListing(deps));
  registry.register(installListing(deps));
  registry.register(uninstallListing(deps));
  registry.register(listMarketplace(deps));
}
