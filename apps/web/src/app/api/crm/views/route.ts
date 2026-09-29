import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { canonicalInputHash, logger } from "@chaste/kernel";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";
import { getResolvedUser } from "@/server/session";

const filterSchema = z.object({
  status: z.enum(["active", "inactive", "all"]),
  owner: z.string().max(64),
  staleOnly: z.boolean(),
  duplicateOnly: z.boolean(),
  tag: z.string().max(40),
});
const bodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: filterSchema,
  isShared: z.boolean(),
  isPinned: z.boolean(),
  id: z.string().uuid().optional(),
});
const viewsResponseSchema = z.object({
  views: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(60),
    filters: filterSchema.strict(),
    isShared: z.boolean(),
    isPinned: z.boolean(),
    createdByUserId: z.string().uuid(),
    updatedAt: z.string().datetime(),
  }).strict()),
}).strict();
const savedViewSnapshotSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(60),
  filters: filterSchema.strict(),
  isShared: z.boolean(),
  isPinned: z.boolean(),
  createdByUserId: z.string().uuid(),
}).strict();
const saveViewOutputSchema = z.object({
  viewId: z.string().uuid(),
  previous: savedViewSnapshotSchema.nullable(),
}).strict();
const noStore = { "Cache-Control": "no-store" };

async function saveCustomerViewFromGo(result: GoCapabilityBridgeResult): Promise<Response> {
  const unavailable = () => NextResponse.json({ error: "Go CRM view save is unavailable" }, { status: 503, headers: noStore });
  if (result.kind !== "response") return unavailable();
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: saveViewOutputSchema }).strict().safeParse(body);
      return parsed.success ? NextResponse.json(parsed.data, { headers: noStore }) : unavailable();
    }
    if (result.response.status === 202) {
      const parsed = z.object({
        ok: z.literal(false),
        pendingApproval: z.literal(true),
        reason: z.string(),
      }).passthrough().safeParse(body);
      return parsed.success
        ? NextResponse.json({ pendingApproval: true, error: parsed.data.reason }, { status: 202, headers: noStore })
        : unavailable();
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      return parsed.success ? NextResponse.json(parsed.data, { status: 401, headers: noStore }) : unavailable();
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      return parsed.success
        ? NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore })
        : unavailable();
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

async function readCustomerViewsFromGo(input: {
  userId: string;
  orgId: string;
  authSessionId: string;
  permissions: readonly string[];
}): Promise<Response> {
  const secret = process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    return NextResponse.json({ error: "Go CRM views service unavailable" }, { status: 503 });
  }

  try {
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      aud: "go.crm.read",
      sub: input.userId,
      org_id: input.orgId,
      capability_id: "crm.listCustomerViews",
      input_sha256: await canonicalInputHash({}),
      actor_id: input.userId,
      actor_type: "human",
      permissions: [...input.permissions].sort(),
      auth_session_id: input.authSessionId,
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
      return NextResponse.json({ error: "Go CRM views service unavailable" }, { status: 503 });
    }

    const response = await fetch(new URL("/__go/crm?views=1", baseUrl), {
      method: "GET",
      headers: { Accept: "application/json", "X-Chaste-Session-Assertion": assertion },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = viewsResponseSchema.safeParse(body);
      if (!parsed.success) {
        logger.warn("Go CRM views read returned an invalid response");
        return NextResponse.json({ error: "Go CRM views service unavailable" }, { status: 503 });
      }
      return NextResponse.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
    }
    const error = z.object({ error: z.string() }).safeParse(body);
    if (error.success && [401, 403, 422].includes(response.status)) {
      return NextResponse.json(error.data, { status: response.status, headers: { "Cache-Control": "no-store" } });
    }
    logger.warn("Go CRM views read failed", { status: response.status });
    return NextResponse.json({ error: "Go CRM views service unavailable" }, { status: 503 });
  } catch {
    logger.warn("Go CRM views read failed");
    return NextResponse.json({ error: "Go CRM views service unavailable" }, { status: 503 });
  }
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  if (process.env.GO_CRM_VIEW_READS === "1") {
    if (ctx.actor.type !== "human" || ctx.actor.id !== resolved.userId || ctx.actor.orgId !== resolved.orgId || !resolved.authSessionId) {
      return NextResponse.json({ error: "Go CRM views service unavailable" }, { status: 503 });
    }
    return readCustomerViewsFromGo({
      userId: resolved.userId,
      orgId: resolved.orgId,
      authSessionId: resolved.authSessionId,
      permissions: [...ctx.actor.permissions],
    });
  }
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("crm.listCustomerViews", ctx, {});
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ views: (result.data as { views: unknown[] } | undefined)?.views ?? [] });
}

export async function POST(request: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = bodySchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.issues }, { status: 400 });
  const ctx = actorFromResolved(resolved, { intentId: typeof raw?.intentId === "string" ? raw.intentId : undefined });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  if (process.env.GO_CRM_VIEW_WRITES === "1") {
    if (ctx.actor.type !== "human" || ctx.actor.id !== resolved.userId || ctx.actor.orgId !== resolved.orgId || !resolved.authSessionId) {
      return NextResponse.json({ error: "Go CRM view save is unavailable" }, { status: 503, headers: noStore });
    }
    try {
      const result = await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId: "crm.saveCustomerView",
        input: body.data,
      });
      return saveCustomerViewFromGo(result);
    } catch {
      return NextResponse.json({ error: "Go CRM view save is unavailable" }, { status: 503, headers: noStore });
    }
  }
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("crm.saveCustomerView", ctx, body.data);
  if (result.pendingApproval) return NextResponse.json({ pendingApproval: true, error: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
