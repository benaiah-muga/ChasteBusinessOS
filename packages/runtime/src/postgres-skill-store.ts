/**
 * Postgres-backed `SkillStore` over the `ai_skills` table.
 *
 * ARCH-4 — the durable counterpart to `InMemorySkillStore`. Skills (org-scoped
 * or platform-bundled) are shared and durable across processes, so a skill
 * enabled through the API is loadable by the worker's follow-up harness.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
const { aiSkills } = schema;
import { platformSkillRecords } from "@chaste/ai-core";
import type { SkillRecord, SkillStore } from "@chaste/ai-core";

export class PostgresSkillStore implements SkillStore {
  constructor(private readonly db: Db) {}

  async list(filter: {
    organizationId: string;
    branchId?: string;
    enabledOnly?: boolean;
  }): Promise<SkillRecord[]> {
    const rows = await this.db
      .select()
      .from(aiSkills)
      .where(
        and(
          // Platform skills (org null) are visible to everyone; org skills only
          // to their own org.
          or(eq(aiSkills.scope, "platform"), eq(aiSkills.organizationId, filter.organizationId)),
          filter.branchId
            ? or(eq(aiSkills.branchId, filter.branchId), isNull(aiSkills.branchId))
            : undefined,
          filter.enabledOnly ? eq(aiSkills.enabled, true) : undefined,
        ),
      );
    const dbRows = rows.map((r) => this.toRecord(r));
    // Read-only platform skills are code-as-source-of-truth (always enabled);
    // an org-scoped override in the DB with the same name shadows the bundled one.
    const bundled = platformSkillRecords().filter(
      (s) => !dbRows.some((r) => r.name === s.name && r.scope === "platform"),
    );
    return [...dbRows, ...bundled]
      .filter((s) => !filter.enabledOnly || s.enabled)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(
    name: string,
    filter: { organizationId: string; branchId?: string },
  ): Promise<SkillRecord | undefined> {
    return (await this.list(filter)).find((s) => s.name === name);
  }

  async upsert(record: Omit<SkillRecord, "createdAt" | "updatedAt">): Promise<SkillRecord> {
    const existing = await this.db
      .select()
      .from(aiSkills)
      .where(
        and(
          eq(aiSkills.name, record.name),
          record.scope === "platform" ? isNull(aiSkills.organizationId) : eq(aiSkills.organizationId, record.organizationId ?? ""),
          record.branchId ? eq(aiSkills.branchId, record.branchId) : isNull(aiSkills.branchId),
        ),
      )
      .limit(1);
    const now = new Date();
    if (existing.length > 0) {
      const row = existing[0]!;
      const updated = await this.db
        .update(aiSkills)
        .set({
          title: record.title,
          summary: record.summary,
          instructions: record.instructions,
          files: record.files ?? [],
          refinements: record.refinements ?? [],
          enabled: record.enabled,
          updatedAt: now,
        })
        .where(eq(aiSkills.id, row.id))
        .returning();
      return this.toRecord(updated[0]!);
    }
    const id = crypto.randomUUID();
    const created = await this.db
      .insert(aiSkills)
      .values({
        id,
        scope: record.scope,
        organizationId: record.organizationId ?? null,
        branchId: record.branchId ?? null,
        name: record.name,
        title: record.title,
        summary: record.summary,
        instructions: record.instructions,
        files: record.files ?? [],
        refinements: record.refinements ?? [],
        enabled: record.enabled,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.toRecord(created[0]!);
  }

  async setEnabled(
    name: string,
    filter: { organizationId: string; branchId?: string },
    enabled: boolean,
  ): Promise<void> {
    const existing = await this.get(name, filter);
    if (!existing) return;
    await this.db
      .update(aiSkills)
      .set({ enabled, updatedAt: new Date() })
      .where(
        and(
          eq(aiSkills.name, name),
          eq(aiSkills.scope, existing.scope),
          existing.organizationId ? eq(aiSkills.organizationId, existing.organizationId) : isNull(aiSkills.organizationId),
          existing.branchId ? eq(aiSkills.branchId, existing.branchId) : isNull(aiSkills.branchId),
        ),
      );
  }

  private toRecord(r: {
    id: string;
    scope: string;
    organizationId: string | null;
    branchId: string | null;
    name: string;
    title: string;
    summary: string;
    instructions: string;
    files: unknown[] | null;
    refinements: unknown[] | null;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): SkillRecord {
    return {
      name: r.name,
      scope: r.scope as SkillRecord["scope"],
      organizationId: r.organizationId ?? undefined,
      branchId: r.branchId ?? undefined,
      title: r.title,
      summary: r.summary,
      instructions: r.instructions,
      files: (r.files ?? []) as SkillRecord["files"],
      refinements: (r.refinements ?? []) as SkillRecord["refinements"],
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
