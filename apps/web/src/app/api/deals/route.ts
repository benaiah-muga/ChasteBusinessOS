import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { deals, customers, getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";
import { canonicalInputHash, logger } from "@chaste/kernel";

const noStore = { "Cache-Control": "no-store" };
const dealReadResponseSchema = z.object({
  deals: z.array(z.object({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    valueMinor: z.number().int(),
    note: z.string().nullable(),
    customerId: z.string().nullable(),
    customerName: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict()),
}).strict();

function dealsGoUnavailable() {
  return NextResponse.json(
    { ok: false, error: "deals service unavailable; check deal status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function readDealsFromGo(resolved: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>, actor: NonNullable<ReturnType<typeof actorFromResolved>>["actor"]) {
  const secret = process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32 || !resolved.orgId || !resolved.authSessionId ||
    actor.type !== "human" || actor.id !== resolved.userId || actor.orgId !== resolved.orgId) {
    return dealsGoUnavailable();
  }

  try {
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      aud: "go.crm.read",
      sub: resolved.userId,
      org_id: resolved.orgId,
      capability_id: "crm.listDeals",
      input_sha256: await canonicalInputHash({}),
      actor_id: actor.id,
      actor_type: actor.type,
      permissions: [...actor.permissions].sort(),
      auth_session_id: resolved.authSessionId,
      iat: issuedAt,
      exp: issuedAt + 30,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const assertion = `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
    const baseUrl = new URL(process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
    const host = baseUrl.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp = baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host);
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/" ||
      (baseUrl.protocol !== "https:" && !loopbackHttp)) {
      return dealsGoUnavailable();
    }
    const response = await fetch(new URL("/__go/crm?deals=1", baseUrl), {
      method: "GET",
      headers: { "X-Chaste-Session-Assertion": assertion },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 401) {
      const body = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
      return body.success ? NextResponse.json({ error: body.data.error }, { status: 401, headers: noStore }) : dealsGoUnavailable();
    }
    if (!response.ok) {
      logger.warn("Go CRM deals read failed", { status: response.status });
      return dealsGoUnavailable();
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = dealReadResponseSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("Go CRM deals read returned an invalid response");
      return dealsGoUnavailable();
    }
    return NextResponse.json(parsed.data, { headers: noStore });
  } catch {
    logger.warn("Go CRM deals read failed");
    return dealsGoUnavailable();
  }
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
  if (process.env.GO_CRM_DEAL_READS === "1") {
    const actor = actorFromResolved(resolved);
    if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return readDealsFromGo(resolved, actor.actor);
  }
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
