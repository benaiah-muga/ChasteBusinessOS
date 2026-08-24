import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Customer directory. Reads power pickers across the app; writes go through
 * the CRM module's governed capabilities so agents and humans share one
 * audited path.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await getDb()
    .db.select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      deactivatedAt: customers.deactivatedAt,
    })
    .from(customers)
    .where(eq(customers.orgId, resolved.orgId))
    .orderBy(asc(customers.name))
    .limit(500);
  return NextResponse.json({
    customers: rows.map((c) => ({ ...c, deactivatedAt: c.deactivatedAt?.toISOString() ?? null })),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).max(120),
    email: z.string().email().optional(),
  }),
  z.object({ action: z.literal("deactivate"), customerId: z.string() }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const result =
    body.data.action === "create"
      ? await executor.execute("crm.createCustomer", humanCtx, {
          name: body.data.name,
          email: body.data.email,
        })
      : await executor.execute("crm.deactivateCustomer", humanCtx, { customerId: body.data.customerId });

  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
