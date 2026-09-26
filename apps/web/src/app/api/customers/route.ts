import { NextResponse } from "next/server";
import { and, asc, count, eq, isNotNull, isNull, lt, lte, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  const editors = alias(users, "customer_editor");
  if (crmDenied) {
    const [rows, purchaseStats] = await Promise.all([
      db
        .select({ id: customers.id, name: customers.name, email: customers.email })
        .from(customers)
        .where(and(eq(customers.orgId, resolved.orgId), isNull(customers.deactivatedAt), isNull(customers.mergedIntoCustomerId)))
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

  const [rows, mergedRows] = await Promise.all([db.select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      ownerUserId: customers.ownerUserId,
      ownerName: users.name,
      ownerEmail: users.email,
      phone: customers.phone,
      preferredContactMethod: customers.preferredContactMethod,
      doNotContact: customers.doNotContact,
      updatedByUserId: customers.updatedByUserId,
      updatedByName: editors.name,
      updatedByEmail: editors.email,
      tags: customers.tags,
      notes: customers.notes,
      createdAt: customers.createdAt,
      updatedAt: customers.updatedAt,
      deactivatedAt: customers.deactivatedAt,
    })
    .from(customers)
    .leftJoin(users, eq(customers.ownerUserId, users.id))
    .leftJoin(editors, eq(customers.updatedByUserId, editors.id))
    .where(and(eq(customers.orgId, resolved.orgId), isNull(customers.mergedIntoCustomerId)))
    .orderBy(asc(customers.name))
    .limit(500),
    db.select({ id: customers.id, name: customers.name, mergedIntoCustomerId: customers.mergedIntoCustomerId, mergedAt: customers.mergedAt })
      .from(customers)
      .where(and(eq(customers.orgId, resolved.orgId), isNotNull(customers.mergedIntoCustomerId)))
      .orderBy(asc(customers.name)),
  ]);
  const mergedRecordsByCustomer = new Map<string, { id: string; name: string; mergedAt: string | null }[]>();
  const canonicalCustomerById = new Map<string, string>();
  for (const merged of mergedRows) {
    if (!merged.mergedIntoCustomerId) continue;
    const records = mergedRecordsByCustomer.get(merged.mergedIntoCustomerId) ?? [];
    records.push({ id: merged.id, name: merged.name, mergedAt: merged.mergedAt?.toISOString() ?? null });
    mergedRecordsByCustomer.set(merged.mergedIntoCustomerId, records);
    canonicalCustomerById.set(merged.id, merged.mergedIntoCustomerId);
  }
  const canonicalId = (customerId: string | null): string | null => customerId ? canonicalCustomerById.get(customerId) ?? customerId : null;

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(todayStart.getTime() + 86400000 - 1);
  const quoteAgeBoundary = new Date(now.getTime() - 7 * 86400000);
  const [dealActivity, taskActivity, invoiceActivity, quoteActivity, documentActivity, purchaseStats, overdueInvoices, agingQuotes, dueTasks] = await Promise.all([
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
    db.select({ id: invoices.id, customerId: invoices.customerId, number: invoices.number, totalMinor: invoices.totalMinor, paidMinor: invoices.paidMinor, creditedMinor: invoices.creditedMinor, dueAt: invoices.dueAt })
      .from(invoices)
      .where(and(eq(invoices.orgId, resolved.orgId), eq(invoices.status, "sent"), isNotNull(invoices.dueAt), lt(invoices.dueAt, now)))
      .orderBy(asc(invoices.dueAt))
      .limit(2000),
    db.select({ id: quotes.id, customerId: quotes.customerId, number: quotes.number, createdAt: quotes.createdAt })
      .from(quotes)
      .where(and(eq(quotes.orgId, resolved.orgId), eq(quotes.status, "sent"), lt(quotes.createdAt, quoteAgeBoundary)))
      .orderBy(asc(quotes.createdAt))
      .limit(2000),
    db.select({ id: tasks.id, refId: tasks.refId, title: tasks.title, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.orgId, resolved.orgId), eq(tasks.refType, "customer"), isNull(tasks.doneAt), isNotNull(tasks.dueAt), lte(tasks.dueAt, todayEnd)))
      .orderBy(asc(tasks.dueAt))
      .limit(2000),
  ]);
  const purchaseStatsByCustomer = new Map<string, { purchaseCount: number; lifetimeSpendMinor: number }>();
  for (const stat of purchaseStats) {
    const customerId = canonicalId(stat.customerId);
    if (!customerId) continue;
    const current = purchaseStatsByCustomer.get(customerId) ?? { purchaseCount: 0, lifetimeSpendMinor: 0 };
    current.purchaseCount += stat.purchaseCount;
    current.lifetimeSpendMinor += Number(stat.lifetimeSpendMinor);
    purchaseStatsByCustomer.set(customerId, current);
  }
  const lastActivityByCustomer = new Map<string, Date>();
  const includeActivity = (customerId: string | null, date: Date | null) => {
    const canonical = canonicalId(customerId);
    if (!canonical || !date) return;
    const previous = lastActivityByCustomer.get(canonical);
    if (!previous || date > previous) lastActivityByCustomer.set(canonical, date);
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
  const nextStepByCustomer = new Map<string, { kind: "invoice" | "quote" | "task"; summary: string; refId: string; amountMinor?: number; rank: number }>();
  const addNextStep = (customerId: string | null, candidate: { kind: "invoice" | "quote" | "task"; summary: string; refId: string; amountMinor?: number; rank: number }) => {
    const canonical = canonicalId(customerId);
    if (!canonical) return;
    const current = nextStepByCustomer.get(canonical);
    if (!current || candidate.rank < current.rank) nextStepByCustomer.set(canonical, candidate);
  };
  for (const invoice of overdueInvoices) {
    const outstanding = Math.max(0, invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor);
    if (outstanding > 0) addNextStep(invoice.customerId, { kind: "invoice", summary: `Invoice #${invoice.number} is overdue by ${Math.floor((now.getTime() - invoice.dueAt!.getTime()) / 86400000)}d`, refId: invoice.id, amountMinor: outstanding, rank: 1 });
  }
  for (const task of dueTasks) {
    const dueAt = task.dueAt!;
    addNextStep(task.refId, { kind: "task", summary: `${dueAt < todayStart ? "Overdue follow-up" : "Follow-up due today"}: ${task.title}`, refId: task.id, rank: dueAt < todayStart ? 2 : 3 });
  }
  for (const quote of agingQuotes) {
    addNextStep(quote.customerId, { kind: "quote", summary: `Quote #${quote.number} is waiting for ${Math.floor((now.getTime() - quote.createdAt.getTime()) / 86400000)} days`, refId: quote.id, rank: 4 });
  }
  return NextResponse.json({
    customers: rows.map((customer) => {
      const lastActivity = lastActivityByCustomer.get(customer.id);
      const mostRecent = lastActivity ?? customer.createdAt;
      return {
        ...customer,
        mergedRecords: mergedRecordsByCustomer.get(customer.id) ?? [],
        purchaseCount: purchaseStatsByCustomer.get(customer.id)?.purchaseCount ?? 0,
        lifetimeSpendMinor: purchaseStatsByCustomer.get(customer.id)?.lifetimeSpendMinor ?? 0,
        ownerName: customer.ownerName ?? customer.ownerEmail ?? null,
        lastActivityAt: mostRecent.toISOString(),
        nextStep: nextStepByCustomer.get(customer.id) ? {
          kind: nextStepByCustomer.get(customer.id)!.kind,
          summary: nextStepByCustomer.get(customer.id)!.summary,
          refId: nextStepByCustomer.get(customer.id)!.refId,
          amountMinor: nextStepByCustomer.get(customer.id)!.amountMinor,
        } : null,
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
    phone: z.string().trim().max(40).optional(),
    preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]).optional(),
    doNotContact: z.boolean().optional(),
  }),
  z.object({ action: z.literal("deactivate"), customerId: z.string() }),
  z.object({
    action: z.literal("merge"),
    survivorCustomerId: z.string().uuid(),
    duplicateCustomerId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("undoMerge"),
    survivorCustomerId: z.string().uuid(),
    duplicateCustomerId: z.string().uuid(),
    previous: z.array(z.object({
      customerId: z.string().uuid(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]),
      doNotContact: z.boolean(),
      reminderOptOut: z.boolean(),
      marketingOptOut: z.boolean(),
      ownerUserId: z.string().uuid().nullable(),
      tags: z.array(z.string()),
      notes: z.string().nullable(),
      creditLimitMinor: z.number().int().nullable(),
      paymentTermDays: z.number().int().nullable(),
      deactivatedAt: z.string().nullable(),
      mergedIntoCustomerId: z.string().uuid().nullable(),
      mergedAt: z.string().nullable(),
    })).min(2).max(502),
  }),
  z.object({
    action: z.literal("updateProfile"),
    customerIds: z.array(z.string().uuid()).min(1).max(100),
    name: z.string().trim().min(1).max(120).optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    addTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    removeTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    notes: z.string().max(4000).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]).optional(),
    doNotContact: z.boolean().optional(),
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
          phone: body.data.phone,
          preferredContactMethod: body.data.preferredContactMethod,
          doNotContact: body.data.doNotContact,
        });
  } else if (body.data.action === "deactivate") {
    result = await executor.execute("crm.deactivateCustomer", humanCtx, { customerId: body.data.customerId });
  } else if (body.data.action === "merge") {
    result = await executor.execute("crm.mergeCustomers", humanCtx, {
      survivorCustomerId: body.data.survivorCustomerId,
      duplicateCustomerId: body.data.duplicateCustomerId,
    });
  } else if (body.data.action === "undoMerge") {
    result = await executor.execute("crm.restoreCustomerMerge", humanCtx, body.data);
  } else {
    result = await executor.execute("crm.updateCustomerProfiles", humanCtx, {
      customerIds: body.data.customerIds,
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.ownerUserId !== undefined ? { ownerUserId: body.data.ownerUserId } : {}),
      ...(body.data.addTags ? { addTags: body.data.addTags } : {}),
      ...(body.data.removeTags ? { removeTags: body.data.removeTags } : {}),
      ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
      ...(body.data.phone !== undefined ? { phone: body.data.phone } : {}),
      ...(body.data.preferredContactMethod !== undefined ? { preferredContactMethod: body.data.preferredContactMethod } : {}),
      ...(body.data.doNotContact !== undefined ? { doNotContact: body.data.doNotContact } : {}),
    });
  }

  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
