import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { deals, customers, getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await getDb()
    .db.select({
      id: deals.id,
      title: deals.title,
      stage: deals.stage,
      valueMinor: deals.valueMinor,
      note: deals.note,
      customerId: deals.customerId,
      customerName: customers.name,
      createdAt: deals.createdAt,
      updatedAt: deals.updatedAt,
    })
    .from(deals)
    .leftJoin(customers, eq(deals.customerId, customers.id))
    .where(eq(deals.orgId, resolved.orgId))
    .limit(200);
  return NextResponse.json({
    deals: rows.map((d) => ({
      ...d,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    })),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().min(1).max(120),
    valueMinor: z.number().int().nonnegative(),
    customerId: z.string().optional(),
  }),
  z.object({ action: z.literal("move"), dealId: z.string(), stage: z.string() }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  if (body.data.action === "create") {
    const result = await executor.execute(
      "crm.createDeal",
      humanCtx,
      { title: body.data.title, valueMinor: body.data.valueMinor, customerId: body.data.customerId },
    );
    return respond(result);
  }

  // Validate the requested stage is a known one before moving.
  const [deal] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.id, body.data.dealId), eq(deals.orgId, resolved.orgId)))
    .limit(1);
  if (!deal) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await executor.execute("crm.moveDealStage", humanCtx, {
    dealId: body.data.dealId,
    stage: body.data.stage,
  });
  return respond(result);
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
