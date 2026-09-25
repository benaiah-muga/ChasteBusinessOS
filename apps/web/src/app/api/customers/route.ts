import { NextResponse } from "next/server";
import { and, asc, count, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, deals, documents, getDb, invoices, quotes, tasks, users } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";

/**
 * Customer directory. Reads power pickers across the app; writes go through
 * the CRM module's governed capabilities so agents and humans share one
 * audited path.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const crmDenied = missingPermission(resolved, "crm.read");
  const posDenied = missingPermission(resolved, "pos.sell");
  if (crmDenied && posDenied) return crmDenied;
  const db = getDb().db;
  if (crmDenied) {
    const [rows, purchaseStats] = await Promise.all([
      db
        .select({ id: customers.id, name: customers.name, email: customers.email })
        .from(customers)
        .where(and(eq(customers.orgId, resolved.orgId), isNull(customers.deactivatedAt)))
        .orderBy(asc(customers.name))
        .limit(500),
      db
        .select({
          customerId: invoices.customerId,
          purchaseCount: count(invoices.id),
          lifetimeSpendMinor: sql<number>`coalesce(sum(${invoices.totalMinor} - ${invoices.creditedMinor}), 0)`,
        })
        .from(invoices)
        .where(and(eq(invoices.orgId, resolved.orgId), isNotNull(invoices.posSessionId), isNotNull(invoices.customerId)))
        .groupBy(invoices.customerId),
    ]);
    const statsByCustomer = new Map(purchaseStats.map((stat) => [stat.customerId, {
      purchaseCount: stat.purchaseCount,
      lifetimeSpendMinor: Number(stat.lifetimeSpendMinor),
    }]));
    return NextResponse.json({
      customers: rows.map((customer) => ({
        ...customer,
        purchaseCount: statsByCustomer.get(customer.id)?.purchaseCount ?? 0,
        lifetimeSpendMinor: statsByCustomer.get(customer.id)?.lifetimeSpendMinor ?? 0,
      })),
    });
  }

  const rows = await db.select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      ownerUserId: customers.ownerUserId,
      ownerName: users.name,
      ownerEmail: users.email,
      tags: customers.tags,
      notes: customers.notes,
      createdAt: customers.createdAt,
      deactivatedAt: customers.deactivatedAt,
    })
    .from(customers)
    .leftJoin(users, eq(customers.ownerUserId, users.id))
    .where(eq(customers.orgId, resolved.orgId))
    .orderBy(asc(customers.name))
    .limit(500);

  const [dealActivity, taskActivity, invoiceActivity, quoteActivity, documentActivity, purchaseStats] = await Promise.all([
    db.select({ customerId: deals.customerId, lastAt: max(deals.updatedAt) })
      .from(deals)
      .where(and(eq(deals.orgId, resolved.orgId), isNotNull(deals.customerId)))
      .groupBy(deals.customerId),
    db.select({ customerId: tasks.refId, createdAt: max(tasks.createdAt), doneAt: max(tasks.doneAt) })
      .from(tasks)
      .where(and(eq(tasks.orgId, resolved.orgId), eq(tasks.refType, "customer"), isNotNull(tasks.refId)))
      .groupBy(tasks.refId),
    db.select({ customerId: invoices.customerId, lastAt: max(invoices.issuedAt) })
      .from(invoices)
      .where(eq(invoices.orgId, resolved.orgId))
      .groupBy(invoices.customerId),
    db.select({ customerId: quotes.customerId, createdAt: max(quotes.createdAt), decidedAt: max(quotes.decidedAt) })
      .from(quotes)
      .where(eq(quotes.orgId, resolved.orgId))
      .groupBy(quotes.customerId),
    db.select({ customerId: documents.refId, lastAt: max(documents.updatedAt) })
      .from(documents)
      .where(and(eq(documents.orgId, resolved.orgId), eq(documents.refType, "customer"), isNotNull(documents.refId)))
      .groupBy(documents.refId),
    db.select({
      customerId: invoices.customerId,
      purchaseCount: count(invoices.id),
      lifetimeSpendMinor: sql<number>`coalesce(sum(${invoices.totalMinor} - ${invoices.creditedMinor}), 0)`,
    })
      .from(invoices)
      .where(and(eq(invoices.orgId, resolved.orgId), isNotNull(invoices.posSessionId), isNotNull(invoices.customerId)))
      .groupBy(invoices.customerId),
  ]);
  const purchaseStatsByCustomer = new Map(purchaseStats.map((stat) => [stat.customerId, {
    purchaseCount: stat.purchaseCount,
    lifetimeSpendMinor: Number(stat.lifetimeSpendMinor),
  }]));
  const lastActivityByCustomer = new Map<string, Date>();
  const includeActivity = (customerId: string | null, date: Date | null) => {
    if (!customerId || !date) return;
    const previous = lastActivityByCustomer.get(customerId);
    if (!previous || date > previous) lastActivityByCustomer.set(customerId, date);
  };
  for (const activity of dealActivity) includeActivity(activity.customerId, activity.lastAt);
  for (const activity of taskActivity) {
    includeActivity(activity.customerId, activity.createdAt);
    includeActivity(activity.customerId, activity.doneAt);
  }
  for (const activity of invoiceActivity) includeActivity(activity.customerId, activity.lastAt);
  for (const activity of quoteActivity) {
    includeActivity(activity.customerId, activity.createdAt);
    includeActivity(activity.customerId, activity.decidedAt);
  }
  for (const activity of documentActivity) includeActivity(activity.customerId, activity.lastAt);
  return NextResponse.json({
    customers: rows.map((customer) => {
      const lastActivity = lastActivityByCustomer.get(customer.id);
      const mostRecent = lastActivity ?? customer.createdAt;
      return {
        ...customer,
        purchaseCount: purchaseStatsByCustomer.get(customer.id)?.purchaseCount ?? 0,
        lifetimeSpendMinor: purchaseStatsByCustomer.get(customer.id)?.lifetimeSpendMinor ?? 0,
        ownerName: customer.ownerName ?? customer.ownerEmail ?? null,
        lastActivityAt: mostRecent.toISOString(),
        deactivatedAt: customer.deactivatedAt?.toISOString() ?? null,
      };
    }),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).max(120),
    email: z.string().email().optional(),
  }),
  z.object({ action: z.literal("deactivate"), customerId: z.string() }),
  z.object({
    action: z.literal("updateProfile"),
    customerIds: z.array(z.string().uuid()).min(1).max(100),
    ownerUserId: z.string().uuid().nullable().optional(),
    addTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    removeTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    notes: z.string().max(4000).nullable().optional(),
  }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const humanCtx = resolved ? actorFromResolved(resolved, { intentId }) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  let result;
  if (body.data.action === "create") {
    result = await executor.execute("crm.createCustomer", humanCtx, {
          name: body.data.name,
          email: body.data.email,
        });
  } else if (body.data.action === "deactivate") {
    result = await executor.execute("crm.deactivateCustomer", humanCtx, { customerId: body.data.customerId });
  } else {
    result = await executor.execute("crm.updateCustomerProfiles", humanCtx, {
      customerIds: body.data.customerIds,
      ...(body.data.ownerUserId !== undefined ? { ownerUserId: body.data.ownerUserId } : {}),
      ...(body.data.addTags ? { addTags: body.data.addTags } : {}),
      ...(body.data.removeTags ? { removeTags: body.data.removeTags } : {}),
      ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
    });
  }

  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
