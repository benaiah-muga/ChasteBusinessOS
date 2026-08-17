/**
 * Postgres-backed proactive-coordinator stores (ADR 0014 tranche 12).
 *
 * Three durable counterparts to the in-memory stores in `@chaste/ai-core`
 * `proactive/`, so watch rules created on one host are honored by another and
 * deliveries/occurrence cursors survive restarts:
 *  - `PostgresWatchRuleStore` over `watch_rules`
 *  - `PostgresProactivePreferencesStore` over `proactive_preferences`
 *  - `PostgresProactiveDeliveryStore` over `proactive_deliveries`
 *
 * The unique (org, dedupe_key) constraint makes a firing exactly-once across
 * hosts even when two hosts race the same tick.
 */
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import {
  proactivePreferencesSchema,
  watchRuleSchema,
  type ProactiveDelivery,
  type ProactiveDeliveryStore,
  type ProactivePreferences,
  type ProactivePreferencesStore,
  type WatchRule,
  type WatchRuleStore,
} from "@chaste/ai-core";

const { watchRules, proactivePreferences, proactiveDeliveries } = schema;

export class PostgresWatchRuleStore implements WatchRuleStore {
  constructor(private readonly db: Db) {}

  async create(
    rule: Omit<WatchRule, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string },
  ): Promise<WatchRule> {
    const id = rule.id ?? crypto.randomUUID();
    await this.db.insert(watchRules).values({
      id,
      organizationId: rule.organizationId,
      name: rule.name,
      trigger: rule.trigger as unknown,
      action: rule.action as unknown,
      condition: rule.condition ?? null,
      enabled: rule.enabled ?? true,
      priority: rule.priority ?? "normal",
      createdByUserId: rule.createdByUserId,
      createdAt: rule.createdAt ? new Date(rule.createdAt) : new Date(),
    });
    const created = await this.get(rule.organizationId, id);
    if (!created) throw new Error("watch rule insert failed");
    return created;
  }

  async update(
    organizationId: string,
    id: string,
    patch: Partial<Pick<WatchRule, "name" | "trigger" | "action" | "condition" | "priority" | "enabled">>,
  ): Promise<WatchRule | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.trigger !== undefined) set.trigger = patch.trigger as unknown;
    if (patch.action !== undefined) set.action = patch.action as unknown;
    if (patch.condition !== undefined) set.condition = patch.condition ?? null;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    await this.db.update(watchRules).set(set).where(and(eq(watchRules.id, id), eq(watchRules.organizationId, organizationId)));
    return this.get(organizationId, id);
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(watchRules)
      .where(and(eq(watchRules.id, id), eq(watchRules.organizationId, organizationId)))
      .returning({ id: watchRules.id });
    return rows.length === 1;
  }

  async get(organizationId: string, id: string): Promise<WatchRule | undefined> {
    const rows = await this.db
      .select()
      .from(watchRules)
      .where(and(eq(watchRules.id, id), eq(watchRules.organizationId, organizationId)))
      .limit(1);
    return this.mapRow(rows[0]);
  }

  async listByOrg(organizationId: string): Promise<WatchRule[]> {
    const rows = await this.db
      .select()
      .from(watchRules)
      .where(eq(watchRules.organizationId, organizationId))
      .orderBy(asc(watchRules.createdAt));
    return rows.map((r) => this.mapRow(r)).filter((r): r is WatchRule => Boolean(r));
  }

  private mapRow(
    row:
      | {
          id: string;
          organizationId: string;
          name: string;
          trigger: unknown;
          action: unknown;
          condition: string | null;
          enabled: boolean;
          priority: string;
          createdByUserId: string;
          createdAt: Date;
          updatedAt: Date;
        }
      | undefined,
  ): WatchRule | undefined {
    if (!row) return undefined;
    const parsed = watchRuleSchema.safeParse({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      trigger: row.trigger,
      action: row.action,
      condition: row.condition ?? undefined,
      enabled: row.enabled,
      priority: row.priority,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    return parsed.success ? parsed.data : undefined;
  }
}

export class PostgresProactivePreferencesStore implements ProactivePreferencesStore {
  constructor(private readonly db: Db) {}

  async get(organizationId: string): Promise<ProactivePreferences> {
    const rows = await this.db
      .select()
      .from(proactivePreferences)
      .where(eq(proactivePreferences.organizationId, organizationId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      const created: ProactivePreferences = { organizationId, maxSuggestionsPerDay: 10, channels: ["inbox"] };
      await this.db.insert(proactivePreferences).values({
        organizationId,
        maxSuggestionsPerDay: 10,
        channels: ["inbox"],
      });
      return created;
    }
    return this.mapRow(row);
  }

  async set(prefs: ProactivePreferences): Promise<ProactivePreferences> {
    await this.db
      .insert(proactivePreferences)
      .values({
        organizationId: prefs.organizationId,
        quietHours: prefs.quietHours ? (prefs.quietHours as unknown) : null,
        maxSuggestionsPerDay: prefs.maxSuggestionsPerDay ?? 10,
        channels: prefs.channels ?? ["inbox"],
      })
      .onConflictDoUpdate({
        target: proactivePreferences.organizationId,
        set: {
          quietHours: prefs.quietHours ? (prefs.quietHours as unknown) : null,
          maxSuggestionsPerDay: prefs.maxSuggestionsPerDay ?? 10,
          channels: prefs.channels ?? ["inbox"],
          updatedAt: new Date(),
        },
      });
    const parsed = proactivePreferencesSchema.safeParse({
      organizationId: prefs.organizationId,
      quietHours: prefs.quietHours ?? undefined,
      maxSuggestionsPerDay: prefs.maxSuggestionsPerDay ?? 10,
      channels: prefs.channels ?? ["inbox"],
    });
    if (!parsed.success) throw new Error("invalid proactive preferences");
    return parsed.data;
  }

  private mapRow(row: {
    organizationId: string;
    quietHours: unknown | null;
    maxSuggestionsPerDay: number;
    channels: string[] | null;
  }): ProactivePreferences {
    const parsed = proactivePreferencesSchema.safeParse({
      organizationId: row.organizationId,
      quietHours: row.quietHours ?? undefined,
      maxSuggestionsPerDay: row.maxSuggestionsPerDay,
      channels: row.channels ?? ["inbox"],
    });
    if (!parsed.success) throw new Error("invalid stored proactive preferences");
    return parsed.data;
  }
}

export class PostgresProactiveDeliveryStore implements ProactiveDeliveryStore {
  constructor(private readonly db: Db) {}

  async record(
    d: Omit<ProactiveDelivery, "id" | "deliveredAt">,
    now?: Date,
  ): Promise<ProactiveDelivery> {
    const id = crypto.randomUUID();
    const at = now ?? new Date();
    await this.db.insert(proactiveDeliveries).values({
      id,
      organizationId: d.organizationId,
      dedupeKey: d.dedupeKey,
      kind: d.kind,
      sourceId: d.sourceId,
      occurrenceKey: d.occurrenceKey,
      triggerEvidence: d.triggerEvidence,
      proposedAction: d.proposedAction,
      expectedImpact: d.expectedImpact,
      requiredApproval: d.requiredApproval,
      priority: d.priority,
      targetUserIds: d.targetUserIds ?? [],
      suppressed: d.suppressed,
      suppressionReason: d.suppressionReason ?? null,
      deliveredAt: at,
    });
    return { ...d, id, deliveredAt: at.toISOString() };
  }

  async seen(organizationId: string, dedupeKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: proactiveDeliveries.id })
      .from(proactiveDeliveries)
      .where(and(eq(proactiveDeliveries.organizationId, organizationId), eq(proactiveDeliveries.dedupeKey, dedupeKey)))
      .limit(1);
    return rows.length > 0;
  }

  async lastOccurrence(organizationId: string, sourceId: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ occurrenceKey: proactiveDeliveries.occurrenceKey })
      .from(proactiveDeliveries)
      .where(and(eq(proactiveDeliveries.organizationId, organizationId), eq(proactiveDeliveries.sourceId, sourceId)))
      .orderBy(desc(proactiveDeliveries.occurrenceKey))
      .limit(1);
    return rows[0]?.occurrenceKey;
  }

  async countDeliveredOn(organizationId: string, day: Date): Promise<number> {
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const end = new Date(start.getTime() + 86_400_000);
    const rows = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(proactiveDeliveries)
      .where(
        and(
          eq(proactiveDeliveries.organizationId, organizationId),
          eq(proactiveDeliveries.suppressed, false),
          gte(proactiveDeliveries.deliveredAt, start),
          sql`${proactiveDeliveries.deliveredAt} < ${end.toISOString()}`,
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async listByOrg(organizationId: string): Promise<ProactiveDelivery[]> {
    const rows = await this.db
      .select()
      .from(proactiveDeliveries)
      .where(eq(proactiveDeliveries.organizationId, organizationId))
      .orderBy(desc(proactiveDeliveries.deliveredAt));
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      dedupeKey: r.dedupeKey,
      kind: r.kind as ProactiveDelivery["kind"],
      sourceId: r.sourceId,
      occurrenceKey: r.occurrenceKey,
      triggerEvidence: r.triggerEvidence,
      proposedAction: r.proposedAction,
      expectedImpact: r.expectedImpact,
      requiredApproval: r.requiredApproval,
      priority: r.priority as ProactiveDelivery["priority"],
      targetUserIds: r.targetUserIds ?? [],
      suppressed: r.suppressed,
      suppressionReason: r.suppressionReason ?? undefined,
      deliveredAt: r.deliveredAt.toISOString(),
    }));
  }
}