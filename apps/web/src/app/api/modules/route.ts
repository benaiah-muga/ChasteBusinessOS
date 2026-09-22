import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { ALL_MODULE_IDS, MODULE_CATALOG, PROTECTED_MODULE_IDS } from "@/app/(app)/_shell/modules";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { hasPermission as hasPermissionFor } from "@chaste/kernel";

/** Catalog plus the org's current switchboard state; protected modules always on. */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const saved = resolved.enabledModules;
  return NextResponse.json({
    catalog: MODULE_CATALOG,
    enabledModules: saved ? [...new Set([...PROTECTED_MODULE_IDS, ...saved])] : ALL_MODULE_IDS,
    usingDefaults: saved == null,
  });
}

const bodySchema = z.object({
  modules: z.array(z.enum(ALL_MODULE_IDS as [string, ...string[]])).min(1),
});

/**
 * Change the module switchboard. Goes through the governed iam.setModules
 * capability: a permitted human admin applies it directly under their own
 * authority; the workmate proposing the same change lands it in the
 * Approvals inbox. Protected spine modules are unioned in server-side, so
 * no toggle can ever drop iam, routines, or signals.
 */
export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermissionFor({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "forbidden: missing permission: iam.admin" }, { status: 403 });
  }

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.setModules", ctx, {
    modules: [...new Set([...parsed.data.modules, ...PROTECTED_MODULE_IDS])],
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "Module changes proposed by the workmate wait for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({
    ok: true,
    data: result.data,
  });
}
