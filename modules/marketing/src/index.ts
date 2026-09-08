import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, invoices, marketingCampaigns, marketingSegments, marketingSends } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

/**
 * Marketing-lite (M13, ADR 0040): saved deterministic segments, campaigns
 * with an honest append-only send log, opt-out honored at send time.
 * Explicitly NO tracking pixels, no journeys, no landing pages — the send
 * log is the analytics.
 */

export interface ModuleDeps {
  db: Database["db"];
}

const createSegment = (deps: ModuleDeps) =>
  defineCapability({
    id: "marketing.createSegment",
    title: "Create segment",
    intent:
      "Save a deterministic customer filter — everyone whose lifetime spend is at least the threshold — so campaigns target the same people every time",
    module: "marketing",
    risk: "write",
    permission: "marketing.write",
    input: z.object({ name: z.string().min(1).max(120), minSpendMinor: z.number().int().nonnegative().default(0) }),
    output: z.object({ segmentId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(marketingSegments)
        .values({ orgId: ctx.actor.orgId, name: input.name, minSpendMinor: input.minSpendMinor })
        .returning({ id: marketingSegments.id });
      return { segmentId: row!.id };
    },
  });

const createCampaign = (deps: ModuleDeps) =>
  defineCapability({
    id: "marketing.createCampaign",
    title: "Create campaign",
    intent: "Draft a campaign against a saved segment with subject and body; nothing is sent until sendCampaign runs",
    module: "marketing",
    risk: "write",
    permission: "marketing.write",
    input: z.object({ segmentId: z.string().uuid(), name: z.string().min(1).max(120), subject: z.string().min(1).max(200), body: z.string().min(1).max(10000) }),
    output: z.object({ campaignId: z.string() }),
    execute: async (ctx, input) => {
      const [seg] = await deps.db
        .select({ id: marketingSegments.id })
        .from(marketingSegments)
        .where(and(eq(marketingSegments.id, input.segmentId), eq(marketingSegments.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!seg) throw new Error("segment not found");
      const [row] = await deps.db
        .insert(marketingCampaigns)
        .values({ orgId: ctx.actor.orgId, segmentId: input.segmentId, name: input.name, subject: input.subject, body: input.body })
        .returning({ id: marketingCampaigns.id });
      return { campaignId: row!.id };
    },
  });

const sendCampaign = (deps: ModuleDeps) =>
  defineCapability({
    id: "marketing.sendCampaign",
    title: "Send campaign",
    intent:
      "Deliver a campaign to every segment member who has not opted out, recording one append-only send-log row each — opted-out customers are never contacted",
    module: "marketing",
    risk: "write",
    permission: "marketing.write",
    input: z.object({ campaignId: z.string().uuid() }),
    output: z.object({ recipients: z.number(), skippedOptOut: z.number(), alreadySent: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [campaign] = await tx
          .select()
          .from(marketingCampaigns)
          .where(and(eq(marketingCampaigns.id, input.campaignId), eq(marketingCampaigns.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!campaign) throw new Error("campaign not found");
        if (campaign.sentAt) throw new Error("campaign already sent");
        const [segment] = await tx
          .select({ minSpendMinor: marketingSegments.minSpendMinor })
          .from(marketingSegments)
          .where(eq(marketingSegments.id, campaign.segmentId))
          .limit(1);
        const minSpend = segment?.minSpendMinor ?? 0;

        const members = await tx
          .select({ id: customers.id, optedOut: customers.marketingOptOut })
          .from(customers)
          .where(and(eq(customers.orgId, ctx.actor.orgId), isNull(customers.deactivatedAt)));
        // Lifetime spend per customer, RLS-safe: one grouped query over the
        // org's invoices rather than a correlated subquery per customer.
        const spendRows = await tx
          .select({ customerId: invoices.customerId, spend: sql<number>`coalesce(sum(${invoices.totalMinor}), 0)` })
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), sql`${invoices.voidedAt} IS NULL`))
          .groupBy(invoices.customerId);
        const spendByCustomer = new Map(spendRows.map((r) => [r.customerId, Number(r.spend)]));

        let recipients = 0;
        let skippedOptOut = 0;
        let alreadySent = 0;
        for (const m of members) {
          if ((spendByCustomer.get(m.id) ?? 0) < minSpend) continue;
          if (m.optedOut) {
            skippedOptOut += 1;
            continue;
          }
          const existing = await tx
            .select({ id: marketingSends.id })
            .from(marketingSends)
            .where(and(eq(marketingSends.campaignId, campaign.id), eq(marketingSends.customerId, m.id)))
            .limit(1);
          if (existing.length > 0) {
            alreadySent += 1;
            continue;
          }
          await tx.insert(marketingSends).values({ orgId: ctx.actor.orgId, campaignId: campaign.id, customerId: m.id, sentAt: ctx.now });
          recipients += 1;
        }
        await tx.update(marketingCampaigns).set({ sentAt: ctx.now }).where(eq(marketingCampaigns.id, campaign.id));
        return { recipients, skippedOptOut, alreadySent };
      });
    },
  });

const campaignAnalytics = (deps: ModuleDeps) =>
  defineCapability({
    id: "marketing.campaignAnalytics",
    title: "Campaign analytics",
    intent: "Report a campaign's delivery count straight from the send log — no pixels, no guesses",
    module: "marketing",
    risk: "read",
    permission: "marketing.read",
    input: z.object({ campaignId: z.string().uuid() }),
    output: z.object({
      campaignName: z.string(),
      sentCount: z.number(),
      sentAt: z.string().nullable(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [campaign] = await tx
          .select({ name: marketingCampaigns.name, sentAt: marketingCampaigns.sentAt })
          .from(marketingCampaigns)
          .where(and(eq(marketingCampaigns.id, input.campaignId), eq(marketingCampaigns.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!campaign) throw new Error("campaign not found");
        const [agg] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(marketingSends)
          .where(eq(marketingSends.campaignId, input.campaignId));
        return {
          campaignName: campaign.name,
          sentCount: Number(agg?.n ?? 0),
          sentAt: campaign.sentAt?.toISOString() ?? null,
        };
      });
    },
  });

export function registerMarketingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createSegment(deps));
  registry.register(createCampaign(deps));
  registry.register(sendCampaign(deps));
  registry.register(campaignAnalytics(deps));
}
