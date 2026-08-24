import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb, marketplaceListings } from "@chaste/db";
import { verifyPlugin } from "@chaste/plugin-kit";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const body = (await req.json()) as {
    action?: string;
    manifest?: unknown;
    signatureBase64?: string;
    publisherPublicKeyBase64?: string;
    listingId?: string;
  };
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

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
