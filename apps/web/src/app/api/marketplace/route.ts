import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb, marketplaceListings } from "@chaste/db";
import { verifyPlugin } from "@chaste/plugin-kit";
import { z } from "zod";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };
const unavailable = () => NextResponse.json({ error: "Go marketplace service unavailable" }, { status: 503, headers: noStore });
const publishListingSchema = z.object({ listingId: z.string().uuid(), slug: z.string(), status: z.literal("verified") }).strict();
const installListingSchema = z.object({ installed: z.literal(true), slug: z.string(), version: z.string() }).strict();
const uninstalledResultSchema = z.object({ uninstalled: z.literal(true) }).strict();
const marketplaceListingSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  status: z.string(),
  capabilityIds: z.array(z.unknown()),
  installedByOrgIds: z.unknown().refine((value) => value !== undefined),
  installedHere: z.boolean(),
  updatedAt: z.string(),
}).strict();

async function marketplaceGoListingsResponse(result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return unavailable();
  try {
    const body: unknown = await result.response.json();
    const status = result.response.status;
    if (status === 200) {
      const envelope = z.object({ ok: z.literal(true), data: z.unknown(), replayed: z.boolean().optional() }).strict().safeParse(body);
      if (!envelope.success) return unavailable();
      const output = z.object({ listings: z.array(marketplaceListingSchema) }).strict().safeParse(envelope.data.data);
      if (!output.success) return unavailable();
      return NextResponse.json(output.data, { headers: noStore });
    }
    if (status === 401 || status === 400 || status === 403) {
      const error = z.object({ error: z.string() }).strict().safeParse(body);
      if (!error.success) return unavailable();
      return NextResponse.json(error.data, { status, headers: noStore });
    }
    if (status === 422) {
      const error = z.object({ ok: z.literal(false), error: z.string() }).strict().safeParse(body);
      if (!error.success) return unavailable();
      return NextResponse.json({ error: error.data.error }, { status: 403, headers: noStore });
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

async function marketplaceGoResponse(
  result: GoCapabilityBridgeResult,
  capability: "creator.verifyPlugin" | "creator.publishListing" | "creator.installListing" | "creator.uninstallListing",
) {
  if (result.kind !== "response") return unavailable();
  try {
    const body: unknown = await result.response.json();
    const status = result.response.status;
    if (status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: z.unknown(), replayed: z.boolean().optional() }).strict().safeParse(body);
      if (!parsed.success) return unavailable();
      if (capability === "creator.verifyPlugin") {
        const verdict = z.object({ valid: z.boolean(), reason: z.string().optional() }).strict().safeParse(parsed.data.data);
        if (!verdict.success) return unavailable();
        const data = verdict.data.valid
          ? { valid: true }
          : { valid: false, ...(verdict.data.reason ? { reason: verdict.data.reason } : {}) };
        return NextResponse.json(data, { status: verdict.data.valid ? 200 : 422, headers: noStore });
      }
      const outputSchema = capability === "creator.publishListing"
        ? publishListingSchema
        : capability === "creator.installListing" ? installListingSchema
          : uninstalledResultSchema;
      const output = outputSchema.safeParse(parsed.data.data);
      if (!output.success) return unavailable();
      return respond({ ok: true, data: output.data }, noStore);
    }
    if (status === 202) {
      const parsed = z.object({
        ok: z.literal(false),
        pendingApproval: z.literal(true),
        reason: z.string(),
        approvalId: z.string().optional(),
      }).strict().safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json({ ok: false, pendingApproval: true, reason: parsed.data.reason }, { status: 202, headers: noStore });
    }
    if (status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).strict().safeParse(body);
      if (!parsed.success) return unavailable();
      if (capability === "creator.verifyPlugin") {
        return NextResponse.json({ valid: false, reason: parsed.data.error }, { status: 422, headers: noStore });
      }
      return respond({ ok: false, error: parsed.data.error }, noStore);
    }
    if (status === 400 || status === 403) {
      const parsed = z.object({ error: z.string() }).strict().safeParse(body);
      if (!parsed.success) return unavailable();
      if (capability === "creator.verifyPlugin") {
        return NextResponse.json({ ok: false, error: parsed.data.error }, { status, headers: noStore });
      }
      return respond({ ok: false, error: parsed.data.error }, noStore);
    }
    if (status === 401) {
      const parsed = z.object({ error: z.string() }).strict().safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json(parsed.data, { status: 401, headers: noStore });
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.GO_CREATOR_MARKETPLACE_READS === "1") {
    const ctx = actorFromResolved(resolved);
    if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
    const result = await executeGoCapability({
      actionContext: ctx,
      session: resolved,
      capabilityId: "creator.listMarketplace",
      input: {},
    });
    return marketplaceGoListingsResponse(result);
  }
  const db = getDb().db;

  const rows = await db
    .select({
      id: marketplaceListings.id,
      slug: marketplaceListings.slug,
      name: marketplaceListings.name,
      version: marketplaceListings.version,
      summary: marketplaceListings.summary,
      status: marketplaceListings.status,
      capabilityIds: marketplaceListings.capabilityIds,
      installedByOrgIds: marketplaceListings.installedByOrgIds,
      updatedAt: marketplaceListings.updatedAt,
    })
    .from(marketplaceListings)
    .orderBy(desc(marketplaceListings.updatedAt))
    .limit(100);

  return NextResponse.json({
    listings: rows.map((r) => ({
      ...r,
      capabilityIds: Array.isArray(r.capabilityIds) ? r.capabilityIds : [],
      installedHere: Array.isArray(r.installedByOrgIds)
        ? (r.installedByOrgIds as string[]).includes(resolved.orgId ?? "")
        : false,
    })),
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    action?: string;
    manifest?: unknown;
    signatureBase64?: string;
    publisherPublicKeyBase64?: string;
    listingId?: string;
    intentId?: string;
  };
  const intentId = typeof body.intentId === "string" ? body.intentId : undefined;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const bridgeVerify = body.action === "verify" && process.env.GO_CREATOR_MARKETPLACE_VERIFY === "1";
  const bridgeWrite = ["publish", "install", "uninstall"].includes(body.action ?? "") && process.env.GO_CREATOR_MARKETPLACE_WRITES === "1";
  if (bridgeVerify || bridgeWrite) {
    if (body.action === "verify" || body.action === "publish") {
      if (!body.manifest || !body.signatureBase64 || !body.publisherPublicKeyBase64) {
        return NextResponse.json({ error: "manifest, signature and publisher key required" }, { status: 400 });
      }
    }
    if ((body.action === "install" || body.action === "uninstall") && !body.listingId) {
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
    }

    const capabilityId = body.action === "verify" ? "creator.verifyPlugin"
      : body.action === "publish" ? "creator.publishListing"
        : body.action === "install" ? "creator.installListing" : "creator.uninstallListing";
    const input = body.action === "verify" || body.action === "publish"
      ? { manifest: body.manifest, signatureBase64: body.signatureBase64, publisherPublicKeyBase64: body.publisherPublicKeyBase64 }
      : { listingId: body.listingId };
    const result = await executeGoCapability({ actionContext: ctx, session: resolved, capabilityId, input });
    return marketplaceGoResponse(result, capabilityId);
  }

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  if (body.action === "verify") {
    if (!body.manifest || !body.signatureBase64 || !body.publisherPublicKeyBase64) {
      return NextResponse.json({ error: "manifest, signature and publisher key required" }, { status: 400 });
    }
    const verdict = verifyPlugin(body.manifest, body.signatureBase64!, body.publisherPublicKeyBase64!);
    return NextResponse.json(verdict, { status: verdict.valid ? 200 : 422 });
  }
  if (body.action === "publish") {
    if (!body.manifest || !body.signatureBase64 || !body.publisherPublicKeyBase64) {
      return NextResponse.json({ error: "manifest, signature and publisher key required" }, { status: 400 });
    }
    return respond(
      await executor.execute("creator.publishListing", ctx, {
        manifest: body.manifest,
        signatureBase64: body.signatureBase64,
        publisherPublicKeyBase64: body.publisherPublicKeyBase64,
      }),
    );
  }
  if (body.action === "install" && body.listingId) {
    return respond(await executor.execute("creator.installListing", ctx, { listingId: body.listingId }));
  }
  if (body.action === "uninstall" && body.listingId) {
    return respond(await executor.execute("creator.uninstallListing", ctx, { listingId: body.listingId }));
  }
  return NextResponse.json({ error: "invalid action" }, { status: 400 });
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }, headers?: HeadersInit) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202, headers });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422, headers });
  return NextResponse.json({ ok: true, data: result.data }, { headers });
}
