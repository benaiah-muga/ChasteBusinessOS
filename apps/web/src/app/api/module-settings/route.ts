import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, moduleSettings } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { settingsSchemaFor } from "@/server/module-settings";
import { getResolvedUser } from "@/server/session";

/**
 * Reads are plain org-scoped selects: configuration shapes what forms
 * default to, and every signed-in member may see them. Writes are governed
 * (iam.setModuleConfig, iam.admin) and validated against the module's
 * registered schema.
 */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const module = new URL(req.url).searchParams.get("module") ?? "";
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(module)) {
    return NextResponse.json({ error: "invalid module" }, { status: 400 });
  }
  const [row] = await getDb()
    .db.select({ settings: moduleSettings.settings })
    .from(moduleSettings)
    .where(and(eq(moduleSettings.orgId, resolved.orgId), eq(moduleSettings.module, module)))
    .limit(1);

  const schema = settingsSchemaFor(module);
  const stored = (row?.settings ?? {}) as Record<string, unknown>;
  const settings = schema?.parse(stored) ?? stored;
  return NextResponse.json({ module, settings });
}

const bodySchema = z.object({
  module: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  settings: z.record(z.string(), z.unknown()),
  intentId: z.string().optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const schema = settingsSchemaFor(parsed.data.module);
  if (!schema) return NextResponse.json({ error: `unknown module: ${parsed.data.module}` }, { status: 404 });

  const checked = schema.safeParse(parsed.data.settings);
  if (!checked.success) {
    return NextResponse.json(
      { error: `invalid settings: ${checked.error.issues[0]?.message ?? "shape mismatch"}` },
      { status: 400 },
    );
  }

  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.setModuleConfig", ctx, {
    module: parsed.data.module,
    settings: checked.data,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "This settings change waits for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
