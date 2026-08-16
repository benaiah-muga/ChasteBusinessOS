/**
 * Postgres-backed context-bundle store over `context_bundles` +
 * `context_sections`.
 *
 * ADR 0014 — versioned context bundles are the durable backing for the
 * model-visible reconstruction invariant: a `ContextBundle` saved here can be
 * rehydrated by a later process (or a replay/audit tool) without the original
 * prompt text, because every section carries source, purpose, authorization,
 * and token estimate.
 */
import { eq } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
const { contextBundles, contextSections } = schema;
import type { ContextBundle, ContextSection } from "@chaste/ai-core";

export class PostgresContextBundleStore {
  constructor(private readonly db: Db) {}

  async save(bundle: ContextBundle): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(contextBundles).values({
        id: bundle.bundleId,
        sessionId: bundle.sessionId,
        organizationId: bundle.organizationId,
        turn: bundle.turn,
        modelRoute: `${bundle.modelRoute.provider}/${bundle.modelRoute.model}`,
        tokenBudget: bundle.tokenBudget as unknown as object,
        evidence: bundle.evidence as unknown[],
        redactions: bundle.redactions as unknown[],
        omitted: bundle.omitted as unknown[],
        summariesUsed: bundle.summariesUsed as unknown[],
        cacheKeys: bundle.cacheKeys as unknown[],
      });
      if (bundle.sections.length > 0) {
        await tx.insert(contextSections).values(
          bundle.sections.map((s) => ({
            id: s.id,
            bundleId: bundle.bundleId,
            sectionKey: s.id,
            tier: s.tier,
            purpose: s.purpose,
            source: s.source,
            visibility: s.visibility,
            contentRef: s.contentRef ?? null,
            renderedText: s.renderedText ?? null,
            tokenEstimate: s.tokenEstimate,
            required: s.required,
          })),
        );
      }
    });
  }

  async get(bundleId: string): Promise<ContextBundle | undefined> {
    const [row] = await this.db
      .select()
      .from(contextBundles)
      .where(eq(contextBundles.id, bundleId))
      .limit(1);
    if (!row) return undefined;
    const sections = await this.db
      .select()
      .from(contextSections)
      .where(eq(contextSections.bundleId, bundleId));
    return this.toBundle(row, sections);
  }

  async listForSession(sessionId: string): Promise<ContextBundle[]> {
    const rows = await this.db
      .select()
      .from(contextBundles)
      .where(eq(contextBundles.sessionId, sessionId));
    const bundles: ContextBundle[] = [];
    for (const row of rows) {
      const sections = await this.db
        .select()
        .from(contextSections)
        .where(eq(contextSections.bundleId, row.id));
      bundles.push(this.toBundle(row, sections));
    }
    return bundles;
  }

  private toBundle(
    row: {
      id: string;
      sessionId: string;
      organizationId: string;
      turn: number;
      modelRoute: string;
      tokenBudget: unknown;
      evidence: unknown;
      redactions: unknown;
      omitted: unknown;
      summariesUsed: unknown;
      cacheKeys: unknown;
    },
    sections: Array<{
      id: string;
      bundleId: string;
      tier: number;
      purpose: string;
      source: string;
      visibility: string;
      contentRef: string | null;
      renderedText: string | null;
      tokenEstimate: number;
      required: boolean;
    }>,
  ): ContextBundle {
    const [provider, model] = String(row.modelRoute).split("/");
    const tokenBudget = row.tokenBudget as unknown as ContextBundle["tokenBudget"];
    return {
      bundleId: row.id,
      sessionId: row.sessionId,
      organizationId: row.organizationId,
      turn: row.turn,
      modelRoute: {
        routeId: `${provider ?? ""}/${model ?? ""}`,
        provider: provider ?? "",
        model: model ?? "",
      },
      tokenBudget,
      evidence: row.evidence as ContextBundle["evidence"],
      redactions: row.redactions as ContextBundle["redactions"],
      omitted: row.omitted as ContextBundle["omitted"],
      summariesUsed: row.summariesUsed as ContextBundle["summariesUsed"],
      cacheKeys: row.cacheKeys as ContextBundle["cacheKeys"],
      sections: sections.map((s) => {
        const section: ContextSection = {
          id: s.id,
          tier: s.tier as ContextSection["tier"],
          purpose: s.purpose as ContextSection["purpose"],
          source: s.source as ContextSection["source"],
          visibility: s.visibility as ContextSection["visibility"],
          contentRef: s.contentRef ?? undefined,
          renderedText: s.renderedText ?? undefined,
          tokenEstimate: s.tokenEstimate,
          required: s.required,
        };
        return section;
      }),
    };
  }
}
