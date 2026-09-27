import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { deals, customers, getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

function dealsGoUnavailable() {
  return NextResponse.json(
    { ok: false, error: "deals service unavailable; check deal status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function dealsGoResponse(
  result: GoCapabilityBridgeResult,
  dataSchema: z.ZodType,
) {
  if (result.kind !== "response") return dealsGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: dataSchema }).safeParse(body);
      if (!parsed.success) return dealsGoUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return dealsGoUnavailable();
      return NextResponse.json(
        { ok: false, pendingApproval: true, reason: parsed.data.reason },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return dealsGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return dealsGoUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return dealsGoUnavailable();
  }

  return dealsGoUnavailable();
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "crm.read");
  if (denied) return denied;
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
  z.object({ action: z.literal("move"), dealId: z.string(), stage: z.string(), lostReason: z.string().trim().min(3).max(500).optional() }),
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

  if (body.data.action === "create") {
    const input = { title: body.data.title, valueMinor: body.data.valueMinor, customerId: body.data.customerId };
    if (process.env.GO_CRM_DEAL_WRITES === "1") {
      try {
        const result = await executeGoCapability({
          actionContext: humanCtx,
          session: resolved,
          capabilityId: "crm.createDeal",
          input,
        });
        return dealsGoResponse(result, z.object({ dealId: z.string().uuid() }));
      } catch {
        return dealsGoUnavailable();
      }
    }
    const executor = buildExecutor(db, buildRegistry(db));
    const result = await executor.execute("crm.createDeal", humanCtx, input);
    return respond(result);
  }

  // Validate the requested stage is a known one before moving.
  const [deal] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.id, body.data.dealId), eq(deals.orgId, resolved.orgId)))
    .limit(1);
  if (!deal) return NextResponse.json({ error: "not found" }, { status: 404 });

  const input = {
    dealId: body.data.dealId,
    stage: body.data.stage,
    lostReason: body.data.lostReason,
  };
  if (process.env.GO_CRM_DEAL_WRITES === "1") {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: "crm.moveDealStage",
        input,
      });
      return dealsGoResponse(result, z.object({ moved: z.literal(true), stage: z.string() }));
    } catch {
      return dealsGoUnavailable();
    }
  }

  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("crm.moveDealStage", humanCtx, input);
  return respond(result);
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
