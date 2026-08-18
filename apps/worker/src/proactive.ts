/**
 * Proactive watch-rule delivery (ADR 0014 tranche 16).
 *
 * The coordinator only *produces* authority-safe suggestions and records the
 * durable delivery ledger — it never executes. This processor is the host loop
 * that (a) collects every due suggestion per org, (b) evaluates the rule's
 * optional `condition` mini-DSL against org data, and (c) turns non-suppressed,
 * condition-true suggestions into in-app notifications for each target user.
 *
 * `request_approval` / `draft` mode suggestions are deliberately NOT auto-
 * executed: they surface as notifications with the intent text (the strict
 * authority ladder in ai-core proactive/watch-rules.ts). Approval routing is a
 * separate human step.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import {
  createProactiveCoordinator,
  type WatchRule,
} from "@chaste/ai-core";
import {
  PostgresActivityStore,
  PostgresProactiveDeliveryStore,
  PostgresProactivePreferencesStore,
  PostgresWakeStore,
  PostgresWatchRuleStore,
} from "@chaste/runtime";

export interface ProactiveTickResult {
  orgs: number;
  delivered: number;
  notified: number;
  suppressed: number;
}

export interface ProactiveProcessor {
  tick(now?: Date): Promise<ProactiveTickResult>;
}

/** Evaluate a stored rule condition (mini DSL) against org data. */
export async function evaluateWatchCondition(
  db: Db,
  organizationId: string,
  condition: string,
): Promise<{ result: boolean; note?: string }> {
  const c = condition.trim();
  let m = c.match(/^po\.total\s+(?:gt|greater than|over)\s+(\d+(?:\.\d+)?)$/i);
  if (m) {
    const threshold = m[1]!;
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.purPurchaseOrders)
      .where(
        and(
          eq(schema.purPurchaseOrders.organizationId, organizationId),
          sql`${schema.purPurchaseOrders.total} > ${threshold}`,
        ),
      );
    return { result: (row?.n ?? 0) > 0 };
  }

  m = c.match(/^invoice\.overdue\s+gt\s+(\d+)$/i);
  if (m) {
    const days = Number(m[1]);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.accInvoices)
      .where(
        and(
          eq(schema.accInvoices.organizationId, organizationId),
          lt(schema.accInvoices.issuedAt, cutoff),
          sql`${schema.accInvoices.status} <> 'paid'`,
        ),
      );
    return { result: (row?.n ?? 0) > 0 };
  }

  m = c.match(/^stock\.product\.([A-Z0-9-]+)\s+(?:below|lt|under)\s+(\d+)$/i);
  if (m) {
    const sku = m[1]!.toUpperCase();
    const threshold = Number(m[2]);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.invStockLevels)
      .innerJoin(schema.invProducts, eq(schema.invProducts.id, schema.invStockLevels.productId))
      .where(
        and(
          eq(schema.invStockLevels.organizationId, organizationId),
          eq(schema.invProducts.sku, sku),
          sql`${schema.invStockLevels.quantity} < ${threshold}`,
        ),
      );
    return { result: (row?.n ?? 0) > 0 };
  }

  return { result: true, note: `condition "${condition}" was not auto-evaluated` };
}

/** Build a human-readable notification body, enriching report-style intents. */
export async function buildWatchNotificationBody(
  db: Db,
  organizationId: string,
  intent: string,
): Promise<string> {
  const lower = intent.toLowerCase();
  const lines: string[] = [];

  if (/stockout|at risk of stock|stock level|replenish/.test(lower)) {
    const rows = await db
      .select({
        sku: schema.invProducts.sku,
        name: schema.invProducts.name,
        reorderLevel: schema.invProducts.reorderLevel,
        quantity: schema.invStockLevels.quantity,
        warehouse: schema.invWarehouses.code,
      })
      .from(schema.invStockLevels)
      .innerJoin(schema.invProducts, eq(schema.invProducts.id, schema.invStockLevels.productId))
      .innerJoin(schema.invWarehouses, eq(schema.invWarehouses.id, schema.invStockLevels.warehouseId))
      .where(
        and(
          eq(schema.invStockLevels.organizationId, organizationId),
          sql`${schema.invStockLevels.quantity} < ${schema.invProducts.reorderLevel}`,
        ),
      )
      .orderBy(schema.invWarehouses.code, schema.invProducts.sku);
    if (rows.length > 0) {
      lines.push("Stockout risk now:");
      for (const r of rows) {
        lines.push(
          `  ${r.sku} (${r.name}) — ${r.quantity} in ${r.warehouse} vs reorder ${r.reorderLevel}`,
        );
      }
    } else {
      lines.push("No products are below their reorder level right now.");
    }
  }

  if (/overdue|past due/.test(lower)) {
    const rows = await db
      .select({ number: schema.accInvoices.number, total: schema.accInvoices.total })
      .from(schema.accInvoices)
      .where(
        and(
          eq(schema.accInvoices.organizationId, organizationId),
          sql`${schema.accInvoices.issuedAt} < now() - interval '14 days'`,
          sql`${schema.accInvoices.status} <> 'paid'`,
        ),
      );
    if (rows.length > 0) {
      lines.push(`Overdue invoices (${rows.length}):`);
      lines.push(...rows.slice(0, 8).map((r) => `  ${r.number} — ${r.total}`));
      if (rows.length > 8) lines.push(`  … and ${rows.length - 8} more`);
    }
  }

  if (/purchase order|po\b|supplier bill|approval routing/.test(lower)) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.purPurchaseOrders)
      .where(
        and(
          eq(schema.purPurchaseOrders.organizationId, organizationId),
          sql`${schema.purPurchaseOrders.total} > 5000000`,
        ),
      );
    if ((row?.n ?? 0) > 0) lines.push(`${row!.n} purchase order(s) over UGX 5,000,000 need attention.`);
  }

  const body = [intent, ...lines].join("\n");
  return body.slice(0, 500);
}

/** Resolve a stored recipient token to concrete user ids for notification. */
async function resolveDeliveryTargets(
  db: Db,
  organizationId: string,
  targets: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const raw of targets) {
    const token = raw.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      out.push(token);
      continue;
    }
    if (token.includes("@")) {
      const [user] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(eq(schema.users.organizationId, organizationId), eq(schema.users.email, token)),
        )
        .limit(1);
      if (user) out.push(user.id);
      continue;
    }
    const roleRows = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(eq(schema.roles.organizationId, organizationId), eq(schema.roles.key, token.toLowerCase())),
      );
    if (roleRows.length > 0) {
      const roleUsers = await db
        .select({ userId: schema.userRoles.userId })
        .from(schema.userRoles)
        .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
        .where(
          and(
            inArray(schema.userRoles.roleId, roleRows.map((r) => r.id)),
            eq(schema.users.isActive, true),
          ),
        );
      out.push(...roleUsers.map((r) => r.userId));
    }
  }
  return [...new Set(out)];
}

export function createProactiveProcessor(db: Db): ProactiveProcessor {
  const watchRules = new PostgresWatchRuleStore(db);
  const wakes = new PostgresWakeStore(db);
  const activities = new PostgresActivityStore(db);
  const preferences = new PostgresProactivePreferencesStore(db);
  const deliveries = new PostgresProactiveDeliveryStore(db);
  const coordinator = createProactiveCoordinator({
    watchRules,
    wakes,
    activities,
    preferences,
    deliveries,
    now: () => new Date(),
  });

  const ruleCache = new Map<string, WatchRule>();

  async function tick(now = new Date()): Promise<ProactiveTickResult> {
    const orgs = await db
      .selectDistinct({ organizationId: schema.watchRules.organizationId })
      .from(schema.watchRules)
      .where(eq(schema.watchRules.enabled, true));
    let delivered = 0;
    let notified = 0;
    let suppressed = 0;

    for (const { organizationId } of orgs) {
      const items = await coordinator.deliverDue(organizationId, now);
      for (const item of items) {
        delivered += 1;
        if (item.suppressed) {
          suppressed += 1;
          continue;
        }
        if (item.kind === "watch_rule") {
          const cached = ruleCache.get(item.sourceId);
          const rule =
            cached ?? (await watchRules.get(organizationId, item.sourceId));
          if (rule?.condition) {
            const evald = await evaluateWatchCondition(db, organizationId, rule.condition);
            if (!evald.result) {
              continue;
            }
          }
        }
        const targets = await resolveDeliveryTargets(db, organizationId, item.targetUserIds);
        if (targets.length === 0) continue;
        const body = await buildWatchNotificationBody(db, organizationId, item.proposedAction);
        for (const userId of targets) {
          await db.insert(schema.notifications).values({
            organizationId,
            userId,
            kind: "proactive",
            title: item.triggerEvidence.slice(0, 120),
            body,
            href: "/ops/proactive",
            resourceType: "watch_rule",
            resourceId: item.sourceId,
          });
          notified += 1;
        }
      }
    }
    return { orgs: orgs.length, delivered, notified, suppressed };
  }

  return { tick };
}
