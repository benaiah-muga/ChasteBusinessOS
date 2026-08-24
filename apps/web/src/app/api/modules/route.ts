import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { ALL_MODULE_IDS, MODULE_CATALOG } from "@/app/(app)/_shell/modules";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { hasPermission as hasPermissionFor } from "@chaste/kernel";

/** Catalog plus the org's current switchboard state. */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    catalog: MODULE_CATALOG,
    enabledModules: resolved.enabledModules ?? ALL_MODULE_IDS,
    usingDefaults: resolved.enabledModules == null,
  });
}

const bodySchema = z.object({
  modules: z.array(z.enum(ALL_MODULE_IDS as [string, ...string[]])).min(1),
});

/**
 * Change the module switchboard. Goes through the governed path:
 * iam.setModules is identity-class, so this lands in the Approvals inbox
 * and applies only after a human with iam.admin approves it.
 */
export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermissionFor({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "forbidden: missing permission: iam.admin" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.setModules", ctx, { modules: parsed.data.modules });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "Module changes wait for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({
    ok: true,
    data: result.data,
  });
}
